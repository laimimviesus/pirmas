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
const MAX_TENDERS = TEST_MODE ? 2 : 4000;
const DETAILS_LIMIT = TEST_MODE ? 2 : 4000;
const SOURCE_NAV_TIMEOUT = 25000;

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

async function fetchTenderDetails(browser, page, tenderUrl) {
  let blockHandler = null;
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

    const apiPromise = page
      .waitForResponse(
        (res) => res.url().includes('/api/tender') && res.ok(),
        { timeout: 10000 }
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

    await new Promise(r => setTimeout(r, 500));

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
      const pubMatch = bodyText.match(
        /(?:published|publication\s*date|julkaistu|julkaisupäivä)[^\n]{0,40}?[:\s]+([^\n]{1,60})/i
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
  });

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
    ];

    let existingIds = new Set();
    try {
      const existing = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: `${TAB_NAME}!A1:P`,
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

    // ---- FETCH DETAILS ----
    const toFetch = newTenders.slice(0, DETAILS_LIMIT);
    console.log(`--- FETCHING DETAILS (${toFetch.length}) ---`);

    for (let i = 0; i < toFetch.length; i++) {
      const cleanUrl = getCleanTenderUrl(toFetch[i].tenderId);
      const t0 = Date.now();
      toFetch[i].details = await fetchTenderDetails(browser, page, cleanUrl);
      const elapsed = Date.now() - t0;

      const d = toFetch[i].details || {};
      console.log(`[${i + 1}/${toFetch.length}] ${elapsed}ms | ${(d.title || 'NONE').slice(0, 60)}`);

      const snippet = (d.fullTextSnippet || '').slice(0, 200);
      if (/414 ERROR|CloudFront|Bad request/i.test(snippet)) {
        console.log(`  ⚠️ CloudFront, retry in 3s...`);
        await new Promise(r => setTimeout(r, 3000));
        toFetch[i].details = await fetchTenderDetails(browser, page, cleanUrl);
      }

      await new Promise(r => setTimeout(r, 400));
    }

    // ---- FORMAT ROWS & APPEND ----
    const nowIso = new Date().toISOString().slice(0, 10);
    const rows = toFetch.map(t => {
      const d = t.details || {};
      // Source URL → pirmenybė šaltinio nuorodai, kaip paprašyta ("puslapis,
      // kuriame tender'is buvo paskelbtas" == originalus šaltinis).
      const publishedUrl = d.sourceUrl || t.url;
      return [
        nowIso,
        d.publicationDate || t.publicationDate || '',
        publishedUrl,
        d.title || t.title || '',
        d.organisation || t.organisation || '',
        d.deadline || t.deadlineRaw || '',
        d.country || t.country || '',
        d.maxBudget || '',
        d.duration || '',
        d.requirementsForSupplier || '',
        d.qualificationRequirements || '',
        d.offerWeighingCriteria || '',
        d.scopeOfAgreement || '',
        d.technicalStack || '',
        d.sourceUrl || '',
        d.referenceNumber || t.tenderId || '',
      ];
    });

    if (rows.length > 0) {
      console.log('Sample row:', JSON.stringify(rows[0]).slice(0, 500));

      const appendRes = await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: `${TAB_NAME}!A:P`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: rows },
      });
      console.log(`✓ Appended ${rows.length} rows: ${appendRes.data.updates?.updatedRange}`);
    } else {
      console.log('Nothing to append');
    }

    console.log('=== SCRAPER FINISHED ===');
    console.log(`Total tenders found: ${allTenders.length}`);
    console.log(`New tenders: ${newTenders.length}`);
    console.log(`Rows appended: ${rows.length}`);

    return { ok: true, tendersFound: allTenders.length, rowsAppended: rows.length };

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
