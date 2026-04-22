const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
const { google } = require('googleapis'); 
async function clickButtonContainsText(page, text) {
  const ok = await page.evaluate((t) => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const el = buttons.find(b => (b.textContent || '').trim().includes(t));
    if (!el) return false;
    el.click();
    return true;
  }, text);

  return ok;
}
async function clickSpanContainsText(page, text) {
  const ok = await page.evaluate((t) => {
    const spans = Array.from(document.querySelectorAll('span'));
    const el = spans.find(s => (s.textContent || '').trim().startsWith(t));
    if (!el) return false;
    el.click();
    return true;
  }, text);

  return ok;
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

    // 1) bandom surasti iš karto
    let label = findLabel();

    // 2) jei nerado — scroll'inam tikrąjį medžio scrollable tėvą
    if (!label) {
      const anyLabel = document.querySelector('span.p-treenode-label');
      const scroller = anyLabel ? getScrollableAncestor(anyLabel) : null;

      if (scroller) {
        scroller.scrollTop = 0;
        fireScroll(scroller);
        await sleep(120);

        const maxY = scroller.scrollHeight + 3000; // su rezervu virtualizavimui
        for (let y = 0; y <= maxY; y += 120) {
          scroller.scrollTop = y;
          fireScroll(scroller);
          await sleep(70);
          label = findLabel();
          if (label) break;
        }
      }

      // 3) atsarginis planas — scroll'inam visą window
      if (!label) {
        for (let y = 0; y <= document.documentElement.scrollHeight; y += 200) {
          window.scrollTo(0, y);
          await sleep(60);
          label = findLabel();
          if (label) break;
        }
      }
    }

    if (!label) {
      const visible = Array.from(document.querySelectorAll('span.p-treenode-label'))
        .map(s => (s.textContent || '').trim());
      return { ok: false, reason: 'label not found', visible };
    }

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

module.exports = async (req, res) => {
  const summary = { errors: [] };
  let browser;
  let page;

  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    page = await browser.newPage();
page.setDefaultNavigationTimeout(120000);
page.setDefaultTimeout(120000);

    // ---- LOGIN (2-step) ----
    await page.goto('https://app.mercell.com/auth/login/challenge/password', { 
       waitUntil: 'domcontentloaded',
       timeout: 120000,
     });
// >>> čia įterpiam cookie banerio tvarkymą
    try {
      await page.waitForFunction(
        () => /Cookie preferences|Accept all|Accept essentials/i.test(document.body.innerText),
        { timeout: 5000 }
      );

      await clickButtonContainsText(page, 'Accept essentials');
      await clickButtonContainsText(page, 'Accept all');
      await clickButtonContainsText(page, 'Accept');
    } catch (_) {
      // jei banerio nėra – nieko blogo
    }
 

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
      if (!submit) throw new Error('Continue/Next button not found after entering email');
      await submit.click();
    }
  })(),
  page.waitForSelector('input[name="password"][type="password"]', { timeout: 60000 }),
]);

    await page.waitForSelector('input[name="password"][type="password"]', { timeout: 15000 });
await page.click('input[name="password"][type="password"]', { clickCount: 3 });
await page.type('input[name="password"][type="password"]', process.env.MERCELL_PASSWORD, { delay: 20 });

// 1) pabandom paprastą submit mygtuką

// spaudžiam login mygtuką pagal tekstą
const clickedLogin =
  (await clickButtonContainsText(page, 'Log in')) ||
  (await clickButtonContainsText(page, 'Login')) ||
  (await clickButtonContainsText(page, 'Sign in'));

if (!clickedLogin) {
  // fallback – jei pavyksta rasti submit mygtuką per selector
  const submit = await page.$('button[type="submit"]');
  if (!submit) throw new Error('Sign-in button not found on password step');
  await submit.click();
}

// laukiame, kol:
await Promise.race([
  // 1) pavyksta išeiti iš /auth/login
  page.waitForFunction(
    () => !location.pathname.includes('/auth/login'),
    { timeout: 120000 }
  ),

  // 2) atsiranda klaidos tekstas (neteisingas password ir pan.)
  page.waitForFunction(
    () => /invalid|incorrect|wrong|error/i.test(document.body.innerText),
    { timeout: 120000 }
  ),

  // 3) atsiranda blokavimo/captcha tekstas (jei Mercell taip rodo)
  page.waitForFunction(
    () => /captcha|robot|blocked|challenge/i.test(document.body.innerText),
    { timeout: 120000 }
  ),
]);

const stillOnLogin = page.url().includes('/auth/login');
if (stillOnLogin) {
  throw new Error('Still on login page after submit (credentials error / captcha / SSO)');
}
// po sėkmingo login
    await page.goto('https://app.mercell.com/search', {
  waitUntil: 'domcontentloaded',
  timeout: 120000,
});
await page.waitForSelector('body', { timeout: 15000 });
console.log('EXPLORE URL:', await page.url());
// atsidūrus Explore puslapyje – atsidarom filtrus

// a) „Search & Filters“ (viršuje)
await clickButtonContainsText(page, 'Search & Filters');

// b) „Filters“ mygtukas (dešiniau)
await page.waitForSelector('button[data-testid="more-filters-toggle-button"]', { timeout: 15000 });
await page.click('button[data-testid="more-filters-toggle-button"]');
// palaukiam, kol dropdown'ai taps aktyvūs (nebebus .p-disabled)
await page.waitForFunction(() => {
  const loc = document.querySelector('div[data-testid="location-dropdown"]');
  const opp = document.querySelector('div[data-testid="opportunity-dropdown"]');
  const pub = document.querySelector('div[data-testid="publication-date-dropdown"]');
  if (!loc || !opp || !pub) return false;
  return !loc.classList.contains('p-disabled') &&
         !opp.classList.contains('p-disabled') &&
         !pub.classList.contains('p-disabled');
}, { timeout: 30000 });
// c) atidarom Location dropdown

// sąrašas šalių
const countries = [
  'Norway', 'Denmark', 'Sweden', 'Finland', 'The Netherlands',
  'Austria', 'Belgium', 'Estonia', 'France', 'Germany',
  'Liechtenstein', 'Luxembourg', 'Portugal', 'Spain',
  'Switzerland', 'United Kingdom',
];

// 1) įsitikinam, kad Filters panelė atidaryta
const sfOk = await clickButtonContainsText(page, 'Search & Filters');
console.log('Clicked Search & Filters?', sfOk);

await page.waitForSelector('button[data-testid="more-filters-toggle-button"]', { timeout: 15000 });
await page.click('button[data-testid="more-filters-toggle-button"]');
console.log('Clicked Filters button');

// 2) spaudžiam „Location“ tekstą, kad atsidarytų medis
const locOk = await clickSpanContainsText(page, 'Location');
console.log('Clicked Location label?', locOk);

// 3) laukiam, kol atsiras šalių medis
await page.waitForSelector('span.p-treenode-label', { timeout: 15000 });

// 4) pažymim šalių checkbox'us (neišskleidžiant sub-regionų)
// DEBUG: kas yra medyje ir kurie konteineriai scroll'inasi
const treeDebug = await page.evaluate(() => {
  const labels = Array.from(document.querySelectorAll('span.p-treenode-label'))
                      .map(s => (s.textContent || '').trim());

  const scrollables = Array.from(document.querySelectorAll('*'))
    .filter(el => {
      const s = getComputedStyle(el);
      return (s.overflowY === 'auto' || s.overflowY === 'scroll' ||
              s.overflow  === 'auto' || s.overflow  === 'scroll') &&
             el.scrollHeight > el.clientHeight + 1;
    })
    .slice(0, 20)
    .map(el => ({
      tag: el.tagName,
      cls: (typeof el.className === 'string' ? el.className : '').slice(0, 160),
      id: el.id || null,
      sh: el.scrollHeight,
      ch: el.clientHeight,
    }));

  return { labelCount: labels.length, labels, scrollables };
});
console.log('DEBUG tree snapshot:', JSON.stringify(treeDebug));
// DEBUG: kas dar yra sidebar panelėje (mygtukai, input'ai, "more/all" tekstai)
const sidebarDebug = await page.evaluate(() => {
  const sidebar = document.querySelector('.p-sidebar-content');
  if (!sidebar) return { error: 'no sidebar' };

  const buttons = Array.from(sidebar.querySelectorAll('button'))
    .map(b => ({
      text: (b.textContent || '').trim().slice(0, 100),
      testid: b.getAttribute('data-testid') || null,
      cls: (typeof b.className === 'string' ? b.className : '').slice(0, 120),
      ariaLabel: b.getAttribute('aria-label') || null,
    }))
    .slice(0, 40);

  const inputs = Array.from(sidebar.querySelectorAll('input'))
    .map(i => ({
      type: i.type,
      placeholder: i.placeholder || null,
      name: i.name || null,
      testid: i.getAttribute('data-testid') || null,
      ariaLabel: i.getAttribute('aria-label') || null,
    }));

  // bet kokie elementai su "show more / all / more" tekstu
  const hintTexts = Array.from(sidebar.querySelectorAll('*'))
    .filter(el => {
      const t = (el.textContent || '').trim().toLowerCase();
      return t.length < 60 &&
        /(show more|show all|view all|see all|all countries|all locations|more locations|more countries|load more|expand)/i
          .test(t);
    })
    .slice(0, 10)
    .map(el => ({
      tag: el.tagName,
      text: (el.textContent || '').trim(),
      cls: (typeof el.className === 'string' ? el.className : '').slice(0, 120),
    }));

  return {
    buttons,
    inputs,
    hintTexts,
    sidebarHTMLSnippet: sidebar.innerHTML.slice(0, 4000),
  };
});
console.log('DEBUG sidebar contents:', JSON.stringify(sidebarDebug));
// Paspaudžiam "Show all (50)" Location sekcijoje, kad būtų visi 50 šalių
const expandedAll = await page.evaluate(() => {
  const btn = document.querySelector('button[data-testid="show-more-button"]');
  if (!btn) return false;
  btn.scrollIntoView({ block: 'center' });
  btn.click();
  return true;
});
console.log('Clicked "Show all" in Location?', expandedAll);

// palaukiam, kol medyje atsiras daugiau negu 5 šalys
await page.waitForFunction(() => {
  return document.querySelectorAll('span.p-treenode-label').length > 10;
}, { timeout: 10000 }).catch(() => {
  console.log('WARN: tree did not expand beyond 10 labels in 10s');
});

// mažytė pauzė, kad tree suspėtų stabilizuotis
await new Promise(r => setTimeout(r, 400));

for (const country of countries) {
  const res = await checkTreeNodeByName(page, country);
  console.log('Checked country checkbox?', country, JSON.stringify(res));
  // trumpa pauzė, kad medis suspėtų perrenderinti po kiekvieno pažymėjimo
  await new Promise(r => setTimeout(r, 250));
}

// --- OPPORTUNITY TYPES: Contract ---

// 1) Atidarom "Opportunity types" accordion'ą
const oppAcc = await page.evaluate(() => {
  const tabs = Array.from(document.querySelectorAll('.p-accordion-tab'));
  const target = tabs.find(t => /doc_type_code/i.test(t.id || ''));
  if (!target) return { found: false };
  const link = target.querySelector('.p-accordion-header-link');
  const wasExpanded = link?.getAttribute('aria-expanded') === 'true';
  if (!wasExpanded && link) {
    link.scrollIntoView({ block: 'center' });
    link.click();
  }
  return { found: true, tabId: target.id, wasExpanded };
});
console.log('Opportunity types accordion:', JSON.stringify(oppAcc));
await new Promise(r => setTimeout(r, 500));

// 2) Paspaudžiam "Contract" checkbox'ą šiame accordion'e
const contractPicked = await page.evaluate(() => {
  const tabs = Array.from(document.querySelectorAll('.p-accordion-tab'));
  const target = tabs.find(t => /doc_type_code/i.test(t.id || ''));
  if (!target) return { ok: false, reason: 'accordion not found' };

  const labels = Array.from(target.querySelectorAll('.p-checkbox-label'));
  const label = labels.find(l => {
    const t = (l.textContent || '').trim();
    return t === 'Contract' || t.startsWith('Contract ') || t.startsWith('Contract(');
  });
  if (!label) {
    const available = labels.map(l => (l.textContent || '').trim()).filter(Boolean);
    return { ok: false, reason: 'Contract label not found', available };
  }

  const wrapper = label.closest('.p-checkbox-wrapper') || label.parentElement;
  const box =
    wrapper?.querySelector('.p-checkbox-box') ||
    wrapper?.querySelector('.p-checkbox') ||
    wrapper;
  if (!box) return { ok: false, reason: 'checkbox box not found' };

  box.scrollIntoView({ block: 'center' });
  box.click();
  return { ok: true };
});
console.log('Selected opportunity type "Contract":', JSON.stringify(contractPicked));

// --- TENDER STATUS: Open for offers ---

// 1) Atidarom "Tender status" accordion'ą
const statusAcc = await page.evaluate(() => {
  const tabs = Array.from(document.querySelectorAll('.p-accordion-tab'));
  const target = tabs.find(t => /tender_status/i.test(t.id || ''));
  if (!target) return { found: false };
  const link = target.querySelector('.p-accordion-header-link');
  const wasExpanded = link?.getAttribute('aria-expanded') === 'true';
  if (!wasExpanded && link) {
    link.scrollIntoView({ block: 'center' });
    link.click();
  }
  return { found: true, tabId: target.id, wasExpanded };
});
console.log('Status accordion:', JSON.stringify(statusAcc));
await new Promise(r => setTimeout(r, 500));

// 2) Paspaudžiam "Open for offers" ir "No time limit" checkbox'us
const statusesToPick = ['Open for offers', 'No time limit'];
const statusResults = [];

for (const wanted of statusesToPick) {
  const res = await page.evaluate((name) => {
    const tabs = Array.from(document.querySelectorAll('.p-accordion-tab'));
    const target = tabs.find(t => /tender_status/i.test(t.id || ''));
    if (!target) return { ok: false, reason: 'status accordion not found' };

    const labels = Array.from(target.querySelectorAll('.p-checkbox-label'));

    // match: tikslus, prasideda vardu + tarpas/(, arba "Open for offer" be s
    const label = labels.find(l => {
      const t = (l.textContent || '').trim();
      return t === name ||
             t.startsWith(name + ' ') ||
             t.startsWith(name + '(') ||
             (name === 'Open for offers' && t.startsWith('Open for offer'));
    });

    if (!label) {
      const available = labels.map(l => (l.textContent || '').trim()).filter(Boolean);
      return { ok: false, reason: `${name} label not found`, available };
    }

    const wrapper = label.closest('.p-checkbox-wrapper') || label.parentElement;
    const box =
      wrapper?.querySelector('.p-checkbox-box') ||
      wrapper?.querySelector('.p-checkbox') ||
      wrapper;
    if (!box) return { ok: false, reason: 'checkbox box not found' };

    box.scrollIntoView({ block: 'center' });
    box.click();
    return { ok: true };
  }, wanted);

  console.log(`Selected status "${wanted}":`, JSON.stringify(res));
  statusResults.push({ name: wanted, ...res });

  // trumpa pauzė tarp paspaudimų, kad DOM stabilizuotųsi
  await new Promise(r => setTimeout(r, 250));
}
// --- CATEGORIES (CPV): IT services 72000000 ---

// 1) Išskleidžiam "Categories (CPV)" accordion'ą
const cpvAcc = await page.evaluate(() => {
  const tabs = Array.from(document.querySelectorAll('.p-accordion-tab'));
  const target = tabs.find(t => /cpv_codes/i.test(t.id || ''));
  if (!target) return { found: false };
  const link = target.querySelector('.p-accordion-header-link');
  const wasExpanded = link?.getAttribute('aria-expanded') === 'true';
  if (!wasExpanded && link) {
    link.scrollIntoView({ block: 'center' });
    link.click();
  }
  return { found: true, tabId: target.id, wasExpanded };
});
console.log('CPV accordion:', JSON.stringify(cpvAcc));
await new Promise(r => setTimeout(r, 500));

// 2) Paspaudžiam "Add categories" mygtuką accordion'e
const clickedAdd = await page.evaluate(() => {
  const tabs = Array.from(document.querySelectorAll('.p-accordion-tab'));
  const target = tabs.find(t => /cpv_codes/i.test(t.id || ''));
  if (!target) return { ok: false, reason: 'CPV tab not found' };

  const buttons = Array.from(target.querySelectorAll('button'));
  const btn = buttons.find(b => /add\s+categor/i.test((b.textContent || '').trim()));
  if (!btn) {
    const available = buttons.map(b => (b.textContent || '').trim()).filter(Boolean);
    return { ok: false, reason: 'Add categories button not found', available };
  }
  btn.scrollIntoView({ block: 'center' });
  btn.click();
  return { ok: true };
});
console.log('Clicked "Add categories":', JSON.stringify(clickedAdd));

// palaukiam, kad atsidarytų picker'is (dialog / sidebar / overlay)
await new Promise(r => setTimeout(r, 1500));

// 3) DEBUG: kas atsirado po "Add categories"
const cpvPickerDebug = await page.evaluate(() => {
  const dialogs = Array.from(document.querySelectorAll(
    '[role="dialog"], .p-dialog, .p-sidebar, .p-overlaypanel, [data-pc-name="dialog"]'
  ));
  const visible = dialogs.filter(d => {
    const rect = d.getBoundingClientRect();
    const cs = getComputedStyle(d);
    return rect.width > 0 && rect.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
  });

  return {
    dialogCount: visible.length,
    dialogs: visible.slice(0, 3).map(d => ({
      tag: d.tagName,
      cls: (typeof d.className === 'string' ? d.className : '').slice(0, 160),
      role: d.getAttribute('role'),
      inputs: Array.from(d.querySelectorAll('input')).slice(0, 10).map(i => ({
        type: i.type,
        placeholder: i.placeholder || null,
        ariaLabel: i.getAttribute('aria-label') || null,
      })),
      buttons: Array.from(d.querySelectorAll('button')).slice(0, 15).map(b => ({
        text: (b.textContent || '').trim().slice(0, 60),
        testid: b.getAttribute('data-testid') || null,
      })),
      // viršutiniai ~20 teksto elementų, kad pamatyti kaip CPV kodai pateikiami
      texts: Array.from(d.querySelectorAll('span, p, li, label'))
        .map(e => (e.textContent || '').trim())
        .filter(t => t && t.length < 120)
        .slice(0, 25),
      sample: d.innerHTML.slice(0, 3500),
    })),
  };
});
console.log('DEBUG CPV picker:', JSON.stringify(cpvPickerDebug));
// --- CPV pasirinkimas: IT services 72000000 ---

// Įrašom "72000000" į CPV modal'o paieškos input'ą
await page.waitForSelector('input[data-testid="cpv-tree-modal-search"]', { timeout: 5000 });
await page.click('input[data-testid="cpv-tree-modal-search"]', { clickCount: 3 });
await page.type('input[data-testid="cpv-tree-modal-search"]', '72000000', { delay: 20 });
await new Promise(r => setTimeout(r, 1000));

// Pažymim 72000000 kategorijos checkbox'ą dialog'e
const cpvPicked = await page.evaluate(() => {
  const dialog = document.querySelector('.p-dialog[role="dialog"]');
  if (!dialog) return { ok: false, reason: 'dialog not found' };

  const candidates = Array.from(dialog.querySelectorAll('li, tr, div, span, label'))
    .filter(el => {
      const t = (el.textContent || '').trim();
      return t.includes('72000000') && t.length < 300;
    });

  if (candidates.length === 0) {
    const codes = Array.from(dialog.querySelectorAll('span, li, label'))
      .map(e => (e.textContent || '').trim())
      .filter(t => /\d{8}/.test(t))
      .slice(0, 20);
    return { ok: false, reason: '72000000 not found after search', visibleCodes: codes };
  }

  // imam "siauriausią" kandidatą
  candidates.sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);
  const target = candidates[0];

  // randam artimiausią checkbox'ą per tėvus
  let parent = target;
  let box = null;
  for (let i = 0; i < 6 && parent; i++) {
    box = parent.querySelector?.('.p-checkbox-box, [role="checkbox"]');
    if (box) break;
    parent = parent.parentElement;
  }
  if (!box) return { ok: false, reason: 'checkbox not found near 72000000' };

  box.scrollIntoView({ block: 'center' });
  box.click();
  return { ok: true, targetText: (target.textContent || '').trim().slice(0, 120) };
});
console.log('CPV 72000000 picked:', JSON.stringify(cpvPicked));
await new Promise(r => setTimeout(r, 600));

// Paspaudžiam confirm mygtuką dialog'e (Save / Apply / Done / Add)
const cpvConfirmed = await page.evaluate(() => {
  const dialog = document.querySelector('.p-dialog[role="dialog"]');
  if (!dialog) return { ok: false, reason: 'dialog not found' };

  const buttons = Array.from(dialog.querySelectorAll('button'));
  const availableLabels = buttons
    .map(b => ({
      text: (b.textContent || '').trim(),
      testid: b.getAttribute('data-testid') || null,
    }))
    .filter(x => x.text);

  const btn = buttons.find(b => {
    const t = (b.textContent || '').trim();
    return /^(save|apply|done|confirm|ok|add|select|finish|submit|add categor)/i.test(t);
  });

  if (!btn) return { ok: false, reason: 'confirm button not found', availableLabels };

  const label = (btn.textContent || '').trim();
  btn.click();
  return { ok: true, label };
});
console.log('CPV confirmed:', JSON.stringify(cpvConfirmed));
await new Promise(r => setTimeout(r, 1000));

// =====================================================================
// DALIS 2 (v2 — SMOKE TEST) — Apply filters + 1 puslapis × 5 tender'iai
// + Google Sheets su dedup pagal tender ID
//
// ĮTERPTI po: console.log('CPV confirmed:', JSON.stringify(cpvConfirmed));
//          ir PRIEŠ: await browser.close()
//
// Reikalavimai:
// - package.json: "googleapis": "^144.0.0"
// - viršuje (kartu su kitais require):
//     const { google } = require('googleapis');
// - env: GOOGLE_SERVICE_ACCOUNT_JSON, SHEET_ID, (opt.) SHEET_TAB_NAME
// =====================================================================

// --- SMOKE TEST RIBOS ----------------------------------------------------
const TEST_MODE = true;
const MAX_PAGES = TEST_MODE ? 1 : 50;
const MAX_TENDERS = TEST_MODE ? 5 : 500;
const DETAILS_LIMIT = TEST_MODE ? 5 : 200;

// --- 1) APPLY FILTERS ----------------------------------------------------
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
  if (!btn) {
    const available = buttons.map(b => (b.textContent || '').trim()).filter(Boolean).slice(0, 30);
    return { ok: false, reason: 'Apply button not found', available };
  }
  btn.scrollIntoView({ block: 'center' });
  btn.click();
  return { ok: true, label: (btn.textContent || '').trim() };
});
console.log('Apply filters:', JSON.stringify(appliedFilters));
if (!appliedFilters.ok) {
  throw new Error('Could not click Apply filters: ' + JSON.stringify(appliedFilters));
}

// laukiam kol rezultatai persifiltruos ir sidebar užsidarys
await page.waitForFunction(() => {
  return document.querySelectorAll('[data-testid="tender-name"]').length > 0;
}, { timeout: 20000 }).catch(() => console.log('WARN: tender-name cards not found in 20s'));
await new Promise(r => setTimeout(r, 1500));

// --- 2) PAGALBINĖS FUNKCIJOS --------------------------------------------

// Ištraukia tender ID iš URL, pvz. /tender/904149649?... → 904149649
function extractTenderId(urlOrHref) {
  const m = (urlOrHref || '').match(/\/tender\/(\d+)/);
  return m ? m[1] : null;
}

async function goToNextPage(page) {
  const clicked = await page.evaluate(() => {
    const next = document.querySelector('.p-paginator-next:not(.p-disabled)');
    if (!next) return false;
    next.scrollIntoView({ block: 'center' });
    next.click();
    return true;
  });
  if (!clicked) return false;
  await new Promise(r => setTimeout(r, 2000));
  return true;
}

// --- 3) SURENKAM TENDER'IUS IŠ SĄRAŠO ------------------------------------
// Naudojam TIKRĄ selector'į iš log'ų: [data-testid="tender-name"]

const allTenders = [];
const seenIds = new Set();

for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
  try {
    await page.waitForFunction(() => {
      return document.querySelectorAll('[data-testid="tender-name"]').length > 0;
    }, { timeout: 15000 });
  } catch (_) {
    console.log(`Page ${pageNum}: no results, stopping`);
    break;
  }

  const pageTenders = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('[data-testid="tender-name"]'));

    return cards.map(nameEl => {
      const linkEl = nameEl.querySelector('a[href*="/tender/"]') || nameEl.closest('a');
      const href = linkEl?.getAttribute('href') || null;
      const title = (nameEl.innerText || '').trim();

      // pasirenkam visą kortelės konteinerį, kad gautume meta-duomenis
      const card = nameEl.closest('[data-testid*="card"], article, li') ||
                   nameEl.parentElement?.parentElement ||
                   nameEl.parentElement;
      const cardText = (card?.innerText || '').trim();

      // meta paieška kortelės viduje
      const organisation =
        card?.querySelector('[data-testid*="buyer"], [data-testid*="organization"], [data-testid*="publisher"]')?.innerText?.trim() ||
        null;

      const countryMatch = cardText.match(/\b(Norway|Sweden|Denmark|Finland|Netherlands|Austria|Belgium|Estonia|France|Germany|Liechtenstein|Luxembourg|Portugal|Spain|Switzerland|United Kingdom|Ireland|Italy|Poland|Iceland|Lithuania|Latvia|Czech|Slovakia|Hungary|Greece|Romania|Bulgaria|Croatia|Slovenia)\b/i);

      const deadlineMatch = cardText.match(/(?:deadline|closes|closing)[^\n]{0,40}?(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})/i) ||
                             cardText.match(/\b(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})\b/);

      return {
        href,
        title,
        organisation,
        country: countryMatch ? countryMatch[1] : null,
        deadlineRaw: deadlineMatch ? (deadlineMatch[1] || deadlineMatch[0]) : null,
        cardText: cardText.slice(0, 1000),
      };
    }).filter(t => t.href);
  });

  let newOnThisPage = 0;
  for (const t of pageTenders) {
    const id = extractTenderId(t.href);
    if (!id || seenIds.has(id)) continue;
    seenIds.add(id);
    const url = t.href.startsWith('http')
      ? t.href
      : new URL(t.href, 'https://app.mercell.com').toString();
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

console.log(`Collected ${allTenders.length} tenders total`);

// DEBUG: parodyk ką radom sąrašo lygyje
console.log('Sample tender from list:', JSON.stringify(allTenders[0], null, 2).slice(0, 1500));

// --- 4) PIRMA PASITIKRINAM Google Sheets ir IŠFILTRUOJAM dublikatus ------
// =====================================================================
// ĮTERPTI PRIEŠ eilutę:
//   const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
// =====================================================================

// --- DEBUG: env vars patikra ---
console.log('ENV CHECK:', {
  hasServiceAccountKey: !!process.env.GOOGLE_SERVICE_ACCOUNT_KEY,
  serviceAccountKeyLength: (process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '').length,
  serviceAccountStartsWith: (process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '').slice(0, 30),
  hasSheetId: !!process.env.SHEET_ID,
  sheetIdLength: (process.env.SHEET_ID || '').length,
  sheetTabName: process.env.SHEET_TAB_NAME || '(not set, will use Sheet1)',
  // visi env var'ai, kurių vardai prasideda GOOGLE / SHEET / MERCELL (be reikšmių, saugumo sumetimais)
  relatedEnvKeys: Object.keys(process.env).filter(k => /^(GOOGLE|SHEET|MERCELL)/i.test(k)),
});

if (!process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
  throw new Error(
    'GOOGLE_SERVICE_ACCOUNT_KEY env var is missing. ' +
    'Check Vercel → Settings → Environment Variables, ' +
    'make sure it is set for Production env, and redeploy.'
  );
}
if (!process.env.SHEET_ID) {
  throw new Error('SHEET_ID env var is missing.');
}
const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
const jwt = new google.auth.JWT({
  email: serviceAccount.client_email,
  key: serviceAccount.private_key,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
await jwt.authorize();
const sheets = google.sheets({ version: 'v4', auth: jwt });
const SHEET_ID = process.env.SHEET_ID;
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

// nuskaitom esamą lapą — paimam URL stulpelį (C arba O), kad dedup'intume
let existingIds = new Set();
try {
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${TAB_NAME}!A1:P`,
  });
  const rows = existing.data.values || [];
  const hasHeader = rows[0] && rows[0][0] === SHEET_HEADERS[0];

  if (!hasHeader && rows.length === 0) {
    // tuščias lapas — įrašom header
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${TAB_NAME}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [SHEET_HEADERS] },
    });
    console.log('Header row inserted (empty sheet)');
  } else if (!hasHeader) {
    console.log('WARN: sheet has data but header mismatch, will NOT overwrite');
  }

  // renkam esamus tender ID iš stulpelio C (LINK...) ir O (Source URL)
  for (let i = hasHeader ? 1 : 0; i < rows.length; i++) {
    const link = rows[i][2] || rows[i][14] || '';
    const id = extractTenderId(link);
    if (id) existingIds.add(id);
  }
  console.log(`Existing tender IDs in sheet: ${existingIds.size}`);
} catch (e) {
  console.log('WARN: could not read existing sheet, will just append:', e.message);
}

// išfiltruojam tuos, kurie jau yra Sheets'e
const newTenders = allTenders.filter(t => !existingIds.has(t.tenderId));
console.log(`New tenders to fetch details for: ${newTenders.length} (${allTenders.length - newTenders.length} already in sheet)`);

// --- 5) DETALĖS — tik naujiems tender'iams, bet ne daugiau nei DETAILS_LIMIT

async function fetchTenderDetails(page, tenderUrl) {
  try {
    await page.goto(tenderUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('body', { timeout: 10000 });
    await new Promise(r => setTimeout(r, 1500));

    const details = await page.evaluate(() => {
      const bodyText = (document.body.innerText || '').trim();

      const sectionText = (labels) => {
        const all = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, dt, th, strong, label, div'));
        for (const lab of labels) {
          const re = new RegExp('^\\s*' + lab + '\\s*:?\\s*$', 'i');
          const el = all.find(e => {
            const t = (e.textContent || '').trim();
            return re.test(t) && t.length < 100;
          });
          if (!el) continue;
          const val = el.nextElementSibling?.innerText
                   || el.parentElement?.nextElementSibling?.innerText
                   || el.parentElement?.querySelector('dd, td, p, span')?.innerText;
          if (val && val.trim()) return val.trim().slice(0, 2000);
        }
        return null;
      };

      const budgetMatch = bodyText.match(
        /(?:estimated value|contract value|max(?:imum)?\s*(?:budget|value)|budget|value\s*\(excl)[^\n]{0,40}?[:\s]+([€$£]?\s*[\d.,\s]+(?:\s*(?:EUR|USD|GBP|NOK|SEK|DKK))?)/i
      );
      const durationMatch = bodyText.match(
        /(?:duration|contract\s*period|contract\s*length|agreement\s*duration|term)[^\n]{0,40}?[:\s]+([^\n.]{1,80})/i
      ) || bodyText.match(/(\d+)\s*(months?|years?)/i);
      const deadlineMatch = bodyText.match(
        /(?:deadline|closing\s*date|offer\s*deadline|submission\s*deadline|tender\s*deadline)[^\n]{0,40}?[:\s]+([^\n]{1,80})/i
      );
      const pubMatch = bodyText.match(
        /(?:published|publication\s*date|date\s*published)[^\n]{0,40}?[:\s]+([^\n]{1,60})/i
      );
      const refMatch = bodyText.match(
        /(?:reference(?:\s+number|\s+no\.?)?|ref\.?\s*no\.?)[:\s]+([A-Z0-9\-\/_.]+)/i
      );

      return {
        title: document.querySelector('h1')?.innerText?.trim() || null,
        organisation: sectionText(['buyer', 'contracting authority', 'contracting entity', 'purchaser', 'organisation']),
        country: sectionText(['country', 'location']),
        deadline: deadlineMatch ? deadlineMatch[1].trim() : null,
        publicationDate: pubMatch ? pubMatch[1].trim() : null,
        referenceNumber: refMatch ? refMatch[1].trim() : null,
        maxBudget: budgetMatch ? budgetMatch[1].trim() : null,
        duration: durationMatch ? (durationMatch[1] + (durationMatch[2] ? ' ' + durationMatch[2] : '')).trim() : null,
        requirementsForSupplier: sectionText(['requirements for supplier', 'supplier requirements', 'requirements']),
        qualificationRequirements: sectionText(['qualification requirements', 'qualifications', 'eligibility', 'selection criteria']),
        offerWeighingCriteria: sectionText(['award criteria', 'evaluation criteria', 'weighing criteria', 'criteria for award']),
        scopeOfAgreement: sectionText(['scope', 'scope of agreement', 'description', 'object of the contract', 'subject matter']),
        technicalStack: sectionText(['technical stack', 'technology', 'technical requirements']),
        fullTextSnippet: bodyText.slice(0, 2000),
      };
    });

    return details;
  } catch (e) {
    return { error: e.message || String(e) };
  }
}

const toFetch = newTenders.slice(0, DETAILS_LIMIT);
console.log(`Fetching details for ${toFetch.length} tenders...`);

for (let i = 0; i < toFetch.length; i++) {
  console.log(`[${i + 1}/${toFetch.length}] ${toFetch[i].url.slice(0, 80)}...`);
  toFetch[i].details = await fetchTenderDetails(page, toFetch[i].url);
  await new Promise(r => setTimeout(r, 300));
}

// --- 6) FORMAT ROWS & APPEND --------------------------------------------

const nowIso = new Date().toISOString().slice(0, 10);
const rows = toFetch.map(t => {
  const d = t.details || {};
  return [
    nowIso,
    d.publicationDate || '',
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
    d.referenceNumber || '',
  ];
});

// DEBUG: parodyk pirmą eilutę, kurią rašysi
if (rows.length > 0) {
  console.log('Sample row to append:', JSON.stringify(rows[0]));
}
// DEBUG: parodyk pirmo tender'io fullTextSnippet — kad matytume parser'io medžiagą
if (toFetch[0]?.details?.fullTextSnippet) {
  console.log('First tender full text snippet:', toFetch[0].details.fullTextSnippet.slice(0, 1500));
}

if (rows.length > 0) {
  const appendRes = await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${TAB_NAME}!A:P`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows },
  });
  console.log(`✓ Appended ${rows.length} rows: ${appendRes.data.updates?.updatedRange}`);
} else {
  console.log('Nothing to append (all tenders already in sheet or none collected)');
}

summary.tendersFound = allTenders.length;
summary.newTenders = newTenders.length;
summary.rowsAppended = rows.length;

await browser.close()
return res.status(200).json({ ok: true });

} catch (e) {
  const msg = e?.message || String(e);
  const debug = { errorMessage: msg };

  // jei jau esam dashboard'e ir tik frame atsijungė – laikom kaip sėkmingą login
  try {
    if (page) {
      const currentUrl = page.url();
      debug.url = currentUrl;

      if (currentUrl.includes('/dashboard') && msg.includes('detached Frame')) {
        try { if (browser) await browser.close(); } catch (_) {}
        return res.status(200).json({ ok: true, note: 'Login ok, frame detached after redirect' });
      }

      debug.path = await page.evaluate(() => location.pathname);
      debug.bodyText = await page.evaluate(
        () => (document.body?.innerText || '').slice(0, 4000)
      );
      debug.htmlSnippet = (await page.content()).slice(0, 30000);
      const screenshot = await page.screenshot({ type: 'png', fullPage: true });
      debug.screenshotBase64 = screenshot.toString('base64');
    }
  } catch (dbgErr) {
    debug.debugCaptureError = dbgErr?.message || String(dbgErr);
  }

  try { if (browser) await browser.close(); } catch (_) {}

  return res.status(500).json({ ok: false, error: 'Login failed', debug });
}


};

