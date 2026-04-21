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
       timeour: 120000,
     });

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
let signInBtn = await page.$('button[type="submit"]');

if (signInBtn) {
  await signInBtn.click();
} else {
  // 2) jei nėra submit, spaudžiam pagal tekstą (per evaluate)
  const clicked =
    (await clickButtonContainsText(page, 'Sign in')) ||
    (await clickButtonContainsText(page, 'Log in')) ||
    (await clickButtonContainsText(page, 'Login'));

  if (!clicked) throw new Error('Sign-in button not found on password step');
}


// laukiam, kol atsiras kažkas “po login”
await Promise.race([
  page.waitForSelector('a[href*="explore"]', { timeout: 60000 }),
  page.waitForSelector('[data-testid="user-menu"]', { timeout: 60000 }),
]);

// laukiam, kol atsiras kažkas “po login”
await Promise.race([
  page.waitForSelector('a[href*="explore"]', { timeout: 60000 }),
  page.waitForSelector('[data-testid="user-menu"]', { timeout: 60000 }),
]);

await signInBtn.click();


    await browser.close();
    return res.status(200).json({ ok: true });
  } catch (e) {
    const debug = { errorMessage: e?.message || String(e) };

    try {
      if (page) {
        const screenshot = await page.screenshot({ type: 'png', fullPage: false });
        debug.screenshotBase64 = screenshot.toString('base64');

        const html = await page.content();
        debug.htmlSnippet = html.slice(0, 4000);
      }
    } catch (dbgErr) {
      debug.debugCaptureError = dbgErr?.message || String(dbgErr);
    }

    try { if (browser) await browser.close(); } catch (_) {}

    return res.status(500).json({ ok: false, error: 'Login failed', debug });
  }
};

