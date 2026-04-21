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

