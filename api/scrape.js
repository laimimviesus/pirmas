const chromium = require('@sparticuz/chromium');
const puppeteer = require ('puppeteer-core');
const { google } = require('googleapis');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

module.exports = async (req, res) => {
  const summary = {
    newTenders: 0,
    skipped: 0,
    errors: [],
  };

  try {
    // 1. Prisijungimas prie Mercell
    const browser = await puppeteer.launch({ 
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
 });
    
    try {
      await page.goto('https://app.mercell.com/', { waitUntil: 'networkidle' });
      await page.fill('input[type="email"]', process.env.MERCELL_USERNAME);
      await page.fill('input[type="password"]', process.env.MERCELL_PASSWORD);
      await page.click('button[type="submit"]');
      await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 });
    } catch (e) {
      summary.errors.push('Mercell login failed: ' + e.message);
      await browser.close();
      await sendReportEmail(summary);
      return res.status(500).json({ ok: false, error: 'Login failed' });
    }

    // 2. TODO: Perėjimas į „Explore“ ir filtrų pritaikymas
    // await applyFilters(page);

    // 3. TODO: Nuskaityti konkursų sąrašą
    const tenders = []; // čia vėliau bus realus sąrašas

    // 4. Google Sheets klientas
    const sheets = await getSheetsClient();

    // 5. Jau esantys ID
    const existingIds = await getExistingIds(sheets);

    for (const tender of tenders) {
      try {
        // 6. TODO: „Go to source“ ir detalės
        // const detailed = await scrapeTenderDetails(tender);

        const uniqueId = crypto
          .createHash('sha256')
          .update(tender.mercellId + '|' + tender.sourceUrl)
          .digest('hex');

        if (existingIds.has(uniqueId)) {
          summary.skipped++;
          continue;
        }

        // 7. TODO: filtrai (biudžetas, remote, SaaS ir t. t.)
        // if (!passesFilters(detailed)) { summary.skipped++; continue; }

        // 8. Įrašas į Google Sheets
        await appendRow(sheets, {
          uniqueId,
          // TODO: čia sudėsi visus laukus (title, budget, url ir t. t.)
        });

        summary.newTenders++;
      } catch (e) {
        summary.errors.push('Tender processing error: ' + e.message);
      }
    }

    await browser.close();

    // 9. Dienos ataskaita el. paštu
    await sendReportEmail(summary);

    return res.status(200).json({ ok: true, summary });
  } catch (e) {
    summary.errors.push('General error: ' + e.message);
    await sendReportEmail(summary);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// ---- Pagalbinės funkcijos (kol kas paprasti stub’ai, kad viskas veiktų) ----

async function getSheetsClient() {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
  const scopes = ['https://www.googleapis.com/auth/spreadsheets'];
  const jwt = new google.auth.JWT(
    creds.client_email,
    null,
    creds.private_key,
    scopes
  );
  await jwt.authorize();
  return google.sheets({ version: 'v4', auth: jwt });
}

async function getExistingIds(sheets) {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'Tenders!A2:A',
  });
  const rows = resp.data.values || [];
  const set = new Set();
  for (const row of rows) {
    if (row[0]) set.add(row[0]);
  }
  return set;
}

async function appendRow(sheets, data) {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  const values = [
    [
      data.uniqueId || '',
      // čia vėliau pridėsim likusius stulpelius
    ],
  ];
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: 'Tenders!A2',
    valueInputOption: 'RAW',
    requestBody: { values },
  });
}

async function sendReportEmail(summary) {
  const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_SMTP_HOST,
    port: Number(process.env.EMAIL_SMTP_PORT),
    secure: false,
    auth: {
      user: process.env.EMAIL_SMTP_USER,
      pass: process.env.EMAIL_SMTP_PASS,
    },
  });

  const text = [
    `New tenders: ${summary.newTenders}`,
    `Skipped: ${summary.skipped}`,
    summary.errors.length ? `Errors:\n- ${summary.errors.join('\n- ')}` : 'No errors.',
  ].join('\n');

  await transporter.sendMail({
    from: process.env.EMAIL_SMTP_USER,
    to: 'monika.bataityte@cornercasetech.com',
    subject: 'Daily Mercell tender report',
    text,
  });
}

// Šitos funkcijos kol kas tuščios – vėliau pildysim scraping logiką
async function applyFilters(page) {}
async function scrapeTenderDetails(tender) {}
function passesFilters(detailed) { return true; }

