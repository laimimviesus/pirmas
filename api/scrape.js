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

    await page.goto('https://app.mercell.com/tender/explore', {
  waitUntil: 'networkidle0',
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
await page.click('div[data-testid="location-dropdown"] .p-treeselect-trigger');





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

