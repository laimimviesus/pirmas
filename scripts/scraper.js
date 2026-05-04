// =====================================================================
// MERCELL SCRAPER — GitHub Actions version
// With "Go to source" page scraping
// =====================================================================
// Paleidimas: node scripts/scraper.js
// Env vars: MERCELL_USERNAME, MERCELL_PASSWORD, GOOGLE_SERVICE_ACCOUNT_KEY,
//           GOOGLE_SHEET_ID, (opt) SHEET_TAB_NAME, (opt) TEST_MODE
// =====================================================================

const puppeteer = require('puppeteer');
const { google } = require('googleapis');

// --- Config ------------------------------------------------------------
const TEST_MODE = process.env.TEST_MODE === 'true';
const MAX_PAGES = TEST_MODE ? 1 : 200;
// Prod limits sąmoningai konservatyvūs — GitHub Actions jobs are capped at
// 6h, o pilnas detail-fetch ciklas per tender'į truko ~5–10s. 4000 tenderių
// prasilenkdavo su timeout'u ir niekas nebuvo įrašoma. Paliekam override'ą
// per aplinkos kintamąjį jeigu kada reikės platesnio pirmojo backfill'o.
const MAX_TENDERS = TEST_MODE ? 9 : Number(process.env.MAX_TENDERS || 500);
const DETAILS_LIMIT = TEST_MODE ? 9 : Number(process.env.DETAILS_LIMIT || 500);
const FLUSH_BATCH = TEST_MODE ? 1 : Number(process.env.FLUSH_BATCH || 5);
const SOURCE_NAV_TIMEOUT = 25000;

// --- Anthropic Claude API ---------------------------------------------
// Naudojam Claude Haiku 4.5 (pigus, greitas) dviem užduotims:
//   1. Pavadinimo ir scope tekstų vertimui į anglų kalbą
//   2. Struktūrizuotų laukų ištraukimui iš Mercell description'o +
//      šaltinio puslapio teksto (maxBudget, requirements, qualifications,
//      offerWeighingCriteria)
// Jei nėra ANTHROPIC_API_KEY — AI žingsniai praleidžiami, scraper'is
// veikia kaip anksčiau.
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const AI_MODEL = process.env.AI_MODEL || 'claude-haiku-4-5-20251001';
const AI_ENABLED = !!ANTHROPIC_API_KEY;
// Rate-limit state (org cap: 5 req/min for Haiku). We keep a rolling log of
// call timestamps and delay so no more than AI_MAX_PER_MIN fire in any 60s.
const AI_MAX_PER_MIN = Number(process.env.AI_MAX_PER_MIN || 4); // headroom under 5/min
const _claudeCallTimes = [];
const _sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function _throttleClaude() {
  while (true) {
    const now = Date.now();
    // drop timestamps older than 60s
    while (_claudeCallTimes.length && now - _claudeCallTimes[0] > 60000) {
      _claudeCallTimes.shift();
    }
    if (_claudeCallTimes.length < AI_MAX_PER_MIN) {
      _claudeCallTimes.push(now);
      return;
    }
    const waitMs = 60000 - (now - _claudeCallTimes[0]) + 250;
    console.log(`    ⏳ Claude rate-limit wait ${(waitMs/1000).toFixed(1)}s (${_claudeCallTimes.length}/${AI_MAX_PER_MIN} in last 60s)`);
    await _sleep(waitMs);
  }
}

// --- Portal credentials --------------------------------------------------
// Mercell „Go to source" nuoroda dažnai veda į kitos platformos (Hansel,
// tarjouspalvelu.fi, eu-supply, e-tendering, mercell.com pati, etc.) login
// puslapį. Norėdami atsisiųsti tender'io priedus iš tų portalų, laikom
// vartotojo / slaptažodžio porą JSON'e su hostname raktais. Paslaptis nustatoma
// GitHub Actions secret'u `PORTAL_CREDS_JSON`. Pavyzdys:
// {
//   "tarjouspalvelu.fi":      { "username": "u@e.com", "password": "..." },
//   "eu.eu-supply.com":       { "username": "u@e.com", "password": "..." },
//   "permalink.mercell.com":  { "username": "u@e.com", "password": "..." }
// }
// Niekada nelaikom tų reikšmių kode. `getPortalCreds()` priima visą URL arba
// hostname'ą, normalizuoja iki host, daro exact-match, tada suffix-match
// (`sub.example.com` → `example.com`).
let _portalCreds = {};
try {
  if (process.env.PORTAL_CREDS_JSON) {
    const parsed = JSON.parse(process.env.PORTAL_CREDS_JSON);
    if (parsed && typeof parsed === 'object') {
      _portalCreds = parsed;
      console.log(`✓ PORTAL_CREDS_JSON parsed: ${Object.keys(_portalCreds).length} portal(s) configured`);
    }
  }
} catch (e) {
  console.log(`⚠️ PORTAL_CREDS_JSON parse failed: ${e.message}`);
}
function getPortalCreds(hostOrUrl) {
  if (!hostOrUrl || !_portalCreds || !Object.keys(_portalCreds).length) return null;
  let host = String(hostOrUrl).trim().toLowerCase();
  // pull host out of full URL
  try {
    if (/^https?:\/\//i.test(host)) host = new URL(host).hostname.toLowerCase();
  } catch (_) { /* ignore */ }
  host = host.replace(/^www\./, '');
  // exact match
  if (_portalCreds[host]) return _portalCreds[host];
  // suffix match — credential key is a domain suffix of host
  for (const key of Object.keys(_portalCreds)) {
    const k = String(key).toLowerCase().replace(/^www\./, '');
    if (host === k || host.endsWith('.' + k)) return _portalCreds[key];
  }
  return null;
}
async function callClaude(systemPrompt, userPrompt, { maxTokens = 1024, temperature = 0 } = {}) {
  if (!AI_ENABLED) throw new Error('ANTHROPIC_API_KEY missing');
  // Circuit breaker — once a non-retryable error (credit balance, 401/403)
  // tripped the circuit earlier in this run, we skip the HTTP call entirely.
  // We still THROW so the caller's catch fires _markAiFailure() and the per-
  // tender loop defers the row. The thrown message includes the original
  // reason so _isAiNonRetryable() classifies it as non-retryable.
  if (_aiCircuitOpen) {
    throw new Error(`Claude circuit-open (skipped): ${_aiCircuitReason}`);
  }
  const body = JSON.stringify({
    model: AI_MODEL,
    max_tokens: maxTokens,
    temperature,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });
  const https = require('https');
  const MAX_ATTEMPTS = 4;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await _throttleClaude();
    try {
      return await new Promise((resolve, reject) => {
        const req = https.request(
          {
            hostname: 'api.anthropic.com',
            path: '/v1/messages',
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-api-key': ANTHROPIC_API_KEY,
              'anthropic-version': '2023-06-01',
              'content-length': Buffer.byteLength(body),
            },
            timeout: 45000,
          },
          (res) => {
            let chunks = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { chunks += c; });
            res.on('end', () => {
              if (res.statusCode === 429 || res.statusCode === 529) {
                const ra = Number(res.headers['retry-after']);
                const wait = (Number.isFinite(ra) && ra > 0 ? ra * 1000 : 15000);
                const err = new Error(`Claude HTTP ${res.statusCode}: ${chunks.slice(0, 200)}`);
                err._retryAfter = wait;
                err._retryable = true;
                return reject(err);
              }
              if (res.statusCode < 200 || res.statusCode >= 300) {
                return reject(new Error(`Claude HTTP ${res.statusCode}: ${chunks.slice(0, 300)}`));
              }
              try {
                const j = JSON.parse(chunks);
                const text = (j.content || [])
                  .filter((b) => b.type === 'text')
                  .map((b) => b.text)
                  .join('')
                  .trim();
                resolve(text);
              } catch (e) {
                reject(new Error(`Claude JSON parse: ${e.message}`));
              }
            });
          }
        );
        req.on('timeout', () => { req.destroy(new Error('Claude request timeout')); });
        req.on('error', reject);
        req.write(body);
        req.end();
      });
    } catch (e) {
      if (e._retryable && attempt < MAX_ATTEMPTS) {
        // Drop the timestamp we just reserved — the call didn't actually succeed,
        // and we want the next attempt to wait the Retry-After window, not skip.
        _claudeCallTimes.pop();
        const wait = e._retryAfter || (5000 * attempt);
        console.log(`    ⏳ Claude 429 (attempt ${attempt}/${MAX_ATTEMPTS}), retrying in ${(wait/1000).toFixed(1)}s`);
        await _sleep(wait);
        continue;
      }
      throw e;
    }
  }
  throw new Error('Claude: exhausted retries');
}
// Module-level flag: set when an AI call fails with a non-retryable error
// (HTTP 400 invalid_request_error like "credit balance too low", or 401/403
// auth issues). The per-tender loop checks this between AI calls and DEFERS
// row-write if any non-retryable failure occurred — that way the tender ID
// never enters the sheet, and the next run picks it up automatically.
// Reset to null at the start of each tender's AI section.
let _lastAiNonRetryableError = null;

// Global circuit breaker. Once any AI call hits a non-retryable error, this
// trips and ALL subsequent callClaude() invocations short-circuit before
// touching the network or the rate limiter. Saves wall-clock time during
// outages (no 30–45s rate-limit waits for calls we know will fail). Lasts
// for the rest of the process lifetime — a fresh GitHub Actions run starts
// the process clean and the circuit closes again.
let _aiCircuitOpen = false;
let _aiCircuitReason = '';
function _tripAiCircuit(err) {
  if (_aiCircuitOpen) return;
  _aiCircuitOpen = true;
  _aiCircuitReason = String(err && err.message || 'unknown').slice(0, 200);
  console.log(`    🔌 AI circuit breaker OPEN — skipping all further AI calls this run (${_aiCircuitReason.slice(0, 120)})`);
}

function _isAiNonRetryable(err) {
  const msg = String(err && err.message || '');
  // Claude HTTP 400 with credit balance / invalid_request_error → not retryable
  // 401/403 → auth/permissions, also not retryable on this run
  // 404 → bad endpoint (config issue), not retryable
  // "circuit-open" → already tripped, so this is non-retryable by definition
  if (/HTTP\s*40[134]/i.test(msg)) return true;
  if (/credit balance|invalid_request_error|insufficient_quota/i.test(msg)) return true;
  if (/circuit-open/i.test(msg)) return true;
  return false;
}
function _markAiFailure(err) {
  if (_isAiNonRetryable(err)) {
    _lastAiNonRetryableError = String(err && err.message || '').slice(0, 200);
    _tripAiCircuit(err);
  }
}

async function translateToEnglish(text, { hint = '', skipHeuristic = false } = {}) {
  if (!AI_ENABLED || !text) return '';
  const trimmed = String(text).slice(0, 6000);
  // Heuristika tik ilgiems tekstams (scope), kad netrinktume Haiku'o dėl
  // aiškiai angliško turinio. Trumpiems pavadinimams heuristika klysta
  // (pvz., vokiškas „Beschaffung eines Schulmanagementsystems" neturi
  // umlautų), tad jiems perduodam skipHeuristic=true.
  //
  // Diakritikos klasė apima: vakarų Europos (ä ö ü ß ñ ç ø æ å ...),
  // baltų (ą č ę ė į š ų ū ž), lenkų (ć ł ń ó ś ź ż), čekų/slovakų
  // (ď ě ň ř ť ů ý ĺ ŕ), estų/vengrų (õ ő ű) — tai praktiškai padengia
  // visus EU 24 oficialiose kalbose paplitusius akcentuotus simbolius.
  // Stopword'ai padengia LT/PL/CZ/SK/ET/HU/HR/SL atvejus, kuriuose
  // diakritikų gali ir nebūti (pvz. „IT sistemos pirkimas" — be
  // diakritikų, bet ne anglų).
  if (!skipHeuristic) {
    const hasNonEnglishDiacritic = /[äöüßñçéèêáíóúîôûàèìòùâêîôûãõÿøœæåÄÖÜÑÉÈÊÁÍÓÚÎÔÛÃÕŸØŒÆÅąčęėįšųūžĄČĘĖĮŠŲŪŽćłńóśźżĆŁŃÓŚŹŻďěňřťůýĎĚŇŘŤŮÝĺŕĹŔőűŐŰ]/.test(trimmed);
    const hasNonEnglishStopword = /\b(?:och|und|der|die|den|das|dem|für|mit|auf|bei|nach|ist|sind|wir|sie|ihr|het|van|een|voor|naar|niet|wel|als|aan|maar|ook|waar|dan|alleen|geen|meer|kan|el|la|los|las|para|del|por|que|con|una|uno|les|pour|sur|avec|sans|dans|sous|dei|delle|della|degli|alla|allo|zur|zum|med|till|fra|men|att|som|inte|och|eller|ir|su|dėl|kad|yra|kaip|bei|arba|taip|šis|tas|tos|kas|kuris|todėl|prie|po|nuo|iki|i|w|na|dla|z|ze|nie|jest|się|że|do|oraz|który|przez|przy|jako|lub|jeśli|a|je|ve|do|by|se|jako|nebo|pokud|který|však|neboť|vo|zo|sa|alebo|však|preto|ja|on|ei|et|ka|oma|või|kui|aga|és|az|egy|hogy|vagy|van|nem|csak|már|i|u|sa|je|li|nije|ali|ima|kao|samo)\b/i.test(trimmed);
    const looksEnglish = !hasNonEnglishDiacritic && !hasNonEnglishStopword;
    if (looksEnglish) return trimmed;
  }
  try {
    const out = await callClaude(
      'You are a precise translator from any European language into English. The user text is from a public procurement notice. ' +
      'ALWAYS translate non-English text into English — do NOT return the source verbatim if it is not already English. ' +
      'If the text already IS English, return it unchanged. ' +
      'Preserve tender reference numbers, organisation names, country names, CPV codes, and product/brand names verbatim. ' +
      'Return ONLY the translation: no preface, no explanations, no quotes, no language label.',
      `${hint ? `Context: ${hint}\n\n` : ''}Text to translate:\n${trimmed}`,
      { maxTokens: 800, temperature: 0 }
    );
    let result = out || trimmed;
    // Defensive retry: if Claude echoed the input unchanged AND the input
    // clearly contains non-ASCII characters (i.e. it isn't English), force
    // a second pass with an even more direct instruction. Avoids the
    // common Haiku failure mode where it hands back the source string
    // because the system prompt felt ambiguous.
    const echoed = out && out.trim() === trimmed.trim();
    const hasNonAscii = /[^\x00-\x7F]/.test(trimmed);
    if (echoed && hasNonAscii) {
      try {
        const forced = await callClaude(
          'Translate the following non-English text into English. Output ONLY the English translation. No source language label, no quotes, no explanation.',
          `Source text (translate to English):\n${trimmed}`,
          { maxTokens: 800, temperature: 0 }
        );
        if (forced && forced.trim() !== trimmed.trim()) {
          result = forced;
        }
      } catch (_) { /* fall back to first result */ }
    }
    return result;
  } catch (e) {
    _markAiFailure(e);
    console.log(`    ⚠️ translate failed: ${e.message}`);
    return trimmed;
  }
}

async function extractFieldsWithAI(text, meta = {}) {
  if (!AI_ENABLED || !text) return {};
  // Bumped to 150000 — Haiku 4.5 has 200K context, so we send up to 150K chars
  // of combined notice text + PDF document content. This lets the model see
  // the full Terms of Reference, mandatory requirements lists, qualification
  // chapters, and award-criteria tables that the sparse fields rely on.
  const trimmed = String(text).slice(0, 150000);
  const system =
    'You extract structured procurement tender fields from free-form notice text plus attached document text. ' +
    'The user message has sections labeled TITLE / DESCRIPTION / MERCELL_PAGE / DOCUMENTS — the DOCUMENTS section, when present, contains the FULL TEXT of one or more attached PDF specifications and is usually where requirements, qualifications, and award criteria are spelled out. SCAN IT THOROUGHLY before deciding a field is empty. ' +
    'Return ONLY a JSON object (no prose, no markdown fences) with these keys: ' +
    'maxBudget, estimatedBudgetEur, duration, requirementsForSupplier, qualificationRequirements, offerWeighingCriteria, scopeOfAgreement.\n' +
    'Rules:\n' +
    '- maxBudget: total ceiling / max contract value AS STATED in the tender or attached docs (with currency code, ex-VAT if specified). Examples: "1,200,000 EUR (ex VAT)", "8 500 000 SEK". Empty string if not explicitly stated anywhere.\n' +
    '- estimatedBudgetEur: integer EUR estimate, ONLY fill if maxBudget is empty AND the description/documents give enough basis (scope, deliverables, duration, country, complexity). Use realistic public-sector IT contract rates for that country. Output a plain integer like 850000 (no separators, no currency, no words). Empty string if you cannot estimate responsibly.\n' +
    '- duration: contract length in months or years. Example: "36 months" or "2 years + 2 x 1 year option". Empty string if not stated.\n' +
    '- requirementsForSupplier: bullet-style summary (≤400 chars) of MANDATORY supplier/bidder requirements (legal status, insurance, ISO certifications, security clearance, technical staff, financial standing). Look in DOCUMENTS for sections titled "Requirements", "Mandatory requirements", "Reikalavimai tiekėjui", "Wymagania", "Anforderungen an den Bieter", "Krav til leverandør", "Eisen aan inschrijver", "Exigences", "Requisitos", "Condiciones de admisión", "Requisitos de participación de los licitadores", "Aptitud para contratar". Empty string if truly absent.\n' +
    '- qualificationRequirements: bullet-style summary (≤400 chars) of SELECTION / qualification criteria (turnover thresholds, references, past similar projects, team CVs, certifications). Look for "Selection criteria", "Qualification", "Kvalifikaciniai reikalavimai", "Kwalifikacja", "Eignungskriterien", "Kvalifikasjonskrav", "Solvencia económica, financiera y técnica", "Solvencia técnica o profesional", "Solvencia económica y financiera", "Criterio de Solvencia Técnica-Profesional", "Criterio de Solvencia Económica-Financiera", "Cláusula 11", "Cláusula 14", "Cláusula 15", "Apartado 15", "Cuadro de Características" (PLACSP/Spanish PCAP docs put hard numbers — minimum annual turnover, mandatory ISO/ENS/ENI/SARA-PdP certificates, references for similar projects of size >X — under those exact headings). Empty string if truly absent.\n' +
    '- offerWeighingCriteria: award criteria with weights if present. Example: "Price 40%, Quality 35%, Delivery time 25%" or "MEAT — lowest price". Look for "Award criteria", "Evaluation", "Vertinimo kriterijai", "Kryteria oceny", "Zuschlagskriterien", "Tildelingskriterier", "Criterios de adjudicación", "Criterios evaluables mediante aplicación de fórmulas", "Criterios evaluables mediante un juicio de valor", "Apartado 21", "Ponderación". When weights add up to 100, list each named criterion with its weight. Empty string if truly absent.\n' +
    '- scopeOfAgreement: 1–3 sentence English summary of what is being procured. Must be English.\n' +
    'Write all field values in English even if the source is in another language. Never invent specifics — but DO synthesize when documents clearly imply requirements (e.g., "ISO 27001 certificate" listed under "Mandatory documents" → include in requirementsForSupplier). If a field is genuinely not present, use an empty string.';
  const metaLine = [
    meta.title ? `Title: ${meta.title}` : '',
    meta.buyer ? `Buyer: ${meta.buyer}` : '',
    meta.country ? `Country: ${meta.country}` : '',
    meta.referenceNumber ? `Ref: ${meta.referenceNumber}` : '',
  ].filter(Boolean).join('\n');
  try {
    const out = await callClaude(
      system,
      `${metaLine ? metaLine + '\n\n' : ''}Notice text:\n${trimmed}`,
      { maxTokens: 1200, temperature: 0 }
    );
    // Claude sometimes wraps JSON in fences; strip them defensively.
    const cleaned = out
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();
    const parsed = JSON.parse(cleaned);
    return {
      maxBudget: (parsed.maxBudget || '').toString().trim(),
      estimatedBudgetEur: (parsed.estimatedBudgetEur || '').toString().trim(),
      duration: (parsed.duration || '').toString().trim(),
      requirementsForSupplier: (parsed.requirementsForSupplier || '').toString().trim(),
      qualificationRequirements: (parsed.qualificationRequirements || '').toString().trim(),
      offerWeighingCriteria: (parsed.offerWeighingCriteria || '').toString().trim(),
      scopeOfAgreement: (parsed.scopeOfAgreement || '').toString().trim(),
    };
  } catch (e) {
    _markAiFailure(e);
    console.log(`    ⚠️ AI extract failed: ${e.message.slice(0, 160)}`);
    return {};
  }
}

// --- Pagalbinės funkcijos ----------------------------------------------

async function clickButtonContainsText(page, text) {
  return await page.evaluate((t) => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const el = buttons.find(b => (b.textContent || '').trim().includes(t));
    if (!el) return false;
    el.click();
    return true;
  }, text);
}

async function clickSpanContainsText(page, text) {
  return await page.evaluate((t) => {
    const spans = Array.from(document.querySelectorAll('span'));
    const el = spans.find(s => (s.textContent || '').trim().startsWith(t));
    if (!el) return false;
    el.click();
    return true;
  }, text);
}

async function checkTreeNodeByName(page, name) {
  return await page.evaluate(async (n) => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const findLabel = () => {
      const labels = Array.from(document.querySelectorAll('span.p-treenode-label'));
      return labels.find(s => {
        const t = (s.textContent || '').trim();
        return t === n || t.startsWith(n + ' ') || t.startsWith(n + '(');
      });
    };
    const getScrollableAncestor = (el) => {
      let cur = el;
      while (cur && cur !== document.body) {
        const s = getComputedStyle(cur);
        const canScroll =
          (s.overflowY === 'auto' || s.overflowY === 'scroll' ||
           s.overflow  === 'auto' || s.overflow  === 'scroll') &&
          cur.scrollHeight > cur.clientHeight + 1;
        if (canScroll) return cur;
        cur = cur.parentElement;
      }
      return null;
    };
    const fireScroll = (el) => {
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
    };

    let label = findLabel();
    if (!label) {
      const anyLabel = document.querySelector('span.p-treenode-label');
      const scroller = anyLabel ? getScrollableAncestor(anyLabel) : null;
      if (scroller) {
        scroller.scrollTop = 0;
        fireScroll(scroller);
        await sleep(120);
        const maxY = scroller.scrollHeight + 3000;
        for (let y = 0; y <= maxY; y += 120) {
          scroller.scrollTop = y;
          fireScroll(scroller);
          await sleep(70);
          label = findLabel();
          if (label) break;
        }
      }
      if (!label) {
        for (let y = 0; y <= document.documentElement.scrollHeight; y += 200) {
          window.scrollTo(0, y);
          await sleep(60);
          label = findLabel();
          if (label) break;
        }
      }
    }

    if (!label) return { ok: false, reason: 'label not found' };

    const content = label.closest('.p-treenode-content') || label.parentElement;
    const checkbox =
      content.querySelector('.p-checkbox-box') ||
      content.querySelector('[role="checkbox"]') ||
      content.querySelector('.p-checkbox');
    if (!checkbox) return { ok: false, reason: 'checkbox not found' };

    label.scrollIntoView({ block: 'center' });
    checkbox.click();
    return { ok: true };
  }, name);
}

// Patikrina/pažymi PrimeReact checkbox'ą po tam tikru .p-accordion-tab (pagal ID regex).
// Naudoja TIKRĄ mouse click per page.click() — element.click() iš evaluate'o neveikia
// PrimeReact'ui su šiais checkbox'ais (patikrinta diagnostika — click'as kviečiasi,
// bet .p-highlight nepersijungia).
async function checkCheckboxInAccordion(page, accordionRegex, labelText) {
  // 1. Išplėsti accordion'ą
  await page.evaluate((pat) => {
    const regex = new RegExp(pat, 'i');
    const tabs = Array.from(document.querySelectorAll('.p-accordion-tab'));
    const target = tabs.find(t => regex.test(t.id || ''));
    if (!target) return;
    const link = target.querySelector('.p-accordion-header-link');
    if (link && link.getAttribute('aria-expanded') !== 'true') {
      link.scrollIntoView({ block: 'center' });
      link.click();
    }
  }, accordionRegex);
  await new Promise(r => setTimeout(r, 700));

  const tryClick = async (mode) => {
    // mode: 'label' | 'box' | 'input'
    const tagged = await page.evaluate((pat, text, clickMode) => {
      const regex = new RegExp(pat, 'i');
      const tabs = Array.from(document.querySelectorAll('.p-accordion-tab'));
      const target = tabs.find(t => regex.test(t.id || ''));
      if (!target) return { ok: false, reason: 'no accordion' };

      document.querySelectorAll('[data-mx-click]').forEach(el => el.removeAttribute('data-mx-click'));

      const labels = Array.from(target.querySelectorAll('.p-checkbox-label'));
      const label = labels.find(l => {
        const t = (l.textContent || '').trim();
        return t === text || t.startsWith(text + ' ') || t.startsWith(text + '(');
      });
      if (!label) return { ok: false, reason: 'no label', avail: labels.map(l => l.textContent?.trim()).slice(0, 12) };

      const wrapper = label.closest('.p-checkbox-wrapper') || label.parentElement;
      let tgt = null;
      if (clickMode === 'label') tgt = label;
      else if (clickMode === 'box') tgt = wrapper?.querySelector('.p-checkbox-box');
      else if (clickMode === 'input') tgt = wrapper?.querySelector('input[type="checkbox"]');
      if (!tgt) return { ok: false, reason: `no target for mode ${clickMode}` };

      tgt.setAttribute('data-mx-click', '1');
      try { tgt.scrollIntoView({ block: 'center' }); } catch (_) {}
      return { ok: true };
    }, accordionRegex, labelText, mode);

    if (!tagged.ok) return { ok: false, reason: tagged.reason, avail: tagged.avail };

    try {
      await page.click('[data-mx-click="1"]', { delay: 20 });
    } catch (e) {
      return { ok: false, reason: 'click error: ' + e.message };
    }
    await new Promise(r => setTimeout(r, 400));

    const state = await page.evaluate((pat, text) => {
      const regex = new RegExp(pat, 'i');
      const tabs = Array.from(document.querySelectorAll('.p-accordion-tab'));
      const target = tabs.find(t => regex.test(t.id || ''));
      if (!target) return null;
      const labels = Array.from(target.querySelectorAll('.p-checkbox-label'));
      const label = labels.find(l => {
        const t = (l.textContent || '').trim();
        return t === text || t.startsWith(text + ' ') || t.startsWith(text + '(');
      });
      if (!label) return null;
      const wrapper = label.closest('.p-checkbox-wrapper');
      const box = wrapper?.querySelector('.p-checkbox-box');
      const input = wrapper?.querySelector('input[type="checkbox"]');
      return {
        boxHighlight: box?.classList.contains('p-highlight') === true,
        inputChecked: input?.checked === true,
        ariaChecked: box?.getAttribute('aria-checked') || null,
      };
    }, accordionRegex, labelText);

    const verified = !!state && (state.boxHighlight || state.inputChecked || state.ariaChecked === 'true');
    return { ok: verified, state };
  };

  // Bandom eilės tvarka: label → box → input
  for (const mode of ['label', 'box', 'input']) {
    const r = await tryClick(mode);
    if (r.ok) {
      console.log(`  ✓ ${labelText} (mode=${mode})`, JSON.stringify(r.state));
      return true;
    }
    if (r.avail) {
      console.log(`  ✗ ${labelText}: ${r.reason}. Available labels:`, r.avail);
      return false; // label'io nėra — nėra ko bandyti
    }
    console.log(`  ... ${labelText} mode=${mode} not verified, trying next`, JSON.stringify(r.state || {}));
  }
  console.log(`  ✗ ${labelText}: all click modes failed`);
  return false;
}

function extractTenderId(urlOrHref) {
  const m = (urlOrHref || '').match(/\/tender\/(-?\d+)/);
  return m ? m[1] : null;
}

function getCleanTenderUrl(tenderId) {
  return `https://app.mercell.com/tender/${tenderId}`;
}

async function goToNextPage(page) {
  const urlBefore = page.url();
  const firstTenderBefore = await page.evaluate(() => {
    const first = document.querySelector('[data-testid="tender-name"] a, a[href*="/tender/"]');
    return first?.getAttribute('href') || null;
  });

  const paginationInfo = await page.evaluate(() => {
    const nextBtn = document.querySelector('.p-paginator-next');
    if (!nextBtn) return { found: false };

    const classes = nextBtn.className || '';
    const disabled = nextBtn.hasAttribute('disabled') ||
                     classes.includes('p-disabled') ||
                     classes.includes('p-paginator-element-disabled') ||
                     nextBtn.getAttribute('aria-disabled') === 'true';

    const allPages = Array.from(document.querySelectorAll('.p-paginator-page'))
      .map(el => el.innerText?.trim())
      .filter(Boolean);

    const currentPage = document.querySelector('.p-paginator-page.p-highlight')?.innerText?.trim() || 'unknown';

    return { found: true, disabled, currentPage, allPages };
  });

  console.log('  Pagination:', JSON.stringify(paginationInfo));

  if (!paginationInfo.found) {
    console.log('  No pagination button - assuming single page');
    return false;
  }
  if (paginationInfo.disabled) {
    console.log('  Next button disabled - last page reached');
    return false;
  }

  const clicked = await page.evaluate(() => {
    const next = document.querySelector('.p-paginator-next');
    if (!next) return false;
    if (next.hasAttribute('disabled') ||
        (next.className || '').includes('p-disabled') ||
        next.getAttribute('aria-disabled') === 'true') {
      return false;
    }
    next.scrollIntoView({ block: 'center' });
    next.click();
    return true;
  });

  if (!clicked) {
    console.log('  Click failed');
    return false;
  }

  try {
    await page.waitForFunction(
      ({ urlBefore, firstTenderBefore }) => {
        const urlChanged = location.href !== urlBefore;
        const firstNow = document.querySelector('[data-testid="tender-name"] a, a[href*="/tender/"]')?.getAttribute('href') || null;
        const firstChanged = firstNow && firstNow !== firstTenderBefore;
        return urlChanged || firstChanged;
      },
      { timeout: 20000 },
      { urlBefore, firstTenderBefore }
    );
  } catch (e) {
    console.log('  WARN: Neither URL nor first tender changed within 20s');
    return false;
  }

  await page.waitForFunction(() => {
    return document.querySelectorAll('[data-testid="tender-name"]').length > 0;
  }, { timeout: 15000 }).catch(() => {});

  await new Promise(r => setTimeout(r, 2000));

  const urlAfter = page.url();
  console.log(`  ✓ Moved to page (URL change: ${urlBefore !== urlAfter})`);
  return true;
}

// --- PORTAL LOGIN HELPER -----------------------------------------------
//
// Generic best-effort login for portals that proxy the Mercell "Go to
// source" link (UK MyTenders, Cloudia/tarjouspalvelu.fi, e-avrop, DEUTSCHE
// EVERGABE, Vergabeportal AT, contrataciondelestado.es, etc.). Looks up
// creds via getPortalCreds() — host stripping + suffix matching are done
// there. Opens a fresh page, follows whatever redirect the portal does
// for an unauthenticated visitor, fills the most common form patterns,
// submits, and verifies the password field is gone afterwards. Cookies
// are stored on the default browserContext, so a subsequent
// fetchSourcePageDetails() call from a fresh page will run authenticated.
//
// Returns true on apparent success, false on any failure (no creds, form
// not found, submission did not clear password field, exception). Logs
// 🔑 / 🔐 / ✅ / ❌ markers for grep-ability in CI logs.
// =====================================================================
async function attemptPortalLogin(browser, sourceUrl, creds, hostLabel) {
  if (!creds || !creds.password) return false;
  const page = await browser.newPage();
  try {
    page.setDefaultNavigationTimeout(30000);
    try {
      await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e) {
      console.log(`    ❌ login goto failed for ${hostLabel}: ${(e.message || '').slice(0, 120)}`);
    }
    // Allow client-side redirects / SPA login forms to settle.
    await new Promise((r) => setTimeout(r, 1500));

    const sels = await page.evaluate(() => {
      const findVisible = (selectors) => {
        for (const sel of selectors) {
          try {
            const el = document.querySelector(sel);
            if (el && el.offsetParent !== null) return sel;
          } catch (_) { /* invalid selector — skip */ }
        }
        return null;
      };
      const userSel = findVisible([
        'input[type="email"]:not([disabled]):not([aria-hidden="true"])',
        'input[name="email"]:not([disabled])',
        'input[id*="email" i]:not([disabled])',
        'input[name="username"]:not([disabled])',
        'input[id*="user" i]:not([disabled])',
        'input[name*="user" i]:not([disabled])',
        'input[name="login"]:not([disabled])',
        'input[name*="login" i]:not([disabled])',
        'input[type="text"]:not([disabled]):not([aria-hidden="true"])',
      ]);
      const passSel = findVisible([
        'input[type="password"]:not([disabled]):not([aria-hidden="true"])',
      ]);
      return { userSel, passSel, currentHost: location.host, currentUrl: location.href };
    }).catch(() => ({ userSel: null, passSel: null, currentHost: hostLabel, currentUrl: '' }));

    if (!sels.passSel) {
      console.log(`    ❌ no password field on ${hostLabel} (post-redirect: ${sels.currentHost})`);
      return false;
    }
    if (sels.currentHost && sels.currentHost !== hostLabel) {
      console.log(`    ↪️  login form is on ${sels.currentHost} (redirected from ${hostLabel})`);
    }

    if (sels.userSel && creds.username) {
      try { await page.click(sels.userSel, { clickCount: 3 }); } catch (_) {}
      try { await page.type(sels.userSel, String(creds.username), { delay: 25 }); }
      catch (e) { console.log(`    ⚠️ username type failed: ${(e.message || '').slice(0, 80)}`); }
    }
    try { await page.click(sels.passSel, { clickCount: 3 }); } catch (_) {}
    try { await page.type(sels.passSel, String(creds.password), { delay: 25 }); }
    catch (e) {
      console.log(`    ❌ password type failed on ${hostLabel}: ${(e.message || '').slice(0, 120)}`);
      return false;
    }

    const submitSel = await page.evaluate(() => {
      const candidates = [
        'button[type="submit"]:not([disabled])',
        'input[type="submit"]:not([disabled])',
        'button[name*="login" i]:not([disabled])',
        'button[id*="login" i]:not([disabled])',
        'button[class*="login" i]:not([disabled])',
        'button[name*="signin" i]:not([disabled])',
        'button[id*="signin" i]:not([disabled])',
        'button[id*="submit" i]:not([disabled])',
      ];
      for (const sel of candidates) {
        try {
          const el = document.querySelector(sel);
          if (el && el.offsetParent !== null) { el.click(); return sel; }
        } catch (_) {}
      }
      return null;
    }).catch(() => null);
    if (!submitSel) {
      try { await page.keyboard.press('Enter'); } catch (_) {}
    }

    // Wait for either navigation or a settled network. Don't throw if
    // neither happens — some SPAs just swap the DOM client-side.
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 })
      .catch(() => null);
    await new Promise((r) => setTimeout(r, 2000));

    const stillLogin = await page.evaluate(() => {
      try {
        const el = document.querySelector(
          'input[type="password"]:not([disabled]):not([aria-hidden="true"])'
        );
        return !!(el && el.offsetParent !== null);
      } catch (_) { return false; }
    }).catch(() => false);
    if (stillLogin) {
      console.log(`    ❌ login submission did not clear password field on ${hostLabel}`);
      return false;
    }
    console.log(`    ✅ login OK on ${hostLabel} (submit=${submitSel || 'Enter'})`);
    return true;
  } catch (e) {
    console.log(`    ❌ login error on ${hostLabel}: ${(e.message || String(e)).slice(0, 200)}`);
    return false;
  } finally {
    try { await page.close(); } catch (_) {}
  }
}

// --- ŠALTINIO PUSLAPIO NUSKAITYMAS -------------------------------------
//
// Atidaro naują tabą, nueina į šaltinio URL, nuskaito kelis laukus pagal
// daugiakalbius raktažodžius (EN/SV/NO/DA/FI/DE/FR/NL/ES/PT/IT) ir grąžina
// objektą. Netrikdo pagrindinio `page` konteksto.
// =====================================================================

async function fetchSourcePageDetails(browser, sourceUrl) {
  // Mercell-internų permalink'ų atpažinimas — jei "Go to source" veda į
  // patį Mercell (permalink.mercell.com ar mercell.com/*), šaltinio
  // skrapinti nėra prasmės, nes tai yra tiesiog redirect'as į patį
  // Mercell tender'io puslapį arba į portal'o landing page'ą, iš kurio
  // realaus tender'io turinio pasiekti neįmanoma be papildomo login'o.
  try {
    const u = new URL(sourceUrl);
    if (/(^|\.)mercell\.com$/i.test(u.hostname)) {
      console.log(`    skipping Mercell-internal source: ${u.host}`);
      return {
        skipped: 'mercell-internal',
        sourceHost: u.host,
      };
    }
  } catch (_) { /* invalid URL → tęsiame, fetchas pats pašalins klaidą */ }

  let srcPage = null;
  try {
    srcPage = await browser.newPage();
    await srcPage.setDefaultNavigationTimeout(SOURCE_NAV_TIMEOUT);
    await srcPage.setDefaultTimeout(SOURCE_NAV_TIMEOUT);

    // Block heavy resources
    await srcPage.setRequestInterception(true);
    const blockHandler = (req) => {
      const type = req.resourceType();
      if (['image', 'media', 'font', 'stylesheet'].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    };
    srcPage.on('request', blockHandler);

    try {
      await srcPage.goto(sourceUrl, {
        waitUntil: 'domcontentloaded',
        timeout: SOURCE_NAV_TIMEOUT,
      });
    } catch (e) {
      console.log(`    source nav warn: ${e.message}`);
    }

    // Po navigacijos patikriname galutinį host'ą — kai kurie "Go to source"
    // permalink'ai atliekami per redirect'us ir galutinė lokacija vis tiek
    // nukreipia į Mercell. Tokiu atveju neturi prasmės laužti duomenų.
    try {
      const finalUrl = new URL(srcPage.url());
      if (/(^|\.)mercell\.com$/i.test(finalUrl.hostname)) {
        console.log(`    source redirected to Mercell (${finalUrl.host}) — skipping`);
        srcPage.off('request', blockHandler);
        try { await srcPage.setRequestInterception(false); } catch (_) {}
        return {
          skipped: 'mercell-redirect',
          sourceHost: finalUrl.host,
        };
      }
      // Dead-site early bail — when the source DNS-fails or the server
      // never responds, Chrome lands on its built-in error page whose
      // host is "chromewebdata". Without this guard we'd burn the full
      // 12s waitForFunction + cookie-banner sleep + per-tender file
      // prefetch loop on the error page. Real-world cost (run on
      // 2026-05-04): 134s wasted on a single dead host.
      const isDeadChromePage = finalUrl.hostname === 'chromewebdata' ||
        finalUrl.hostname === '' ||
        srcPage.url().startsWith('chrome-error://');
      if (isDeadChromePage) {
        const bodyPreview = await srcPage.evaluate(
          () => (document.body?.innerText || '').slice(0, 200)
        ).catch(() => '');
        console.log(`    source dead — Chrome error page (host: ${finalUrl.hostname || 'empty'}, preview: "${bodyPreview.replace(/\s+/g, ' ').slice(0, 120)}") — skipping`);
        srcPage.off('request', blockHandler);
        try { await srcPage.setRequestInterception(false); } catch (_) {}
        return {
          skipped: 'dead-site',
          sourceHost: finalUrl.hostname || 'chromewebdata',
          error: 'Chrome error page (DNS / connection / timeout)',
        };
      }
    } catch (_) {}

    // Trumpam palaukti kol renderis stabilizuosis — SPA'oms (pvz., Finnish
    // hankintailmoitukset.fi) reikia daugiau laiko nei paprastam HTML'ui.
    await srcPage.waitForFunction(() => {
      const t = (document.body?.innerText || '').trim();
      return t.length > 800;
    }, { timeout: 12000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 1200));

    // Bandome uždaryti cookie banner'us, kurie dažnai uždengia turinį
    await srcPage.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"]'));
      const acc = btns.find(b => /accept|godkänn|godkend|aksepter|hyväksy|akzeptier|accepter|aanvaard|aceptar|accetta/i
        .test((b.textContent || b.value || '').trim()));
      acc?.click?.();
    }).catch(() => {});
    await new Promise(r => setTimeout(r, 200));

    // --- simap.ch INTERESSE-BEKUNDEN HANDLER --------------------------
    //
    // simap.ch (Swiss federal procurement) hides the documents list behind
    // an "Interesse bekunden" / "Manifester l'intérêt" / "Manifestare
    // l'interesse" button — until the visitor explicitly expresses interest,
    // the tender attachments are not shown. We try to click that button so
    // the document list materialises on the next render. We deliberately
    // avoid the inverse "Interesse zurückziehen" / "Retirer l'intérêt"
    // button (which would withdraw an already-registered interest).
    //
    // Some flows pop a confirmation dialog ("Bestätigen" / "Confirmer" /
    // "Conferma") — we click that too if it appears. The whole step is
    // best-effort; any failure leaves the page state unchanged so the
    // standard extractor can still pull whatever public text is there.
    let simapInterestClicked = false;
    try {
      const finalHostNow = (() => {
        try { return new URL(srcPage.url()).hostname.toLowerCase(); }
        catch (_) { return ''; }
      })();
      if (/(^|\.)simap\.ch$/i.test(finalHostNow)) {
        const clickRes = await srcPage.evaluate(() => {
          const POSITIVE = /interesse\s*bekunden|manifester\s*(?:l'|l\s*’\s*)?intér[eè]t|manifestare\s*(?:l'|l\s*’\s*)?interesse|express\s*interest|register\s*interest/i;
          const NEGATIVE = /interesse\s*zur[üu]ckziehen|retirer\s*(?:l'|l\s*’\s*)?intér[eè]t|ritirare\s*(?:l'|l\s*’\s*)?interesse|withdraw\s*interest/i;
          const all = Array.from(document.querySelectorAll(
            'button, a, input[type="button"], input[type="submit"], [role="button"]'
          ));
          // Prefer enabled, visible candidates that match POSITIVE and not NEGATIVE.
          const candidates = all.filter(el => {
            const t = (el.textContent || el.value || '').trim();
            if (!t) return false;
            if (NEGATIVE.test(t)) return false;
            if (!POSITIVE.test(t)) return false;
            if (el.disabled) return false;
            const rect = el.getBoundingClientRect?.();
            if (rect && (rect.width === 0 || rect.height === 0)) return false;
            return true;
          });
          if (!candidates.length) return { clicked: false, reason: 'no-button' };
          const btn = candidates[0];
          btn.scrollIntoView?.({ block: 'center' });
          btn.click?.();
          return { clicked: true, label: (btn.textContent || btn.value || '').trim().slice(0, 80) };
        }).catch((e) => ({ clicked: false, reason: 'eval-error: ' + e.message }));

        if (clickRes && clickRes.clicked) {
          simapInterestClicked = true;
          console.log(`    simap: clicked "${clickRes.label}" — waiting for documents to render`);
          // Wait a bit, then attempt confirmation-dialog click if simap pops one.
          await new Promise(r => setTimeout(r, 1500));
          await srcPage.evaluate(() => {
            const CONFIRM = /^(?:bestätigen|best[äa]tigen|ja|confirmer|confirmer\s+l['’\s]intér[eè]t|conferma|confermare|confirm|ok)$/i;
            const NEG = /interesse\s*zur[üu]ckziehen|retirer|ritirare|abbrechen|annuler|cancella|cancel/i;
            const all = Array.from(document.querySelectorAll(
              'button, a, input[type="button"], input[type="submit"], [role="button"]'
            ));
            const btn = all.find(el => {
              const t = (el.textContent || el.value || '').trim();
              if (!t) return false;
              if (NEG.test(t)) return false;
              if (!CONFIRM.test(t)) return false;
              if (el.disabled) return false;
              const rect = el.getBoundingClientRect?.();
              if (rect && (rect.width === 0 || rect.height === 0)) return false;
              return true;
            });
            btn?.click?.();
          }).catch(() => {});
          // Give simap.ch a moment to re-render the documents list.
          await new Promise(r => setTimeout(r, 2500));
          // Wait for any download-looking link to appear (best-effort).
          await srcPage.waitForFunction(() => {
            const links = Array.from(document.querySelectorAll('a[href]'));
            return links.some(a => /\.(pdf|docx?|xlsx?|zip|rtf|odt|ods)(?:[?#]|$)/i.test(a.getAttribute('href') || ''));
          }, { timeout: 8000 }).catch(() => {});
        } else {
          console.log(`    simap: no "Interesse bekunden" button found (${clickRes?.reason || 'unknown'})`);
        }
      }
    } catch (e) {
      console.log(`    simap interest-button handler error: ${e.message}`);
    }

    const result = await srcPage.evaluate((simapInterestClicked) => {
      const bodyText = (document.body?.innerText || '').trim();

      // --- LOGIN-WALL DETEKTORIUS -----------------------------------
      //
      // Daugelis UK / DE / DK procurement portal'ų (MyTenders, Jaggaer,
      // Bravo, BravoSolution, DTVP, etc.) rodo tik login formą
      // neautentifikuotiems lankytojams. Atpažįstam tokius puslapius
      // kad nereikalautume bereikalingai regex'ų ir nenuperrašytume
      // Mercell laukų tuščiais duomenimis.
      //
      // Heuristika: skaičiuojam kiek "login-ženklų" yra body tekste.
      // Jei ≥2 ir yra aktyvi password forma ARBA tekstas < 2500 simb.,
      // laikom login-walled.
      const loginMarkers = [
        /\bplease\s*(?:log|sign)\s*in\b/i,
        /\blog\s*in\s*(?:to\s*(?:continue|access|the))/i,
        /\bsign\s*in\s*(?:to\s*(?:continue|access|the))/i,
        /\benter\s*your\s*(?:email|username|password|login)/i,
        /\bforgot\s*(?:your\s*)?password/i,
        /\bnot\s*registered\s*yet/i,
        /\bregister\s*(?:here|now|an\s*account)/i,
        /\bcreate\s*(?:an\s*)?account/i,
        /\bthis\s*secure\s*(?:website|portal|site)/i,
        /\bwelcome\s*to\s*the\s*[^\n]{1,50}\s*(?:eprocurement|e-procurement|esourcing|e-sourcing|supplier|tender)\s*portal/i,
        // LT/LV/EE/PL/DE/FR/ES/IT/NL equivalents
        /\bprisijunkite\b/i,           // LT
        /\blogg\s*inn\b/i,             // NO
        /\blogga\s*in\b/i,             // SV
        /\blog\s*ind\b/i,              // DA
        /\bkirjaudu\s*sisään\b/i,      // FI
        /\banmelden\s*(?:sie)?\b/i,    // DE
        /\bpassword\s*vergessen\b/i,   // DE
        /\bse\s*connecter\b/i,         // FR
        /\bmot\s*de\s*passe\s*oublié/i,// FR
        /\binloggen\b/i,               // NL
        /\binicia(?:r)?\s*sesión\b/i,  // ES
        /\bcontraseña\s*olvidada\b/i,  // ES
        /\baccedi\s*(?:al|all)\b/i,    // IT
      ];
      const matchedMarkers = loginMarkers.filter((re) => re.test(bodyText)).length;
      const hasPasswordField = !!document.querySelector(
        'input[type="password"]:not([disabled]):not([aria-hidden="true"])'
      );
      const shortBody = bodyText.length < 2500;
      // A visible password field + at least one login-related word in the
      // page text is a strong enough signal on its own. Cloudia / Mercell
      // wholesale-portal patterns (tarjouspalvelu.fi, vergabeportal, etc.)
      // commonly inline a tender-description teaser ABOVE the login form,
      // which used to push the page over the previous 4000-char cap and
      // cause the gated detection to silently miss. Body-length only
      // matters now when there is NO password field at all (rare).
      const loginGated =
        (matchedMarkers >= 2 && (hasPasswordField || shortBody)) ||
        (hasPasswordField && matchedMarkers >= 1);

      if (loginGated) {
        return {
          loginGated: true,
          sourceHost: location.host,
          matchedMarkers,
          hasPasswordField,
          bodyLength: bodyText.length,
          bodyTextPreview: bodyText.slice(0, 300),
        };
      }

      // --- helper: rasti reikšmę pagal etiketę ---
      // ieškom po headerio / kito elemento su etikete — paimam kaimyno /
      // <dd>/<td>/po-brolio tekstą.
      const sectionText = (labels) => {
        const all = Array.from(document.querySelectorAll(
          'h1, h2, h3, h4, h5, h6, dt, th, strong, b, label, div, span, p, li'
        ));
        for (const labRaw of labels) {
          const re = new RegExp('^\\s*' + labRaw + '\\s*:?\\s*$', 'i');
          const el = all.find(e => {
            const t = (e.textContent || '').trim();
            return re.test(t) && t.length < 120;
          });
          if (!el) continue;
          let val =
            el.nextElementSibling?.innerText ||
            (el.parentElement && el.parentElement.nextElementSibling?.innerText) ||
            (el.tagName === 'DT' && el.nextElementSibling?.tagName === 'DD' ? el.nextElementSibling.innerText : null) ||
            (el.tagName === 'TH' && el.parentElement?.querySelector('td')?.innerText) ||
            (el.parentElement?.querySelector('dd, td, p, span, div')?.innerText);
          if (val && val.trim() && val.trim() !== el.textContent.trim()) {
            return val.trim().replace(/\s+\n/g, '\n').slice(0, 4000);
          }
        }
        return null;
      };

      // --- helper: rasti tekstą kuris eina po header'io H2/H3 iki kito header'io ---
      const sectionBlock = (labels) => {
        const heads = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, strong, b'));
        for (const labRaw of labels) {
          const re = new RegExp('^\\s*' + labRaw + '\\s*:?\\s*$', 'i');
          const h = heads.find(e => re.test((e.textContent || '').trim()));
          if (!h) continue;
          let out = '';
          let cur = h.nextElementSibling;
          let steps = 0;
          while (cur && steps < 12) {
            if (/^H[1-5]$/.test(cur.tagName)) break;
            const t = (cur.innerText || '').trim();
            if (t) out += (out ? '\n' : '') + t;
            if (out.length > 3000) break;
            cur = cur.nextElementSibling;
            steps++;
          }
          if (out) return out.slice(0, 4000);
        }
        return null;
      };

      // MAX BUDGET
      //
      // Griežtesnis matching'as:
      // - MINIMALIAI 4 skaitmenys grupėje (1000+), kad išvengtume klaidingų
      //   "10" ar "100" paėmimų iš ad-hoc konteksto (puslapių numeriai,
      //   buyer ID, version'ai ir t.t.).
      // - PRIVALOMA valiutos etiketė (€, EUR, kr, NOK, SEK, DKK, £, $, USD, GBP)
      //   arba prieš skaitmenis, arba po jų.
      // - Po etiketės leidžiami atskyrikliai: tarpas, dvitaškis, tab, naujalinija.
      //
      // Grupinamoji sintaksė (valiuta + skaičius) × 2 variantai, kad pagautume
      // "EUR 1 234 567,89" ir "1 234 567,89 EUR".
      //
      // Pastaba: `\b\d{1,3}(?:[\s.,]\d{3}){1,}\b` reikalauja bent vieno
      // tūkstančių atskyriklio (t.y. ≥1000). Taip pat leidžiame paprastą
      // ≥4 skaitmenų blokeliu be atskyriklių (pvz., "10000").
      const numPat = '(?:\\d{1,3}(?:[\\s.,]\\d{3}){1,}(?:[.,]\\d+)?|\\d{4,}(?:[.,]\\d+)?)';
      const curPre = '(?:€|EUR|kr|NOK|SEK|DKK|£|\\$|USD|GBP)';
      const curPost = '(?:\\s*(?:€|EUR|kr|NOK|SEK|DKK|£|USD|GBP))';
      const budgetLabels = [
        // EN
        'estimated\\s*(?:total\\s*)?value', 'contract\\s*value', 'total\\s*value',
        'max(?:imum)?\\s*(?:budget|value)', 'value\\s*excluding\\s*vat',
        'value\\s*excl\\.?\\s*vat', 'budget',
        // SV/NO/DA
        'uppskattat\\s*värde', 'kontraktsvärde', 'totalt?\\s*värde',
        'maxbudget', 'avtalsvärde', 'estimert\\s*verdi', 'kontraktsverdi',
        'estimeret\\s*værdi', 'kontraktværdi',
        // FI
        'arvioitu\\s*(?:kokonais)?arvo', 'hankinnan\\s*(?:ennakoitu\\s*)?arvo',
        'sopimuksen\\s*arvo', 'kokonaisarvo', 'ennakoitu\\s*arvo',
        // DE
        'geschätzter\\s*(?:gesamt)?wert', 'auftragswert', 'vertragswert',
        'maximalbudget', 'gesamtwert',
        // FR
        'valeur\\s*(?:totale\\s*)?estimée', 'montant\\s*estimé',
        'valeur\\s*du\\s*marché', 'budget\\s*maximum',
        // NL
        'geschatte\\s*waarde', 'contractwaarde', 'totale\\s*waarde',
        'maximale\\s*begroting',
        // ES/PT
        'valor\\s*(?:total\\s*)?estimado', 'importe\\s*estimado',
        'valor\\s*do\\s*contrato', 'presupuesto\\s*máximo', 'orçamento\\s*máximo',
        // IT
        'valore\\s*(?:totale\\s*)?stimato', 'importo\\s*stimato',
        'valore\\s*del\\s*contratto', 'budget\\s*massimo',
      ].join('|');

      // Du variantai: (a) valiuta prieš skaičių, (b) skaičius prieš valiutą.
      const budgetRegexes = [
        new RegExp(`(?:${budgetLabels})[^\\n]{0,60}?[:\\s]+((?:${curPre})\\s*${numPat}${curPost}?)`, 'i'),
        new RegExp(`(?:${budgetLabels})[^\\n]{0,60}?[:\\s]+(${numPat}\\s*${curPre})`, 'i'),
      ];

      let maxBudget = null;
      for (const re of budgetRegexes) {
        const m = bodyText.match(re);
        if (!m) continue;
        const raw = m[1].trim().replace(/\s+/g, ' ');
        // Sanity check: turi būti ≥4 skaitmenys IŠ VISO reikšmėje
        const digitCount = (raw.match(/\d/g) || []).length;
        if (digitCount < 4) continue;
        maxBudget = raw;
        break;
      }

      // DURATION
      let duration = null;
      const durationRegexes = [
        /(\d+)\s*(months?|mån(?:ader)?|måneder|kuukautta|Monate|mois|maanden|meses|mesi)\b/i,
        /(\d+)\s*(years?|år|vuotta|Jahre|ans|jaar|años|anos|anni)\b/i,
        /(?:duration|contract\s*period|contract\s*length|avtalsperiod|avtalstid|kontraktsperiode|varighet|varighed|sopimuskausi|sopimuksen\s*kesto|kesto|vertragslaufzeit|laufzeit|durée\s*du\s*(?:contrat|marché)|looptijd|contractduur|duración\s*del\s*contrato|duração\s*do\s*contrato|durata\s*del\s*contratto)[^\n]{0,40}?[:\s]+([^\n.]{1,80})/i,
      ];
      for (const re of durationRegexes) {
        const m = bodyText.match(re);
        if (m) {
          duration = (m[1] + (m[2] ? ' ' + m[2] : '')).trim();
          break;
        }
      }

      // REQUIREMENTS FOR SUPPLIER
      const requirementsForSupplier =
        sectionBlock([
          'requirements for supplier', 'supplier requirements',
          'krav på leverantör', 'krav til leverandør', 'krav til leverandøren',
          'tarjoajan vaatimukset', 'anforderungen an (?:den )?(?:lieferant|bieter)',
          'exigences pour le (?:fournisseur|soumissionnaire)',
          'vereisten aan de (?:leverancier|inschrijver)',
          'requisitos para el (?:proveedor|licitador)',
          'requisitos para o (?:fornecedor|concorrente)',
          'requisiti per il fornitore',
        ]) ||
        sectionText([
          'requirements', 'vaatimukset', 'anforderungen', 'exigences',
          'vereisten', 'requisitos', 'requisiti',
        ]);

      // QUALIFICATION REQUIREMENTS
      const qualificationRequirements =
        sectionBlock([
          'qualification requirements', 'qualifications', 'eligibility',
          'selection criteria', 'suitability criteria',
          'soveltuvuusvaatimukset', 'soveltuvuus', 'kvalifikationskrav',
          'kvalifikasjonskrav', 'eignungskriterien', 'teilnahmebedingungen',
          'critères de qualification', 'critères de sélection',
          'kwalificatiecriteria', 'geschiktheidseisen',
          'criterios de calificación', 'criterios de selección',
          'critérios de qualificação', 'critérios de seleção',
          'criteri di qualificazione', 'criteri di selezione',
        ]) ||
        sectionText([
          'qualifications', 'eligibility', 'soveltuvuus',
        ]);

      // OFFER WEIGHING CRITERIA / AWARD CRITERIA
      const offerWeighingCriteria =
        sectionBlock([
          'award criteria', 'evaluation criteria', 'weighing criteria',
          'criteria for award', 'contract award criteria',
          'tilldelningskriterier', 'utvärderingskriterier',
          'tildelingskriterier', 'evalueringskriterier',
          'valintaperusteet', 'vertailuperusteet',
          'zuschlagskriterien', 'bewertungskriterien',
          'critères d.attribution', 'critères d.évaluation',
          'gunningscriteria', 'beoordelingscriteria',
          'criterios de adjudicación', 'criterios de evaluación',
          'critérios de adjudicação', 'critérios de avaliação',
          'criteri di aggiudicazione', 'criteri di valutazione',
        ]) ||
        sectionText(['award criteria', 'evaluation criteria']);

      // SCOPE OF AGREEMENT
      const scopeOfAgreement =
        sectionBlock([
          'scope of agreement', 'scope of contract', 'scope of the contract',
          'scope', 'object of the contract', 'subject matter',
          'description of the procurement', 'short description',
          'omfattning', 'avtalets omfattning', 'beskrivning',
          'omfang', 'avtalets omfang', 'beskrivelse', 'kort beskrivelse',
          'hankinnan kohde', 'hankinnan kuvaus', 'kuvaus', 'laajuus',
          'umfang', 'auftragsgegenstand', 'beschreibung',
          'objet du (?:marché|contrat)', 'description', 'étendue',
          'voorwerp van de opdracht', 'beschrijving', 'omvang',
          'objeto del contrato', 'descripción', 'alcance',
          'objeto do contrato', 'descrição', 'âmbito',
          'oggetto del contratto', 'descrizione', 'portata',
        ]) ||
        sectionText(['scope', 'description', 'kuvaus', 'beskrivelse', 'beskrivning']);

      // TECHNICAL STACK / TECHNICAL REQUIREMENTS
      const technicalStack =
        sectionBlock([
          'technical stack', 'technology stack', 'tech stack',
          'technical requirements', 'technical specifications',
          'tekniset vaatimukset', 'tekniset spesifikaatiot',
          'tekniska krav', 'teknisk specifikation',
          'tekniske krav', 'teknisk spesifikasjon',
          'technische anforderungen', 'technische spezifikationen',
          'spécifications techniques', 'exigences techniques',
          'technische vereisten', 'technische specificaties',
          'requisitos técnicos', 'especificaciones técnicas',
          'especificações técnicas',
          'requisiti tecnici', 'specifiche tecniche',
        ]) ||
        sectionText([
          'technical stack', 'technology', 'technical',
          'tekninen', 'teknisk', 'technisch', 'technique', 'técnico', 'tecnico',
        ]);

      // Publication / reference / deadline — jei Mercell neturi
      const refMatch = bodyText.match(
        /(?:reference(?:\s+number|\s+no\.?)?|ref\.?\s*no\.?|ärende(?:nummer)?|viitenumero|saknummer|sagsnr|aktenzeichen|numéro\s*de\s*référence|kenmerk|número\s*de\s*referencia|numero\s*di\s*riferimento)[:\s]+([A-Z0-9\-\/_.]+)/i
      );

      // --- SOURCE-PAGE FILE-LINK INVENTORY ---------------------------
      //
      // Some portals (notably simap.ch after "Interesse bekunden" was
      // clicked) render document download links as plain <a href>'s
      // pointing at PDFs / DOCX / ZIPs / etc. We harvest those here so
      // the outer fetch loop can pull and parse them just like the
      // Mercell-internal collectedFiles.
      //
      // Heuristic: anchor href whose URL path or query ends in a known
      // document extension. Resolve relative URLs against the current
      // page. Deduplicate by absolute URL.
      const sourceFiles = (() => {
        const DOC_RE = /\.(pdf|docx?|xlsx?|zip|rtf|odt|ods|txt)(?:[?#]|$)/i;
        const seen = new Set();
        const out = [];
        const anchors = Array.from(document.querySelectorAll('a[href]'));
        for (const a of anchors) {
          const hrefRaw = a.getAttribute('href') || '';
          if (!hrefRaw || /^javascript:/i.test(hrefRaw)) continue;
          let abs = hrefRaw;
          try { abs = new URL(hrefRaw, location.href).toString(); } catch (_) { continue; }
          // simap.ch sometimes routes downloads through a "downloadFile"
          // handler that doesn't carry a doc extension in the URL but
          // does carry one in the link text. Catch those too.
          const linkText = (a.textContent || '').trim();
          const extFromUrl  = (abs.match(DOC_RE) || [])[1];
          const extFromName = (linkText.match(DOC_RE) || [])[1];
          const looksLikeDownload = /download|herunterladen|télécharger|scarica|attach|anhang|dokument|document|datei|fichier|allegato/i.test(linkText) ||
            /download|datei|file|attach|allegat/i.test(abs);
          const ext = (extFromUrl || extFromName || '').toLowerCase();
          if (!ext && !looksLikeDownload) continue;
          if (!ext) continue; // skip if we can't even guess an extension
          if (seen.has(abs)) continue;
          seen.add(abs);
          out.push({
            url: abs,
            name: linkText || abs.split('/').pop() || `source-file.${ext}`,
            ext,
          });
          if (out.length >= 20) break;
        }
        return out;
      })();

      // --- PLACSP (contrataciondelestado.es) PRIORITY HUNT -----------
      //
      // Spanish public procurement portal (Plataforma de Contratación
      // del Sector Público) lists contract documents as anchors inside
      // the "Documento de Pliegos" / "Anuncio de Licitación" section.
      // Those anchor URLs route through a docAccCmpnt servlet and DO
      // NOT carry a .pdf extension, so the generic extension-based
      // harvester above misses them entirely. The Pliego de Cláusulas
      // Administrativas Particulares (PCAP) is what holds qualification
      // requirements (cl. 11, 14, 15.3.1, 15.3.2 + Cuadro de
      // Características apartado 15) and the award criteria (apartado
      // 21) — i.e. exactly the columns we need to populate in the
      // sheet. We text-match the anchor labels and force ext='pdf' so
      // the prefetch loop downloads + parses them; the magic-byte
      // check downstream still verifies the bytes really are a PDF.
      // PCAP comes first in priority order so per-file/total caps
      // never starve it of context for the AI extractor.
      const placspResult = (() => {
        const isPlacsp = /(^|\.)contrataciondelestado\.es$/i.test(location.host);
        if (!isPlacsp) {
          return { files: [], stats: null };
        }
        // PASS A — anchor text patterns (Spanish labels). Order = priority.
        const PRIORITY_RE = [
          /pliego\b[^<\n]{0,30}cl[aá]usulas\s+administrativas/i,    // PCAP
          /pliego\b[^<\n]{0,30}prescripciones\s+t[eé]cnicas/i,      // PPT
          /anuncio\s+de\s+licitaci[oó]n/i,
          /documento\s+de\s+pliegos/i,
          /pliego\s+administrativo/i,
          /cl[aá]usulas\s+administrativas/i,                        // bare PCAP (no "Pliego" prefix)
          /prescripciones\s+t[eé]cnicas/i,                          // bare PPT
        ];
        // PASS B — URL pattern fallback. PLACSP streams every document
        // download through the same docAccCmpnt servlet (or its
        // GetDocumentsById variant). Any anchor whose href hits that
        // endpoint is, by construction, a Pliego/Anuncio/Documento PDF
        // — even if the visible anchor text is an icon or empty.
        const URL_RE = [
          /docAccCmpnt/i,
          /GetDocumentsById/i,
          /uri=deeplink:detalle_(?:pliego|anuncio)/i,
        ];

        const seenPriority = new Set();
        const out2 = [];
        const allAnchors = Array.from(document.querySelectorAll('a[href]'));
        const totalAnchors = allAnchors.length;
        let textMatches = 0;
        let urlMatches = 0;
        const sampleTexts = [];

        // PASS A
        for (let i = 0; i < PRIORITY_RE.length; i++) {
          const re = PRIORITY_RE[i];
          for (const a of allAnchors) {
            const text = (a.textContent || a.getAttribute('title') || '').trim();
            if (!text || !re.test(text)) continue;
            const hrefRaw = a.getAttribute('href') || '';
            if (!hrefRaw || /^javascript:/i.test(hrefRaw) || hrefRaw === '#') continue;
            let abs;
            try { abs = new URL(hrefRaw, location.href).toString(); }
            catch (_) { continue; }
            if (seenPriority.has(abs)) continue;
            seenPriority.add(abs);
            out2.push({
              url: abs,
              name: text.slice(0, 120),
              ext: 'pdf',
              priority: true,
              priorityRank: i,
              matchType: 'text',
            });
            textMatches += 1;
          }
        }

        // PASS B — URL pattern fallback (broader catch).
        for (const a of allAnchors) {
          const hrefRaw = a.getAttribute('href') || '';
          if (!hrefRaw || /^javascript:/i.test(hrefRaw) || hrefRaw === '#') continue;
          let abs;
          try { abs = new URL(hrefRaw, location.href).toString(); }
          catch (_) { continue; }
          if (seenPriority.has(abs)) continue;
          if (!URL_RE.some(re => re.test(abs))) continue;
          const text = (a.textContent || a.getAttribute('title') || '').trim();
          seenPriority.add(abs);
          out2.push({
            url: abs,
            name: (text || `placsp-doc-${out2.length + 1}`).slice(0, 120),
            ext: 'pdf',
            priority: true,
            priorityRank: 50,    // lower than text matches (0–6) but above default
            matchType: 'url',
          });
          urlMatches += 1;
        }

        // Diagnostic sample of first 6 anchor texts so we can see what
        // the page actually looked like when nothing matched.
        for (const a of allAnchors.slice(0, 30)) {
          const t = (a.textContent || '').trim().slice(0, 80);
          if (t) sampleTexts.push(t);
          if (sampleTexts.length >= 6) break;
        }

        return {
          files: out2,
          stats: { totalAnchors, textMatches, urlMatches, sampleTexts },
        };
      })();
      const placspFiles = placspResult.files;

      // Merge PLACSP priority docs at the FRONT of the file list, drop
      // duplicates from the generic harvest. Cap the combined list at
      // 20 entries (same as before) so the prefetch loop terminates.
      const sourceFilesMerged = (() => {
        if (!placspFiles.length) return sourceFiles;
        const priorityUrls = new Set(placspFiles.map(f => f.url));
        const generic = sourceFiles.filter(f => !priorityUrls.has(f.url));
        return [...placspFiles, ...generic].slice(0, 20);
      })();

      return {
        maxBudget,
        duration,
        requirementsForSupplier,
        qualificationRequirements,
        offerWeighingCriteria,
        scopeOfAgreement,
        technicalStack,
        referenceNumberSource: refMatch ? refMatch[1].trim() : null,
        sourceTitle: document.querySelector('h1')?.innerText?.trim() || null,
        sourceHost: location.host,
        bodyTextPreview: bodyText.slice(0, 600),
        sourceFiles: sourceFilesMerged,
        placspDocsFound: placspFiles.length,
        placspStats: placspResult.stats,
        simapInterestClicked: !!simapInterestClicked,
      };
    }, simapInterestClicked);

    // --- PRE-FETCH + PARSE source-page document bytes -------------------
    //
    // sourceFiles point at absolute URLs that often live on the source
    // portal's own domain (simap.ch, etc.) — meaning their authenticated
    // session cookies are bound to *this* tab, not Mercell's. We fetch
    // them now (while srcPage is still open) using the page's own fetch
    // (carries simap.ch cookies + Interesse-bekunden state), then parse
    // each buffer with the same multi-format toolset that the Mercell
    // pipeline uses. The combined text is returned as
    // `result.sourceFilesText` so the outer pipeline can append it to
    // `details.pdfText` without needing to know about the source domain.
    try {
      if (Array.isArray(result?.sourceFiles) && result.sourceFiles.length) {
        const hasPriority = result.sourceFiles.some(f => f && f.priority);
        if (result.placspDocsFound) {
          console.log(`    🇪🇸 PLACSP: ${result.placspDocsFound} priority document(s) detected (PCAP/PPT/Anuncio) — bumping char caps`);
        }
        const MAX_SRC_FILES = 8;
        // PLACSP PCAP files routinely run 40-50 pages (≈100k chars) and
        // hold the qualification + award-criteria sections we need to
        // extract. Bump per-file cap from 30k→60k and total from
        // 80k→140k whenever any priority file is in the queue, so the
        // AI prompt actually sees Apartado 15 / 21 / 31 of the
        // Cuadro de Características (which sit deep in the PCAP body).
        const SRC_DOC_CHAR_CAP_DEFAULT  = 30000;       // per non-priority file
        const SRC_DOC_CHAR_CAP_PRIORITY = 60000;       // per PLACSP priority file
        const SRC_TOTAL_CHAR_CAP        = hasPriority ? 140000 : 80000;
        // Keep legacy name `SRC_DOC_CHAR_CAP` for the inner zip recursion
        // — for zip entries we always use the default cap, since priority
        // PCAP/PPT docs themselves are PDFs, not zips.
        const SRC_DOC_CHAR_CAP = SRC_DOC_CHAR_CAP_DEFAULT;
        // Lazy-load optional deps; missing ones just degrade per-format.
        let pdfParse2 = null, mammoth2 = null, XLSX2 = null, AdmZip2 = null;
        try { pdfParse2 = require('pdf-parse'); } catch (_) {}
        try { mammoth2  = require('mammoth');   } catch (_) {}
        try { XLSX2     = require('xlsx');      } catch (_) {}
        try { AdmZip2   = require('adm-zip');   } catch (_) {}

        const detectFormat2 = (buf) => {
          if (!buf || buf.length < 4) return 'unknown';
          const b0 = buf[0], b1 = buf[1], b2 = buf[2], b3 = buf[3];
          if (b0 === 0x25 && b1 === 0x50 && b2 === 0x44 && b3 === 0x46) return 'pdf';
          if (b0 === 0x50 && b1 === 0x4B && (b2 === 0x03 || b2 === 0x05 || b2 === 0x07)) return 'zip';
          if (b0 === 0xD0 && b1 === 0xCF && b2 === 0x11 && b3 === 0xE0) return 'cfb';
          if (b0 === 0x7B && b1 === 0x5C && b2 === 0x72 && b3 === 0x74) return 'rtf';
          const head = buf.slice(0, 64).toString('utf8').trim().toLowerCase();
          if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml') || head.startsWith('<')) return 'html';
          if (head.startsWith('{') || head.startsWith('[')) return 'json';
          return 'unknown';
        };
        const magicMatchesExt2 = (buf, ext) => {
          const got = detectFormat2(buf);
          const ex = String(ext || '').toLowerCase();
          if (ex === 'pdf') return got === 'pdf';
          if (['docx', 'xlsx', 'odt', 'ods', 'zip'].includes(ex)) return got === 'zip';
          if (ex === 'doc' || ex === 'xls') return got === 'cfb';
          if (ex === 'rtf') return got === 'rtf';
          if (ex === 'txt') return got !== 'html';
          return true;
        };

        const parseBuf = async (name, ext, bytes) => {
          if (!bytes || !bytes.length) return '';
          const ex = String(ext || '').toLowerCase();
          if (!magicMatchesExt2(bytes, ex)) {
            const got = detectFormat2(bytes);
            console.log(`    ⚠️ src ${ex.toUpperCase()} "${name}" magic mismatch (got=${got}, ${bytes.length}B) — skipping`);
            return '';
          }
          try {
            if (ex === 'pdf') {
              if (!pdfParse2) return '';
              const parsed = await pdfParse2(bytes);
              return (parsed && parsed.text ? parsed.text : '').trim();
            }
            if (ex === 'docx' || ex === 'odt') {
              if (!mammoth2) return '';
              const out = await mammoth2.extractRawText({ buffer: bytes });
              return (out && out.value ? out.value : '').trim();
            }
            if (ex === 'xlsx' || ex === 'xls' || ex === 'ods') {
              if (!XLSX2) return '';
              const wb = XLSX2.read(bytes, { type: 'buffer' });
              const parts = [];
              for (const sn of wb.SheetNames) {
                const csv = XLSX2.utils.sheet_to_csv(wb.Sheets[sn]);
                if (csv && csv.trim()) parts.push(`# Sheet: ${sn}\n${csv}`);
              }
              return parts.join('\n\n').trim();
            }
            if (ex === 'rtf' || ex === 'txt') {
              const raw = bytes.toString('utf8');
              if (ex === 'txt') return raw.trim();
              return raw.replace(/\\[a-z]+-?\d*\s?/gi, ' ').replace(/[{}]/g, ' ').replace(/\s+/g, ' ').trim();
            }
            if (ex === 'zip') {
              if (!AdmZip2) return '';
              const zip = new AdmZip2(bytes);
              const entries = zip.getEntries().filter(e => !e.isDirectory).slice(0, 5);
              const parts = [];
              for (const z of entries) {
                const innerBytes = z.getData();
                const innerExt = (z.entryName.match(/\.([a-z0-9]{1,5})$/i) || [])[1] || '';
                const t = await parseBuf(z.entryName, innerExt, innerBytes);
                if (t) parts.push(`--- (zip:${name}) ${z.entryName} ---\n${t.slice(0, SRC_DOC_CHAR_CAP)}`);
              }
              return parts.join('\n\n');
            }
          } catch (e) {
            console.log(`    ⚠️ src ${ex.toUpperCase()} parse failed for "${name}": ${e.message}`);
            return '';
          }
          return '';
        };

        // --- PDF ANNOTATION URI EXTRACTOR ----------------------------
        //
        // PLACSP "Documento de Pliegos" PDFs embed clickable hyperlinks
        // (e.g. anchor "Pliego Cláusulas Administrativas" → real PCAP
        // PDF) as PDF link annotations. pdf-parse only returns rendered
        // text, so the URLs are invisible in `parsed.text`. We scan the
        // raw buffer for `/URI (https://...)` annotation entries — works
        // for uncompressed object streams (which PLACSP-generated PDFs
        // typically have). FlateDecode-compressed PDFs would hide them;
        // those need pdf-lib, but in practice the gov-issued PLACSP
        // bundles ship uncompressed annotations.
        const extractPdfAnnotationUrls = (bytes) => {
          if (!bytes || !bytes.length) return [];
          let raw;
          try { raw = bytes.toString('latin1'); }
          catch (_) { return []; }
          const out = new Set();
          const re = /\/URI\s*\(([^)]{8,500})\)/g;
          let m;
          while ((m = re.exec(raw)) !== null) {
            // PDF strings can be padded with whitespace and may contain
            // escaped chars — strip the obvious ones.
            const url = m[1].replace(/\\([rnt()\\])/g, ' ').trim();
            if (/^https?:\/\//i.test(url)) out.add(url);
          }
          return Array.from(out);
        };
        // Recognise the URL patterns that PLACSP uses for PCAP / Pliego
        // downloads. Anchor text "Pliego Cláusulas Administrativas"
        // typically links to a `docAccCmpnt` servlet URL with a
        // DocumentIdParam query param. We also accept any URL that
        // mentions "Pliego" or "Cláusulas" outright.
        const isPlacspPliegoUrl = (url) => {
          if (!url) return false;
          if (!/contrataciondelestado\.es/i.test(url)) return false;
          return /docAccCmpnt|GetDocumentsById|cl[aá]usulas|pliego/i.test(url);
        };

        // Track URLs we've already fetched so we don't loop on
        // self-referencing PDFs (the "Documento de Pliegos" sometimes
        // includes its own link, etc.).
        const fetchedUrls = new Set();

        // Inner helper: fetch + parse one URL, append text to docTexts,
        // return the buffer so callers can mine annotations.
        const fetchParseOne = async (sf, capOverride) => {
          if (fetchedUrls.has(sf.url)) return { skipped: true };
          fetchedUrls.add(sf.url);
          const fetched = await srcPage.evaluate(async (url) => {
            try {
              const r = await fetch(url, { credentials: 'include' });
              const ct = r.headers.get('content-type') || '';
              if (!r.ok) return { ok: false, status: r.status, contentType: ct };
              const buf = await r.arrayBuffer();
              const arr = Array.from(new Uint8Array(buf));
              return { ok: true, status: r.status, contentType: ct, data: arr, size: arr.length };
            } catch (e) {
              return { ok: false, error: String(e) };
            }
          }, sf.url);
          if (!(fetched && fetched.ok && fetched.size > 100)) {
            const tail = fetched ? `status=${fetched.status || '?'}, ct=${(fetched.contentType || '').slice(0, 40)}` : 'no-response';
            console.log(`    ⚠️ src fetch failed "${sf.name}" (${tail})`);
            return { error: 'fetch-failed' };
          }
          const buf = Buffer.from(fetched.data);
          const text = await parseBuf(sf.name, sf.ext, buf);
          if (text) {
            const perFileCap = capOverride
              || (sf.priority ? SRC_DOC_CHAR_CAP_PRIORITY : SRC_DOC_CHAR_CAP_DEFAULT);
            const clipped = text.slice(0, perFileCap);
            docTexts.push(`--- (source) ${sf.name} ---\n${clipped}`);
            totalChars += clipped.length;
            okCount += 1;
            const tag = sf.priority ? '⭐ PRIORITY' : '📄';
            console.log(`    ${tag} parsed source ${String(sf.ext).toUpperCase()} "${sf.name}" (${buf.length}B → ${clipped.length}ch${sf.priority ? `, cap=${perFileCap}` : ''})`);
          } else {
            console.log(`    ⚠️ src ${String(sf.ext).toUpperCase()} "${sf.name}" had no extractable text`);
          }
          return { buf, hadText: !!text };
        };

        const docTexts = [];
        let okCount = 0;
        let totalChars = 0;

        // PASS 1 — fetch + parse the original sourceFiles (PLACSP
        // priority docs first thanks to the front-of-array merge).
        for (const sf of result.sourceFiles.slice(0, MAX_SRC_FILES)) {
          if (totalChars >= SRC_TOTAL_CHAR_CAP) break;
          try {
            const r1 = await fetchParseOne(sf);
            if (r1.skipped || r1.error || !r1.buf) continue;

            // PASS 2 — when this PDF was a PLACSP priority doc (e.g.
            // "Documento de Pliegos"), mine its link annotations for an
            // embedded PCAP URL and follow it. Cap recursion at 1 hop.
            if (sf.priority && sf.ext === 'pdf' && /(^|\.)contrataciondelestado\.es$/i.test(result.sourceHost || '')) {
              const innerUrls = extractPdfAnnotationUrls(r1.buf);
              const candidates = innerUrls
                .filter(isPlacspPliegoUrl)
                .filter(u => !fetchedUrls.has(u));
              if (innerUrls.length) {
                console.log(`    🔗 PDF "${sf.name}" embedded ${innerUrls.length} URL(s); ${candidates.length} match PCAP/Pliego pattern`);
              }
              // Heuristic: prefer URLs whose surrounding raw bytes
              // mention "Cláusulas Administrativas" (PCAP). We can't do
              // proper context-anchoring without a real PDF parser, so
              // we just pull at most 3 candidates and let pdf-parse
              // tell us which one had real PCAP body via char count.
              for (const url of candidates.slice(0, 3)) {
                if (totalChars >= SRC_TOTAL_CHAR_CAP) break;
                console.log(`    ↳ following embedded link: ${url.slice(0, 100)}`);
                await fetchParseOne({
                  url,
                  name: 'PCAP (embedded link from Documento de Pliegos)',
                  ext: 'pdf',
                  priority: true,
                  fromAnnotation: true,
                });
              }
            }
          } catch (e) {
            console.log(`    ⚠️ src file "${sf.name}" error: ${e.message}`);
          }
        }
        if (docTexts.length) {
          result.sourceFilesText = docTexts.join('\n\n').slice(0, SRC_TOTAL_CHAR_CAP);
        }
        console.log(`    source files prefetched/parsed: ${okCount}/${result.sourceFiles.length} (host: ${result.sourceHost})${fetchedUrls.size > result.sourceFiles.length ? `, +${fetchedUrls.size - result.sourceFiles.length} via embedded annotations` : ''}`);
        // Trim raw bytes from result (we no longer need them to leave the helper)
        result.sourceFiles = result.sourceFiles.map(sf => ({
          name: sf.name, ext: sf.ext, url: sf.url,
        }));
      }
    } catch (e) {
      console.log(`    source-file prefetch error: ${e.message}`);
    }

    srcPage.off('request', blockHandler);
    try { await srcPage.setRequestInterception(false); } catch (_) {}
    return result;
  } catch (e) {
    const msg = e.message || String(e);
    // Some portals (notably www.mytenders.co.uk's NoticeBuilder_FileDownload
    // endpoint, Jaggaer's eu-supply gateway, etc.) trigger a hard redirect
    // to their login form during page.evaluate(), which Puppeteer surfaces
    // as "Execution context was destroyed, most likely because of a
    // navigation". That is functionally a login wall — we never got to
    // read the page body — so treat it as loginGated so the source-loop
    // retries with portal credentials instead of silently giving up.
    const navMidEval =
      /Execution context was destroyed/i.test(msg) ||
      /Target closed/i.test(msg) ||
      /Navigation timeout/i.test(msg) ||
      /detached Frame/i.test(msg);
    if (navMidEval) {
      let host = null;
      try { host = new URL(sourceUrl).hostname.toLowerCase(); } catch (_) {}
      // Try one last URL read from the live page in case it stabilised.
      let finalUrl = '';
      try { finalUrl = (srcPage && srcPage.url && srcPage.url()) || ''; } catch (_) {}
      if (finalUrl) {
        try { host = new URL(finalUrl).hostname.toLowerCase() || host; } catch (_) {}
      }
      console.log(`    source nav-mid-extract → treating as login-gated (host: ${host || 'n/a'})`);
      return {
        loginGated: true,
        sourceHost: host,
        matchedMarkers: 0,
        hasPasswordField: null,
        bodyLength: 0,
        bodyTextPreview: '',
        navError: msg.slice(0, 200),
      };
    }
    return { error: msg };
  } finally {
    if (srcPage) {
      try { await srcPage.close(); } catch (_) {}
    }
  }
}

// --- Mercell detalių puslapio nuskaitymas ------------------------------
//
// PAPILDOMA: Mercell React komponentai nerodo paprasto label→value HTML'o,
// todėl `sectionText`-stiliaus DOM-scraping neveikia budget/duration/scope/
// requirements laukams. Tačiau Mercell atlieka JSON užklausą į:
//   https://search-service-api.discover.app.mercell.com/api/v1/search/tenders/{id}
//   https://sd-match-service.discover.app.mercell.com/api/v1/bopp-matches/{id}
// Perimam šias response'as, parse'inam JSON ir išgaunam struktūruotus laukus.

// Bando paimti reikšmę iš įdėto objekto pagal kelis galimus field name'us.
function pickField(obj, candidates) {
  if (!obj || typeof obj !== 'object') return null;
  for (const cand of candidates) {
    if (obj[cand] !== undefined && obj[cand] !== null) {
      const v = obj[cand];
      if (typeof v === 'string' && v.trim()) return v.trim();
      if (typeof v === 'number') return String(v);
      if (Array.isArray(v) && v.length) {
        return v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('; ');
      }
      if (typeof v === 'object' && v.value !== undefined) return String(v.value);
    }
  }
  // Rekursiškai patikrinam nested'us — bet tik vieną lygį, kad nesugaištumėm
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const cand of candidates) {
        if (v[cand] !== undefined && v[cand] !== null) {
          const val = v[cand];
          if (typeof val === 'string' && val.trim()) return val.trim();
          if (typeof val === 'number') return String(val);
        }
      }
    }
  }
  return null;
}

// Mercell pateikia daug laukų kaip `[{languageCode:"en", text:"..."},...]`.
// Ištraukiam angliškąjį tekstą (arba pirmąjį, jei anglų nėra).
function pickTranslationText(v) {
  if (!v) return null;
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && v.length) {
    const en = v.find((x) => x && (x.languageCode === 'en' || x.lang === 'en' || x.language === 'en'));
    const pick = en || v[0];
    if (pick && typeof pick === 'object') {
      return pick.text || pick.value || pick.content || null;
    }
  }
  if (typeof v === 'object' && v.text) return v.text;
  return null;
}

// Iš Mercell tender JSON'o išsitraukia mūsų domenui reikalingus laukus.
function extractFieldsFromTenderJson(tenderJson) {
  if (!tenderJson || typeof tenderJson !== 'object') return {};

  // Kartais response'as yra { data: {...}, result: {...}, tender: {...} }
  const root =
    tenderJson.tender || tenderJson.data || tenderJson.result || tenderJson;

  // Title: `[{languageCode,text}]` formatas
  const title = pickTranslationText(root.title) || pickField(root, [
    'name', 'subject', 'tenderTitle', 'officialTitle', 'heading',
  ]);
  // Description: `[{languageCode,text}]`, dažnai ilgas
  const description = pickTranslationText(root.description) || pickField(root, [
    'shortDescription', 'longDescription', 'summary',
    'objectDescription', 'scopeDescription', 'contentDescription', 'content',
  ]);
  // Mercell JSON key name'ai (patvirtinti iš live response'ų):
  //   authority    → {name, nameAndCity, country} — perkančioji organizacija
  //   buyer        → {name, organizationNumber, emails, contactPoint, contractingPartners}
  //   tenderLocation[] → [{name, city, code}]
  //   bidDueDate / deadlineDate → submission deadline (ISO timestamp)
  //   moneyRange   → {currency, low, high} biudžetas
  //   contractLength → {awardRange, optionRanges} — agreement duration
  //   evaluationBasis → award criteria description
  //   noticeType   → dokumento tipas
  //   procedure    → procurement procedure
  const authorityObj = root.authority;
  const buyerObj = root.buyer;
  let buyer = null;
  if (authorityObj && typeof authorityObj === 'object') {
    buyer = authorityObj.name || authorityObj.nameAndCity || null;
  }
  if (!buyer && buyerObj && typeof buyerObj === 'object') {
    buyer = buyerObj.name || null;
  }
  if (!buyer) {
    buyer = pickField(root, [
      'buyerName', 'organisation', 'organization', 'contractingAuthority',
      'contractingEntity', 'purchaser', 'awardingAuthority',
      'publishedBy', 'issuer', 'authorityName', 'authorityTitle',
    ]);
  }

  // Country — prioritetas:
  //   1) authority.country  (perkančiosios org. šalis — teisingiausia)
  //   2) tenderLocation[].code prefix (pvz. "FI1C2" → "FI")
  //   3) tenderLocation[].name — DĖMESIO: tai dažnai yra regionas
  //      (pvz. "Pirkanmaa", ne "Finland"). Naudojam tik kaip paskutinę viltį.
  //   4) pickField(root, ...)
  //
  // Jei gaunam 2 raidžių kodą (FI, DE, ES...) — konvertuojam į pilną
  // pavadinimą iš COUNTRY_CODES žodynėlio. Taip pat žiūrim ar gautas
  // string'as nėra regionas (pvz. "Pirkanmaa") — jei taip, grąžinam null
  // ir leidžiam einat toliau.
  const COUNTRY_CODES = {
    NO: 'Norway', DK: 'Denmark', SE: 'Sweden', FI: 'Finland',
    NL: 'Netherlands', AT: 'Austria', BE: 'Belgium', EE: 'Estonia',
    FR: 'France', DE: 'Germany', LI: 'Liechtenstein', LU: 'Luxembourg',
    PT: 'Portugal', ES: 'Spain', CH: 'Switzerland', UK: 'United Kingdom',
    GB: 'United Kingdom', IE: 'Ireland', IT: 'Italy', PL: 'Poland',
    IS: 'Iceland', LT: 'Lithuania', LV: 'Latvia', CZ: 'Czech Republic',
    SK: 'Slovakia', HU: 'Hungary', GR: 'Greece', RO: 'Romania',
    BG: 'Bulgaria', HR: 'Croatia', SI: 'Slovenia', MT: 'Malta',
    CY: 'Cyprus',
  };
  const normalizeCountry = (raw) => {
    if (!raw) return null;
    const s = String(raw).trim();
    if (!s) return null;
    // Kodas (2 raidės) → pavadinimas
    if (/^[A-Z]{2}$/.test(s) && COUNTRY_CODES[s]) return COUNTRY_CODES[s];
    // Kodas su regionu (FI1C2) → išsitraukiam pirmas 2 raides
    const codeMatch = s.match(/^([A-Z]{2})[A-Z0-9]{1,3}$/);
    if (codeMatch && COUNTRY_CODES[codeMatch[1]]) return COUNTRY_CODES[codeMatch[1]];
    // Jei jau pilnas pavadinimas
    const lower = s.toLowerCase();
    for (const name of Object.values(COUNTRY_CODES)) {
      if (lower === name.toLowerCase()) return name;
    }
    // Kitaip — gal regionas, ne šalis. Grąžinam null.
    return null;
  };

  let country = null;
  // 1) authority.country
  if (authorityObj && typeof authorityObj === 'object') {
    country = normalizeCountry(authorityObj.country);
  }
  // 2) tenderLocation[].code (regiono kodas su šalies prefiksu)
  if (!country) {
    const locArr = root.tenderLocation;
    if (Array.isArray(locArr) && locArr.length) {
      for (const loc of locArr) {
        if (loc && typeof loc === 'object' && loc.code) {
          const c = normalizeCountry(loc.code);
          if (c) { country = c; break; }
        }
      }
    }
  }
  // 3) pickField — bendras bandymas
  if (!country) {
    const picked = pickField(root, [
      'country', 'countryCode', 'countryName', 'nation',
      'deliveryPlaceCode',
    ]);
    if (picked) country = normalizeCountry(picked) || picked;
  }
  // 4) Paskutinė viltis — tenderLocation[].name (dažnai regionas)
  if (!country) {
    const locArr = root.tenderLocation;
    if (Array.isArray(locArr) && locArr.length) {
      const first = locArr[0];
      if (first && typeof first === 'object') {
        country = first.name || null;
      }
    }
  }

  const deadline = pickField(root, [
    'bidDueDate', 'deadline', 'deadlineDate', 'submissionDeadline',
    'endDate', 'closingDate', 'offerDeadline', 'tenderDeadline',
    'tenderDueDate', 'bidOpeningDate',
  ]);
  const publicationDate = pickField(root, [
    'publicationDate', 'publishedDate', 'published', 'publishDate',
    'noticePublishedDate', 'created', 'createdDate', 'releaseDate',
  ]);
  const reference = pickField(root, [
    'referenceNumber', 'reference', 'noticeNumber', 'ocid',
    'tenderReference', 'externalReferenceNumber', 'sourceNoticeId',
  ]);
  // VERTĖ / BUDGET — Mercell pateikia `moneyRange: {currency, low, high}`.
  // Taip pat galim sulaukti `estimatedValue` ir pan. objektuose su
  // {amount, currency} ar {min, max}.
  // Anksčiau formatter'is pateikdavo "30 EUR" kai realioj JSON būdavo
  // `{low: 30000, high: null}` arba `{low: 30000, high: 30000}` — dabar:
  //   • numerius formatuojam su tūkstančių skirtukais ("30 000 EUR"),
  //   • jei turim ir low ir high (ir skirtingi) — rodom range,
  //   • jei amt yra per mažas (<1) — laikom nesančiu ir einam toliau.
  const fmtMoney = (n) => {
    if (n === undefined || n === null || n === '') return '';
    const num = typeof n === 'number' ? n : parseFloat(String(n).replace(/[,\s]/g, '.').replace(/\.(?=\d{3}\b)/g, ''));
    if (!Number.isFinite(num) || num <= 0) return '';
    // Use narrow-NBSP as thousands separator (European convention).
    return num.toLocaleString('en-US').replace(/,/g, ' ');
  };
  const budgetCandidates = [
    'moneyRange', 'estimatedValue', 'estimatedTotalValue',
    'contractValue', 'totalValue', 'maxBudget', 'maximumBudget',
    'value', 'budget', 'valueExcludingVat', 'valueAmount', 'amount',
    'estimatedBudget', 'contractAmount',
  ];
  let budget = null;
  for (const key of budgetCandidates) {
    const v = root[key];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const cur = v.currency ?? v.currencyCode ?? v.code ?? '';
      const loRaw = v.low ?? v.min ?? v.minValue ?? v.minimum;
      const hiRaw = v.high ?? v.max ?? v.maxValue ?? v.maximum;
      const amtRaw = v.amount ?? v.value ?? v.number;
      const loNum = Number(loRaw);
      const hiNum = Number(hiRaw);
      const amtNum = Number(amtRaw);
      const loOk = Number.isFinite(loNum) && loNum > 0;
      const hiOk = Number.isFinite(hiNum) && hiNum > 0;
      const amtOk = Number.isFinite(amtNum) && amtNum > 0;
      if (loOk && hiOk && loNum !== hiNum) {
        budget = `${fmtMoney(loNum)}–${fmtMoney(hiNum)} ${cur}`.trim();
        break;
      }
      if (hiOk) { budget = `${fmtMoney(hiNum)} ${cur}`.trim(); break; }
      if (loOk) { budget = `${fmtMoney(loNum)} ${cur}`.trim(); break; }
      if (amtOk) { budget = `${fmtMoney(amtNum)} ${cur}`.trim(); break; }
    }
  }
  if (!budget) {
    const picked = pickField(root, budgetCandidates);
    if (picked) {
      // Validate scalar pick — if it's obviously trash (like just "0"),
      // drop it. Otherwise pass through verbatim so AI can refine later.
      const num = parseFloat(String(picked).replace(/[,\s]/g, '.'));
      if (!Number.isFinite(num) || num > 0) budget = String(picked).trim();
    }
  }

  // DURATION — Mercell pateikia `contractLength: {awardRange, optionRanges}`,
  // kur awardRange yra pvz. `{low, high, unit}` arba panašiai.
  //
  // BUG fix: anksčiau pickField'as iš `performancePeriod`/`contractPeriod`
  // paimdavo date-range string'ą tipo "01/07/2026 - 28/10/2030" ir jį
  // įrašydavo kaip duration. Dabar:
  //   • tikrinam ar awardRange.low/high yra skaičiai — tik tada render'inam,
  //   • jei jie datos — paverčiam jas mėnesių skaičiumi,
  //   • pickField'o fallback — nepriimam string'ų, kuriuose daug skaičių
  //     su slash/dash (tikėtinai — datos), o esant datų pora — konvertuojam.
  const monthsBetween = (a, b) => {
    const da = new Date(a);
    const db = new Date(b);
    if (isNaN(da) || isNaN(db)) return null;
    const diff = (db.getFullYear() - da.getFullYear()) * 12
      + (db.getMonth() - da.getMonth());
    return diff > 0 ? diff : null;
  };
  const parseDateRange = (s) => {
    if (!s || typeof s !== 'string') return null;
    // dd/mm/yyyy - dd/mm/yyyy   or   yyyy-mm-dd - yyyy-mm-dd
    const m = s.match(
      /(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}|\d{4}[\/.\-]\d{1,2}[\/.\-]\d{1,2})\s*[-–—]\s*(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}|\d{4}[\/.\-]\d{1,2}[\/.\-]\d{1,2})/
    );
    if (!m) return null;
    const norm = (d) => {
      const mm = d.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/);
      if (mm) {
        const [_, dd, mo, yy] = mm;
        const y = yy.length === 2 ? '20' + yy : yy;
        return `${y}-${mo.padStart(2,'0')}-${dd.padStart(2,'0')}`;
      }
      return d;
    };
    return [norm(m[1]), norm(m[2])];
  };
  let duration = null;
  const cl = root.contractLength;
  if (cl && typeof cl === 'object') {
    const ar = cl.awardRange;
    if (ar && typeof ar === 'object') {
      const lo = ar.low ?? ar.min ?? ar.minimum;
      const hi = ar.high ?? ar.max ?? ar.maximum;
      const unit = (ar.unit || ar.units || 'months').toString().toLowerCase().replace(/^month$/, 'months');
      const loNum = Number(lo);
      const hiNum = Number(hi);
      const loIsNum = Number.isFinite(loNum) && loNum > 0;
      const hiIsNum = Number.isFinite(hiNum) && hiNum > 0;
      if (loIsNum && hiIsNum && loNum !== hiNum) {
        duration = `${loNum}–${hiNum} ${unit}`;
      } else if (hiIsNum) {
        duration = `${hiNum} ${unit}`;
      } else if (loIsNum) {
        duration = `${loNum} ${unit}`;
      } else if (typeof lo === 'string' && typeof hi === 'string') {
        // lo/hi look like dates → convert to months span
        const months = monthsBetween(lo, hi);
        if (months) duration = `${months} months`;
      }
    }
    if (!duration && Array.isArray(cl.optionRanges) && cl.optionRanges.length) {
      const or = cl.optionRanges[0];
      if (or && typeof or === 'object') {
        const loNum = Number(or.low);
        const hiNum = Number(or.high);
        const unit = or.unit || 'months';
        if (Number.isFinite(loNum) && Number.isFinite(hiNum) && loNum > 0 && hiNum > 0) {
          duration = `${loNum}–${hiNum} ${unit} (option)`;
        }
      }
    }
  }
  if (!duration) {
    const pickedDur = pickField(root, [
      'duration', 'contractDuration', 'durationMonths', 'periodMonths',
      'contractPeriod', 'performancePeriod',
      'timeFrame', 'validityPeriod', 'estimatedDuration',
    ]);
    if (pickedDur) {
      // If pickField returned a date range, convert to month count.
      const range = parseDateRange(String(pickedDur));
      if (range) {
        const months = monthsBetween(range[0], range[1]);
        if (months) duration = `${months} months`;
      } else if (/\d/.test(pickedDur) && !/\d{4}.*\d{4}/.test(pickedDur)) {
        // Accept only if it looks duration-ish (not like two years).
        duration = String(pickedDur).trim();
      }
    }
  }

  // AWARD CRITERIA — Mercell: `evaluationBasis` (dažnai enum / string).
  const awardCriteria = pickField(root, [
    'evaluationBasis',
    'awardCriteria', 'awardCriterion', 'evaluationCriteria',
    'weighingCriteria', 'criteria', 'contractAwardCriteria',
    'awardingCriteria', 'evaluationMethod', 'selectionMethod',
  ]);
  const qualification = pickField(root, [
    'qualificationRequirements', 'selectionCriteria', 'suitabilityCriteria',
    'eligibilityCriteria', 'qualifications', 'participationCriteria',
    'qualificationCriteria', 'tendererQualifications',
  ]);
  const requirements = pickField(root, [
    'requirementsForSupplier', 'supplierRequirements', 'requirements',
    'bidderRequirements', 'conditionsForParticipation',
    'technicalRequirements', 'mandatoryRequirements', 'minimumRequirements',
  ]);
  const sourceUrl = pickField(root, [
    'sourceUrl', 'linkUrl', 'url', 'originalSourceUrl', 'externalUrl',
    'documentUrl', 'permalink', 'link',
  ]);
  const cpvCodes = pickField(root, ['cpvCodes', 'cpvCode', 'cpv']);

  return {
    _raw: root,
    title,
    description,
    buyer,
    country,
    deadline,
    publicationDate,
    reference,
    budget,
    duration,
    awardCriteria,
    qualification,
    requirements,
    sourceUrl,
    cpvCodes,
  };
}

async function fetchTenderDetails(browser, page, tenderUrl) {
  let blockHandler = null;
  let responseHandler = null;
  const capturedApis = []; // { url, json }
  // Bearer token captured from the SPA's own outgoing API requests.
  // Mercell's frontend stores its access token in localStorage and sends
  // it as `Authorization: Bearer <token>` on every XHR to *.discover.app.
  // mercell.com. Cookies alone aren't enough — the search-service-api
  // returns 401 without this header. We capture it once from the first
  // intercepted request and reuse it on direct file fetches via CDP.
  let mercellBearer = null;
  try {
    await page.setRequestInterception(true);
    blockHandler = (req) => {
      const type = req.resourceType();
      // Sniff the outgoing Authorization header for any Mercell-internal
      // API call. Captured ONCE and reused thereafter; the token is
      // session-scoped and stable for the lifetime of this page.
      try {
        if (!mercellBearer) {
          const reqUrl = req.url();
          if (/\.discover\.app\.mercell\.com\//.test(reqUrl)) {
            const headers = req.headers() || {};
            const auth = headers.authorization || headers.Authorization;
            if (auth && /^bearer\s+/i.test(auth)) {
              mercellBearer = auth;
              console.log(`    🔑 captured Mercell Bearer (${auth.length}ch) from ${new URL(reqUrl).hostname}`);
            }
          }
        }
      } catch (_) { /* ignore */ }
      if (['image', 'media', 'font'].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    };
    page.on('request', blockHandler);

    // JSON response capture — renkam visas Mercell detailinio tender'io
    // užklausų atsakymas (tiek `search-service-api`, tiek `sd-match-service`).
    responseHandler = async (res) => {
      try {
        const url = res.url();
        if (!/\.discover\.app\.mercell\.com\//.test(url)) return;
        if (!res.ok()) return;
        const ctype = res.headers()['content-type'] || '';
        if (!ctype.includes('application/json')) return;
        // Mums reikia TIK tender-specific response'ų, ne facets/search list
        if (!/\/search\/tenders\/|\/bopp-matches\//.test(url)) return;
        const text = await res.text();
        try {
          const json = JSON.parse(text);
          capturedApis.push({ url, json });
        } catch (_) {}
      } catch (_) {}
    };
    page.on('response', responseHandler);

    // Net jei `apiPromise` nesulauks, `capturedApis` masyve jau bus viskas.
    const apiPromise = page
      .waitForResponse(
        (res) => /\/api\/v1\/search\/tenders\//.test(res.url()) && res.ok(),
        { timeout: 12000 }
      )
      .catch(() => null);

    const navPromise = page.goto(tenderUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });

    await Promise.race([apiPromise, navPromise]);

    await page.waitForFunction(() => {
      const h1 = document.querySelector('h1');
      if (h1 && (h1.innerText || '').trim().length > 5) return true;
      const text = (document.body.innerText || '').trim();
      return text.length > 500 && !/414 ERROR|CloudFront/i.test(text);
    }, { timeout: 8000 }).catch(() => {
      console.log(`  WARN: no h1/content for ${tenderUrl}`);
    });

    // Po domcontentloaded eksplicitiškai palaukiam API atsakymų —
    // `responseHandler` visąlaik renka, bet turim duoti XHR'ams laiko pasileist.
    await apiPromise;

    // Papildomas settle time, kad spėtų ir `bopp-matches` užklausa (dažnai
    // fetchinama šiek tiek vėliau nei tender'io core info).
    await new Promise(r => setTimeout(r, 1500));

    // Nuskaitome Mercell puslapio turinį
    const details = await page.evaluate(() => {
      const bodyText = (document.body.innerText || '').trim();

      const sectionText = (labels) => {
        const all = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6, dt, th, strong, label, div, span, p'));
        for (const lab of labels) {
          const re = new RegExp('^\\s*' + lab + '\\s*:?\\s*$', 'i');
          const el = all.find(e => {
            const t = (e.textContent || '').trim();
            return re.test(t) && t.length < 100;
          });
          if (!el) continue;
          const val = el.nextElementSibling?.innerText
                   || el.parentElement?.nextElementSibling?.innerText
                   || el.parentElement?.querySelector('dd, td, p, span, div')?.innerText;
          if (val && val.trim() && val.trim() !== el.textContent.trim()) {
            return val.trim().slice(0, 2000);
          }
        }
        return null;
      };

      const budgetMatch = bodyText.match(
        /(?:estimated value|contract value|max(?:imum)?\s*(?:budget|value)|total value|budget|hankinnan arvo|arvio)[^\n]{0,40}?[:\s]+([€$£]?\s*[\d.,\s]+(?:\s*(?:EUR|USD|GBP|NOK|SEK|DKK))?)/i
      );
      const durationMatch = bodyText.match(
        /(?:duration|contract\s*period|contract\s*length|sopimuskausi|sopimuksen kesto|kesto)[^\n]{0,40}?[:\s]+([^\n.]{1,80})/i
      ) || bodyText.match(/(\d+)\s*(months?|years?|kuukautta|vuotta)/i);
      const deadlineMatch = bodyText.match(
        /(?:deadline|closing\s*date|submission\s*deadline|määräaika|tarjousaika)[^\n]{0,40}?[:\s]+([^\n]{1,80})/i
      );
      // Publication date turi atrodyti kaip data (dd/mm/yyyy, yyyy-mm-dd,
      // „26 May 2026" ir pan.). Be to reikalavimo heuristika kibsdavo už
      // „26 May - Deadline" ir panašių pavadinimų.
      const pubMatch = bodyText.match(
        /(?:published|publication\s*date|julkaistu|julkaisupäivä)[^\n]{0,40}?[:\s]+(\d{1,2}[\/.\- ]\w{1,10}[\/.\- ]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})/i
      );
      const refMatch = bodyText.match(
        /(?:reference(?:\s+number|\s+no\.?)?|ref\.?\s*no\.?|viitenumero|hankintailmoituksen\s*numero)[:\s]+([A-Z0-9\-\/_.]+)/i
      );

      // ŠALTINIO URL iš "Go to source" mygtuko
      const sourceBtn = document.querySelector('button[data-testid="join-tender-button"]');
      const sourceUrl = sourceBtn?.getAttribute('data-linkurl') || null;

      return {
        title: document.querySelector('h1')?.innerText?.trim() || null,
        organisation: sectionText([
          'buyer', 'contracting authority', 'contracting entity', 'purchaser', 'organisation',
          'hankintayksikkö', 'tilaaja', 'awarding authority'
        ]),
        country: sectionText(['country', 'location', 'maa', 'sijainti']),
        deadline: deadlineMatch ? deadlineMatch[1].trim() : null,
        publicationDate: pubMatch ? pubMatch[1].trim() : null,
        referenceNumber: refMatch ? refMatch[1].trim() : null,
        maxBudget: budgetMatch ? budgetMatch[1].trim() : null,
        duration: durationMatch ? (durationMatch[1] + (durationMatch[2] ? ' ' + durationMatch[2] : '')).trim() : null,
        requirementsForSupplier: sectionText([
          'requirements for supplier', 'supplier requirements', 'requirements',
          'vaatimukset', 'tarjoajan vaatimukset'
        ]),
        qualificationRequirements: sectionText([
          'qualification requirements', 'qualifications', 'eligibility', 'selection criteria',
          'soveltuvuusvaatimukset'
        ]),
        offerWeighingCriteria: sectionText([
          'award criteria', 'evaluation criteria', 'weighing criteria', 'criteria for award',
          'valintaperusteet', 'vertailuperusteet'
        ]),
        scopeOfAgreement: sectionText([
          'scope', 'scope of agreement', 'description', 'object of the contract', 'subject matter',
          'hankinnan kohde', 'kuvaus', 'laajuus'
        ]),
        technicalStack: sectionText([
          'technical stack', 'technology', 'technical requirements',
          'tekniset vaatimukset'
        ]),
        sourceUrl,
        fullTextSnippet: bodyText.slice(0, 3000),
      };
    });

    page.off('request', blockHandler);
    await page.setRequestInterception(false);

    // --- FILE-ROW DOM PROBE + CLICK ------------------------------------
    // Praeitam runn'e atradom, kad documents tab'as yra automatiškai
    // atidarytas (SPA'oje matėm „document name upload date file size ..."
    // antraštės eilutę DIV'e). Reiškia, failai jau renderinami DOM'e — tik
    // mes nemokam jų parsisiųsti. Šis blokas:
    //   1) Suskenuoja DOM ir randa elementus, kurių text'as panašus į
    //      failo vardą (turi .pdf/.docx/.xlsx/... plėtinį).
    //   2) Išspausdina jų href / data-* atributus — jei href yra, gausim
    //      URL be jokio click'o.
    //   3) Paspaudžia pirmą tokį elementą, kad pamatytume, kokį XHR'ą
    //      Mercell SPA iššaukia (visus host'us, ne tik mercell.com).
    const docsClickUrls = [];
    const docsClickResponseHandler = (res) => {
      try {
        const url = res.url();
        // NOISE_HOST_RE filter applied at log time, capture everything here
        const headers = res.headers() || {};
        const ctype = headers['content-type'] || '';
        const size = headers['content-length'] || '';
        docsClickUrls.push({
          url,
          status: res.status(),
          ctype,
          size,
        });
      } catch (_) { /* ignore */ }
    };
    const docsClickRequestHandler = (req) => {
      try {
        // Catch redirects / navigations / downloads that may not produce
        // a `response` event in this context.
        const url = req.url();
        const rt = req.resourceType();
        if (rt === 'document' || rt === 'xhr' || rt === 'fetch' || rt === 'other') {
          docsClickUrls.push({
            url,
            status: 'REQ',
            ctype: rt,
            size: '',
          });
        }
      } catch (_) { /* ignore */ }
    };
    page.on('response', docsClickResponseHandler);
    page.on('request', docsClickRequestHandler);

    // 1) Pasiklausom navigation events — kad nepraleistum top-level
    //    navigation'o, kuris gali būti file download trigger.
    let navUrls = [];
    const frameNavHandler = (frame) => {
      try {
        if (frame === page.mainFrame()) {
          navUrls.push(frame.url());
        }
      } catch (_) {}
    };
    page.on('framenavigated', frameNavHandler);

    // 2) DOM probe — search for filename-like text + capture surrounding
    //    anchor's href / data attributes. This often reveals the download
    //    URL without needing to click anything.
    let domProbe = [];
    let clickProbe = { clicked: false };
    try {
      domProbe = await page.evaluate(() => {
        const EXT_RE = /\.(pdf|docx?|xlsx?|zip|rtf|txt|odt|ods|xml|json|csv|tsv|pptx?)\b/i;
        const out = [];
        const seen = new Set();
        const all = Array.from(document.querySelectorAll('a, button, [role="link"], [role="button"], [class*="file" i], [class*="document" i], [class*="attach" i], [class*="download" i]'));
        for (const el of all) {
          const txt = ((el.innerText || el.textContent || '') + '').trim();
          if (!txt || txt.length > 250) continue;
          if (!EXT_RE.test(txt)) continue;
          // Walk up to find any anchor with an href
          let hrefEl = el.tagName === 'A' ? el : el.closest('a');
          const href = (hrefEl && hrefEl.getAttribute('href')) || '';
          const target = (hrefEl && hrefEl.getAttribute('target')) || '';
          const downloadAttr = (hrefEl && hrefEl.getAttribute('download')) || '';
          const dataAttrs = {};
          const probeEl = hrefEl || el;
          for (const attr of probeEl.attributes || []) {
            const n = attr.name.toLowerCase();
            if (/^(data-|ng-|on)/.test(n) || /url|src|file|doc|download/i.test(n)) {
              dataAttrs[attr.name] = (attr.value || '').slice(0, 240);
            }
          }
          // Also check parent row/li/tr for data attrs that often hold IDs
          const row = el.closest('tr,li,[class*="row" i]');
          const rowAttrs = {};
          if (row) {
            for (const attr of row.attributes || []) {
              const n = attr.name.toLowerCase();
              if (n.startsWith('data-') || /id$/i.test(n)) {
                rowAttrs[attr.name] = (attr.value || '').slice(0, 240);
              }
            }
          }
          const k = (probeEl.tagName || '') + '|' + txt.slice(0, 80);
          if (seen.has(k)) continue;
          seen.add(k);
          out.push({
            tag: probeEl.tagName,
            txt: txt.slice(0, 110),
            href: href.slice(0, 240),
            target,
            download: downloadAttr,
            data: dataAttrs,
            row: rowAttrs,
            outer: (probeEl.outerHTML || '').slice(0, 320),
          });
          if (out.length >= 12) break;
        }
        return out;
      });
    } catch (e) {
      console.log(`    📎 file-row DOM probe failed: ${e.message}`);
    }

    if (domProbe.length) {
      console.log(`    📎 file-row DOM probe: ${domProbe.length} candidate(s)`);
      for (const m of domProbe.slice(0, 6)) {
        const dataKeys = Object.keys(m.data || {}).filter((k) => m.data[k]);
        const rowKeys = Object.keys(m.row || {}).filter((k) => m.row[k]);
        console.log(`        <${m.tag}> "${m.txt}" href="${m.href || ''}" target="${m.target || ''}" dl="${m.download || ''}"`);
        if (dataKeys.length) {
          for (const k of dataKeys.slice(0, 5)) {
            console.log(`            [${k}] = ${m.data[k]}`);
          }
        }
        if (rowKeys.length) {
          for (const k of rowKeys.slice(0, 5)) {
            console.log(`            row[${k}] = ${m.row[k]}`);
          }
        }
      }
      // Dump first candidate's outerHTML for shape inspection
      console.log(`    📎 first candidate outerHTML preview: ${domProbe[0].outer}`);
    } else {
      console.log(`    📎 file-row DOM probe: 0 candidates (no filename-like text in DOM)`);
    }

    // 3) Click probe — only if no usable href found in DOM probe.
    //    We click ONCE on the first filename-like element and watch network.
    const hasUsableHref = domProbe.some((m) => m.href && /^https?:\/\//i.test(m.href));
    if (!hasUsableHref && domProbe.length > 0) {
      try {
        // Override window.open and location.assign so the page stays alive
        await page.evaluate(() => {
          try {
            window.__capturedOpens__ = [];
            const realOpen = window.open;
            window.open = function (...args) {
              try { window.__capturedOpens__.push(['open', String(args[0] || '')]); } catch (_) {}
              return null;
            };
            const realAssign = window.location.assign.bind(window.location);
            try {
              Object.defineProperty(window.location, 'assign', {
                configurable: true,
                value: function (u) { window.__capturedOpens__.push(['assign', String(u || '')]); }
              });
            } catch (_) {}
            try {
              Object.defineProperty(window.location, 'replace', {
                configurable: true,
                value: function (u) { window.__capturedOpens__.push(['replace', String(u || '')]); }
              });
            } catch (_) {}
          } catch (_) {}
        });

        clickProbe = await page.evaluate(() => {
          const EXT_RE = /\.(pdf|docx?|xlsx?|zip|rtf|txt|odt|ods|xml|json|csv|tsv|pptx?)\b/i;
          const all = Array.from(document.querySelectorAll('a, button, [role="link"], [role="button"]'));
          for (const el of all) {
            const txt = ((el.innerText || el.textContent || '') + '').trim();
            if (!txt || txt.length > 250) continue;
            if (!EXT_RE.test(txt)) continue;
            try {
              el.scrollIntoView({ block: 'center' });
              el.click();
              return { clicked: true, tag: el.tagName, txt: txt.slice(0, 100) };
            } catch (_) {}
          }
          return { clicked: false };
        });

        if (clickProbe.clicked) {
          console.log(`    📎 file-row clicked (<${clickProbe.tag}> "${clickProbe.txt}")`);
          await new Promise((r) => setTimeout(r, 3500));

          // Read back any window.open / location.assign captures
          try {
            const opens = await page.evaluate(() => window.__capturedOpens__ || []);
            if (Array.isArray(opens) && opens.length) {
              console.log(`    📎 captured navigation hooks (${opens.length}):`);
              for (const [kind, u] of opens.slice(0, 10)) {
                console.log(`        [${kind}] ${String(u).slice(0, 200)}`);
              }
            }
          } catch (_) {}
        }
      } catch (e) {
        console.log(`    📎 file-row click failed: ${e.message}`);
      }
    } else if (hasUsableHref) {
      console.log(`    📎 skipping click — DOM probe already revealed href(s)`);
    }

    try {
      page.off('response', docsClickResponseHandler);
      page.off('request', docsClickRequestHandler);
      page.off('framenavigated', frameNavHandler);
    } catch (_) {}

    // Filtruojam triukšmą — nereikia matyti notification/user-service/comments XHR'ų
    const NOISE_HOST_RE = /(notification-api|user-management-api|user-service\.|comments-service|telemetry|analytics|sentry|google-analytics|googletagmanager|hotjar|cookiebot|fonts\.googleapis|gstatic|cloudflareinsights)/i;
    const STATIC_RE = /\.(js|css|woff2?|ttf|eot|svg|png|jpg|jpeg|gif|ico|map)(\?|$)/i;
    const docsClickFiltered = docsClickUrls.filter((u) => !NOISE_HOST_RE.test(u.url) && !STATIC_RE.test(u.url));
    if (docsClickFiltered.length) {
      console.log(`    📎 docs-phase requests/responses (${docsClickFiltered.length}):`);
      for (const u of docsClickFiltered.slice(0, 30)) {
        console.log(`        [${u.status}] ${u.ctype} ${u.size}b ${u.url.slice(0, 200)}`);
      }
    } else if (docsClickUrls.length) {
      console.log(`    📎 docs-phase: ${docsClickUrls.length} captured but all filtered as noise/static`);
    }
    if (navUrls.length) {
      console.log(`    📎 frame navigations during probe: ${navUrls.map((u) => u.slice(0, 180)).join(' → ')}`);
    }

    // --- MERCELL JSON API ATSAKYMAI ------------------------------------
    // Mercell tender'io puslapis fetchina `/api/v1/search/tenders/{id}`
    // ir `/api/v1/bopp-matches/{id}` iš discover.app.mercell.com. Šiuose
    // JSON'uose yra daug struktūrizuotų laukų, kurių neradome puslapio DOM'e.
    try {
      page.off('response', responseHandler);
    } catch (_) {}

    console.log(`    Captured ${capturedApis.length} Mercell API responses`);

    // DEBUG: pirmo naujo tender'io JSON'ą išrašom į diską — tai leis mums
    // pamatyti nested'us laukus (requirements, duration, criteria, ...),
    // kurių nėra top-level'yje.
    try {
      const fs = require('fs');
      const path = require('path');
      const dumpDir = path.join(process.cwd(), 'debug-json');
      if (!fs.existsSync(dumpDir)) fs.mkdirSync(dumpDir, { recursive: true });
      for (let i = 0; i < capturedApis.length; i++) {
        const { url, json } = capturedApis[i];
        const slug = url.replace(/[^a-zA-Z0-9]+/g, '_').slice(-80);
        const file = path.join(dumpDir, `${Date.now()}_${i}_${slug}.json`);
        fs.writeFileSync(file, JSON.stringify(json, null, 2));
      }
    } catch (e) {
      console.log(`    (debug dump failed: ${e.message})`);
    }

    for (const { url, json } of capturedApis) {
      const topKeys = Object.keys(json || {}).slice(0, 20);
      console.log(`    API: ${url.slice(0, 100)} keys=${JSON.stringify(topKeys)}`);

      // Diagnostika: dar gilesni nested keys, kad atrastume kur slypi
      // requirements/qualifications/criteria/duration.
      const nestedSummary = {};
      for (const [k, v] of Object.entries(json || {})) {
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          nestedSummary[k] = Object.keys(v).slice(0, 8);
        } else if (Array.isArray(v) && v.length && typeof v[0] === 'object') {
          nestedSummary[k + '[]'] = Object.keys(v[0] || {}).slice(0, 8);
        }
      }
      if (Object.keys(nestedSummary).length) {
        console.log(`    nested: ${JSON.stringify(nestedSummary).slice(0, 500)}`);
      }

      // --- diagnostic: actual VALUES of fields the public-notice harvester
      // looks at. Confirmed empirically that `originalNotices` is a
      // literal "TODO" stub in the current Mercell schema (schema field
      // exists but is unimplemented), and `fileReferenceNumber` holds the
      // BUYER'S INTERNAL ref (e.g. "GNU 2026/67", "ET183") — NOT a TED
      // publication number. Skip logging known stubs so we still get a
      // signal if Mercell ever populates a real value on a future tender.
      const STUB_VALUES = new Set(['"TODO"', '"todo"', '"N/A"', '"n/a"', '""', 'null']);
      const dumpField = (label, value) => {
        if (value == null) return;
        try {
          const s = JSON.stringify(value);
          if (!s || s === 'null' || s === '""' || s === '{}' || s === '[]') return;
          if (STUB_VALUES.has(s)) return;
          console.log(`    🔎 ${label}: ${s.slice(0, 300)}${s.length > 300 ? '…' : ''}`);
        } catch (_) { /* ignore */ }
      };
      if (json && typeof json === 'object') {
        dumpField('fileReferenceNumber', json.fileReferenceNumber);
        dumpField('originalNotices', json.originalNotices);
        dumpField('publicationNumber', json.publicationNumber);
        dumpField('externalReferences', json.externalReferences);
      }

      const fields = extractFieldsFromTenderJson(json);

      // JSON VIRŠ DOM'O — Mercell JSON'as struktūrizuotas ir patikimas,
      // o DOM heuristika dažnai pateikia šiukšles (pvz., publicationDate
      // anksčiau gaudavo „26 May - Deadline"). Todėl čia užrašom JSON reikšmes
      // per viršų, nebent jos tuščios.
      if (fields.title) details.title = fields.title;
      if (fields.buyer) details.organisation = fields.buyer;
      if (fields.country) details.country = fields.country;
      if (fields.deadline) details.deadline = fields.deadline;
      if (fields.publicationDate) details.publicationDate = fields.publicationDate;
      if (fields.reference) details.referenceNumber = fields.reference;
      if (fields.budget) details.maxBudget = fields.budget;
      if (fields.duration) details.duration = fields.duration;
      if (fields.awardCriteria) details.offerWeighingCriteria = fields.awardCriteria;
      if (fields.qualification) details.qualificationRequirements = fields.qualification;
      if (fields.requirements) details.requirementsForSupplier = fields.requirements;
      if (fields.description && !details.scopeOfAgreement) details.scopeOfAgreement = fields.description;
      if (fields.sourceUrl) details.sourceUrl = fields.sourceUrl;
      if (fields.cpvCodes && !details.cpvCodes) details.cpvCodes = fields.cpvCodes;

      // Logginam ką radom iš JSON'o, kad paprasta debugint kokie laukai buvo užpildyti
      const filled = Object.entries(fields)
        .filter(([k, v]) => v && k !== '_raw')
        .map(([k, v]) => `${k}(${String(v).length}ch)`)
        .join(', ');
      if (filled) console.log(`    → from JSON: ${filled}`);
    }

    // --- PDF DOKUMENTŲ PARSINIMAS ------------------------------------
    // Mercell tender'io JSON'uose gali būti `files[]` / `documents[]` /
    // `attachments[]` — čia surandame PDF'us, parsiunčiame su authent'intais
    // puslapio sausainiais (`credentials: 'include'` per `page.evaluate`) ir
    // ištraukiame teksto turinį pdf-parse'u. Išgautą tekstą pridedame į
    // `details.pdfText`, kad AI ištraukimas galėtų pasimatyti reikalavimus,
    // kvalifikacijas ir vertinimo kriterijus iš tikrų dokumentų.
    try {
      const collectedFiles = [];
      const seenIds = new Set();

      // String coercer — kartais Mercell JSON'e lauke yra array (pvz., title[])
      // arba objektas su {languageCode,text}. Paversciam į plain string.
      const toStr = (v) => {
        if (v == null) return '';
        if (typeof v === 'string') return v;
        if (Array.isArray(v)) {
          for (const it of v) { const s = toStr(it); if (s) return s; }
          return '';
        }
        if (typeof v === 'object') {
          return toStr(v.text || v.name || v.value || v.fileName || '');
        }
        return String(v);
      };

      // Diagnostic: surenka VISUS file-like nodes (be filtravimo pagal extension).
      // Naudojam tik debug log'ui, kad matytume ką API'us iš tikro grąžina —
      // jei `collectedFiles` būna tuščias, šitas inventory rodys ar files[]
      // nepalaikomos struktūros, ar tikrai išvis nieko nėra.
      const fileLikeInventory = [];
      const seenInvIds = new Set();

      // Extensions, kurias laikom „dokumentu" pagrindiniu sąraše:
      //   pdf  — pdf-parse
      //   docx — mammoth
      //   doc  — (legacy; mammoth nepalaiko, bandysim plain-text fallback)
      //   xlsx, xls — SheetJS
      //   zip — adm-zip recurse
      //   rtf, txt — plain text
      //   odt, ods — atvirkštinis OOXML; bandysim ZIP recurse
      const DOC_EXTENSIONS = new Set([
        'pdf', 'docx', 'doc', 'xlsx', 'xls', 'zip', 'rtf', 'txt', 'odt', 'ods',
        // XML — Mercell often attaches ONLY the TED OriginalNotice in
        // eForms XML format (type=OriginalNotice). The XML is structured
        // and contains qualification criteria, award criteria, lots, and
        // contract value verbatim. Strip-tag extraction gives us the same
        // content that would otherwise sit in a ToR PDF.
        'xml',
        // JSON — UK Find-a-Tender (FTS) notices are attached as JSON
        // (type=OriginalNotice, ext=json). The schema mirrors TED eForms
        // semantically — qualification, award criteria, lots, value — but
        // is encoded as a flat JSON tree instead of XML. Pretty-printing
        // it with JSON.stringify gives the AI extraction prompt the same
        // verbatim text content it gets from XML notices.
        'json',
      ]);

      const pickFromNode = (node) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { for (const it of node) pickFromNode(it); return; }
        // Strict file detection: reikia `fileId`/`documentId`/`guid` (kad
        // nepagautume root tender'io objekto) PLIUS bent vienos požymio,
        // kad tai dokumentas (extension/mime/type/url su žinoma extension'a).
        const hasFileId = !!(node.fileId || node.documentId || node.guid);
        const extRaw = toStr(node.extension || '');
        const mimeRaw = toStr(node.mimeType || node.contentType || '');
        const typeRaw = toStr(node.type || '');
        const nameRaw = toStr(node.name || node.filename || node.fileName || node.displayName || '');
        const urlRaw = toStr(node.url || node.downloadUrl || node.downloadLink || node.href || '');

        // Mercell laiko `extension` lauką nevienodai: kartais su tašku (".pdf",
        // ".zip"), kartais be ("docx", "xlsx"). Norm: nuvalykim leading dot ir
        // visą whitespace'ą, tada lower-case.
        const extRawClean = String(extRaw).trim().replace(/^\./, '');
        const extFromName = (nameRaw.match(/\.([a-z0-9]{1,5})$/i) || [])[1] || '';
        const extFromUrl  = (urlRaw.match(/\.([a-z0-9]{1,5})(?:[?#]|$)/i) || [])[1] || '';
        const ext = (extRawClean || extFromName || extFromUrl || '').toLowerCase();

        const looksLikeFile = hasFileId && (extRaw || nameRaw || mimeRaw || urlRaw);

        // --- diagnostic inventory: KIEKVIENĄ file-like node'ą įrašom, kad ir
        // be žinomos extension'os (pvz., generic mimeType arba neaiškus type).
        if (looksLikeFile) {
          const id = toStr(node.fileId || node.documentId || node.guid);
          if (id && !seenInvIds.has(id)) {
            seenInvIds.add(id);
            fileLikeInventory.push({
              id,
              name: nameRaw || '(no-name)',
              ext,
              mime: mimeRaw,
              type: typeRaw,
              hasUrl: !!urlRaw,
            });
          }
        }

        // --- žinomos dokumentų extension'os → įtraukiam į collectedFiles
        // (parsing'ui). Jei nėra extension'os bet mime aiškiai PDF → tikslinam.
        let docExt = ext;
        if (!docExt && /pdf/i.test(mimeRaw)) docExt = 'pdf';
        if (!docExt && /pdf/i.test(typeRaw)) docExt = 'pdf';
        if (!docExt && /word|document/i.test(mimeRaw)) docExt = 'docx';
        if (!docExt && /sheet|excel/i.test(mimeRaw)) docExt = 'xlsx';
        if (!docExt && /zip/i.test(mimeRaw)) docExt = 'zip';

        const isDocFile = looksLikeFile && DOC_EXTENSIONS.has(docExt);

        if (isDocFile) {
          const id = toStr(node.fileId || node.documentId || node.guid);
          // `fileReference` Mercell'yje yra GUID (skiriasi nuo `fileId` int'o).
          // file-service'as download'ui beveik visada nori būtent GUID'o, ne
          // signed-int'o hash'o, todėl saugom ATSKIRAI ir abu naudosim fetch'e.
          const ref = toStr(node.fileReference || node.reference || '');
          if (id && !seenIds.has(id)) {
            seenIds.add(id);
            collectedFiles.push({
              id,
              ref,
              name: nameRaw || `file-${id}.${docExt}`,
              url: urlRaw || null,
              mime: mimeRaw,
              ext: docExt,
            });
          }
        }

        for (const v of Object.values(node)) {
          if (v && typeof v === 'object') pickFromNode(v);
        }
      };

      for (const { json } of capturedApis) pickFromNode(json);

      // --- diagnostic 📎 inventory log -------------------------------------
      // Jei collectedFiles tuščias, bet API kažką grąžino — čia matysim ką
      // tiksliai. Ekonomijai logginam tik pirmus 12 ir bendrą skaičių.
      if (fileLikeInventory.length) {
        const summary = fileLikeInventory
          .slice(0, 12)
          .map(f => {
            const parts = [];
            if (f.ext) parts.push(`ext=${f.ext}`);
            if (f.mime) parts.push(`mime=${f.mime.slice(0, 40)}`);
            if (f.type) parts.push(`type=${f.type.slice(0, 24)}`);
            return `${f.name.slice(0, 50)} [${parts.join(',') || '?'}]`;
          })
          .join('; ');
        const tail = fileLikeInventory.length > 12 ? ` … (+${fileLikeInventory.length - 12} more)` : '';
        console.log(`    📎 file-like nodes: ${fileLikeInventory.length} — ${summary}${tail}`);
      } else {
        console.log(`    📎 file-like nodes: 0 (capturedApis count=${capturedApis.length})`);
      }

      if (collectedFiles.length) {
        const byExt = collectedFiles.reduce((m, f) => {
          m[f.ext || '?'] = (m[f.ext || '?'] || 0) + 1;
          return m;
        }, {});
        const extSummary = Object.entries(byExt).map(([k, v]) => `${k}=${v}`).join(', ');
        console.log(`    📄 found ${collectedFiles.length} document file(s) in JSON (${extSummary})`);
      }

      // --- PDF RELEVANCE SORTING --------------------------------------
      // Mercell tender'iai dažnai pridėti 5–15 failų: ToR, EBVPD, kainos forma,
      // priedai, NDA šablonai. Reikalavimai / kvalifikacijos / vertinimo
      // kriterijai paprastai būna ToR / Specifikacijos / Pirkimo sąlygos
      // dokumentuose. Surūšiuojam taip, kad relevant'iškiausi keliautų pirmi —
      // multilingual, nes scraper'is grobia 16 ES šalių.
      const POSITIVE_KW = [
        // English
        'requirement', 'qualification', 'criteria', 'criterion', 'specification',
        'spec', 'tor', 'terms of reference', 'task description', 'sow',
        'scope of work', 'rfp', 'tender doc', 'evaluation', 'award', 'selection',
        // Lithuanian
        'reikalav', 'kvalifik', 'kriterij', 'specifik', 'sąlyg', 'pirkimo',
        // Polish
        'wymag', 'kwalifik', 'kryteri', 'specyfik', 'opis przedmiotu',
        // German
        'anforder', 'kriterien', 'lastenheft', 'leistungsbeschr',
        // Norwegian / Swedish / Danish
        'krav', 'kravspec', 'tildelings',
        // Dutch
        'eisen', 'bestek', 'criteri', 'gunning',
        // French
        'exigen', 'cahier', 'crit',
        // Spanish / Portuguese
        'requisi', 'pliego',
        // Italian
        'capitolat',
        // Czech / Slovak
        'požadav', 'kritéri',
        // Finnish
        'vaatimuk', 'kelpoisuu',
        // Estonian
        'nõue', 'kriteer',
        // Latvian
        'prasīb',
      ];
      const NEGATIVE_KW = [
        'espd', 'gdpr', 'nda', 'cv', 'logo', 'cover-letter', 'price-form',
        'kainos forma', 'formularz cenowy', 'preisblatt', 'oferta-cenow',
      ];
      const scoreFile = (name) => {
        const n = String(name || '').toLowerCase();
        let s = 0;
        for (const kw of POSITIVE_KW) if (n.includes(kw)) s += 10;
        for (const kw of NEGATIVE_KW) if (n.includes(kw)) s -= 8;
        // Annex/appendix → slight de-prioritization (often supplementary)
        if (/\b(annex|appendix|priedas|liite|załącznik|bilag|bilaga|anlage|allegato|anexo)\b/i.test(n)) s -= 2;
        return s;
      };
      collectedFiles.sort((a, b) => scoreFile(b.name) - scoreFile(a.name));
      if (collectedFiles.length) {
        const top = collectedFiles.slice(0, 6).map(f => `${f.name}[${f.ext}](${scoreFile(f.name)})`).join(', ');
        console.log(`    📄 doc priority: ${top}`);
      }

      // Kiek dokumentų parsinam per tender'į (kad neužtruktų per ilgai):
      // tender'iai dažnai turi po kelis svarbius dokumentus (ToR +
      // qualification + award criteria atskirai), o filename'ų prioritizavimas
      // užtikrina, kad pirmi yra reikšmingiausi.
      const MAX_DOCS_PER_TENDER = 6;
      const MAX_DOC_TEXT_CHARS = 30000;       // per single document
      const MAX_TOTAL_DOC_CHARS = 120000;     // total for AI prompt
      const MAX_INNER_BYTES = 10 * 1024 * 1024; // ZIP inner-file size cap
      const MAX_ZIP_DEPTH = 2;

      // Optional deps — visi try-load: jei nėra įdiegti, atitinkamą formatą
      // praleidžiam su perspėjimu (bet visi kiti formatai ir toliau veikia).
      let pdfParse = null, mammoth = null, XLSX = null, AdmZip = null;
      try { pdfParse = require('pdf-parse'); } catch (_) { /* opt */ }
      try { mammoth  = require('mammoth');   } catch (_) { /* opt */ }
      try { XLSX     = require('xlsx');      } catch (_) { /* opt */ }
      try { AdmZip   = require('adm-zip');   } catch (_) { /* opt */ }

      // Loginam ko trūksta — tik kartą per tender'į ir tik jei iš tiesų yra
      // failų, kuriuos reikės tame formate parsinti.
      const haveExt = new Set(collectedFiles.map(f => f.ext));
      if (collectedFiles.length) {
        const missing = [];
        if (haveExt.has('pdf')  && !pdfParse) missing.push('pdf-parse');
        if ((haveExt.has('docx') || haveExt.has('odt')) && !mammoth) missing.push('mammoth');
        if ((haveExt.has('xlsx') || haveExt.has('xls') || haveExt.has('ods')) && !XLSX) missing.push('xlsx');
        if (haveExt.has('zip')  && !AdmZip) missing.push('adm-zip');
        if (missing.length) {
          console.log(`    ⚠️ optional deps missing: ${missing.join(', ')} — affected files will be skipped`);
        }
      }

      // --- magic-byte sniffer ----------------------------------------------
      // Mercell file-service kartais grąžina HTML login/redirect puslapį su
      // 200 OK statusu — tas baitas pratenka mūsų `size > 100` filtrą, bet
      // pdf-parse'ui jie nepriklauso PDF struktūrai ir log'as užsipildo
      // šimtais "Ignoring invalid character" eilučių. Patikrinkim magic bytes
      // PRIEŠ apkraunant parser'į.
      const detectFormat = (buf) => {
        if (!buf || buf.length < 4) return 'unknown';
        const b0 = buf[0], b1 = buf[1], b2 = buf[2], b3 = buf[3];
        // %PDF-
        if (b0 === 0x25 && b1 === 0x50 && b2 === 0x44 && b3 === 0x46) return 'pdf';
        // PK (ZIP family — also DOCX, XLSX, ODT, ODS)
        if (b0 === 0x50 && b1 === 0x4B && (b2 === 0x03 || b2 === 0x05 || b2 === 0x07)) return 'zip';
        // CFB (legacy doc/xls)
        if (b0 === 0xD0 && b1 === 0xCF && b2 === 0x11 && b3 === 0xE0) return 'cfb';
        // {\rtf
        if (b0 === 0x7B && b1 === 0x5C && b2 === 0x72 && b3 === 0x74) return 'rtf';
        // HTML / XML wrapper — first non-whitespace is '<'
        const head = buf.slice(0, 64).toString('utf8').trim().toLowerCase();
        if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml') || head.startsWith('<')) return 'html';
        // JSON error envelope
        if (head.startsWith('{') || head.startsWith('[')) return 'json';
        return 'unknown';
      };
      const magicMatchesExt = (buf, ext) => {
        const got = detectFormat(buf);
        const ex = String(ext || '').toLowerCase();
        if (ex === 'pdf') return got === 'pdf';
        if (ex === 'docx' || ex === 'xlsx' || ex === 'odt' || ex === 'ods' || ex === 'zip') return got === 'zip';
        if (ex === 'doc' || ex === 'xls') return got === 'cfb';
        if (ex === 'rtf') return got === 'rtf';
        if (ex === 'txt') return got !== 'html'; // accept anything plausible
        // XML — accept anything that detectFormat classified as 'html'
        // (which covers `<?xml`, `<html`, and any other `<…>`-prefixed
        // payload). We don't distinguish XML from HTML at the magic-byte
        // level; the parser strips both safely.
        if (ex === 'xml') return got === 'html';
        // JSON — matches the 'json' detector, but ALSO be permissive when
        // the bytes are plain text starting with `{` or `[`. Some servers
        // serve JSON with surrogate framing or BOMs that detectFormat
        // doesn't classify as 'json'.
        if (ex === 'json') return got === 'json';
        return true; // unknown ext — be permissive
      };

      // --- multi-format text extractor (used for both top-level docs and ZIP entries)
      async function extractTextFromBuffer({ name, ext, bytes }, depth = 0) {
        if (!bytes || !bytes.length) return '';
        const ex = String(ext || '').toLowerCase();
        // Pre-sniff: jei magic baitai nebus tinkami, ekstraktoriaus visiškai
        // nešaukiam — taip išvengiam šimtų pdf-parse warning'ų ir nesusigadinam
        // log'o, jei mums grąžino HTML/JSON vietoj failo.
        if (!magicMatchesExt(bytes, ex)) {
          const got = detectFormat(bytes);
          console.log(`    ⚠️ ${ex.toUpperCase()} "${name}" magic mismatch (got=${got}, ${bytes.length}B) — skipping parse`);
          return '';
        }
        try {
          if (ex === 'pdf') {
            if (!pdfParse) return '';
            const parsed = await pdfParse(bytes);
            return (parsed && parsed.text ? parsed.text : '').trim();
          }
          if (ex === 'docx' || ex === 'odt') {
            if (!mammoth) return '';
            const out = await mammoth.extractRawText({ buffer: bytes });
            return (out && out.value ? out.value : '').trim();
          }
          if (ex === 'xlsx' || ex === 'xls' || ex === 'ods') {
            if (!XLSX) return '';
            const wb = XLSX.read(bytes, { type: 'buffer' });
            const parts = [];
            for (const sheetName of wb.SheetNames) {
              const csv = XLSX.utils.sheet_to_csv(wb.Sheets[sheetName]);
              if (csv && csv.trim()) parts.push(`# Sheet: ${sheetName}\n${csv}`);
            }
            return parts.join('\n\n').trim();
          }
          if (ex === 'rtf' || ex === 'txt') {
            // RTF — naivus stripping (curly braces + control words). Pakanka
            // raktažodžių paieškai. Pilna RTF parser'iai retai sutinkami EU
            // tenderiuose, tad nesivelti į priklausomybes.
            const raw = bytes.toString('utf8');
            if (ex === 'txt') return raw.trim();
            return raw
              .replace(/\\[a-z]+-?\d*\s?/gi, ' ')
              .replace(/[{}]/g, ' ')
              .replace(/\s+/g, ' ')
              .trim();
          }
          if (ex === 'xml') {
            // XML — naivus tag stripping. TED eForms XML talpina visus
            // mums reikalingus laukus (qualification criteria, award
            // criteria, lot scope, value). Schema sudėtinga (efbc:, efac:,
            // cbc:, cac: namespaces), bet text content'as suskaitomas po
            // tagų pašalinimo. Decode'inam XML entity'es — eForms turi
            // daug `&amp;`, `&#x2019;`, etc. Apkarpom žemyn iki MAX caps.
            const raw = bytes.toString('utf8');
            const stripped = raw
              // pašalinti CDATA wrapper'ius, paliekant turinį
              .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
              // pašalinti komentarus
              .replace(/<!--[\s\S]*?-->/g, ' ')
              // pašalinti processing instructions (<?xml ?>, <?xsl ?>)
              .replace(/<\?[\s\S]*?\?>/g, ' ')
              // pašalinti doctype
              .replace(/<!DOCTYPE[^>]*>/gi, ' ')
              // pašalinti VISUS XML/HTML tag'us
              .replace(/<\/?[a-zA-Z][^>]*>/g, ' ')
              // decode common entities
              .replace(/&amp;/g, '&')
              .replace(/&lt;/g, '<')
              .replace(/&gt;/g, '>')
              .replace(/&quot;/g, '"')
              .replace(/&apos;/g, "'")
              .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
                try { return String.fromCodePoint(parseInt(hex, 16)); }
                catch (_e) { return ' '; }
              })
              .replace(/&#(\d+);/g, (_, dec) => {
                try { return String.fromCodePoint(parseInt(dec, 10)); }
                catch (_e) { return ' '; }
              })
              // collapse whitespace
              .replace(/\s+/g, ' ')
              .trim();
            return stripped;
          }
          if (ex === 'json') {
            // JSON — UK FTS / Mercell-wrapped notice payloads. Try to
            // pretty-print so the AI extraction prompt sees a flat,
            // line-broken text representation of every key/value pair
            // (qualification, award criteria, lots, value). If parse
            // fails (rare; some servers wrap JSON in HTML), fall back
            // to raw UTF-8 text.
            const raw = bytes.toString('utf8').replace(/^\uFEFF/, '');
            try {
              const parsed = JSON.parse(raw);
              return JSON.stringify(parsed, null, 2).trim();
            } catch (_) {
              return raw.replace(/\s+/g, ' ').trim();
            }
          }
          if (ex === 'zip') {
            if (!AdmZip) return '';
            if (depth >= MAX_ZIP_DEPTH) {
              console.log(`    ⚠️ ZIP depth limit reached for "${name}"`);
              return '';
            }
            const zip = new AdmZip(bytes);
            const entries = zip.getEntries().filter(e => !e.isDirectory);
            // Score & sort entries — naudojam tą pačią scoreFile heuristiką
            const scored = entries.map(e => {
              const entryName = e.entryName || '';
              const entryExt = (entryName.match(/\.([a-z0-9]{1,5})$/i) || [])[1] || '';
              return {
                e,
                name: entryName,
                ext: entryExt.toLowerCase(),
                score: scoreFile(entryName),
              };
            });
            // Tik žinomi dokumentai (žinomos extension'os)
            const docEntries = scored
              .filter(s => DOC_EXTENSIONS.has(s.ext))
              .sort((a, b) => b.score - a.score)
              .slice(0, MAX_DOCS_PER_TENDER);
            const zipParts = [];
            for (const z of docEntries) {
              try {
                const innerBytes = z.e.getData();
                if (!innerBytes || innerBytes.length === 0) continue;
                if (innerBytes.length > MAX_INNER_BYTES) {
                  console.log(`    ⚠️ ZIP entry "${z.name}" too large (${innerBytes.length}B), skipping`);
                  continue;
                }
                const innerText = await extractTextFromBuffer(
                  { name: z.name, ext: z.ext, bytes: innerBytes },
                  depth + 1,
                );
                if (innerText) {
                  const clipped = innerText.slice(0, MAX_DOC_TEXT_CHARS);
                  zipParts.push(`--- (zip:${name}) ${z.name} ---\n${clipped}`);
                  console.log(`    📦 zip entry "${z.name}" (${z.ext}, ${innerBytes.length}B → ${clipped.length}ch)`);
                }
              } catch (e) {
                console.log(`    ⚠️ ZIP entry "${z.name}" failed: ${e.message}`);
              }
            }
            return zipParts.join('\n\n');
          }
        } catch (e) {
          console.log(`    ⚠️ ${ex.toUpperCase()} parse failed for "${name}": ${e.message}`);
          return '';
        }
        return '';
      }

      // --- Node-side https GET (no cookies, follows redirects) -------------
      //
      // Mercell now serves many attachments as presigned S3 URLs
      // (`old-dc-import-notices-prod.s3.eu-…amazonaws.com/...?X-Amz-Signature=...`).
      // These URLs are self-authenticating, but fetching them through
      // `page.evaluate(fetch, {credentials:'include'})` confuses S3 — the
      // browser sends Mercell session cookies + triggers a CORS preflight,
      // and S3 responds with an HTML/XML error page. So for any non-Mercell
      // URL we fetch from Node directly with no cookies; the presigned
      // signature is all S3 needs. Returns { ok, status, contentType, bytes:Buffer|null, error }.
      const isMercellHost = (url) => {
        try {
          const h = new URL(url).hostname.toLowerCase();
          return /(^|\.)mercell\.com$/.test(h);
        } catch (_) { return false; }
      };
      const fetchNode = (url, redirects = 5) => new Promise((resolve) => {
        try {
          const u = new URL(url);
          const lib = u.protocol === 'http:' ? require('http') : require('https');
          const req = lib.get({
            hostname: u.hostname,
            path: u.pathname + u.search,
            port: u.port || (u.protocol === 'http:' ? 80 : 443),
            // No `Cookie:` header on purpose — presigned URL is self-authenticating.
            // `Accept-Encoding: identity` so S3 doesn't return a gzip body that we'd
            // need to manually inflate; `Connection: close` so we don't reuse a
            // socket whose state could interfere across attempts.
            headers: {
              'User-Agent': 'Mozilla/5.0 (compatible; mercell-scraper/1.0)',
              'Accept': '*/*',
              'Accept-Encoding': 'identity',
              'Connection': 'close',
            },
            timeout: 30000,
          }, (res) => {
            // Follow redirects manually so we can keep the no-cookies posture
            // through the chain (S3 sometimes 302's to a different signed URL).
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
              const next = new URL(res.headers.location, url).toString();
              res.resume();
              fetchNode(next, redirects - 1).then(resolve);
              return;
            }
            const ct = res.headers['content-type'] || '';
            const chunks = [];
            res.on('data', (d) => chunks.push(d));
            res.on('end', () => {
              const bytes = Buffer.concat(chunks);
              resolve({
                ok: res.statusCode >= 200 && res.statusCode < 300,
                status: res.statusCode,
                contentType: ct,
                bytes,
                size: bytes.length,
              });
            });
            res.on('error', (e) => resolve({ ok: false, error: e.message }));
          });
          req.on('error', (e) => resolve({ ok: false, error: e.message }));
          req.on('timeout', () => { req.destroy(new Error('timeout')); });
        } catch (e) {
          resolve({ ok: false, error: e.message });
        }
      });

      // --- CDP-based fetch (browser network layer, bypasses CORS) -----------
      //
      // Diagnostic logs revealed that BOTH existing strategies fail for
      // Mercell attachments:
      //
      //  - NODE fetch of S3 presigned URL:
      //      `status=403 ct=application/xml sniff="<Error><Code>AccessDe…"`
      //    The presign in `fileReference` is signed for Mercell's own
      //    backend, not for end-user GET. AWS rejects with AccessDenied.
      //
      //  - PAGE fetch (page.evaluate) of file-service.discover.app.mercell.com:
      //      `status=? err=TypeError: Failed to fetch`
      //    file-service has no Access-Control-Allow-Origin header, so
      //    the browser blocks the cross-origin fetch BEFORE it reaches
      //    the network. (CORS is a JS-sandbox restriction.)
      //
      // Chrome DevTools Protocol's `Network.loadNetworkResource` runs at
      // the browser's *network* layer — it picks up the existing Mercell
      // session cookies (so file-service auth works), follows redirects
      // (so file-service → fresh presigned S3 URL works), and is NOT
      // subject to CORS. We open ONE CDP session per call to
      // fetchTenderDetails and reuse it across every candidate URL.
      let cdpSession = null;
      let cdpFrameId = null;
      // NOTE: Bearer-token injection via Network.setExtraHTTPHeaders has
      // been REMOVED. Empirically the captured token has /search/ audience
      // and search-service-api still 401s for /files/ endpoints, so the
      // injection had zero upside. It also broke 8/9 subsequent tender
      // navigations: enabling the Network domain + injecting headers on
      // the page's CDP session leaks state into page.goto() and the SPA
      // renders blank. We now skip Network.enable entirely and rely on
      // cookies (via includeCredentials) for any session auth.
      const ensureCdp = async () => {
        if (cdpSession) return cdpSession;
        try {
          cdpSession = await page.target().createCDPSession();
          const { frameTree } = await cdpSession.send('Page.getFrameTree');
          cdpFrameId = frameTree.frame.id;
          return cdpSession;
        } catch (e) {
          cdpSession = null;
          return null;
        }
      };
      // Detach the CDP session when we're done with this tender — orphaned
      // sessions accumulate per-tender and subtly affect page behavior.
      const detachCdp = async () => {
        if (!cdpSession) return;
        try { await cdpSession.detach(); } catch (_) { /* ignore */ }
        cdpSession = null;
        cdpFrameId = null;
      };
      // Drain a CDP IO.read stream into a Buffer. Returns Buffer.alloc(0)
      // on any error so the caller can still report status/headers.
      const drainCdpStream = async (sess, handle) => {
        const chunks = [];
        try {
          let done = false;
          for (let i = 0; i < 200 && !done; i++) {
            const chunk = await sess.send('IO.read', { handle });
            if (chunk && chunk.data) {
              chunks.push(Buffer.from(chunk.data, chunk.base64Encoded ? 'base64' : 'utf8'));
            }
            done = !!(chunk && chunk.eof);
          }
        } catch (_) { /* ignore */ }
        try { await sess.send('IO.close', { handle }); } catch (_) { /* ignore */ }
        return Buffer.concat(chunks);
      };
      const fetchViaCDP = async (url) => {
        try {
          const sess = await ensureCdp();
          if (!sess) return { ok: false, error: 'cdp-init-failed' };
          const r = await sess.send('Network.loadNetworkResource', {
            frameId: cdpFrameId,
            url,
            options: { disableCache: false, includeCredentials: true },
          });
          const resource = r && r.resource;
          if (!resource) return { ok: false, error: 'no-resource' };
          const status = resource.httpStatusCode || 0;
          const respHeaders = resource.headers || {};
          const ct = respHeaders['content-type']
            || respHeaders['Content-Type']
            || respHeaders['CONTENT-TYPE']
            || '';
          // Read body whether or not CDP marks success. CDP says
          // success=false for any non-2xx status, but the stream IS
          // populated and contains diagnostic XML/JSON — critical for
          // distinguishing "Request has expired" from "AccessDenied"
          // from "SignatureDoesNotMatch" on S3 presigned URLs.
          let bytes = Buffer.alloc(0);
          if (resource.stream) {
            bytes = await drainCdpStream(sess, resource.stream);
          }
          if (!resource.success) {
            return {
              ok: false,
              status,
              contentType: ct,
              error: resource.netErrorName || 'load-failed',
              bytes,
              size: bytes.length,
            };
          }
          return {
            ok: status >= 200 && status < 300,
            status,
            contentType: ct,
            bytes,
            size: bytes.length,
          };
        } catch (e) {
          return { ok: false, error: String(e && e.message || e) };
        }
      };

      // --- PUBLIC NOTICE FETCH (TED / Find-a-Tender / Doffin / etc.) -----
      //
      // Mercell's own file storage is locked behind two unbreakable walls:
      //   - S3 presigned URLs in `fileReference` are signed for the
      //     backend, not for end-user GET → AccessDenied (403).
      //   - search-service-api `/files/` endpoints want a Bearer with
      //     `/files/` audience, but our captured token has `/search/`.
      //
      // Mercell's tender JSON, however, contains references to the
      // ORIGINAL public notice (TED, UK Find-a-Tender, Doffin, etc.) —
      // either as a direct URL field or as a publication number that maps
      // to a canonical public URL. Those public pages serve the same
      // qualification / award criteria / lot scope / contract value
      // content as the Mercell-internal copy, but require NO auth and
      // NO CORS. We harvest them here and fetch via plain Node HTTP,
      // bypassing the entire Mercell auth wall.
      const publicNoticeUrls = [];
      {
        const seenPubUrls = new Set();
        const PUBLIC_HOSTS = /(?:^|\.)(ted\.europa\.eu|find-tender\.service\.gov\.uk|contractsfinder\.service\.gov\.uk|doffin\.no|hilma\.fi)$/i;
        const TED_REF_RE = /^\d{6,8}-\d{4}$/;
        const pushPublic = (rawUrl, label) => {
          if (!rawUrl) return;
          let u;
          try { u = new URL(String(rawUrl).trim()); } catch (_) { return; }
          if (!PUBLIC_HOSTS.test(u.hostname)) return;
          const key = u.toString();
          if (seenPubUrls.has(key)) return;
          seenPubUrls.add(key);
          publicNoticeUrls.push({ url: key, label: label || u.hostname });
        };
        const walkPublic = (node) => {
          if (!node || typeof node !== 'object') return;
          if (Array.isArray(node)) { for (const it of node) walkPublic(it); return; }
          for (const [k, v] of Object.entries(node)) {
            if (v == null) continue;
            if (typeof v === 'string') {
              const s = v.trim();
              if (/^https?:\/\//i.test(s)) {
                // Only consider URL-shaped strings whose key suggests
                // they're a *notice* link (not a logo, profile, banner).
                if (/url|link|href|source|notice|publication/i.test(k)) {
                  pushPublic(s, `${k}`);
                }
              } else if (
                TED_REF_RE.test(s) &&
                /reference|publication|notice/i.test(k)
              ) {
                // TED publication-number style → canonical TED URL.
                // Pattern matches both old (188432-2026) and new
                // (00288908-2026) eForms-era IDs.
                pushPublic(`https://ted.europa.eu/en/notice/-/detail/${s}`, `${k}->ted`);
              }
            } else if (typeof v === 'object') {
              walkPublic(v);
            }
          }
        };
        for (const { json } of capturedApis) walkPublic(json);
      }

      const publicNoticeTexts = [];
      if (publicNoticeUrls.length) {
        const preview = publicNoticeUrls
          .slice(0, 4)
          .map(p => `[${p.label}] ${p.url.slice(0, 70)}`)
          .join('; ');
        const tail = publicNoticeUrls.length > 4 ? ` (+${publicNoticeUrls.length - 4} more)` : '';
        console.log(`    🌐 public notice URLs: ${publicNoticeUrls.length} — ${preview}${tail}`);
        // Cap at 4 fetches per tender — these pages can be large and
        // we want to leave context budget for any Mercell-internal docs
        // that DO succeed.
        const toFetch = publicNoticeUrls.slice(0, 4);
        for (const p of toFetch) {
          let result;
          try {
            result = await fetchNode(p.url);
          } catch (e) {
            result = { ok: false, error: String(e && e.message || e) };
          }
          if (!result || !result.ok || !(result.size > 100)) {
            const statusTail = result && result.status != null ? `, status=${result.status}` : '';
            const errTail = result && result.error ? `, err=${String(result.error).slice(0, 60)}` : '';
            console.log(`    ⚠️ public notice fetch failed: ${p.url.slice(0, 70)}${statusTail}${errTail}`);
            continue;
          }
          // Sniff actual format from magic bytes — public-notice URLs
          // sometimes resolve to a ZIP attachment (Find-a-Tender's
          // /Notice/Attachment/A-… serves a 70KB ZIP of XML/PDF) or a
          // direct PDF. If we blindly passed ext='xml' here the
          // magic-mismatch guard in extractTextFromBuffer would skip
          // everything. Map the detected format → an extension the
          // multi-format extractor knows how to dispatch on, then let
          // it recurse into ZIP entries / parse PDF / strip XML/HTML
          // as appropriate.
          let detectedFmt = 'unknown';
          try { detectedFmt = detectFormat(result.bytes); } catch (_) {}
          // URL-tail hint as a tiebreaker for cases where the body
          // didn't match a known magic (e.g. plain text manifest).
          let urlExt = '';
          try {
            const urlPath = new URL(p.url).pathname.toLowerCase();
            urlExt = (urlPath.match(/\.([a-z0-9]{1,5})$/) || [])[1] || '';
          } catch (_) {}
          let parseExt;
          if (detectedFmt === 'zip') parseExt = 'zip';
          else if (detectedFmt === 'pdf') parseExt = 'pdf';
          else if (detectedFmt === 'cfb') parseExt = (urlExt === 'xls' ? 'xls' : 'doc');
          else if (detectedFmt === 'rtf') parseExt = 'rtf';
          else if (detectedFmt === 'json') parseExt = 'json';
          else if (detectedFmt === 'html') parseExt = 'xml'; // HTML/XML — strip-tag path
          else parseExt = (urlExt && /^(pdf|zip|docx|xlsx|odt|ods|doc|xls|rtf|json|xml|html|htm|txt)$/.test(urlExt))
            ? (urlExt === 'htm' || urlExt === 'html' ? 'xml' : urlExt)
            : 'xml';
          let text = '';
          try {
            text = await extractTextFromBuffer(
              { name: p.label, ext: parseExt, bytes: result.bytes },
              0,
            );
          } catch (e) {
            console.log(`    ⚠️ public notice extractor failed for ${p.url.slice(0, 70)}: ${e.message}`);
            continue;
          }
          if (!text) {
            console.log(`    ⚠️ public notice empty after extract (fmt=${detectedFmt}, ext=${parseExt}): ${p.url.slice(0, 70)}`);
            continue;
          }
          const clipped = text.slice(0, MAX_DOC_TEXT_CHARS);
          publicNoticeTexts.push(`--- (public:${p.label}) ${p.url} ---\n${clipped}`);
          console.log(`    🌐 parsed public notice (${result.size}B/${detectedFmt} -> ${clipped.length}ch from ${p.url.slice(0, 70)})`);
        }
      }

      if (collectedFiles.length) {
        const docTexts = [];
        const toFetch = collectedFiles.slice(0, MAX_DOCS_PER_TENDER);

        for (const f of toFetch) {
          // Bandomi URL šablonai (vienas iš jų suveiks). Pirmas — jei JSON'e
          // jau buvo `url`/`downloadUrl` laukas. Plėtėm sąrašą — file-service
          // kartais grąžina HTML login wall'ą ir mums reikia kito host.
          const candidates = [];
          if (f.url) candidates.push(f.url);
          // `fileReference` Mercell'yje yra... ne GUID, o pilnas presigned S3
          // URL (`https://old-dc-import-notices-prod.s3.eu-...amazonaws.com/...
          // ?X-Amz-Signature=...`). Naudojam tiesiogiai, jokio template'inimo.
          // Jei kažkada Mercell'is pakeis ir pradės tiekti GUID'ą, fallback'as
          // suklaps į template'ą.
          if (f.ref) {
            const refStr = String(f.ref).trim();
            if (/^https?:\/\//i.test(refStr)) {
              // Direct URL — paduodam kaip yra
              candidates.push(refStr);
            } else {
              // GUID-style — template'inam į žinomus endpoint'us.
              // file-service.discover.app.mercell.com PAŠALINTAS —
              // DNS NXDOMAIN, host'as neegzistuoja. Prieš tai gaišom 4
              // candidate'us per failą bandydami nepasiekiamą subdomeną.
              candidates.push(
                `https://search-service-api.discover.app.mercell.com/api/v1/files/${refStr}/download`,
                `https://search-service-api.discover.app.mercell.com/api/v1/files/${refStr}`,
                `https://app.mercell.com/files/${refStr}/download`,
                `https://app.mercell.com/api/v1/files/${refStr}`,
                `https://permalink.mercell.com/api/v1/files/${refStr}/download`,
              );
            }
          }
          // Integer ID variantai kaip fallback'as — kartais Mercell'is juos
          // priima legacy endpoint'uose. (file-service.* irgi pašalintas
          // čia — žr. komentarą aukščiau.)
          candidates.push(
            // search-service-api — pagrindinis API host'as. Su captured
            // Bearer'iu turėtų grąžinti file content arba presigned URL.
            `https://search-service-api.discover.app.mercell.com/api/v1/files/${f.id}/download`,
            `https://search-service-api.discover.app.mercell.com/api/v1/files/${f.id}`,
            // app.mercell.com legacy
            `https://app.mercell.com/files/${f.id}/download`,
            `https://app.mercell.com/api/v1/files/${f.id}`,
            // permalink.mercell.com (kartais procurement docs ten kabo)
            `https://permalink.mercell.com/api/v1/files/${f.id}/download`,
          );

          let bytes = null;
          let okUrl = null;
          let lastFormat = null;
          let lastStatus = null;
          let lastContentType = null;
          let lastError = null;
          // per-attempt trace, dumped if we can't fetch — invaluable for
          // diagnosing why an entire batch comes back as ct=text/html.
          const attemptTrace = [];
          // Helper: build "PATH host status=… ct=… size=… sniff="…" err=…"
          // line and push onto attemptTrace. Centralizing this keeps the
          // CDP/NODE/PAGE branches identical in their tracing.
          const pushTrace = (label, host, result) => {
            const parts = [`${label} ${host}`];
            if (result) {
              if (result.status != null) parts.push(`status=${result.status}`);
              else parts.push('status=?');
              if (result.contentType) parts.push(`ct=${String(result.contentType).slice(0, 30)}`);
              if (typeof result.size === 'number') parts.push(`size=${result.size}`);
              const tmpBytes = result.bytes || (Array.isArray(result.data) ? Buffer.from(result.data) : null);
              if (tmpBytes && tmpBytes.length) {
                // 180ch (was 60) so full S3 <Error><Message>…</Message>
                // bodies are visible — needed to distinguish "Request has
                // expired" from "SignatureDoesNotMatch" from "AccessDenied".
                const sniff = tmpBytes.slice(0, 180).toString('utf8').replace(/\s+/g, ' ').slice(0, 180);
                parts.push(`sniff="${sniff}"`);
              }
              if (result.error) parts.push(`err=${String(result.error).slice(0, 80)}`);
            } else {
              parts.push('NO_RESULT');
            }
            attemptTrace.push(parts.join(' '));
          };
          // Per-URL fetch with CDP-first, NODE/PAGE fallback. CDP wins for
          // virtually everything because it runs at the browser network
          // layer (cookies + no CORS + follows redirects). We only fall
          // back when CDP itself errors at the transport level (cdp-init,
          // net::ERR_*, etc.) — if CDP returns a real HTTP response (even
          // 403/404), that's the truth and we use it.
          for (const u of candidates) {
            let host = '?';
            try { host = new URL(u).hostname; } catch (_) { /* ignore */ }
            const fallbackLabel = isMercellHost(u) ? 'PAGE' : 'NODE';
            const fallbackFetch = async () => {
              if (isMercellHost(u)) {
                // Mercell-internal fallback — page.evaluate keeps cookies
                // but is CORS-blocked for cross-subdomain calls. Kept as
                // a last resort in case CDP is unavailable.
                let r;
                try {
                  r = await page.evaluate(async (url) => {
                    try {
                      const rr = await fetch(url, { credentials: 'include' });
                      const ct = rr.headers.get('content-type') || '';
                      if (!rr.ok) return { ok: false, status: rr.status, contentType: ct };
                      const buf = await rr.arrayBuffer();
                      const arr = Array.from(new Uint8Array(buf));
                      return { ok: true, status: rr.status, contentType: ct, data: arr, size: arr.length };
                    } catch (e) {
                      return { ok: false, error: String(e) };
                    }
                  }, u);
                } catch (e) {
                  return { ok: false, error: String(e && e.message || e) };
                }
                if (r && r.ok && Array.isArray(r.data)) {
                  r = { ...r, bytes: Buffer.from(r.data) };
                }
                return r;
              }
              // Non-Mercell fallback — Node fetch (no cookies, no CORS).
              return fetchNode(u);
            };

            // Attempt 1: CDP
            let result;
            try {
              result = await fetchViaCDP(u);
            } catch (e) {
              result = { ok: false, error: String(e && e.message || e) };
            }
            pushTrace('CDP', host, result);

            // Did CDP return a real HTTP response? If yes, trust it. If
            // no (transport-level failure with no status), fall back.
            const cdpReachedServer = result && (result.ok || (result.status != null && result.status > 0));
            if (!cdpReachedServer) {
              try {
                result = await fallbackFetch();
              } catch (e) {
                result = { ok: false, error: String(e && e.message || e) };
              }
              pushTrace(fallbackLabel, host, result);
            }

            if (result && result.ok && (result.size || 0) > 100) {
              const tmpBytes = result.bytes || Buffer.from(result.data || []);
              lastStatus = result.status;
              lastContentType = result.contentType;
              lastFormat = detectFormat(tmpBytes);
              if (magicMatchesExt(tmpBytes, f.ext)) {
                bytes = tmpBytes;
                okUrl = u;
                break;
              }
            } else if (result && !result.ok) {
              if (result.status != null) lastStatus = result.status;
              if (!lastContentType && result.contentType) lastContentType = result.contentType;
              if (result.error) lastError = String(result.error).slice(0, 80);
            }
          }

          if (!bytes) {
            const ctTail = lastContentType ? `, ct=${lastContentType.slice(0, 40)}` : '';
            const fmtTail = lastFormat ? `, got=${lastFormat}` : '';
            const statusTail = (lastStatus != null) ? `, last=${lastStatus}` : '';
            const errTail = lastError ? `, err=${lastError}` : '';
            const refLen = f.ref ? String(f.ref).length : 0;
            const refTail = f.ref
              ? `, ref=${String(f.ref).slice(0, 40)}…(len=${refLen})`
              : ', ref=NONE';
            console.log(`    ⚠️ could not fetch ${f.ext.toUpperCase()} "${f.name}" (id=${f.id}${refTail}${statusTail}${ctTail}${fmtTail}${errTail})`);
            // Dump per-attempt trace so we can see WHICH URLs were tried
            // and what each returned — critical when whole batches fail.
            // Bumped from 8 to 14 because each URL now contributes up to
            // 2 entries (CDP + fallback), and we want full coverage of
            // the typical 8-candidate search.
            for (const t of attemptTrace.slice(0, 14)) {
              console.log(`      · ${t}`);
            }
            continue;
          }

          try {
            const text = await extractTextFromBuffer({ name: f.name, ext: f.ext, bytes }, 0);
            if (text) {
              const clipped = text.slice(0, MAX_DOC_TEXT_CHARS);
              docTexts.push(`--- ${f.name} ---\n${clipped}`);
              console.log(`    📄 parsed ${f.ext.toUpperCase()} "${f.name}" (${bytes.length}B → ${clipped.length}ch from ${okUrl.slice(0, 70)})`);
            } else {
              console.log(`    ⚠️ ${f.ext.toUpperCase()} "${f.name}" has no extractable text`);
            }
          } catch (e) {
            console.log(`    ⚠️ extractor failed for "${f.name}": ${e.message}`);
          }
        }

        if (docTexts.length) {
          const combined = docTexts.join('\n\n');
          // Bendrai ribokime per tender'į iki 120K chars — Claude Haiku 4.5 turi
          // 200K context'ą, tad palieam vietos title'ui, description'ui ir
          // sistemos prompt'ui. Nesutrumpinta — taip AI mato visą ToR turinį.
          details.pdfText = combined.slice(0, MAX_TOTAL_DOC_CHARS);
        }
      }

      // Merge public notice text on top of any Mercell-internal doc text.
      // Public notices go FIRST so the AI sees verbatim qualification /
      // award-criteria language from TED/FTS before any contract-specific
      // attachments. This block runs even when collectedFiles was empty —
      // many tenders have ONLY a public-notice reference, no attachments.
      if (publicNoticeTexts.length) {
        const publicCombined = publicNoticeTexts.join('\n\n');
        const existing = details.pdfText || '';
        const merged = existing
          ? `${publicCombined}\n\n${existing}`
          : publicCombined;
        details.pdfText = merged.slice(0, MAX_TOTAL_DOC_CHARS);
      }
    } catch (e) {
      console.log(`    ⚠️ document extraction error: ${e.message}`);
    } finally {
      // Detach the per-tender CDP session so orphaned sessions don't
      // accumulate on the page target — leaving them attached over many
      // tenders correlates with subsequent page.goto()s rendering blank
      // (`WARN: no h1/content`) and the response sniffer capturing 0
      // APIs. Detach is best-effort; ignore errors.
      try { await detachCdp(); } catch (_) { /* ignore */ }
    }

    // --- ŠALTINIO PUSLAPIS -------------------------------------------
    if (details.sourceUrl) {
      console.log(`    → source: ${details.sourceUrl.slice(0, 80)}`);
      const t0 = Date.now();
      const src = await fetchSourcePageDetails(browser, details.sourceUrl);
      const elapsed = Date.now() - t0;
      console.log(`    source done in ${elapsed}ms (host: ${src?.sourceHost || 'n/a'}, err: ${src?.error || 'none'}${src?.skipped ? ', skipped: ' + src.skipped : ''}${src?.placspDocsFound ? `, placsp=${src.placspDocsFound}` : ''})`);

      // PLACSP-specific diagnostic so we can see why 0 priority docs
      // were found on contrataciondelestado.es pages even when the
      // detail page rendered. Shows total anchors, text-pattern hits,
      // url-pattern hits, plus a sample of first 6 anchor texts.
      if (src?.placspStats) {
        const ps = src.placspStats;
        const sample = (ps.sampleTexts || []).map(t => `"${t}"`).join(', ');
        console.log(`    🇪🇸 PLACSP stats: anchors=${ps.totalAnchors}, textMatches=${ps.textMatches}, urlMatches=${ps.urlMatches}; sample=[${sample}]`);
      }

      if (src?.skipped) {
        // Mercell-internis permalink'as — nefetchinam, tik paliekam žymę.
        details.sourceHost = src.sourceHost || null;
        details.sourceSkipped = src.skipped;
      } else if (src?.loginGated) {
        // Login-gated portal'as (UK MyTenders, Jaggaer, Bravo, DTVP, ...)
        // — realaus turinio nepaseiksim be autentifikacijos. Pirma bandom
        // prisijungti su PORTAL_CREDS_JSON paslaptyje saugomais
        // credentials'ais; jei pavyksta, persifetchinam šaltinio puslapį
        // ir traukiame qualification laukus iš autentikuoto DOM'o.
        console.log(
          `    source login-gated (host: ${src.sourceHost}, markers: ${src.matchedMarkers}, ` +
          `bodyLen: ${src.bodyLength}, passwordField: ${src.hasPasswordField})`
        );
        details.sourceHost = src.sourceHost || null;
        const creds = getPortalCreds(src.sourceHost || details.sourceUrl);
        let postLoginSrc = null;
        if (creds && creds.password) {
          console.log(`    🔑 portal creds found for ${src.sourceHost}`);
          console.log(`    🔐 logging in to ${src.sourceHost} ...`);
          const ok = await attemptPortalLogin(
            browser, details.sourceUrl, creds, src.sourceHost
          );
          if (ok) {
            const t1 = Date.now();
            postLoginSrc = await fetchSourcePageDetails(browser, details.sourceUrl);
            console.log(
              `    🔁 post-login source fetch: ${Date.now() - t1}ms ` +
              `(gated=${!!postLoginSrc?.loginGated}, err=${postLoginSrc?.error || 'none'})`
            );
          }
        } else {
          console.log(`    ℹ️  no portal creds configured for ${src.sourceHost}`);
        }
        if (postLoginSrc && !postLoginSrc.loginGated && !postLoginSrc.error) {
          // Reuse the same per-field extraction the success branch does.
          const srcFieldSummary = {};
          for (const key of [
            'maxBudget',
            'duration',
            'requirementsForSupplier',
            'qualificationRequirements',
            'offerWeighingCriteria',
            'scopeOfAgreement',
            'technicalStack',
          ]) {
            const v = postLoginSrc[key];
            srcFieldSummary[key] = v
              ? `${String(v).length}ch: ${String(v).slice(0, 60).replace(/\s+/g, ' ')}`
              : null;
            if (v) details[key] = v;
          }
          console.log(`    source fields (post-login):`, JSON.stringify(srcFieldSummary));
          if (postLoginSrc.bodyTextPreview) {
            console.log(
              `    source body preview (first 300ch): ` +
              postLoginSrc.bodyTextPreview.slice(0, 300).replace(/\s+/g, ' ')
            );
          }
          if (!details.referenceNumber && postLoginSrc.referenceNumberSource) {
            details.referenceNumber = postLoginSrc.referenceNumberSource;
          }
          if (postLoginSrc.sourceFilesText && postLoginSrc.sourceFilesText.length) {
            const HARD_CAP = 200000;
            const existing = details.pdfText || '';
            const sep = existing ? '\n\n' : '';
            const combined = (existing + sep + postLoginSrc.sourceFilesText).slice(0, HARD_CAP);
            details.pdfText = combined;
            console.log(
              `    → merged ${postLoginSrc.sourceFilesText.length}ch of source-page docs into pdfText ` +
              `(total now ${combined.length}ch)`
            );
          }
          details.sourceLoggedIn = true;
        } else {
          details.sourceSkipped = 'login-gated';
        }
      } else if (src && !src.error) {
        // Per-field logging — matome ką šaltinio puslapis grąžino
        const srcFieldSummary = {};
        for (const key of [
          'maxBudget',
          'duration',
          'requirementsForSupplier',
          'qualificationRequirements',
          'offerWeighingCriteria',
          'scopeOfAgreement',
          'technicalStack',
        ]) {
          const v = src[key];
          srcFieldSummary[key] = v ? `${String(v).length}ch: ${String(v).slice(0, 60).replace(/\s+/g, ' ')}` : null;
          if (v) details[key] = v;
        }
        console.log(`    source fields:`, JSON.stringify(srcFieldSummary));
        if (src.bodyTextPreview) {
          console.log(`    source body preview (first 300ch): ${src.bodyTextPreview.slice(0, 300).replace(/\s+/g, ' ')}`);
        }
        if (!details.referenceNumber && src.referenceNumberSource) {
          details.referenceNumber = src.referenceNumberSource;
        }
        details.sourceHost = src.sourceHost || null;

        // Append parsed source-page document text (e.g. simap.ch
        // attachments revealed via "Interesse bekunden") into the same
        // pdfText pool the AI extractor reads. Cap total to 200K so we
        // stay inside Claude Haiku 4.5's 200K context with margin for
        // title/description/system prompt.
        if (src.sourceFilesText && src.sourceFilesText.length) {
          const HARD_CAP = 200000;
          const existing = details.pdfText || '';
          const sep = existing ? '\n\n' : '';
          const combined = (existing + sep + src.sourceFilesText).slice(0, HARD_CAP);
          details.pdfText = combined;
          console.log(`    → merged ${src.sourceFilesText.length}ch of source-page docs into pdfText (total now ${combined.length}ch)`);
        }
        if (src.simapInterestClicked) {
          details.simapInterestClicked = true;
        }
      } else {
        details.sourceFetchError = src?.error || 'unknown';
      }
    } else {
      console.log('    (no "Go to source" button / data-linkurl)');
    }

    return details;

  } catch (e) {
    try {
      if (blockHandler) page.off('request', blockHandler);
      await page.setRequestInterception(false);
    } catch (_) {}
    try {
      if (responseHandler) page.off('response', responseHandler);
    } catch (_) {}
    return { error: e.message || String(e) };
  }
}

// --- RETRANSLATE_STALE BACKFILL ----------------------------------------
// One-shot mode: when env var RETRANSLATE_STALE=1, scan the sheet for rows
// whose TITLE (col D) or SCOPE (col M) look like non-English strings that
// snuck through during a prior run when AI was failing (credit balance
// exhausted, transient 5xx, etc.). Re-run translateToEnglish on just those
// two columns and patch the cells in place via spreadsheets.values.batchUpdate
// — does NOT touch other columns (E-L hold organisation/budget/requirements
// /qualifications/criteria, which would be unsafe to clobber blindly without
// re-fetching the source notice).
//
// On any non-retryable AI error (credits exhausted again, 401/403),
// the pass aborts immediately so we don't loop pointlessly.
async function runRetranslateStale(sheets, SHEET_ID, TAB_NAME) {
  console.log('=== RETRANSLATE_STALE START ===');
  if (!AI_ENABLED) {
    console.log('⚠️ AI disabled — cannot translate. Set ANTHROPIC_API_KEY and re-run.');
    return;
  }
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${TAB_NAME}!A1:Q`,
  });
  const rows = resp.data.values || [];
  if (rows.length === 0) {
    console.log('Sheet is empty — nothing to backfill.');
    return;
  }
  const hasHeader = rows[0] && /DATE OF WHEN ADDED/i.test(rows[0][0] || '');
  const dataStart = hasHeader ? 1 : 0;
  console.log(`Read ${rows.length} rows (header: ${hasHeader}, data rows: ${rows.length - dataStart})`);

  // Same heuristic family as translateToEnglish: flags rows whose visible
  // text contains either non-English diacritics or non-English stopwords,
  // OR contains any non-ASCII byte at all (catches the case where the
  // string is a single non-English noun phrase with no stopword and no
  // diacritic — those would slip past otherwise).
  function looksNonEnglish(s) {
    if (!s) return false;
    const trimmed = String(s).trim();
    if (!trimmed) return false;
    const hasNonAscii = /[^\x00-\x7F]/.test(trimmed);
    const hasNonEnglishDiacritic = /[äöüßñçéèêáíóúîôûàèìòùâêîôûãõÿøœæåÄÖÜÑÉÈÊÁÍÓÚÎÔÛÃÕŸØŒÆÅąčęėįšųūžĄČĘĖĮŠŲŪŽćłńóśźżĆŁŃÓŚŹŻďěňřťůýĎĚŇŘŤŮÝĺŕĹŔőűŐŰ]/.test(trimmed);
    const hasNonEnglishStopword = /\b(?:och|und|der|die|den|das|dem|für|mit|auf|bei|nach|ist|sind|wir|sie|ihr|het|van|een|voor|naar|niet|wel|als|aan|maar|ook|waar|dan|alleen|geen|meer|kan|el|la|los|las|para|del|por|que|con|una|uno|les|pour|sur|avec|sans|dans|sous|dei|delle|della|degli|alla|allo|zur|zum|med|till|fra|men|att|som|inte|eller|ir|su|dėl|kad|yra|kaip|arba|taip|šis|tas|tos|kas|kuris|todėl|prie|po|nuo|iki|w|na|dla|z|ze|nie|jest|się|że|do|oraz|który|przez|przy|jako|lub|jeśli|a|je|ve|by|se|nebo|pokud|však|neboť|vo|zo|sa|alebo|preto|ja|on|ei|et|ka|oma|või|kui|aga|és|az|egy|hogy|vagy|van|nem|csak|már|u|li|nije|ali|ima|kao|samo)\b/i.test(trimmed);
    return hasNonAscii || hasNonEnglishDiacritic || hasNonEnglishStopword;
  }

  const updates = []; // pending batchUpdate payload: [{ range, values }]
  let scanned = 0, candidates = 0, translated = 0;
  let aborted = false;

  async function flushUpdates(label) {
    if (!updates.length) return;
    try {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: { valueInputOption: 'RAW', data: updates.splice(0) },
      });
      console.log(`  💾 flushed ${label} (${translated} cells so far)`);
    } catch (e) {
      console.log(`  ⚠️ batchUpdate failed (${label}): ${e.message}`);
    }
  }

  for (let i = dataStart; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    scanned++;
    const sheetRow = i + 1; // Sheets API rows are 1-indexed
    const title = (r[3] || '').toString();   // col D — TENDER NAME
    const scope = (r[12] || '').toString();  // col M — SCOPE OF AGREEMENT

    const titleStale = looksNonEnglish(title);
    const scopeStale = looksNonEnglish(scope);
    if (!titleStale && !scopeStale) continue;
    candidates++;

    // Reset per-row failure flag — _markAiFailure() will re-set it if a
    // non-retryable error fires.
    _lastAiNonRetryableError = null;

    if (titleStale) {
      const titleEn = await translateToEnglish(title, {
        hint: 'Public tender title',
        skipHeuristic: true,
      });
      if (titleEn && titleEn.trim() !== title.trim()) {
        updates.push({ range: `${TAB_NAME}!D${sheetRow}`, values: [[titleEn]] });
        translated++;
        console.log(`  [${sheetRow}] D: "${title.slice(0, 50)}" → "${titleEn.slice(0, 50)}"`);
      } else {
        console.log(`  [${sheetRow}] D: no change (echoed/empty)`);
      }
    }

    if (_lastAiNonRetryableError) {
      console.log(`⛔ AI non-retryable error (${_lastAiNonRetryableError}) — aborting backfill.`);
      aborted = true;
      break;
    }

    if (scopeStale) {
      const scopeEn = await translateToEnglish(scope, { hint: 'Public tender scope of agreement' });
      if (scopeEn && scopeEn.trim() !== scope.trim()) {
        updates.push({ range: `${TAB_NAME}!M${sheetRow}`, values: [[scopeEn]] });
        translated++;
        console.log(`  [${sheetRow}] M: scope translated (${scope.length}ch → ${scopeEn.length}ch)`);
      } else {
        console.log(`  [${sheetRow}] M: no change (echoed/empty)`);
      }
    }

    if (_lastAiNonRetryableError) {
      console.log(`⛔ AI non-retryable error (${_lastAiNonRetryableError}) — aborting backfill.`);
      aborted = true;
      break;
    }

    // Periodic flush so partial progress survives a crash.
    if (updates.length >= 50) {
      await flushUpdates('batch');
    }

    await new Promise(res => setTimeout(res, 500));
  }

  // Final flush.
  await flushUpdates('final');

  console.log('=== RETRANSLATE_STALE DONE ===');
  console.log(`Scanned: ${scanned}, candidates: ${candidates}, cells translated: ${translated}, aborted: ${aborted}`);
}

// --- MAIN SCRAPER FUNKCIJA --------------------------------------------

async function runScraper() {
  console.log('=== MERCELL SCRAPER START ===');
  console.log('Test mode:', TEST_MODE);
  console.log('Max tenders:', MAX_TENDERS);

  console.log('ENV CHECK:', {
    hasServiceAccountKey: !!process.env.GOOGLE_SERVICE_ACCOUNT_KEY,
    hasSheetId: !!process.env.GOOGLE_SHEET_ID,
    hasUsername: !!process.env.MERCELL_USERNAME,
    hasPassword: !!process.env.MERCELL_PASSWORD,
    hasAnthropicKey: AI_ENABLED,
    aiModel: AI_ENABLED ? AI_MODEL : '(disabled)',
  });

  if (!AI_ENABLED) {
    console.log('');
    console.log('==========================================================');
    console.log('⚠️  ANTHROPIC_API_KEY NOT SET — AI is DISABLED');
    console.log('   → Tender titles & scope will NOT be translated to English');
    console.log('   → maxBudget / requirements / qualifications / criteria');
    console.log('     will NOT be filled from source text when Mercell JSON');
    console.log('     does not carry them.');
    console.log('   To enable:');
    console.log('     1. Add ANTHROPIC_API_KEY to GitHub repo Settings →');
    console.log('        Secrets and variables → Actions → New repository secret.');
    console.log('     2. In .github/workflows/*.yml under the scraper step, add:');
    console.log('          env:');
    console.log('            ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}');
    console.log('==========================================================');
    console.log('');
  } else {
    console.log(`✓ AI enabled (model: ${AI_MODEL})`);
  }

  // --- RETRANSLATE_STALE EARLY BRANCH ---------------------------------
  // Backfill-only mode: skip Mercell scraping entirely. Read the sheet,
  // re-translate stale TITLE/SCOPE cells in place, exit. Doesn't touch
  // requirements/qualifications/criteria — those need source text we
  // don't have at backfill time. Trigger with: RETRANSLATE_STALE=1.
  if (process.env.RETRANSLATE_STALE === '1' || process.env.RETRANSLATE_STALE === 'true') {
    console.log('=== RETRANSLATE_STALE MODE — backfill only, no scraping ===');
    if (!AI_ENABLED) {
      console.log('⚠️ ANTHROPIC_API_KEY missing — cannot translate. Aborting.');
      return;
    }
    if (!process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY env var is missing');
    }
    if (!process.env.GOOGLE_SHEET_ID) {
      throw new Error('GOOGLE_SHEET_ID env var is missing');
    }
    const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
    const jwt = new google.auth.JWT({
      email: serviceAccount.client_email,
      key: serviceAccount.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    await jwt.authorize();
    const sheets = google.sheets({ version: 'v4', auth: jwt });
    const SHEET_ID = process.env.GOOGLE_SHEET_ID;
    const TAB_NAME = process.env.SHEET_TAB_NAME || 'Sheet1';
    await runRetranslateStale(sheets, SHEET_ID, TAB_NAME);
    return;
  }

  if (!process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY env var is missing');
  }
  if (!process.env.GOOGLE_SHEET_ID) {
    throw new Error('GOOGLE_SHEET_ID env var is missing');
  }
  if (!process.env.MERCELL_USERNAME || !process.env.MERCELL_PASSWORD) {
    throw new Error('MERCELL_USERNAME or MERCELL_PASSWORD is missing');
  }

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage();
    page.on('response', (res) => {
      if (res.url().includes('mercell.com') && res.request().resourceType() === 'xhr') {
        console.log('XHR:', res.url());
      }
    });
    page.setDefaultNavigationTimeout(120000);
    page.setDefaultTimeout(120000);

    // ---- LOGIN ----
    console.log('--- LOGIN ---');
    await page.goto('https://app.mercell.com/auth/login/challenge/password', {
      waitUntil: 'domcontentloaded',
      timeout: 120000,
    });

    try {
      await page.waitForFunction(
        () => /Cookie preferences|Accept all|Accept essentials/i.test(document.body.innerText),
        { timeout: 5000 }
      );
      await clickButtonContainsText(page, 'Accept essentials');
      await clickButtonContainsText(page, 'Accept all');
      await clickButtonContainsText(page, 'Accept');
    } catch (_) {}

    await page.waitForSelector('#email', { timeout: 15000 });
    await page.click('#email', { clickCount: 3 });
    await page.type('#email', process.env.MERCELL_USERNAME, { delay: 20 });

    await Promise.all([
      (async () => {
        const clicked =
          (await clickButtonContainsText(page, 'Continue')) ||
          (await clickButtonContainsText(page, 'Next'));
        if (!clicked) {
          const submit = await page.$('button[type="submit"]');
          if (!submit) throw new Error('Continue/Next button not found');
          await submit.click();
        }
      })(),
      page.waitForSelector('input[name="password"][type="password"]', { timeout: 60000 }),
    ]);

    await page.waitForSelector('input[name="password"][type="password"]', { timeout: 15000 });
    await page.click('input[name="password"][type="password"]', { clickCount: 3 });
    await page.type('input[name="password"][type="password"]', process.env.MERCELL_PASSWORD, { delay: 20 });

    const clickedLogin =
      (await clickButtonContainsText(page, 'Log in')) ||
      (await clickButtonContainsText(page, 'Login')) ||
      (await clickButtonContainsText(page, 'Sign in'));
    if (!clickedLogin) {
      const submit = await page.$('button[type="submit"]');
      if (!submit) throw new Error('Sign-in button not found');
      await submit.click();
    }

    await Promise.race([
      page.waitForFunction(() => !location.pathname.includes('/auth/login'), { timeout: 120000 }),
      page.waitForFunction(() => /invalid|incorrect|wrong|error/i.test(document.body.innerText), { timeout: 120000 }),
      page.waitForFunction(() => /captcha|robot|blocked|challenge/i.test(document.body.innerText), { timeout: 120000 }),
    ]);

    if (page.url().includes('/auth/login')) {
      throw new Error('Still on login page — credentials error or captcha');
    }
    console.log('✓ Login successful');

    // ---- GO TO SEARCH ----
    await page.goto('https://app.mercell.com/search', {
      waitUntil: 'domcontentloaded',
      timeout: 120000,
    });
    await page.waitForSelector('body', { timeout: 15000 });
    console.log('On search page:', page.url());

    // ---- OPEN FILTERS ----
    console.log('--- FILTERS ---');
    await clickButtonContainsText(page, 'Search & Filters');
    await page.waitForSelector('button[data-testid="more-filters-toggle-button"]', { timeout: 15000 });
    await page.click('button[data-testid="more-filters-toggle-button"]');

    await page.waitForFunction(() => {
      const loc = document.querySelector('div[data-testid="location-dropdown"]');
      const opp = document.querySelector('div[data-testid="opportunity-dropdown"]');
      const pub = document.querySelector('div[data-testid="publication-date-dropdown"]');
      if (!loc || !opp || !pub) return false;
      return !loc.classList.contains('p-disabled') &&
             !opp.classList.contains('p-disabled') &&
             !pub.classList.contains('p-disabled');
    }, { timeout: 30000 });

    const countries = [
      'Norway', 'Denmark', 'Sweden', 'Finland', 'The Netherlands',
      'Austria', 'Belgium', 'Estonia', 'France', 'Germany',
      'Liechtenstein', 'Luxembourg', 'Portugal', 'Spain',
      'Switzerland', 'United Kingdom',
    ];

    await clickButtonContainsText(page, 'Search & Filters');
    await page.waitForSelector('button[data-testid="more-filters-toggle-button"]', { timeout: 15000 });
    await page.click('button[data-testid="more-filters-toggle-button"]');
    await clickSpanContainsText(page, 'Location');
    await page.waitForSelector('span.p-treenode-label', { timeout: 15000 });

    await page.evaluate(() => {
      const btn = document.querySelector('button[data-testid="show-more-button"]');
      if (btn) { btn.scrollIntoView({ block: 'center' }); btn.click(); }
    });
    await page.waitForFunction(() => {
      return document.querySelectorAll('span.p-treenode-label').length > 10;
    }, { timeout: 10000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 400));

    for (const country of countries) {
      const res = await checkTreeNodeByName(page, country);
      console.log('  Country:', country, res.ok ? '✓' : '✗');
      await new Promise(r => setTimeout(r, 250));
    }

    // Opportunity type: Contract
    const contractOk = await checkCheckboxInAccordion(page, 'doc_type_code', 'Contract');
    console.log('  Opportunity type: Contract', contractOk ? '✓' : '✗');

    // Tender status
    const openOk = await checkCheckboxInAccordion(page, 'tender_status', 'Open for offers');
    console.log('  Status: Open for offers', openOk ? '✓' : '✗');
    const noTimeOk = await checkCheckboxInAccordion(page, 'tender_status', 'No time limit');
    console.log('  Status: No time limit', noTimeOk ? '✓' : '✗');

    // CPV Categories
    await page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll('.p-accordion-tab'));
      const target = tabs.find(t => /cpv_codes/i.test(t.id || ''));
      const link = target?.querySelector('.p-accordion-header-link');
      if (link && link.getAttribute('aria-expanded') !== 'true') {
        link.scrollIntoView({ block: 'center' });
        link.click();
      }
    });
    await new Promise(r => setTimeout(r, 500));

    await page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll('.p-accordion-tab'));
      const target = tabs.find(t => /cpv_codes/i.test(t.id || ''));
      if (!target) return;
      const buttons = Array.from(target.querySelectorAll('button'));
      const btn = buttons.find(b => /add\s+categor/i.test((b.textContent || '').trim()));
      btn?.scrollIntoView({ block: 'center' });
      btn?.click();
    });
    await new Promise(r => setTimeout(r, 1500));

    await page.waitForSelector('input[data-testid="cpv-tree-modal-search"]', { timeout: 5000 });
    await page.click('input[data-testid="cpv-tree-modal-search"]', { clickCount: 3 });
    await page.type('input[data-testid="cpv-tree-modal-search"]', '72000000', { delay: 20 });
    await new Promise(r => setTimeout(r, 1000));

    await page.evaluate(() => {
      const dialog = document.querySelector('.p-dialog[role="dialog"]');
      if (!dialog) return;
      const candidates = Array.from(dialog.querySelectorAll('li, tr, div, span, label'))
        .filter(el => (el.textContent || '').trim().includes('72000000') && el.textContent.length < 300);
      candidates.sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);
      const target = candidates[0];
      if (!target) return;
      let parent = target;
      let box = null;
      for (let i = 0; i < 6 && parent; i++) {
        box = parent.querySelector?.('.p-checkbox-box, [role="checkbox"]');
        if (box) break;
        parent = parent.parentElement;
      }
      box?.scrollIntoView({ block: 'center' });
      box?.click();
    });
    await new Promise(r => setTimeout(r, 600));

    await page.evaluate(() => {
      const dialog = document.querySelector('.p-dialog[role="dialog"]');
      if (!dialog) return;
      const buttons = Array.from(dialog.querySelectorAll('button'));
      const btn = buttons.find(b => /^(save|apply|done|confirm|ok|add|select|finish|submit|add categor)/i.test((b.textContent || '').trim()));
      btn?.click();
    });
    await new Promise(r => setTimeout(r, 1000));
    console.log('  CPV 72000000 ✓');

    // ---- PRE-APPLY: DIAGNOSTINIS DUMP ----
    // Patikrinam ar Contract / Open for offers / No time limit checkbox'ai iš tikrųjų aria-checked=true.
    const preApplyState = await page.evaluate(() => {
      const out = { checkedByAccordion: {}, allChecked: [] };
      const tabs = Array.from(document.querySelectorAll('.p-accordion-tab'));
      for (const tab of tabs) {
        const id = tab.id || 'unknown';
        // Checkbox'ai: PrimeReact naudoja .p-checkbox su hidden input, ir .p-highlight class'ę ant .p-checkbox-box kai pažymėta
        const checkedBoxes = Array.from(tab.querySelectorAll('.p-checkbox-box.p-highlight, .p-checkbox .p-highlight'));
        const labels = checkedBoxes.map(b => {
          const wrapper = b.closest('.p-checkbox-wrapper') || b.parentElement?.parentElement;
          return (wrapper?.querySelector('.p-checkbox-label')?.textContent || '').trim();
        }).filter(Boolean);
        if (labels.length) {
          out.checkedByAccordion[id] = labels;
          out.allChecked.push(...labels.map(l => `${id}::${l}`));
        }
      }
      // Arba tiesiog visi checked visam sidebar'e
      const sidebar = document.querySelector('.p-sidebar-content, [role="dialog"], .p-sidebar');
      if (sidebar) {
        const allHi = Array.from(sidebar.querySelectorAll('.p-checkbox-box.p-highlight'));
        out.totalCheckedInSidebar = allHi.length;
      }
      return out;
    });
    console.log('PRE-APPLY checked boxes:', JSON.stringify(preApplyState, null, 2));

    // ---- APPLY FILTERS ----
    const appliedFilters = await page.evaluate(() => {
      const sidebar = document.querySelector('.p-sidebar-content, [role="dialog"], .p-sidebar');
      const root = sidebar || document;
      const buttons = Array.from(root.querySelectorAll('button'));
      const btn = buttons.find(b => {
        const t = (b.textContent || '').trim().toLowerCase();
        return /^apply filters(\s*\(\d+\))?$/i.test(t) ||
               /^show\s+\d+\s+results?$/i.test(t) ||
               /^apply$/i.test(t);
      });
      if (!btn) return { ok: false };
      btn.scrollIntoView({ block: 'center' });
      btn.click();
      return { ok: true, label: (btn.textContent || '').trim() };
    });
    console.log('Apply filters:', JSON.stringify(appliedFilters));
    if (!appliedFilters.ok) throw new Error('Could not click Apply filters');

    await page.waitForFunction(() => {
      const mask = document.querySelector('.p-sidebar-mask');
      return !mask || !mask.isConnected;
    }, { timeout: 15000 }).catch(() => console.log('WARN: sidebar mask still visible'));

    await page.waitForFunction(() => {
      return document.querySelectorAll('[data-testid="tender-name"]').length > 0 ||
             document.querySelectorAll('a[href^="/tender/"]').length > 0;
    }, { timeout: 60000 }).catch(() => {
      console.log('WARN: no result cards after 60s');
    });
    await new Promise(r => setTimeout(r, 2000));

    // ---- POST-APPLY: DIAGNOSTINIS DUMP ----
    const postApplyState = await page.evaluate(() => {
      const firstCards = Array.from(document.querySelectorAll('[data-testid^="search-result-card:"]')).slice(0, 3);
      return {
        url: location.href.slice(0, 500),
        urlHasStatusFilter: /filter=tender_status/i.test(location.href),
        urlHasDocTypeFilter: /filter=doc_type_code/i.test(location.href),
        totalCards: document.querySelectorAll('[data-testid^="search-result-card:"]').length,
        firstCards: firstCards.map(c => ({
          title: (c.querySelector('[data-testid="tender-name"]')?.innerText || '').trim().slice(0, 60),
          status: (c.querySelector('[data-testid="tender-header__tender-status"]')?.innerText || '').trim(),
          docType: (c.querySelector('[data-testid="tender-header__doc-type-code"]')?.innerText || '').trim(),
        })),
      };
    });
    console.log('POST-APPLY URL/results:', JSON.stringify(postApplyState, null, 2));

    // ---- COLLECT TENDERS FROM ALL PAGES ----
    console.log('--- COLLECTING TENDERS ---');
    const allTenders = [];
    const seenIds = new Set();

    let emptyPagesInRow = 0;
    const MAX_EMPTY_PAGES_IN_ROW = 2;

    for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
      try {
        await page.waitForFunction(() => {
          return document.querySelectorAll('[data-testid="tender-name"]').length > 0;
        }, { timeout: 15000 });
      } catch (_) {
        console.log(`Page ${pageNum}: no results loaded, stopping`);
        break;
      }

      const pageTenders = await page.evaluate(() => {
        const cards = Array.from(document.querySelectorAll('[data-testid^="search-result-card:"]'));
        return cards.map(card => {
          const nameEl = card.querySelector('[data-testid="tender-name"]');
          const linkEl = nameEl?.querySelector('a[href*="/tender/"]') || nameEl?.querySelector('a');
          const href = linkEl?.getAttribute('href') || null;
          const title = (nameEl?.innerText || '').trim();

          const pubDateRaw = card.querySelector('[data-testid="tender-header__publication-date"]')?.innerText?.trim() || '';
          const status = card.querySelector('[data-testid="tender-header__tender-status"]')?.innerText?.trim() || '';
          const docType = card.querySelector('[data-testid="tender-header__doc-type-code"]')?.innerText?.trim() || '';
          const publicationDate = pubDateRaw.replace(/^Published\s*/i, '').trim() || null;

          const cardText = (card.innerText || '').trim();
          const lines = cardText.split('\n').map(s => s.trim()).filter(Boolean);

          const deadlineLine = lines.find(l =>
            /^\d{1,2}\/\d{1,2}\/\d{4}(\s+\d{1,2}:\d{2})?$/.test(l) ||
            /^\d{1,2}\.\d{1,2}\.\d{4}/.test(l)
          );

          const orgCountryLine = lines.find(l => {
            if (l === title) return false;
            return /,\s*(Norway|Sweden|Denmark|Finland|Netherlands|Austria|Belgium|Estonia|France|Germany|Liechtenstein|Luxembourg|Portugal|Spain|Switzerland|United Kingdom|Ireland|Italy|Poland|Iceland|Lithuania|Latvia|Czech|Slovakia|Hungary|Greece|Romania|Bulgaria|Croatia|Slovenia)(\s|$)/i.test(l);
          });

          let organisation = null;
          let country = null;
          if (orgCountryLine) {
            const m = orgCountryLine.match(/^(.+),\s*([A-Za-z\s]+)$/);
            if (m) {
              organisation = m[1].trim();
              country = m[2].trim();
            }
          }

          if (!country) {
            const locEl = card.querySelector('[data-testid="search-result-card__locations"]');
            const locText = (locEl?.innerText || '').trim();
            const countryMatch = locText.match(/\b(Norway|Sweden|Denmark|Finland|Netherlands|Austria|Belgium|Estonia|France|Germany|Liechtenstein|Luxembourg|Portugal|Spain|Switzerland|United Kingdom|Ireland|Italy|Poland|Iceland|Lithuania|Latvia|Czech|Slovakia|Hungary|Greece|Romania|Bulgaria|Croatia|Slovenia)\b/i);
            if (countryMatch) country = countryMatch[1];
          }

          return {
            href, title, organisation, country,
            deadlineRaw: deadlineLine || null,
            publicationDate, docType, status,
          };
        }).filter(t => t.href);
      });

      const foundHrefs = pageTenders.slice(0, 3).map(t => (t.href || '').slice(0, 60));
      console.log(`Page ${pageNum}: found ${pageTenders.length} cards, first hrefs: ${JSON.stringify(foundHrefs)}`);

      let newOnThisPage = 0;
      let dupesOnThisPage = 0;
      for (const t of pageTenders) {
        const id = extractTenderId(t.href);
        if (!id) continue;
        if (seenIds.has(id)) {
          dupesOnThisPage++;
          continue;
        }
        seenIds.add(id);
        const url = getCleanTenderUrl(id);
        allTenders.push({ ...t, tenderId: id, url });
        newOnThisPage++;
        if (allTenders.length >= MAX_TENDERS) break;
      }
      console.log(`Page ${pageNum}: +${newOnThisPage} new, ${dupesOnThisPage} dupes (total: ${allTenders.length})`);

      if (allTenders.length >= MAX_TENDERS) {
        console.log(`Hit MAX_TENDERS limit (${MAX_TENDERS})`);
        break;
      }

      if (newOnThisPage === 0) {
        emptyPagesInRow++;
        console.log(`  (${emptyPagesInRow}/${MAX_EMPTY_PAGES_IN_ROW} empty pages in a row)`);
        if (emptyPagesInRow >= MAX_EMPTY_PAGES_IN_ROW) {
          console.log('Too many empty pages - stopping');
          break;
        }
      } else {
        emptyPagesInRow = 0;
      }

      const hasNext = await goToNextPage(page);
      if (!hasNext) {
        console.log('No next page available');
        break;
      }
    }

    console.log(`✓ Collected ${allTenders.length} tenders total (before defensive filter)`);

    // ---- DEFENSIVE POST-FILTER ----
    // Jei URL/API filtrai neprilipo, bent jau išmeskim tuos, kurie tikrai neatitinka kriterijų.
    const WANTED_STATUSES = ['Open for offers', 'No time limit'];
    const beforeFilter = allTenders.length;
    const filteredOut = [];
    const kept = [];
    for (const t of allTenders) {
      const status = (t.status || '').trim();
      const docType = (t.docType || '').trim();
      const statusOk = WANTED_STATUSES.some(s => status.toLowerCase().startsWith(s.toLowerCase()));
      const docOk = /contract/i.test(docType) && !/award\s*notice/i.test(docType);
      if (!statusOk || !docOk) {
        filteredOut.push({ id: t.tenderId, title: (t.title || '').slice(0, 40), status, docType });
        continue;
      }
      kept.push(t);
    }
    allTenders.length = 0;
    allTenders.push(...kept);
    console.log(`Defensive filter: kept ${kept.length}/${beforeFilter} (dropped ${filteredOut.length})`);
    if (filteredOut.length) {
      console.log('Dropped samples:', JSON.stringify(filteredOut.slice(0, 5), null, 2));
    }
    if (allTenders.length > 0) {
      console.log('Sample tender:', JSON.stringify(allTenders[0], null, 2));
    }

    // ---- GOOGLE SHEETS SETUP ----
    console.log('--- GOOGLE SHEETS ---');
    const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
    const jwt = new google.auth.JWT({
      email: serviceAccount.client_email,
      key: serviceAccount.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    await jwt.authorize();
    const sheets = google.sheets({ version: 'v4', auth: jwt });
    const SHEET_ID = process.env.GOOGLE_SHEET_ID;
    const TAB_NAME = process.env.SHEET_TAB_NAME || 'Sheet1';

    const SHEET_HEADERS = [
      'DATE OF WHEN ADDED TO THE LIST',
      'BIDDING ANNOUCEMENT DATE',
      'LINK TO THE PAGE TENDER WAS PUBLISHED ON',
      'TENDER NAME',
      'BIDDING ORGANISATION',
      'BIDDING DEADLINE DATE',
      'COUNTRY',
      'MAX BUDGET EUR without VAT',
      'DURATION OF AGREEMENT (months)',
      'REQUIREMENTS FOR SUPPLIER',
      'QUALIFICATION REQUIREMENTS',
      'OFFER WEIGHING CRITERIA',
      'SCOPE OF AGREEMENT',
      'TECHNICAL STACK',
      'Source URL',
      'Reference number',
      'KEYWORDS',
    ];

    let existingIds = new Set();
    try {
      const existing = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: `${TAB_NAME}!A1:Q`,
      });
      const rows = existing.data.values || [];
      const hasHeader = rows[0] && rows[0][0] === SHEET_HEADERS[0];

      if (!hasHeader && rows.length === 0) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: SHEET_ID,
          range: `${TAB_NAME}!A1`,
          valueInputOption: 'RAW',
          requestBody: { values: [SHEET_HEADERS] },
        });
        console.log('Header row inserted (empty sheet)');
      }

      for (let i = hasHeader ? 1 : 0; i < rows.length; i++) {
        const link = rows[i][2] || rows[i][14] || '';
        const id = extractTenderId(link);
        if (id) existingIds.add(id);
      }
      console.log(`Existing tender IDs in sheet: ${existingIds.size}`);
    } catch (e) {
      console.log('WARN: could not read existing sheet:', e.message);
    }

    const newTenders = allTenders.filter(t => !existingIds.has(t.tenderId));
    console.log(`New tenders: ${newTenders.length} (${allTenders.length - newTenders.length} already in sheet)`);

    // ---- FETCH DETAILS + INCREMENTAL APPEND ----
    // SVARBU: GitHub Actions job'as turi 6h cap. Per praėjusį pilną run'ą
    // job'as buvo nutrauktas 6h 5m ribose, o visas `sheets.append` iškvie-
    // timas vyko tik loop'o gale → niekas nespėjo būti įrašyta. Dabar
    // flushinam kas `FLUSH_BATCH` tenderių, plus SIGTERM/SIGINT handler'is
    // išsaugo likusias eilutes, kai runner'is bando nužudyti procesą.
    const toFetch = newTenders.slice(0, DETAILS_LIMIT);
    console.log(`--- FETCHING DETAILS (${toFetch.length}) with flush batch ${FLUSH_BATCH} ---`);

    const nowIso = new Date().toISOString().slice(0, 10);

    const fmtDate = (s) => {
      if (!s) return '';
      const str = String(s).trim();
      const m = str.match(/^(\d{4}-\d{2}-\d{2})T/);
      if (m) return m[1];
      return str;
    };
    // HTML entity decoder — Mercell scope/requirements often contain
    // `&#61;` (=), `&amp;`, `&#39;` ('), `&quot;`, `&lt;`, `&gt;`, `&nbsp;`
    // and numeric entities like `&#8211;` (en-dash). Sheet rendered them
    // raw, so we normalise here before handing the string to the sheet or AI.
    const NAMED_ENTITIES = {
      amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
      laquo: '«', raquo: '»', hellip: '…', mdash: '—', ndash: '–',
      lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•',
      copy: '©', reg: '®', trade: '™', deg: '°', middot: '·',
    };
    const decodeHtmlEntities = (s) => {
      if (!s) return '';
      return String(s)
        .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
          const code = parseInt(hex, 16);
          return Number.isFinite(code) ? String.fromCodePoint(code) : _;
        })
        .replace(/&#(\d+);/g, (_, num) => {
          const code = parseInt(num, 10);
          return Number.isFinite(code) ? String.fromCodePoint(code) : _;
        })
        .replace(/&([a-zA-Z]+);/g, (orig, name) =>
          NAMED_ENTITIES[name.toLowerCase()] !== undefined
            ? NAMED_ENTITIES[name.toLowerCase()]
            : orig
        );
    };

    const cleanDescription = (v) => {
      if (!v) return '';
      const s = String(v);
      let out = s;
      if (s.includes('languageCode') && s.includes('text')) {
        try {
          const arr = JSON.parse(s.startsWith('[') ? s : `[${s}]`);
          if (Array.isArray(arr)) {
            const en = arr.find((x) => x && x.languageCode === 'en');
            const pick = en || arr[0];
            if (pick && pick.text) out = String(pick.text);
          }
        } catch (_) {
          const texts = [...s.matchAll(/"text"\s*:\s*"([^"]*(?:\\.[^"]*)*)"/g)]
            .map((m) => m[1].replace(/\\"/g, '"').replace(/\\n/g, ' '));
          if (texts.length) out = texts[0];
        }
      }
      // Decode HTML entities (handles &#61;, &amp;, &#39;, &quot;, numeric
      // decimal/hex, and common named entities). Safe to run repeatedly.
      out = decodeHtmlEntities(out);
      // Collapse whitespace runs (incl. NBSP leftovers) and trim.
      out = out.replace(/[\u00A0\s]+/g, ' ').trim();
      return out;
    };
    const cleanOrg = (v) => {
      if (!v) return '';
      const s = String(v).trim();
      const first = s.split(/\n|\r/).map((x) => x.trim()).filter(Boolean)[0];
      return first || s;
    };

    // --- KEYWORD TAGGING ------------------------------------------------
    // Sales komanda nori matyti, kurie iš jų bendrai sekamų raktinių
    // žodžių atitinka tender'į. Surinktus žodžius grąžinam kaip
    // comma-separated list'ą paskutiniame sheet'o stulpelyje ("KEYWORDS").
    // Match'as vykdomas regex'u ant EN tikro teksto (title + scope +
    // requirements + qualifications + criteria + keywords iš CPV aprašymo).
    const KEYWORD_PATTERNS = [
      { label: 'software development', re: /\b(software\s*development|custom\s*software|bespoke\s*software)\b/i },
      { label: 'project management',   re: /\b(project\s*management|programme\s*management|programme\s*manager|PMP|prince2)\b/i },
      { label: 'Agile',                re: /\b(agile|scrum|kanban|SAFe|sprint\s*planning)\b/i },
      { label: 'AI',                   re: /\b(AI|artificial\s*intelligence|machine\s*learning|\bML\b|LLM|generative\s*ai|genai|deep\s*learning|neural\s*network)\b/i },
      { label: 'IT',                   re: /\b(IT\s*services?|ICT|information\s*technology|IT\s*systems?)\b/i },
      { label: 'system support',       re: /\b(system\s*support|application\s*support|maintenance\s*and\s*support|technical\s*support)\b/i },
      { label: 'application development', re: /\b(application\s*development|app\s*development|web\s*application|mobile\s*application)\b/i },
      { label: 'JAVA',                 re: /\b(java|spring\s*boot|\bJVM\b|jakarta\s*ee|javaee)\b/i },
      { label: 'Python',               re: /\b(python|django|flask|fastapi)\b/i },
      { label: 'React',                re: /\b(react(?!\s*native)|reactjs|next\.?js)\b/i },
      { label: 'React Native',         re: /\b(react\s*native)\b/i },
      { label: 'IT system modernization', re: /\b(system\s*modernization|legacy\s*modernization|legacy\s*migration|modernisation|replatforming)\b/i },
      { label: 'cloud-native development', re: /\b(cloud[-\s]*native|AWS|azure|GCP|kubernetes|\bK8s\b|microservices|serverless)\b/i },
      { label: 'quality assurance',    re: /\b(quality\s*assurance|\bQA\b|test\s*automation)\b/i },
      { label: 'testing',              re: /\b(testing|test\s*management|test\s*strategy|test\s*cases?)\b/i },
      { label: 'user interface',       re: /\b(user\s*interface|\bUI\s*design|\bUI\b(?!\w))\b/i },
      { label: 'system implementation', re: /\b(system\s*implementation|rollout|deployment|go[-\s]*live)\b/i },
      { label: 'UX/UI',                re: /\b(UX\/UI|UI\/UX|UX\s*design|user\s*experience|\bUX\b(?!\w))\b/i },
    ];
    const matchKeywords = (texts) => {
      const blob = (Array.isArray(texts) ? texts : [texts]).filter(Boolean).join(' \n ');
      if (!blob.trim()) return '';
      const matched = new Set();
      for (const { label, re } of KEYWORD_PATTERNS) {
        if (re.test(blob)) matched.add(label);
      }
      return Array.from(matched).join(', ');
    };

    // --- BUDGET PARSER (into EUR) --------------------------------------
    // Grąžina { amount: number|null, known: boolean }. Palaiko:
    //   "1,200,000 EUR", "1 200 000,00 €", "€1.5 million", "200k NOK",
    //   "2,5 mln EUR", "no limit", "€30" (suspect — grąžinam kaip 30).
    // Valiutos: EUR/€, NOK, SEK, DKK, GBP/£, USD/$ — verčiam į EUR pagal
    // grubų kursą (užtenka "virš/po 500K" filtrui).
    const FX_TO_EUR = {
      EUR: 1, '€': 1,
      NOK: 0.087, SEK: 0.088, DKK: 0.134,
      GBP: 1.17, '£': 1.17,
      USD: 0.92, '$': 0.92,
      PLN: 0.23, CZK: 0.040, HUF: 0.0026,
    };
    const parseEurBudget = (raw) => {
      if (!raw) return { amount: null, known: false };
      let s = String(raw).trim();
      if (!s) return { amount: null, known: false };
      // Anything saying "no limit", "unknown", "not specified" — treat as unknown.
      if (/\b(no\s*limit|unknown|not\s*specified|n\/?a|none)\b/i.test(s)) {
        return { amount: null, known: false };
      }
      // Pick currency
      let fx = 1;
      let currencyMatched = null;
      for (const code of ['EUR', 'NOK', 'SEK', 'DKK', 'GBP', 'USD', 'PLN', 'CZK', 'HUF']) {
        const re = new RegExp('\\b' + code + '\\b', 'i');
        if (re.test(s)) { fx = FX_TO_EUR[code]; currencyMatched = code; break; }
      }
      if (!currencyMatched) {
        if (/€/.test(s)) fx = FX_TO_EUR['€'];
        else if (/£/.test(s)) fx = FX_TO_EUR['£'];
        else if (/\$/.test(s)) fx = FX_TO_EUR['$'];
      }
      // Multiplier (million / billion / k)
      let mult = 1;
      if (/\b(bln|bil(?:lion)?|mlrd|miljard)\b/i.test(s)) mult = 1e9;
      else if (/\b(mln|mio|million|milj|miljoon)\b/i.test(s)) mult = 1e6;
      else if (/\b(k|thousand|tuhat|tys)\b/i.test(s) && !/\bEUR\s*k\b/i.test(s)) mult = 1e3;
      // Strip currency markers, whitespace, letters; keep digits/./,/-
      let numStr = s
        .replace(/(EUR|NOK|SEK|DKK|GBP|USD|PLN|CZK|HUF|€|£|\$)/gi, ' ')
        .replace(/\b(mln|mio|million|milj|miljoon|bln|bil|billion|mlrd|miljard|k|thousand|tuhat|tys)\b/gi, ' ')
        .replace(/[^0-9.,\s-]/g, ' ')
        .trim();
      // If both '.' and ',' present, assume comma = thousands (EU style uses
      // comma as decimal but also common to see space/thousands), heuristika:
      //   "1,200,000.50" → 1200000.50  (US)
      //   "1.200.000,50" → 1200000.50  (EU)
      if (numStr.includes('.') && numStr.includes(',')) {
        if (numStr.lastIndexOf(',') > numStr.lastIndexOf('.')) {
          // EU: dot = thousands, comma = decimal
          numStr = numStr.replace(/\./g, '').replace(',', '.');
        } else {
          // US: comma = thousands, dot = decimal
          numStr = numStr.replace(/,/g, '');
        }
      } else if (numStr.includes(',')) {
        // Only comma: decide by position. If comma followed by 1-2 digits at
        // end, treat as decimal; otherwise as thousands separator.
        if (/,\d{1,2}$/.test(numStr)) numStr = numStr.replace(',', '.');
        else numStr = numStr.replace(/,/g, '');
      }
      numStr = numStr.replace(/\s+/g, '').replace(/^0+(?=\d)/, '');
      const firstMatch = numStr.match(/-?\d+(?:\.\d+)?/);
      if (!firstMatch) return { amount: null, known: false };
      const n = parseFloat(firstMatch[0]);
      if (!Number.isFinite(n) || n <= 0) return { amount: null, known: false };
      const eur = n * mult * fx;
      return { amount: eur, known: true };
    };
    const formatEurBudget = (raw) => {
      if (!raw) return '';
      const rawStr = String(raw).trim();
      // Preserve "EST" prefix produced by AI estimation fallback when no
      // explicit budget exists. We re-format the inner number but keep the
      // EST marker so the user can tell estimates from stated budgets.
      const estMatch = rawStr.match(/^EST\s+(.+)$/i);
      if (estMatch) {
        const inner = formatEurBudget(estMatch[1]);
        return inner ? `EST ${inner}` : rawStr;
      }
      const { amount, known } = parseEurBudget(rawStr);
      if (!known || !Number.isFinite(amount)) return rawStr;
      const rounded = Math.round(amount);
      const formatted = rounded.toLocaleString('en-US');
      const hadForeignCurrency = /\b(NOK|SEK|DKK|GBP|USD|PLN|CZK|HUF)\b|[£$]/i.test(rawStr);
      if (hadForeignCurrency) {
        return `EUR ${formatted} (${rawStr})`;
      }
      return `EUR ${formatted}`;
    };
    const buildRow = (t) => {
      const d = t.details || {};
      const publishedUrl = d.sourceUrl || t.url;
      // Pavadinimui ir scope — jei turim AI išverstą versiją, rodom ją
      // (lengviau sales komandai dirbti angliškai). Jei AI išjungtas, rodom
      // originalą.
      const titleOut = d.titleEn || cleanDescription(d.title || t.title || '');
      const scopeOut = d.scopeOfAgreementEn || cleanDescription(d.scopeOfAgreement || '');
      const reqOut = cleanDescription(d.requirementsForSupplier || '');
      const qualOut = cleanDescription(d.qualificationRequirements || '');
      const critOut = cleanDescription(d.offerWeighingCriteria || '');
      // Keyword'ai match'inami ant visko, ką turim anglų kalba.
      const keywords = matchKeywords([titleOut, scopeOut, reqOut, qualOut, critOut, d.technicalStack || '']);
      return [
        nowIso,
        fmtDate(d.publicationDate || t.publicationDate || ''),
        publishedUrl,
        titleOut,
        cleanOrg(d.organisation || t.organisation || ''),
        fmtDate(d.deadline || t.deadlineRaw || ''),
        d.country || t.country || '',
        formatEurBudget(d.maxBudget),
        d.duration || '',
        reqOut,
        qualOut,
        critOut,
        scopeOut,
        d.technicalStack || '',
        d.sourceUrl || '',
        d.referenceNumber || t.tenderId || '',
        keywords,
      ];
    };

    // Pending buffer + totals shared su signal handler'iu.
    const pendingRows = [];
    let totalAppended = 0;
    let flushInFlight = false;

    const flushPending = async (label) => {
      if (pendingRows.length === 0) return;
      if (flushInFlight) return; // viena flush operacija vienu metu
      flushInFlight = true;
      const batch = pendingRows.splice(0, pendingRows.length);
      try {
        const res = await sheets.spreadsheets.values.append({
          spreadsheetId: SHEET_ID,
          range: `${TAB_NAME}!A:Q`,
          valueInputOption: 'RAW',
          insertDataOption: 'INSERT_ROWS',
          requestBody: { values: batch },
        });
        totalAppended += batch.length;
        console.log(
          `✓ ${label || 'Flush'}: +${batch.length} rows (cumulative ${totalAppended}) range=${res.data.updates?.updatedRange}`
        );
      } catch (e) {
        // Jei nepavyko — grąžinam eilutes atgal į buferį, kad neprarastume.
        pendingRows.unshift(...batch);
        console.log(`✗ Flush failed (${label}): ${e.message}; ${batch.length} rows kept in buffer`);
        throw e;
      } finally {
        flushInFlight = false;
      }
    };

    // SIGTERM/SIGINT — GitHub Actions cancel siunčia SIGTERM ir duoda ~10s
    // grace period'o. Spėjam flushinti buferį prieš SIGKILL.
    let shuttingDown = false;
    const onShutdown = async (signal) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`\n⚠️ ${signal} received — flushing ${pendingRows.length} pending rows before exit`);
      try { await flushPending(`${signal}-flush`); } catch (e) { console.log('Shutdown flush error:', e.message); }
      try { await browser.close(); } catch (_) {}
      process.exit(0);
    };
    process.on('SIGTERM', () => onShutdown('SIGTERM'));
    process.on('SIGINT', () => onShutdown('SIGINT'));

    let sampleLogged = false;
    // 500K EUR threshold: drop tenders whose known budget is below this.
    // Keep rows where budget is unknown (empty) or ≥ 500K EUR.
    const BUDGET_MIN_EUR = 500000;
    let budgetFilteredCount = 0;

    for (let i = 0; i < toFetch.length; i++) {
      const cleanUrl = getCleanTenderUrl(toFetch[i].tenderId);
      const t0 = Date.now();
      try {
        toFetch[i].details = await fetchTenderDetails(browser, page, cleanUrl);
      } catch (e) {
        console.log(`  ✗ fetchTenderDetails threw: ${e.message}`);
        toFetch[i].details = { sourceUrl: '', title: toFetch[i].title || '' };
      }
      const elapsed = Date.now() - t0;

      const d = toFetch[i].details || {};
      console.log(`[${i + 1}/${toFetch.length}] ${elapsed}ms | ${(d.title || 'NONE').slice(0, 60)}`);

      const snippet = (d.fullTextSnippet || '').slice(0, 200);
      if (/414 ERROR|CloudFront|Bad request/i.test(snippet)) {
        console.log(`  ⚠️ CloudFront, retry in 3s...`);
        await new Promise(r => setTimeout(r, 3000));
        try {
          toFetch[i].details = await fetchTenderDetails(browser, page, cleanUrl);
        } catch (e) {
          console.log(`  ✗ retry threw: ${e.message}`);
        }
      }

      // --- AI ENRICHMENT (translate + extract missing fields) -------
      // Reset the per-tender AI failure flag — _markAiFailure() will set it
      // if any AI call hits a non-retryable error (HTTP 400 invalid_request,
      // 401/403, "credit balance too low"). Checked below before row-write
      // to DEFER the tender (skip pendingRows.push) so the next run retries.
      _lastAiNonRetryableError = null;
      if (AI_ENABLED) {
        const dd = toFetch[i].details || {};
        const rawTitle = cleanDescription(dd.title || toFetch[i].title || '');
        const rawScope = cleanDescription(dd.scopeOfAgreement || '');
        const combinedText = [
          rawTitle ? `TITLE: ${rawTitle}` : '',
          rawScope ? `DESCRIPTION: ${rawScope}` : '',
          dd.fullTextSnippet ? `MERCELL_PAGE: ${dd.fullTextSnippet}` : '',
          dd.pdfText ? `DOCUMENTS: ${dd.pdfText}` : '',
        ].filter(Boolean).join('\n\n');

        // Jei Mercell JSON'e maxBudget yra suspect'iškai mažas (< 1000) —
        // beveik neįmanomas IT kontraktui — nuvaloma ir leidžiame AI jį
        // užpildyti iš realaus teksto. Taip pat — jei duration yra datų
        // range tipo "01/07/2026 - 28/10/2030" — laikom tuščiu.
        const budgetNum = parseFloat(
          String(dd.maxBudget || '').replace(/[\s,€$£]/g, '').replace(/^0+/, '')
        );
        if (dd.maxBudget && Number.isFinite(budgetNum) && budgetNum > 0 && budgetNum < 1000) {
          console.log(`    ⚠️ discarding suspicious maxBudget: "${dd.maxBudget}" (${budgetNum})`);
          dd.maxBudget = '';
        }
        if (dd.duration && /\d{1,4}[\/.\-]\d{1,2}[\/.\-]\d{1,4}\s*[-–—]\s*\d{1,4}[\/.\-]\d{1,2}[\/.\-]\d{1,4}/.test(dd.duration)) {
          console.log(`    ⚠️ discarding date-range duration: "${dd.duration}"`);
          dd.duration = '';
        }

        // --- PRE-AI BUDGET FILTER -----------------------------------
        // Jei Mercell'as paraše aiškų biudžetą ir jis < 500K EUR —
        // nėra ko kviesti AI nei rašyti į sheet'ą. Taupom Claude tokens.
        const preBudget = parseEurBudget(dd.maxBudget);
        if (preBudget.known && preBudget.amount < BUDGET_MIN_EUR) {
          budgetFilteredCount++;
          console.log(`    ⏭️  skipping: budget below 500K EUR ("${dd.maxBudget}" ≈ €${Math.round(preBudget.amount).toLocaleString()})`);
          toFetch[i].details = dd;
          await new Promise(r => setTimeout(r, 200));
          continue;
        }

        // 1) Extract structured fields if any are missing
        const needsExtract =
          !dd.maxBudget || !dd.requirementsForSupplier ||
          !dd.qualificationRequirements || !dd.offerWeighingCriteria ||
          !dd.scopeOfAgreement;
        // Diagnostic: how much text are we feeding the AI? Empty pdfText
        // is the #1 reason requirementsForSupplier / qualificationRequirements
        // come back blank — the AI literally has nothing to extract from.
        const pdfLen = (dd.pdfText || '').length;
        const snipLen = (dd.fullTextSnippet || '').length;
        const descLen = rawScope.length;
        console.log(`    📏 AI inputs: title=${rawTitle.length}ch, desc=${descLen}ch, snippet=${snipLen}ch, pdfText=${pdfLen}ch (combined=${combinedText.length}ch)`);
        if (needsExtract && combinedText) {
          if (pdfLen === 0) {
            console.log(`    ⚠️ no pdfText — AI extract will likely return empty requirements/qualifications`);
          }
          const ai = await extractFieldsWithAI(combinedText, {
            title: rawTitle,
            buyer: dd.organisation || '',
            country: dd.country || '',
            referenceNumber: dd.referenceNumber || '',
          });
          const filled = [];
          if (!dd.maxBudget && ai.maxBudget) { dd.maxBudget = ai.maxBudget; filled.push('maxBudget'); }
          // AI estimate fallback — no explicit budget anywhere, but AI thinks
          // it can ballpark from scope/duration/country market rates. Marked
          // with "EST " prefix so the cell visibly differentiates an estimate
          // from a stated budget. Filter logic below still applies (estimates
          // < 500K EUR are dropped exactly like stated budgets).
          if (!dd.maxBudget && ai.estimatedBudgetEur) {
            const num = parseFloat(String(ai.estimatedBudgetEur).replace(/[^0-9.]/g, ''));
            if (Number.isFinite(num) && num > 0) {
              dd.maxBudget = `EST ${Math.round(num).toLocaleString('en-US')} EUR`;
              dd.budgetIsEstimated = true;
              filled.push('maxBudget(EST)');
            }
          }
          if (!dd.duration && ai.duration) { dd.duration = ai.duration; filled.push('duration'); }
          if (!dd.requirementsForSupplier && ai.requirementsForSupplier) { dd.requirementsForSupplier = ai.requirementsForSupplier; filled.push('requirements'); }
          if (!dd.qualificationRequirements && ai.qualificationRequirements) { dd.qualificationRequirements = ai.qualificationRequirements; filled.push('qualifications'); }
          if (!dd.offerWeighingCriteria && ai.offerWeighingCriteria) { dd.offerWeighingCriteria = ai.offerWeighingCriteria; filled.push('criteria'); }
          // scopeOfAgreement: AI's English summary overrides native-language description
          if (ai.scopeOfAgreement) { dd.scopeOfAgreement = ai.scopeOfAgreement; filled.push('scope'); }
          if (filled.length) console.log(`    🤖 AI filled: ${filled.join(', ')}`);
        }

        // --- POST-AI BUDGET FILTER ---------------------------------
        // AI galėjo įrašyti biudžetą kur Mercell'o nebuvo. Patikrinam dar
        // kartą — jei žinomas ir < 500K, praleidžiam (eilutė nerašoma).
        const postBudget = parseEurBudget(dd.maxBudget);
        if (postBudget.known && postBudget.amount < BUDGET_MIN_EUR) {
          budgetFilteredCount++;
          console.log(`    ⏭️  skipping (post-AI): budget below 500K EUR ("${dd.maxBudget}" ≈ €${Math.round(postBudget.amount).toLocaleString()})`);
          toFetch[i].details = dd;
          await new Promise(r => setTimeout(r, 200));
          continue;
        }

        // 2) Translate title (always — short, heuristika klysta trumpiems).
        //    Jei tekstas jau anglų, Claude grąžins jį beveik identišką.
        if (rawTitle) {
          const titleEn = await translateToEnglish(rawTitle, {
            hint: 'Public tender title',
            skipHeuristic: true,
          });
          if (titleEn) dd.titleEn = titleEn;
          if (titleEn && titleEn.trim() === rawTitle.trim() && /[^\x00-\x7F]/.test(rawTitle)) {
            console.log(`    ⚠️ title translation echoed source (likely AI failure): "${rawTitle.slice(0, 60)}"`);
          }
        }

        // 3) Translate scopeOfAgreement if not already English
        //    (if AI extract above produced English scope, skip; otherwise translate)
        const scopeToTranslate = dd.scopeOfAgreement || rawScope;
        if (scopeToTranslate) {
          const scopeEn = await translateToEnglish(scopeToTranslate, { hint: 'Public tender scope of agreement' });
          if (scopeEn) dd.scopeOfAgreementEn = scopeEn;
          if (scopeEn && scopeEn.trim() === scopeToTranslate.trim() && /[^\x00-\x7F]/.test(scopeToTranslate)) {
            console.log(`    ℹ️ scope translation skipped/echoed (heuristic flagged as English or AI echoed)`);
          }
        }

        toFetch[i].details = dd;
      } else {
        // AI išjungtas — vis tiek taikom budget filtrą pagal Mercell'o lauką.
        const dd = toFetch[i].details || {};
        const preBudget = parseEurBudget(dd.maxBudget);
        if (preBudget.known && preBudget.amount < BUDGET_MIN_EUR) {
          budgetFilteredCount++;
          console.log(`    ⏭️  skipping: budget below 500K EUR ("${dd.maxBudget}" ≈ €${Math.round(preBudget.amount).toLocaleString()})`);
          await new Promise(r => setTimeout(r, 200));
          continue;
        }
      }

      // Defer-on-AI-failure: if any AI call hit a non-retryable error
      // (credit balance, 400/401/403), DO NOT write this row — the AI fields
      // (title translation, scope, requirements) would be blank/native-language
      // and once the tenderId is in the sheet it won't be retried.
      if (_lastAiNonRetryableError) {
        console.log(`    ⏭️  deferring row — AI failure (will retry next run): ${_lastAiNonRetryableError}`);
        await new Promise(r => setTimeout(r, 200));
        continue;
      }

      // Build & buffer
      const row = buildRow(toFetch[i]);
      pendingRows.push(row);

      if (!sampleLogged) {
        console.log('Sample row:', JSON.stringify(row).slice(0, 500));
        sampleLogged = true;
      }

      // Flush batch
      if (pendingRows.length >= FLUSH_BATCH) {
        try {
          await flushPending(`batch@${i + 1}`);
        } catch (e) {
          // jei flush'as numiršta — eilutės liko buferyje, bandysim dar kartą vėliau
          await new Promise(r => setTimeout(r, 2000));
        }
      }

      await new Promise(r => setTimeout(r, 400));
    }

    // Galutinis flush
    if (pendingRows.length > 0) {
      try { await flushPending('final'); }
      catch (e) { console.log('Final flush error:', e.message); }
    } else if (totalAppended === 0) {
      console.log('Nothing to append');
    }

    console.log('=== SCRAPER FINISHED ===');
    console.log(`Total tenders found: ${allTenders.length}`);
    console.log(`New tenders: ${newTenders.length}`);
    console.log(`Rows appended: ${totalAppended}`);
    console.log(`Budget-filtered (<500K EUR): ${budgetFilteredCount}`);

    return { ok: true, tendersFound: allTenders.length, rowsAppended: totalAppended };

  } finally {
    try { await browser.close(); } catch (_) {}
  }
}

// --- MAIN ENTRY POINT --------------------------------------------------

(async () => {
  try {
    await runScraper();
    process.exit(0);
  } catch (e) {
    console.error('✗ FATAL:', e.message);
    console.error(e.stack);
    process.exit(1);
  }
})();
