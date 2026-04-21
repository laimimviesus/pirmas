const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

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
page.setDefaultNavigationTimeout(60000);
page.setDefaultTimeout(60000);

    // ---- LOGIN (2-step) ----
    await page.goto('https://app.mercell.com/', { waitUntil: 'networkidle2' });

    await page.waitForSelector('#email', { timeout: 15000 });
    await page.fill('#email', process.env.MERCELL_USERNAME);

    const continueBtn =
      (await page.$('button:has-text("Continue")')) ||
      (await page.$('button:has-text("Next")')) ||
      (await page.$('button[type="submit"]'));

    if (!continueBtn) throw new Error('Continue/Next button not found after entering email');
await Promise.all([
  continueBtn.click(),
  page.waitForSelector('input[name="password"][type="password"]', { timeout: 60000 }),
]);

    await page.waitForSelector('input[name="password"][type="password"]', { timeout: 15000 });
    await page.fill('input[name="password"][type="password"]', process.env.MERCELL_PASSWORD);

    const signInBtn =
      (await page.$('button:has-text("Sign in")')) ||
      (await page.$('button:has-text("Log in")')) ||
      (await page.$('button:has-text("Login")')) ||
      (await page.$('button[type="submit"]'));

    if (!signInBtn) throw new Error('Sign-in button not found on password step');


// laukiam, kol atsiras kažkas “po login”
await page.waitForSelector(
  'text=Explore, a[href*="explore"], [data-testid="user-menu"]',
  { timeout: 60000 }
);

// laukiam, kol atsiras kažkas “po login”
await page.waitForSelector(
  'text=Explore, a[href*="explore"], [data-testid="user-menu"]',
  { timeout: 60000 }
);
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

