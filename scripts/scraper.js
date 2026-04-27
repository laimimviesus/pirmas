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
async function translateToEnglish(text, { hint = '', skipHeuristic = false } = {}) {
  if (!AI_ENABLED || !text) return '';
  const trimmed = String(text).slice(0, 6000);
  // Heuristika tik ilgiems tekstams (scope), kad netrinktume Haiku'o dėl
  // aiškiai angliško turinio. Trumpiems pavadinimams heuristika klysta
  // (pvz., vokiškas „Beschaffung eines Schulmanagementsystems" neturi
  // umlautų), tad jiems perduodam skipHeuristic=true.
  if (!skipHeuristic) {
    const looksEnglish =
      !/[äöüßñçéèêáíóúîôûàèìòùâêîôûãõÿøœæåÄÖÜÑÉÉÈÊÁÍÓÚÎÔÛ]/.test(trimmed) &&
      !/\b(och|und|der|die|den|het|van|een|de|el|la|les|los|das|für|pour|sur|avec|med|till|fra|para|del|dei|delle|della|zur|zum|mit|auf|bei|nach|ist|sind|wir|sie|ihr|van|voor|naar|niet|wel|als|aan|bij|maar|ook|waar|dan|alleen|geen|meer|kan)\b/i.test(trimmed);
    if (looksEnglish) return trimmed;
  }
  try {
    const out = await callClaude(
      'You are a precise translator. Translate the user text into clear, concise English. Preserve technical terms, tender reference numbers, organisation names, CPV codes verbatim. Return ONLY the translation, no preface, no explanations, no quotes.',
      `${hint ? `Context: ${hint}\n\n` : ''}Text to translate:\n${trimmed}`,
      { maxTokens: 800, temperature: 0 }
    );
    return out || trimmed;
  } catch (e) {
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
    '- requirementsForSupplier: bullet-style summary (≤400 chars) of MANDATORY supplier/bidder requirements (legal status, insurance, ISO certifications, security clearance, technical staff, financial standing). Look in DOCUMENTS for sections titled "Requirements", "Mandatory requirements", "Reikalavimai tiekėjui", "Wymagania", "Anforderungen an den Bieter", "Krav til leverandør", "Eisen aan inschrijver", "Exigences", "Requisitos". Empty string if truly absent.\n' +
    '- qualificationRequirements: bullet-style summary (≤400 chars) of SELECTION / qualification criteria (turnover thresholds, references, past similar projects, team CVs, certifications). Look for "Selection criteria", "Qualification", "Kvalifikaciniai reikalavimai", "Kwalifikacja", "Eignungskriterien", "Kvalifikasjonskrav". Empty string if truly absent.\n' +
    '- offerWeighingCriteria: award criteria with weights if present. Example: "Price 40%, Quality 35%, Delivery time 25%" or "MEAT — lowest price". Look for "Award criteria", "Evaluation", "Vertinimo kriterijai", "Kryteria oceny", "Zuschlagskriterien", "Tildelingskriterier". Empty string if truly absent.\n' +
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

    const result = await srcPage.evaluate(() => {
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
      const loginGated =
        (matchedMarkers >= 2 && (hasPasswordField || shortBody)) ||
        (hasPasswordField && matchedMarkers >= 1 && bodyText.length < 4000);

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
      };
    });

    srcPage.off('request', blockHandler);
    try { await srcPage.setRequestInterception(false); } catch (_) {}
    return result;
  } catch (e) {
    return { error: e.message || String(e) };
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
  try {
    await page.setRequestInterception(true);
    blockHandler = (req) => {
      const type = req.resourceType();
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
              // GUID-style — template'inam į žinomus endpoint'us
              candidates.push(
                `https://file-service.discover.app.mercell.com/api/v1/files/${refStr}/download`,
                `https://file-service.discover.app.mercell.com/api/v1/files/${refStr}`,
                `https://file-service.discover.app.mercell.com/files/${refStr}/download`,
                `https://file-service.discover.app.mercell.com/files/${refStr}`,
                `https://search-service-api.discover.app.mercell.com/api/v1/files/${refStr}/download`,
                `https://search-service-api.discover.app.mercell.com/api/v1/files/${refStr}`,
                `https://app.mercell.com/files/${refStr}/download`,
                `https://app.mercell.com/api/v1/files/${refStr}`,
                `https://permalink.mercell.com/api/v1/files/${refStr}/download`,
              );
            }
          }
          // Integer ID variantai kaip fallback'as — kartais Mercell'is juos
          // priima legacy endpoint'uose.
          candidates.push(
            // file-service.discover.app.mercell.com — pagrindinis
            `https://file-service.discover.app.mercell.com/api/v1/files/${f.id}/download`,
            `https://file-service.discover.app.mercell.com/api/v1/files/${f.id}`,
            `https://file-service.discover.app.mercell.com/files/${f.id}/download`,
            `https://file-service.discover.app.mercell.com/files/${f.id}`,
            // search-service-api — kartais file-service deleguojamas
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
          for (const u of candidates) {
            try {
              const result = await page.evaluate(async (url) => {
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
              }, u);
              if (result && result.ok && result.size > 100) {
                const tmpBytes = Buffer.from(result.data);
                lastStatus = result.status;
                lastContentType = result.contentType;
                lastFormat = detectFormat(tmpBytes);
                if (magicMatchesExt(tmpBytes, f.ext)) {
                  bytes = tmpBytes;
                  okUrl = u;
                  break;
                }
                // wrong magic — log only at debug level and try next candidate
              } else if (result && !result.ok) {
                lastStatus = result.status;
              }
            } catch (_) {
              // try next
            }
          }

          if (!bytes) {
            const ctTail = lastContentType ? `, ct=${lastContentType.slice(0, 40)}` : '';
            const fmtTail = lastFormat ? `, got=${lastFormat}` : '';
            const statusTail = lastStatus ? `, last=${lastStatus}` : '';
            const refTail = f.ref ? `, ref=${String(f.ref).slice(0, 40)}` : ', ref=NONE';
            console.log(`    ⚠️ could not fetch ${f.ext.toUpperCase()} "${f.name}" (id=${f.id}${refTail}${statusTail}${ctTail}${fmtTail})`);
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
    } catch (e) {
      console.log(`    ⚠️ document extraction error: ${e.message}`);
    }

    // --- ŠALTINIO PUSLAPIS -------------------------------------------
    if (details.sourceUrl) {
      console.log(`    → source: ${details.sourceUrl.slice(0, 80)}`);
      const t0 = Date.now();
      const src = await fetchSourcePageDetails(browser, details.sourceUrl);
      const elapsed = Date.now() - t0;
      console.log(`    source done in ${elapsed}ms (host: ${src?.sourceHost || 'n/a'}, err: ${src?.error || 'none'}${src?.skipped ? ', skipped: ' + src.skipped : ''})`);

      if (src?.skipped) {
        // Mercell-internis permalink'as — nefetchinam, tik paliekam žymę.
        details.sourceHost = src.sourceHost || null;
        details.sourceSkipped = src.skipped;
      } else if (src?.loginGated) {
        // Login-gated portal'as (UK MyTenders, Jaggaer, Bravo, DTVP, ...)
        // — realaus turinio nepaseiksim be autentifikacijos. Paliekam
        // Mercell laukus nepakitusius; tik pažymim kad šaltinis login-walled.
        console.log(
          `    source login-gated (host: ${src.sourceHost}, markers: ${src.matchedMarkers}, ` +
          `bodyLen: ${src.bodyLength}, passwordField: ${src.hasPasswordField})`
        );
        details.sourceHost = src.sourceHost || null;
        details.sourceSkipped = 'login-gated';
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
        if (needsExtract && combinedText) {
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
        }

        // 3) Translate scopeOfAgreement if not already English
        //    (if AI extract above produced English scope, skip; otherwise translate)
        const scopeToTranslate = dd.scopeOfAgreement || rawScope;
        if (scopeToTranslate) {
          const scopeEn = await translateToEnglish(scopeToTranslate, { hint: 'Public tender scope of agreement' });
          if (scopeEn) dd.scopeOfAgreementEn = scopeEn;
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
