// =====================================================================
// MERCELL SCRAPER — GitHub Actions version
// =====================================================================
// Paleidimas: node scripts/scraper.js
// Env vars: MERCELL_USERNAME, MERCELL_PASSWORD, GOOGLE_SERVICE_ACCOUNT_KEY,
//           GOOGLE_SHEET_ID, (opt) SHEET_TAB_NAME, (opt) TEST_MODE
// =====================================================================

const puppeteer = require('puppeteer');
const { google } = require('googleapis');

// --- Config ------------------------------------------------------------
const TEST_MODE = process.env.TEST_MODE === 'true';
const MAX_PAGES = TEST_MODE ? 1 : 100;
const MAX_TENDERS = TEST_MODE ? 2 : 2000;
const DETAILS_LIMIT = TEST_MODE ? 2 : 2000;

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

function extractTenderId(urlOrHref) {
  const m = (urlOrHref || '').match(/\/tender\/(-?\d+)/);
  return m ? m[1] : null;
}

function getCleanTenderUrl(tenderId) {
  return `https://app.mercell.com/tender/${tenderId}`;
}

async function goToNextPage(page) {
  // Paimam "before" state
  const urlBefore = page.url();
  const firstTenderBefore = await page.evaluate(() => {
    const first = document.querySelector('[data-testid="tender-name"] a, a[href*="/tender/"]');
    return first?.getAttribute('href') || null;
  });
 
  // Debug info apie pagination mygtuką
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
 
  // Paspaudžiam Next
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
 
  // Laukiam kol URL arba pirmasis tender'is pasikeis (patikimas požymis, kad nauji rezultatai atsiuntė)
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
 
  // Laukiam kol nauji rezultatai tikrai atsiras
  await page.waitForFunction(() => {
    return document.querySelectorAll('[data-testid="tender-name"]').length > 0;
  }, { timeout: 15000 }).catch(() => {});
 
  // Papildoma pauzė kad DOM stabilizuotųsi
  await new Promise(r => setTimeout(r, 2000));
 
  const urlAfter = page.url();
  console.log(`  ✓ Moved to page (URL change: ${urlBefore !== urlAfter})`);
  return true;
}
 

// --- Detalių puslapio nuskaitymas --------------------------------------

async function fetchTenderDetails(page, tenderUrl) {
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

    await page.goto(tenderUrl, { waitUntil: 'networkidle2', timeout: 60000 });

    await page.waitForFunction(() => {
      const h1 = document.querySelector('h1');
      if (h1 && (h1.innerText || '').trim().length > 5) return true;
      const text = (document.body.innerText || '').trim();
      return text.length > 1000 && !/414 ERROR|CloudFront/i.test(text);
    }, { timeout: 15000 }).catch(() => {
      console.log(`  WARN: no h1/content for ${tenderUrl}`);
    });

    await new Promise(r => setTimeout(r, 1500));

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
        fullTextSnippet: bodyText.slice(0, 3000),
      };
    });

    page.off('request', blockHandler);
    await page.setRequestInterception(false);
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

  // Env vars check
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
    page.setDefaultNavigationTimeout(120000);
    page.setDefaultTimeout(120000);

    // ---- LOGIN ----
    console.log('--- LOGIN ---');
    await page.goto('https://app.mercell.com/auth/login/challenge/password', {
      waitUntil: 'domcontentloaded',
      timeout: 120000,
    });

    // Cookie banner
    try {
      await page.waitForFunction(
        () => /Cookie preferences|Accept all|Accept essentials/i.test(document.body.innerText),
        { timeout: 5000 }
      );
      await clickButtonContainsText(page, 'Accept essentials');
      await clickButtonContainsText(page, 'Accept all');
      await clickButtonContainsText(page, 'Accept');
    } catch (_) {}

    // Email
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

    // Password
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

    // Countries
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

    // Expand all countries
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
    await page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll('.p-accordion-tab'));
      const target = tabs.find(t => /doc_type_code/i.test(t.id || ''));
      const link = target?.querySelector('.p-accordion-header-link');
      if (link && link.getAttribute('aria-expanded') !== 'true') {
        link.scrollIntoView({ block: 'center' });
        link.click();
      }
    });
    await new Promise(r => setTimeout(r, 500));

    await page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll('.p-accordion-tab'));
      const target = tabs.find(t => /doc_type_code/i.test(t.id || ''));
      if (!target) return;
      const labels = Array.from(target.querySelectorAll('.p-checkbox-label'));
      const label = labels.find(l => (l.textContent || '').trim().startsWith('Contract'));
      if (!label) return;
      const wrapper = label.closest('.p-checkbox-wrapper') || label.parentElement;
      const box = wrapper?.querySelector('.p-checkbox-box') || wrapper?.querySelector('.p-checkbox') || wrapper;
      box?.scrollIntoView({ block: 'center' });
      box?.click();
    });
    console.log('  Opportunity type: Contract ✓');

    // Tender status
    await page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll('.p-accordion-tab'));
      const target = tabs.find(t => /tender_status/i.test(t.id || ''));
      const link = target?.querySelector('.p-accordion-header-link');
      if (link && link.getAttribute('aria-expanded') !== 'true') {
        link.scrollIntoView({ block: 'center' });
        link.click();
      }
    });
    await new Promise(r => setTimeout(r, 500));

    for (const wanted of ['Open for offers', 'No time limit']) {
      await page.evaluate((name) => {
        const tabs = Array.from(document.querySelectorAll('.p-accordion-tab'));
        const target = tabs.find(t => /tender_status/i.test(t.id || ''));
        if (!target) return;
        const labels = Array.from(target.querySelectorAll('.p-checkbox-label'));
        const label = labels.find(l => {
          const t = (l.textContent || '').trim();
          return t === name || t.startsWith(name + ' ') || t.startsWith(name + '(') ||
                 (name === 'Open for offers' && t.startsWith('Open for offer'));
        });
        if (!label) return;
        const wrapper = label.closest('.p-checkbox-wrapper') || label.parentElement;
        const box = wrapper?.querySelector('.p-checkbox-box') || wrapper?.querySelector('.p-checkbox') || wrapper;
        box?.scrollIntoView({ block: 'center' });
        box?.click();
      }, wanted);
      console.log('  Status:', wanted, '✓');
      await new Promise(r => setTimeout(r, 250));
    }

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

    // Wait for sidebar to close and results to appear
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

    // ---- COLLECT TENDERS FROM ALL PAGES ----
    console.log('--- COLLECTING TENDERS ---');
    const allTenders = [];
    const seenIds = new Set();

   
let emptyPagesInRow = 0;
const MAX_EMPTY_PAGES_IN_ROW = 2;  // jei 2 puslapiai iš eilės be naujų — tada tikrai pabaiga
 
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
 
  // DEBUG: parodyk, kiek unique href radom ir kiek jų nauji
  const foundHrefs = pageTenders.map(t => t.href).slice(0, 3);
  console.log(`Page ${pageNum}: found ${pageTenders.length} cards on page, first hrefs: ${JSON.stringify(foundHrefs)}`);
 
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
  console.log(`Page ${pageNum}: +${newOnThisPage} new, ${dupesOnThisPage} duplicates (total: ${allTenders.length})`);
 
  if (allTenders.length >= MAX_TENDERS) {
    console.log(`Hit MAX_TENDERS limit (${MAX_TENDERS})`);
    break;
  }
 
  // Tolerantiškas sustojimas: leidžiam 2 tuščius puslapius iš eilės
  if (newOnThisPage === 0) {
    emptyPagesInRow++;
    console.log(`  (${emptyPagesInRow}/${MAX_EMPTY_PAGES_IN_ROW} empty pages in a row)`);
    if (emptyPagesInRow >= MAX_EMPTY_PAGES_IN_ROW) {
      console.log('Too many empty pages - stopping pagination');
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

      let newOnThisPage = 0;
      for (const t of pageTenders) {
        const id = extractTenderId(t.href);
        if (!id || seenIds.has(id)) continue;
        seenIds.add(id);
        const url = getCleanTenderUrl(id);
        allTenders.push({ ...t, tenderId: id, url });
        newOnThisPage++;
        if (allTenders.length >= MAX_TENDERS) break;
      }
      console.log(`Page ${pageNum}: +${newOnThisPage} tenders (total: ${allTenders.length})`);

      if (allTenders.length >= MAX_TENDERS) break;
      if (newOnThisPage === 0) break;
      const hasNext = await goToNextPage(page);
      if (!hasNext) break;
    }

    console.log(`✓ Collected ${allTenders.length} tenders total`);
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

    // Check existing IDs for dedup
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
      toFetch[i].details = await fetchTenderDetails(page, cleanUrl);
      const elapsed = Date.now() - t0;

      const d = toFetch[i].details || {};
      console.log(`[${i + 1}/${toFetch.length}] ${elapsed}ms | ${(d.title || 'NONE').slice(0, 60)}`);

      const snippet = (d.fullTextSnippet || '').slice(0, 200);
      if (/414 ERROR|CloudFront|Bad request/i.test(snippet)) {
        console.log(`  ⚠️ CloudFront, retry in 3s...`);
        await new Promise(r => setTimeout(r, 3000));
        toFetch[i].details = await fetchTenderDetails(page, cleanUrl);
      }

      await new Promise(r => setTimeout(r, 400));
    }

    // ---- FORMAT ROWS & APPEND ----
    const nowIso = new Date().toISOString().slice(0, 10);
    const rows = toFetch.map(t => {
      const d = t.details || {};
      return [
        nowIso,
        d.publicationDate || t.publicationDate || '',
        t.url,
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
        t.url,
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
