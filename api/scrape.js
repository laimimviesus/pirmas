const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
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
// DALIS 2 — Apply filters + rezultatų nuskaitymas + Google Sheets append
// ĮTERPTI po: console.log('CPV confirmed:', JSON.stringify(cpvConfirmed));
//          ir PRIEŠ: await browser.close()
// =====================================================================

// --- 0) Reikia pridėti priklausomybę (VIRŠUJE, prie puppeteer importų):
// const { google } = require('googleapis');
//
// Ir package.json -> "dependencies": { ..., "googleapis": "^144.0.0" }

// --- 1) APPLY FILTERS ---------------------------------------------------
// Mercell sidebar'e apačioje yra "Apply filters" / "Apply" / "Show results" mygtukas.
// Kartais jis yra sticky footer'yje — paieškom pagal tekstą, ne tik selector.

const appliedFilters = await page.evaluate(() => {
  // pirma bandom rasti sidebar footer
  const sidebar = document.querySelector('.p-sidebar-content, [role="dialog"], .p-sidebar');
  const root = sidebar || document;

  const buttons = Array.from(root.querySelectorAll('button'));
  const btn = buttons.find(b => {
    const t = (b.textContent || '').trim().toLowerCase();
    return /^(apply filters|apply|show results|show \d+ results|search)$/i.test(t)
        || /apply\s+filter/i.test(t)
        || /show\s+\d+\s+result/i.test(t);
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

// Palaukiam kol užsidarys sidebar ir atsinaujins rezultatai.
// Sidebar užsidarius — .p-sidebar-mask dings arba sidebar gaus "exit" klasę.
await new Promise(r => setTimeout(r, 2500));

// --- 2) DEBUG: paimam rezultatų konteinerio struktūrą -------------------
// Kad žinotume, kokiais selector'iais paimti korteles.
const resultsDebug = await page.evaluate(() => {
  // tipiški PrimeReact / custom variantai:
  const candidates = [
    '[data-testid*="tender"]',
    '[data-testid*="result"]',
    '[data-testid*="card"]',
    'a[href*="/tender/"]',
    'a[href*="/opportunity/"]',
    'a[href*="/procurement/"]',
    '.p-datatable-tbody tr',
    'article',
  ];

  const counts = {};
  for (const sel of candidates) {
    try {
      counts[sel] = document.querySelectorAll(sel).length;
    } catch (_) { counts[sel] = -1; }
  }

  // paieškom bet kokio mygtuko su "next" / puslapio paginacijos
  const pagButtons = Array.from(document.querySelectorAll('button, a'))
    .filter(el => {
      const t = (el.textContent || '').trim().toLowerCase();
      const al = (el.getAttribute('aria-label') || '').toLowerCase();
      return /next|page|›|»/i.test(t) || /next page|pagination/i.test(al);
    })
    .slice(0, 10)
    .map(el => ({
      tag: el.tagName,
      text: (el.textContent || '').trim().slice(0, 40),
      aria: el.getAttribute('aria-label') || null,
      testid: el.getAttribute('data-testid') || null,
      cls: (typeof el.className === 'string' ? el.className : '').slice(0, 120),
    }));

  // imam pirmą kortelės kandidatą ir paimam jos HTML pavyzdį
  const firstLink = document.querySelector('a[href*="/tender/"], a[href*="/opportunity/"], a[href*="/procurement/"]');
  const firstCard = firstLink ? firstLink.closest('article, li, tr, .p-card, [data-testid]') || firstLink.parentElement : null;

  return {
    url: location.href,
    counts,
    pagButtons,
    firstCardHTML: firstCard ? firstCard.outerHTML.slice(0, 3000) : null,
    firstLinkHref: firstLink?.getAttribute('href') || null,
  };
});
console.log('DEBUG results page:', JSON.stringify(resultsDebug));

// --- 3) Pagalbinės funkcijos --------------------------------------------

// ištrauks tekstą pagal label'ą kortelėje/detalių puslapyje (fallback'as, jei struktūra nepastovi)
async function extractByLabel(page, scopeSelector, labels) {
  return await page.evaluate((scopeSel, wantedLabels) => {
    const scope = scopeSel ? document.querySelector(scopeSel) : document;
    if (!scope) return {};
    const result = {};
    const all = Array.from(scope.querySelectorAll('dt, th, label, span, p, div'));
    for (const wanted of wantedLabels) {
      const re = new RegExp('^\\s*' + wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:?\\s*$', 'i');
      const labelEl = all.find(el => re.test((el.textContent || '').trim()) && el.textContent.length < 80);
      if (!labelEl) { result[wanted] = null; continue; }
      // value: next sibling / dd / td
      let val = null;
      if (labelEl.tagName === 'DT') val = labelEl.nextElementSibling?.textContent;
      else if (labelEl.tagName === 'TH') val = labelEl.parentElement?.querySelector('td')?.textContent
                                        || labelEl.nextElementSibling?.textContent;
      else val = labelEl.nextElementSibling?.textContent
             || labelEl.parentElement?.nextElementSibling?.textContent;
      result[wanted] = (val || '').trim() || null;
    }
    return result;
  }, scopeSelector, labels);
}

// laukia kol paginacijos next taps disabled arba puslapis pasikeis
async function goToNextPage(page) {
  // tipiniai paginator variantai PrimeReact: .p-paginator-next
  const clicked = await page.evaluate(() => {
    const next =
      document.querySelector('.p-paginator-next:not(.p-disabled)') ||
      document.querySelector('button[aria-label="Next Page" i]:not([disabled])') ||
      document.querySelector('button[aria-label*="next" i]:not([disabled])');
    if (!next) return false;
    next.scrollIntoView({ block: 'center' });
    next.click();
    return true;
  });
  if (!clicked) return false;
  await new Promise(r => setTimeout(r, 1500)); // palaukiam naujų rezultatų
  return true;
}

// --- 4) SURENKAM VISŲ PUSLAPIŲ TENDER'IŲ SĄRAŠĄ ------------------------

const allTenders = [];
const seenHrefs = new Set();
const MAX_PAGES = 50;        // safety limit
const MAX_TENDERS = 500;     // safety limit

for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
  // palaukiam kol kortelės atsiras
  try {
    await page.waitForFunction(() => {
      return document.querySelectorAll('a[href*="/tender/"], a[href*="/opportunity/"], a[href*="/procurement/"]').length > 0;
    }, { timeout: 15000 });
  } catch (_) {
    console.log(`Page ${pageNum}: no results found, stopping`);
    break;
  }

  const pageTenders = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll(
      'a[href*="/tender/"], a[href*="/opportunity/"], a[href*="/procurement/"]'
    ));
    // dedupe pagal href, tik unikalūs per vieną puslapį
    const byHref = new Map();
    for (const a of links) {
      const href = a.getAttribute('href');
      if (!href || byHref.has(href)) continue;
      const card = a.closest('article, li, tr, [data-testid]') || a.parentElement;
      const txt = (card?.innerText || a.innerText || '').trim();

      // pavadinimas = ilgiausia pirma eilutė arba link'o tekstas
      const title = (a.innerText || '').trim() || (txt.split('\n')[0] || '').trim();

      // deadline: ieškom "DD.MM.YYYY" arba "DD Month YYYY" pattern'o
      const deadlineMatch = txt.match(/\b(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{1,2}\s+\w+\s+\d{4})\b[^\n]*\b(?:\d{1,2}:\d{2})?/);

      // šalis — paprastai viena iš: Norway, Sweden, etc. tekste
      const countryMatch = txt.match(/\b(Norway|Sweden|Denmark|Finland|Netherlands|Austria|Belgium|Estonia|France|Germany|Liechtenstein|Luxembourg|Portugal|Spain|Switzerland|United Kingdom|Ireland|Italy|Poland|Iceland|Lithuania|Latvia|Czech|Slovakia|Hungary|Greece|Romania|Bulgaria|Croatia|Slovenia)\b/i);

      // organizacija — dažnai po title arba prieš šalį. Heuristika:
      const lines = txt.split('\n').map(s => s.trim()).filter(Boolean);
      // org = 2-oji eilutė, jei ji nėra data ir nėra šalis ir nėra title
      let org = null;
      for (const l of lines.slice(1, 5)) {
        if (l === title) continue;
        if (/^\d/.test(l)) continue;
        if (countryMatch && l === countryMatch[1]) continue;
        if (l.length > 120) continue;
        org = l; break;
      }

      // ref. nr.: "Reference: XYZ" arba patterns
      const refMatch = txt.match(/(?:Reference|Ref\.?|Reference no\.?|Reference number)[:\s]+([A-Z0-9\-\/_.]+)/i);

      // publikacijos data: "Published" / "Publication" prefix
      const pubMatch = txt.match(/(?:Published|Publication date)[:\s]+(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{1,2}\s+\w+\s+\d{4})/i);

      byHref.set(href, {
        href,
        title,
        organisation: org,
        country: countryMatch ? countryMatch[1] : null,
        deadlineRaw: deadlineMatch ? deadlineMatch[0] : null,
        referenceNumber: refMatch ? refMatch[1] : null,
        publicationDate: pubMatch ? pubMatch[1] : null,
        rawText: txt.slice(0, 800), // debug'ui ir detalių papildymui
      });
    }
    return Array.from(byHref.values());
  });

  let newOnThisPage = 0;
  for (const t of pageTenders) {
    if (seenHrefs.has(t.href)) continue;
    seenHrefs.add(t.href);
    // absoliutus URL
    const url = t.href.startsWith('http') ? t.href : new URL(t.href, 'https://app.mercell.com').toString();
    allTenders.push({ ...t, url });
    newOnThisPage++;
    if (allTenders.length >= MAX_TENDERS) break;
  }
  console.log(`Page ${pageNum}: collected ${newOnThisPage} new tenders (total: ${allTenders.length})`);

  if (allTenders.length >= MAX_TENDERS) {
    console.log('Hit MAX_TENDERS limit, stopping pagination');
    break;
  }
  if (newOnThisPage === 0) {
    console.log('No new tenders on this page, assuming end of list');
    break;
  }

  const hasNext = await goToNextPage(page);
  if (!hasNext) {
    console.log('No next page button, pagination finished');
    break;
  }
}

console.log(`TOTAL tenders collected: ${allTenders.length}`);

// --- 5) DETALĖS: įeinam į kiekvieną tender'io puslapį --------------------
// Šie laukai paprastai NĖRA sąrašo kortelėje:
//   MAX BUDGET, DURATION, REQUIREMENTS, QUALIFICATION, WEIGHING, SCOPE, TECH STACK
// Todėl einam į kiekvieno detalės puslapį.

async function fetchTenderDetails(page, tenderUrl) {
  try {
    await page.goto(tenderUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('body', { timeout: 10000 });
    await new Promise(r => setTimeout(r, 1200)); // hydration

    // Paimam visą matomą tekstą — tada ieškom pattern'ų
    const details = await page.evaluate(() => {
      const bodyText = (document.body.innerText || '').trim();

      // utility: ieškom sekcijos pagal antraštę
      const sectionText = (labels) => {
        const all = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, dt, th, strong, label'));
        for (const lab of labels) {
          const re = new RegExp('^\\s*' + lab + '\\s*:?\\s*$', 'i');
          const el = all.find(e => re.test((e.textContent || '').trim()) && e.textContent.length < 100);
          if (!el) continue;
          // imam sibling arba tėvo sibling
          let val = el.nextElementSibling?.innerText
                 || el.parentElement?.nextElementSibling?.innerText
                 || el.parentElement?.querySelector('dd, td, p, span')?.innerText;
          if (val && val.trim()) return val.trim();
        }
        return null;
      };

      // budget
      const budgetMatch = bodyText.match(
        /(?:estimated value|contract value|maximum value|max(?:imum)? budget|budget|value)[^\n]{0,30}?[:\s]+([€$£]?\s*[\d.,]+(?:\s*(?:EUR|USD|GBP|NOK|SEK|DKK))?)/i
      );

      // duration: "24 months", "2 years", "Duration: ..."
      const durationMatch = bodyText.match(
        /(?:duration|contract period|contract length|agreement duration|term)[^\n]{0,30}?[:\s]+([^\n.]{1,80})/i
      ) || bodyText.match(/(\d+)\s*(months?|years?|mths?|yrs?)/i);

      // deadline: daugiau tikslus nei list'e
      const deadlineMatch = bodyText.match(
        /(?:deadline|closing date|offer deadline|submission deadline|tender deadline)[^\n]{0,30}?[:\s]+([^\n]{1,80})/i
      );

      // publication
      const pubMatch = bodyText.match(
        /(?:published|publication date|date published)[^\n]{0,30}?[:\s]+([^\n]{1,60})/i
      );

      // reference
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
        duration: durationMatch ? (durationMatch[1] || `${durationMatch[1]} ${durationMatch[2]}`).trim() : null,
        requirementsForSupplier: sectionText(['requirements for supplier', 'supplier requirements', 'general requirements', 'requirements']),
        qualificationRequirements: sectionText(['qualification requirements', 'qualifications', 'eligibility', 'selection criteria']),
        offerWeighingCriteria: sectionText(['award criteria', 'evaluation criteria', 'weighing criteria', 'offer evaluation', 'criteria for award']),
        scopeOfAgreement: sectionText(['scope', 'scope of agreement', 'scope of contract', 'description', 'object of the contract', 'subject matter']),
        technicalStack: sectionText(['technical stack', 'technology', 'technical requirements', 'technologies']),
        // full text fallback — jei reikės vėliau parse'inti rankiniu budu
        fullTextSnippet: bodyText.slice(0, 2000),
      };
    });

    return details;
  } catch (e) {
    return { error: e.message || String(e) };
  }
}

// einam į detales — ribojam, kad nelaukus valandos
const DETAILS_LIMIT = Math.min(allTenders.length, 100);
console.log(`Fetching details for ${DETAILS_LIMIT} tenders...`);

for (let i = 0; i < DETAILS_LIMIT; i++) {
  const t = allTenders[i];
  console.log(`[${i + 1}/${DETAILS_LIMIT}] ${t.url}`);
  const d = await fetchTenderDetails(page, t.url);
  allTenders[i].details = d;
  // trumpa pauzė, kad neprovokuotume rate limit'o
  await new Promise(r => setTimeout(r, 300));
}

// --- 6) RAŠOM Į GOOGLE SHEETS ------------------------------------------

// headers tiksliai kaip prašei
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

const nowIso = new Date().toISOString().slice(0, 10);

const rows = allTenders.map(t => {
  const d = t.details || {};
  return [
    nowIso,                                                          // 1. when added
    d.publicationDate || t.publicationDate || '',                   // 2. announcement
    t.url,                                                           // 3. link
    d.title || t.title || '',                                        // 4. name
    d.organisation || t.organisation || '',                          // 5. org
    d.deadline || t.deadlineRaw || '',                               // 6. deadline
    d.country || t.country || '',                                    // 7. country
    d.maxBudget || '',                                               // 8. budget
    d.duration || '',                                                // 9. duration
    d.requirementsForSupplier || '',                                 // 10. requirements
    d.qualificationRequirements || '',                               // 11. qualif
    d.offerWeighingCriteria || '',                                   // 12. weighing
    d.scopeOfAgreement || '',                                        // 13. scope
    d.technicalStack || '',                                          // 14. tech stack
    t.url,                                                           // 15. source URL (same as link)
    d.referenceNumber || t.referenceNumber || '',                    // 16. ref. no.
  ];
});

// Google Sheets klientas
const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
const jwt = new google.auth.JWT({
  email: serviceAccount.client_email,
  key: serviceAccount.private_key,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
await jwt.authorize();
const sheets = google.sheets({ version: 'v4', auth: jwt });

const SHEET_ID = process.env.SHEET_ID;
const TAB_NAME = process.env.SHEET_TAB_NAME || 'Sheet1';

// 1) užtikrinam, kad header eilutė yra (jei lapas tuščias — įrašom)
const firstRow = await sheets.spreadsheets.values.get({
  spreadsheetId: SHEET_ID,
  range: `${TAB_NAME}!A1:P1`,
});
const hasHeader = firstRow.data.values && firstRow.data.values[0] && firstRow.data.values[0].length > 0;

if (!hasHeader) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${TAB_NAME}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [SHEET_HEADERS] },
  });
  console.log('Header row inserted');
}

// 2) append eilutes
if (rows.length > 0) {
  const appendRes = await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${TAB_NAME}!A:P`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows },
  });
  console.log(`Appended ${rows.length} rows. Updated range: ${appendRes.data.updates?.updatedRange}`);
}

summary.tendersCollected = allTenders.length;
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

