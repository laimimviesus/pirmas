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
// COUNTRY_FILTER — comma-separated country names (e.g. "Spain" or
// "Spain,Portugal"). When set, the listing-page collector skips
// tenders whose country doesn't match. Useful for one-off debug runs
// against a specific procurement portal (e.g. Spain → PLACSP /
// contrataciondelestado.es).
// Country variants — Mercell tender cards expose `country` as a plain
// English string ("Netherlands"/"United Kingdom"/etc.). Users typing
// COUNTRY_FILTER often write the colloquial / lowercased form ("uk",
// "netherlands", "the netherlands"). To avoid silent zero-match runs
// (2026-05-12 Netherlands run: 420 tenders all filtered out), every
// filter token is normalised to lowercase AND expanded to a small set
// of equivalent aliases before comparison.
const COUNTRY_ALIASES = {
  'netherlands':       ['netherlands', 'the netherlands', 'holland', 'nl'],
  'the netherlands':   ['netherlands', 'the netherlands', 'holland', 'nl'],
  'holland':           ['netherlands', 'the netherlands', 'holland', 'nl'],
  'united kingdom':    ['united kingdom', 'uk', 'great britain', 'britain', 'england'],
  'uk':                ['united kingdom', 'uk', 'great britain', 'britain', 'england'],
  'great britain':     ['united kingdom', 'uk', 'great britain', 'britain', 'england'],
  'czech republic':    ['czech republic', 'czechia'],
  'czechia':           ['czech republic', 'czechia'],
  'germany':           ['germany', 'deutschland'],
  'deutschland':       ['germany', 'deutschland'],
  'spain':             ['spain', 'españa', 'espana'],
  'sweden':            ['sweden', 'sverige'],
  'finland':           ['finland', 'suomi'],
  'norway':            ['norway', 'norge'],
  'denmark':           ['denmark', 'danmark'],
  'france':            ['france'],
  'belgium':           ['belgium', 'belgique', 'belgië', 'belgie'],
  'estonia':           ['estonia', 'eesti'],
  'lithuania':         ['lithuania', 'lietuva'],
  'latvia':            ['latvia', 'latvija'],
  'austria':           ['austria', 'österreich', 'osterreich'],
  'switzerland':       ['switzerland', 'schweiz', 'suisse', 'svizzera'],
  'portugal':          ['portugal'],
  'ireland':           ['ireland', 'éire', 'eire'],
};
const COUNTRY_FILTER_RAW = (process.env.COUNTRY_FILTER || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const COUNTRY_FILTER = new Set();
for (const token of COUNTRY_FILTER_RAW) {
  const lower = token.toLowerCase();
  const variants = COUNTRY_ALIASES[lower] || [lower];
  for (const v of variants) COUNTRY_FILTER.add(v);
}
const COUNTRY_FILTER_ACTIVE = COUNTRY_FILTER.size > 0;
// When a filter is active, allow many more listing pages than usual —
// matching tenders may be sparse (e.g. Spanish IT tenders are <2% of
// the global feed), so a 1-page cap in TEST_MODE would never find any.
const MAX_PAGES = COUNTRY_FILTER_ACTIVE
  ? Number(process.env.MAX_PAGES || 50)
  : (TEST_MODE ? 1 : 200);
// Prod limits sąmoningai konservatyvūs — GitHub Actions jobs are capped at
// 6h, o pilnas detail-fetch ciklas per tender'į truko ~5–10s. 4000 tenderių
// prasilenkdavo su timeout'u ir niekas nebuvo įrašoma. Paliekam override'ą
// per aplinkos kintamąjį jeigu kada reikės platesnio pirmojo backfill'o.
const MAX_TENDERS = TEST_MODE ? 9 : Number(process.env.MAX_TENDERS || 500);
const DETAILS_LIMIT = TEST_MODE ? 9 : Number(process.env.DETAILS_LIMIT || 500);
const FLUSH_BATCH = TEST_MODE ? 1 : Number(process.env.FLUSH_BATCH || 5);
const SOURCE_NAV_TIMEOUT = 25000;

if (COUNTRY_FILTER_ACTIVE) {
  console.log(`🔎 COUNTRY_FILTER active: only collecting tenders from ${Array.from(COUNTRY_FILTER).join(', ')} (max pages: ${MAX_PAGES})`);
}

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
// Cross-host SSO mapping — portals that don't have their own auth and
// instead federate to a central login service. The MAP value is a host
// whose entry in PORTAL_CREDS_JSON should be reused. Example:
// tarjouspalvelu.fi (Finnish national tender front-end) doesn't accept
// direct logins; users authenticate at https://login.cloudia.net/...
// and the session cookies are then accepted by tarjouspalvelu.fi.
// When a tender's source host appears here, getPortalCreds() resolves
// credentials via the aliased host instead.
const PORTAL_HOST_ALIASES = {
  'tarjouspalvelu.fi': 'cloudia.net',
};
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
  // SSO alias — recursively look up the aliased host. Allows the
  // creds JSON to keep a single entry (e.g. "cloudia.net") that
  // covers every fronted portal (tarjouspalvelu.fi, etc.).
  if (PORTAL_HOST_ALIASES[host]) {
    const aliasCreds = getPortalCreds(PORTAL_HOST_ALIASES[host]);
    if (aliasCreds) return aliasCreds;
  }
  return null;
}

// Hosts that ALWAYS need login, even when the loginGated heuristic doesn't
// fire. These portals serve a thin "shell" page (~100–500 chars) when the
// visitor is anonymous and lazy-load actual tender content via AJAX after
// authentication. Login-marker regex misses them because the shell page
// shows almost no body text. Real-world example: e-avrop.com renders
// "Download and Subscribe / Go to My Subscriptions / Current Notices /
// Places / RÄDDNINGSTJÄNSTEN STORGÖTEBORG / NOTICE / SV EN / Register
// account / © 1999-2026 Antirio AB Help Support" — total ≈190 chars,
// only 1 marker matches ("Register account"), so the heuristic skips
// login. We force login here.
const ALWAYS_LOGIN_HOSTS = [
  'e-avrop.com',          // Swedish — Antirio platform shell
  // tendsign.com — re-added 2026-05-14. Public anonymous view
  // (/public/p_meformsnotice.aspx) exposes the Announcement summary
  // and a "Dokument" tab anchor of shape
  //   <a href="../doc.aspx?MeFormsNoticeId=<id>&Goto=Docs">Dokument</a>
  // but clicking it lands on a LOGIN wall (user-confirmed DOM 2026-05-14
  // for MeFormsNoticeId=91377). So we need credentials to reach the
  // actual document URLs (Flow A p_documents.aspx / Flow B
  // s_view_advertfiles.aspx). Login attempts on doc.aspx succeed and
  // the session cookie carries through the public→doc.aspx redirect
  // chain, unlocking Documents content for fetchTendSignDocuments.
  'tendsign.com',
  'kommersannons.se',      // Swedish FMV — Kommers Annons shell
  'tarjouspalvelu.fi',     // Finnish — Cloudia-fronted (SSO via login.cloudia.net)
  // dtvp.de — REMOVED 2026-05-14 (briefly added then reverted same day).
  //
  // The Germany run revealed two facts that make forced-login a NET
  // NEGATIVE for dtvp.de:
  //
  // 1. The bulk-documents ZIP ("Alle Dokumente als ZIP-Datei
  //    herunterladen") is anonymously downloadable on most dtvp.de
  //    notice pages — the existing source-prefetch flow grabs it
  //    without auth (proven on tender CXS0YYEYTPNPSNPC: 9 MB ZIP →
  //    30 000 ch text → AI extracted Eignungskriterien correctly).
  //
  // 2. The id.dtvp.de Keycloak login form's submit currently fails
  //    ("login submission did not clear password field"). The fail
  //    path triggers a POST-LOGIN source re-fetch that OVERWRITES the
  //    sourceFilesText we already collected, wiping out the 30 000 ch
  //    of ZIP content. Net result: less context for the AI.
  //
  // Until either the anonymous ZIP fails (proven failing case) OR the
  // Keycloak login is debugged + merged (instead of overwrite), keep
  // dtvp.de out of ALWAYS_LOGIN_HOSTS. The /Satellite/notice/<id>/documents
  // URL renders the body with the bulk ZIP link anonymously — that's
  // the path that already works.
];
function hostRequiresLogin(host) {
  if (!host) return false;
  const h = String(host).trim().toLowerCase().replace(/^www\./, '');
  return ALWAYS_LOGIN_HOSTS.some((k) => h === k || h.endsWith('.' + k));
}

// Dedicated login URLs for portals where the tender page (Mercell "Go to
// source" target) does NOT contain a login form. attemptPortalLogin's
// default behaviour of navigating to the source URL fails on these
// portals because the announcement page renders only an empty shell —
// the actual login form lives at a separate URL (typically a /Default
// or /Login route). When a host appears in this map, we navigate to
// the dedicated URL FIRST, complete the login flow, and rely on the
// browser cookie jar to authenticate subsequent fetchSourcePageDetails
// calls within the same browser context.
const LOGIN_URLS = {
  // e-avrop.com — confirmed direct login URL is /login.aspx (not the
  // earlier /e-User/Default.aspx which renders without a visible form).
  'e-avrop.com':              'https://www.e-avrop.com/login.aspx',
  // kommersannons.se hosts MULTIPLE buyer tenants under the same root
  // domain (/fmv/, /elite/, /roslagsvatten/, /goteborgshamn/, etc.) and
  // each tenant has its OWN /<tenant>/Account/Login.aspx login form. The
  // ASP.NET session cookie set on /fmv/ does NOT carry over to /elite/
  // because the form uses tenant-relative paths and ASP.NET path-
  // scopes its auth cookie. We therefore derive the login URL from the
  // source URL's first path segment at call time (see
  // getDedicatedLoginUrl). The entry below is just a host-presence
  // marker — the value is used as a fallback when source URL has no
  // tenant prefix (i.e. it's the bare root).
  // 2026-05-12 fix: switched from /Default.aspx → /Account/Login.aspx.
  // /Default.aspx is the tenant HOMEPAGE — it renders header/footer
  // and a generic "Login" button that links to Account/Login.aspx. The
  // homepage has NO email/password form, so attemptPortalLogin's
  // password-field scan returned 0 fields and we hit a random submit
  // button (search/contact). Account/Login.aspx is the actual login
  // form with email + password inputs.
  'kommersannons.se':         'https://www.kommersannons.se/fmv/Account/Login.aspx',
  // tarjouspalvelu.fi (Finnish national tender front-end) doesn't host
  // its own login form — the Cloudia SaaS platform serves authentication
  // at login.cloudia.net. After login there, session cookies are valid
  // for tarjouspalvelu.fi via shared backend (Cloudia SSO).
  // Credentials look up via PORTAL_HOST_ALIASES (tarjouspalvelu.fi
  // → cloudia.net).
  'tarjouspalvelu.fi':        'https://login.cloudia.net/user/login',
  // marches-publics.gouv.fr — the source URL itself has a "Login" button
  // in the corner; clicking it pops up a form whose fields are
  // form[_username] / form[_password] (action=/entreprise/login). The
  // new login-button-click logic in attemptPortalLogin handles that
  // popup automatically, so no dedicated URL is needed.
  // tendsign.com keeps its login form on the tender URL via redirect,
  // so the default flow works — no override needed.
};
// ---------------------------------------------------------------------
// normalizeSourceUrl
// ---------------------------------------------------------------------
// Apply early URL fixes BEFORE the URL is used by any consumer (source
// fetch, login goto, deep-link resolver). Previously these fixes lived
// only inside fetchSourcePageDetails — but downstream callers like
// attemptPortalLogin received the original Mercell-provided URL and
// hit ERR_NAME_NOT_RESOLVED on typo'd domains.
//
// Currently handles:
//   - marchespublics.gouv.fr (no hyphen) → marches-publics.gouv.fr
//   - http://marches-publics.gouv.fr     → https:// (forced HTTPS)
//   - dtvp.de notice pages without /documents suffix → add /documents
//
// Safe to call repeatedly — operations are idempotent.
function normalizeSourceUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return rawUrl;
  let u;
  try { u = new URL(rawUrl.trim()); }
  catch (_) { return rawUrl; }

  let changed = false;

  // marches-publics.gouv.fr typo fix (Mercell occasionally drops the hyphen)
  if (u.hostname === 'www.marchespublics.gouv.fr' || u.hostname === 'marchespublics.gouv.fr') {
    u.hostname = 'www.marches-publics.gouv.fr';
    changed = true;
  }
  // Force HTTPS on marches-publics (it's a 301→https on the real domain anyway)
  if (/(^|\.)marches-publics\.gouv\.fr$/i.test(u.hostname) && u.protocol === 'http:') {
    u.protocol = 'https:';
    changed = true;
  }

  // dtvp.de — rewrite any notice URL to its /documents endpoint
  if (u.hostname === 'www.dtvp.de' || u.hostname === 'dtvp.de') {
    const noticeMatch = u.pathname.match(/^\/Satellite\/notice\/([A-Z0-9]{6,40})(?:\/.*)?$/i);
    if (noticeMatch && !/\/documents\/?$/i.test(u.pathname)) {
      u.pathname = `/Satellite/notice/${noticeMatch[1]}/documents`;
      u.search = '';
      u.hash = '';
      changed = true;
    }
  }

  return changed ? u.toString() : rawUrl;
}

function getDedicatedLoginUrl(host, sourceUrl) {
  if (!host) return null;
  const h = String(host).trim().toLowerCase().replace(/^www\./, '');
  // kommersannons.se — multi-tenant: extract /<tenant>/ from the source
  // URL and build /<tenant>/Account/Login.aspx so we log in on the SAME
  // path scope as the tender page. Falls through to the static
  // LOGIN_URLS entry if no tenant prefix is parseable.
  // 2026-05-12: user confirmed the actual login form lives at
  // /<tenant>/Account/Login.aspx (not /<tenant>/Default.aspx — that's
  // the homepage, which contains only header navigation and a "Login"
  // button that links here).
  if (h === 'kommersannons.se' || h.endsWith('.kommersannons.se')) {
    try {
      if (sourceUrl) {
        const u = new URL(sourceUrl);
        // Path looks like "/elite/Notice/NoticeOverview.aspx" — first
        // non-empty segment is the tenant. Whitelist alphanumerics +
        // hyphen to avoid stray segments like "Notice" (which would
        // happen if the URL was already on /Notice/...).
        const segs = u.pathname.split('/').filter(Boolean);
        const first = segs[0] || '';
        const RESERVED = new Set(['notice', 'login', 'default.aspx', 'admin', 'app', 'account']);
        if (first && /^[a-z0-9_-]{2,40}$/i.test(first) && !RESERVED.has(first.toLowerCase())) {
          return `https://www.kommersannons.se/${first}/Account/Login.aspx`;
        }
      }
    } catch (_) { /* fall through */ }
    return LOGIN_URLS['kommersannons.se'] || null;
  }
  // e-avrop.com — earlier attempt at /<tenant>/login.aspx revealed
  // those URLs don't exist (server 302s to bare root). Stick with
  // bare /login.aspx — the marketing-redirect failure mode
  // (`Header1_LoginControl1_blogLink → info.e-avrop.com`) is now
  // blocked by the cross-host marketing-href filter in the trigger
  // scoring step below, so the bare URL is safe again.
  if (LOGIN_URLS[h]) return LOGIN_URLS[h];
  // suffix match
  for (const key of Object.keys(LOGIN_URLS)) {
    if (h === key || h.endsWith('.' + key)) return LOGIN_URLS[key];
  }
  return null;
}

// =====================================================================
// extractQualificationHints
// ---------------------------------------------------------------------
// Scan a flattened public-notice text (TED, FTS, Doffin, hilma, etc.)
// for known qualification-section anchors and return up to ~6000 chars
// of structured snippets (one per anchor hit). The caller prepends the
// result to the AI input so Claude sees the qualification cues UP-FRONT
// instead of buried in 30k chars of breadcrumbs / metadata.
//
// Anchors are multilingual because TED renders in 24 EU langs and many
// portals republish the notice in the buyer's local language. We match
// case-insensitively, on word boundaries, and look for headings that
// sit on their own line OR start a sentence (TED's flat text often
// concatenates: "5.1.9.\nSelection criteria\n  Criterion: Type:
// Suitability...\n").
//
// Output format (compact, keeps Claude focused):
//   [HINT: Selection criteria]
//   <up to 1200 chars of context>
//   [HINT: Eignungskriterien]
//   <…>
// Returns '' (empty string) if no anchors hit.
// =====================================================================
function extractQualificationHints(text) {
  if (!text || typeof text !== 'string' || text.length < 100) return '';
  const ANCHORS = [
    // English (TED / FTS)
    /\b(Selection criteria|Conditions for participation|Suitability to pursue the professional activity|Economic and financial standing|Technical and professional ability|Award criteria)\b/i,
    // TED eForms structural patterns — these are stable across language
    // renderings because TED eForms uses English internal labels even
    // when the buyer language is non-English. "Type:" appears at the
    // start of each criterion block; "Procurement Term" labels frame
    // selection / award sections. Section numbers (5.1.9, 5.1.10) are
    // eForms BT codes for selection/award criteria sections.
    /(?:^|\s)(5\.1\.(?:9|10|11)|BT-7[0-9]{2})\.?\s/,
    /\b(Type:\s*(?:Suitability|Economic|Technical|Other)|Procurement\s+Term|Lot\s+\d+\s*[:.\-—]\s*Conditions?)\b/i,
    // Spanish (PLACSP, BOE)
    /\b(Solvencia económica(?: y financiera)?|Solvencia técnica(?: o profesional)?|Criterios? de selección|Criterios de adjudicación|Condiciones de admisión|Criterio de Solvencia (?:Técnica|Económica)|Aptitud para ejercer|Capacidad para contratar|Requisitos? de aptitud)\b/i,
    // German (DTVP, evergabe)
    /\b(Eignungskriterien|Eignungsnachweise|Auswahlkriterien|Zuschlagskriterien|Wirtschaftliche und finanzielle Leistungsfähigkeit|Technische und berufliche Leistungsfähigkeit|Anforderungen an den Bieter|Eignungsanforderungen)\b/i,
    // French (marches-publics, awsolutions)
    /\b(Critères de sélection|Conditions de participation|Capacité économique et financière|Capacité technique et professionnelle|Critères d['’]attribution|Aptitude à exercer)\b/i,
    // Dutch (tenderned)
    /\b(Selectiecriteria|Geschiktheidseisen|Economische en financiële draagkracht|Technische en beroepsbekwaamheid|Gunningscriteria|Eisen aan inschrijver|Geschiktheid om de beroepsactiviteit)\b/i,
    // Swedish (e-avrop, kommersannons, tendsign)
    /\b(Urvalskriterier|Kvalificeringskrav|Krav på leverantören|Tilldelningskriterier|Ekonomisk(?: och finansiell)? ställning|Teknisk(?: och yrkesmässig)? kapacitet|Lämplighet att utöva)\b/i,
    // Finnish (tarjouspalvelu, hilma)
    /\b(Valintaperusteet|Soveltuvuusvaatimukset|Taloudellinen ja rahoituksellinen tilanne|Tekninen ja ammatillinen pätevyys|Vertailuperusteet|Kelpoisuus harjoittaa)\b/i,
    // Norwegian (doffin)
    /\b(Utvelgelseskriterier|Kvalifikasjonskrav|Tildelingskriterier|Egnethet til å utøve)\b/i,
    // Lithuanian (CVPP)
    /\b(Kvalifikacijos reikalavimai|Pasiūlymų vertinimo kriterijai|Tiekėjų kvalifikacija|Tinkamumas verstis)\b/i,
    // Italian
    /\b(Criteri di selezione|Condizioni di partecipazione|Capacità economica e finanziaria|Capacità tecnica e professionale|Criteri di aggiudicazione|Idoneità professionale)\b/i,
    // Portuguese
    /\b(Critérios de seleção|Capacidade económica e financeira|Capacidade técnica e profissional|Critérios de adjudicação|Habilitação para o exercício)\b/i,
  ];
  const hits = [];
  const seen = new Set();
  for (const rx of ANCHORS) {
    // Find ALL matches per anchor (some notices have multiple lots
    // each with their own selection-criteria block).
    const globalRx = new RegExp(rx.source, rx.flags + 'g');
    let m;
    while ((m = globalRx.exec(text)) !== null) {
      const matchStart = m.index;
      const heading = m[0];
      // Avoid duplicates within ~200 chars (some notices repeat the
      // heading in nav + body — we want the body match).
      const bucket = `${heading.toLowerCase()}@${Math.floor(matchStart / 500)}`;
      if (seen.has(bucket)) continue;
      seen.add(bucket);
      // Window: 200 chars before (catch lot/section number prefix
      // like "5.1.9." or "Apartado 15"), 1200 chars after.
      const winStart = Math.max(0, matchStart - 200);
      const winEnd = Math.min(text.length, matchStart + heading.length + 1200);
      let snippet = text.slice(winStart, winEnd).replace(/\s+/g, ' ').trim();
      if (snippet.length < 80) continue; // too thin to be useful
      hits.push(`[HINT: ${heading}]\n${snippet}`);
      if (hits.length >= 6) break; // hard cap so we don't overflow
    }
    if (hits.length >= 6) break;
  }
  if (hits.length === 0) return '';
  // Total cap ~6000 chars across all hints.
  let combined = hits.join('\n\n');
  if (combined.length > 6000) combined = combined.slice(0, 6000) + '…';
  return combined;
}

// ---------------------------------------------------------------------
// hintExtractorDiagnostic
// ---------------------------------------------------------------------
// When extractQualificationHints returns '' (no anchors hit) for a text
// that LOOKS like it should contain qualifications (TED notice, long
// procurement description), this helper scans for near-miss stems and
// reports back what WAS there — so we can extend the anchor regex in
// the next iteration.
//
// Returns a short string like:
//   "nearMisses: 'criterion of selection' @1234, 'capacidad técnica' @5678"
// or '' if no near-misses found either.
// =====================================================================
function hintExtractorDiagnostic(text) {
  if (!text || typeof text !== 'string') return '';
  const STEMS = [
    'criter', 'capac', 'solven', 'eignung', 'kvalif', 'urval', 'sélect', 'select',
    'soveltuvuus', 'taloud', 'tekni', 'eligibility', 'aptit', 'requisit',
    'requirement', 'condici', 'condition', 'auswahl', 'zuschlag', 'gunning',
  ];
  const lower = text.toLowerCase();
  const out = [];
  for (const stem of STEMS) {
    const idx = lower.indexOf(stem);
    if (idx >= 0) {
      // Capture ~40ch around the first occurrence for context
      const ctx = text.slice(Math.max(0, idx - 5), idx + 40).replace(/\s+/g, ' ').trim();
      out.push(`"${ctx}" @${idx}`);
      if (out.length >= 4) break; // cap diag length
    }
  }
  return out.length ? `near-miss stems: ${out.join('; ')}` : '';
}

// ---------------------------------------------------------------------
// extractTedNoticeStructured
// ---------------------------------------------------------------------
// TED-specific HTML preprocessor. Standard tag-strip (in extractTextFrom
// Buffer 'xml' branch) collapses ALL whitespace including newlines, which
// destroys TED's section boundaries — and that in turn prevents the
// hint-extractor regex from anchoring to "Selection criteria" etc.
//
// This function applies a structure-preserving strip BEFORE collapsing
// whitespace:
//   - Block-level tags (</p>, </li>, </tr>, </h*>, </section>, </div>,
//     <br>) → newline
//   - Definition-list pairs (<dt>x</dt><dd>y</dd>) → "x: y\n"
//   - Inline tags → space
//
// The output is "semi-structured" text where each criterion / section
// header sits on its own line, which:
//   1. Lets extractQualificationHints anchor reliably on section heads
//   2. Gives Claude a clearly-formatted block to extract from
//
// Applied only when the public-notice host is ted.europa.eu so we don't
// disturb processing of attachment ZIPs / PDFs from TED, or HTML from
// other public-notice sources.
// =====================================================================
function extractTedNoticeStructured(bytes) {
  if (!bytes || !bytes.length) return '';
  let raw;
  try { raw = bytes.toString('utf8'); }
  catch (_) { return ''; }
  // Pre-decode CDATA / comments / PI / doctype like xml branch does
  let html = raw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\?[\s\S]*?\?>/g, ' ')
    .replace(/<!DOCTYPE[^>]*>/gi, ' ')
    // Drop <script>/<style> blocks entirely — they're noise
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');

  // Convert structural HTML to newline-separated text.
  // <dt>X</dt><dd>Y</dd> → "X: Y\n" pattern — TED uses these for
  // criterion definitions ("Type:", "Description:", "Source:" etc.)
  html = html
    .replace(/<\/dt>\s*<dd[^>]*>/gi, ': ')
    .replace(/<\/dd>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    // Block-level closings → newline (Pre-emptive — closes contain
    // the section content, not the heading text itself)
    .replace(/<\/(p|li|tr|td|th|div|section|article|h[1-6]|dl|ul|ol|table|blockquote|caption|figcaption|details|summary|fieldset|legend)>/gi, '\n')
    // <hr> rules → section break
    .replace(/<hr\s*\/?>/gi, '\n')
    // All remaining tags → single space (preserve inter-word boundaries)
    .replace(/<\/?[a-zA-Z][^>]*>/g, ' ');

  // Decode entities
  html = html
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      try { return String.fromCodePoint(parseInt(hex, 16)); }
      catch (_e) { return ' '; }
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      try { return String.fromCodePoint(parseInt(dec, 10)); }
      catch (_e) { return ' '; }
    });

  // Normalise whitespace while PRESERVING line breaks:
  //   - tabs + multiple spaces → single space
  //   - lines with only whitespace → empty
  //   - 3+ blank lines → 2 blank lines (paragraph break)
  html = html
    .replace(/[ \t\f\v]+/g, ' ')          // horizontal whitespace
    .replace(/^[ ]+|[ ]+$/gm, '')          // leading/trailing spaces per line
    .replace(/\n{3,}/g, '\n\n')            // cap blank-line runs
    .replace(/(?:^\s*\n){2,}/g, '\n\n')    // collapse leading blanks
    .trim();

  return html;
}

async function callClaude(systemPrompt, userPrompt, { maxTokens = 1024, temperature = 0 } = {}) {
  if (!AI_ENABLED) throw new Error('ANTHROPIC_API_KEY missing');
  // Circuit breaker — once a non-retryable error (credit balance, 401/403)
  // tripped the circuit earlier in this run, we skip the HTTP call entirely.
  // We still THROW so the caller's catch fires _markAiFailure() and the per-
  // tender loop defers the row. The thrown message includes the original
  // reason so _isAiNonRetryable() classifies it as non-retryable.
  if (_aiCircuitOpen) {
    throw new Error(`Claude circuit-open (skipped): ${_aiCircuitReason}`);
  }
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
      // Transient network errors — request timeout, TCP reset, name
      // resolution glitch, socket hangup. These hit req.on('error') /
      // req.destroy() and bypass the 429 path above, so without an
      // explicit retry the very first hiccup kills qualification
      // extraction for a tender. We saw this on 2026-05-11: Nacka
      // kommun tender on kommersannons → "Claude request timeout" →
      // pdfText=53ch landed in sheet with no requirements/quals. Up
      // to MAX_ATTEMPTS-1 retries with linear backoff.
      const msg = String(e && e.message || '');
      const isTransient = /request timeout|ECONN(RESET|REFUSED|ABORTED)|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang ?up|network/i.test(msg);
      if (isTransient && attempt < MAX_ATTEMPTS) {
        _claudeCallTimes.pop();
        const wait = 3000 * attempt;
        console.log(`    ⏳ Claude transient error (attempt ${attempt}/${MAX_ATTEMPTS}): ${msg.slice(0, 80)} — retrying in ${(wait/1000).toFixed(1)}s`);
        await _sleep(wait);
        continue;
      }
      throw e;
    }
  }
  throw new Error('Claude: exhausted retries');
}
// Module-level flag: set when an AI call fails with a non-retryable error
// (HTTP 400 invalid_request_error like "credit balance too low", or 401/403
// auth issues). The per-tender loop checks this between AI calls and DEFERS
// row-write if any non-retryable failure occurred — that way the tender ID
// never enters the sheet, and the next run picks it up automatically.
// Reset to null at the start of each tender's AI section.
let _lastAiNonRetryableError = null;

// Global circuit breaker. Once any AI call hits a non-retryable error, this
// trips and ALL subsequent callClaude() invocations short-circuit before
// touching the network or the rate limiter. Saves wall-clock time during
// outages (no 30–45s rate-limit waits for calls we know will fail). Lasts
// for the rest of the process lifetime — a fresh GitHub Actions run starts
// the process clean and the circuit closes again.
let _aiCircuitOpen = false;
let _aiCircuitReason = '';
function _tripAiCircuit(err) {
  if (_aiCircuitOpen) return;
  _aiCircuitOpen = true;
  _aiCircuitReason = String(err && err.message || 'unknown').slice(0, 200);
  console.log(`    🔌 AI circuit breaker OPEN — skipping all further AI calls this run (${_aiCircuitReason.slice(0, 120)})`);
}

function _isAiNonRetryable(err) {
  const msg = String(err && err.message || '');
  // Claude HTTP 400 with credit balance / invalid_request_error → not retryable
  // 401/403 → auth/permissions, also not retryable on this run
  // 404 → bad endpoint (config issue), not retryable
  // "circuit-open" → already tripped, so this is non-retryable by definition
  if (/HTTP\s*40[134]/i.test(msg)) return true;
  if (/credit balance|invalid_request_error|insufficient_quota/i.test(msg)) return true;
  if (/circuit-open/i.test(msg)) return true;
  return false;
}
function _markAiFailure(err) {
  if (_isAiNonRetryable(err)) {
    _lastAiNonRetryableError = String(err && err.message || '').slice(0, 200);
    _tripAiCircuit(err);
  }
}

async function translateToEnglish(text, { hint = '', skipHeuristic = false } = {}) {
  if (!AI_ENABLED || !text) return '';
  const trimmed = String(text).slice(0, 6000);
  // Heuristika tik ilgiems tekstams (scope), kad netrinktume Haiku'o dėl
  // aiškiai angliško turinio. Trumpiems pavadinimams heuristika klysta
  // (pvz., vokiškas „Beschaffung eines Schulmanagementsystems" neturi
  // umlautų), tad jiems perduodam skipHeuristic=true.
  //
  // Diakritikos klasė apima: vakarų Europos (ä ö ü ß ñ ç ø æ å ...),
  // baltų (ą č ę ė į š ų ū ž), lenkų (ć ł ń ó ś ź ż), čekų/slovakų
  // (ď ě ň ř ť ů ý ĺ ŕ), estų/vengrų (õ ő ű) — tai praktiškai padengia
  // visus EU 24 oficialiose kalbose paplitusius akcentuotus simbolius.
  // Stopword'ai padengia LT/PL/CZ/SK/ET/HU/HR/SL atvejus, kuriuose
  // diakritikų gali ir nebūti (pvz. „IT sistemos pirkimas" — be
  // diakritikų, bet ne anglų).
  if (!skipHeuristic) {
    const hasNonEnglishDiacritic = /[äöüßñçéèêáíóúîôûàèìòùâêîôûãõÿøœæåÄÖÜÑÉÈÊÁÍÓÚÎÔÛÃÕŸØŒÆÅąčęėįšųūžĄČĘĖĮŠŲŪŽćłńóśźżĆŁŃÓŚŹŻďěňřťůýĎĚŇŘŤŮÝĺŕĹŔőűŐŰ]/.test(trimmed);
    const hasNonEnglishStopword = /\b(?:och|und|der|die|den|das|dem|für|mit|auf|bei|nach|ist|sind|wir|sie|ihr|het|van|een|voor|naar|niet|wel|als|aan|maar|ook|waar|dan|alleen|geen|meer|kan|el|la|los|las|para|del|por|que|con|una|uno|les|pour|sur|avec|sans|dans|sous|dei|delle|della|degli|alla|allo|zur|zum|med|till|fra|men|att|som|inte|och|eller|ir|su|dėl|kad|yra|kaip|bei|arba|taip|šis|tas|tos|kas|kuris|todėl|prie|po|nuo|iki|i|w|na|dla|z|ze|nie|jest|się|że|do|oraz|który|przez|przy|jako|lub|jeśli|a|je|ve|do|by|se|jako|nebo|pokud|který|však|neboť|vo|zo|sa|alebo|však|preto|ja|on|ei|et|ka|oma|või|kui|aga|és|az|egy|hogy|vagy|van|nem|csak|már|i|u|sa|je|li|nije|ali|ima|kao|samo)\b/i.test(trimmed);
    const looksEnglish = !hasNonEnglishDiacritic && !hasNonEnglishStopword;
    if (looksEnglish) return trimmed;
  }
  try {
    const out = await callClaude(
      'You are a precise translator from any European language into English. The user text is from a public procurement notice. ' +
      'ALWAYS translate non-English text into English — do NOT return the source verbatim if it is not already English. ' +
      'If the text already IS English, return it unchanged. ' +
      'Preserve tender reference numbers, organisation names, country names, CPV codes, and product/brand names verbatim. ' +
      'Return ONLY the translation: no preface, no explanations, no quotes, no language label.',
      `${hint ? `Context: ${hint}\n\n` : ''}Text to translate:\n${trimmed}`,
      { maxTokens: 800, temperature: 0 }
    );
    let result = out || trimmed;
    // Defensive retry: if Claude echoed the input unchanged AND the input
    // clearly contains non-ASCII characters (i.e. it isn't English), force
    // a second pass with an even more direct instruction. Avoids the
    // common Haiku failure mode where it hands back the source string
    // because the system prompt felt ambiguous.
    const echoed = out && out.trim() === trimmed.trim();
    const hasNonAscii = /[^\x00-\x7F]/.test(trimmed);
    if (echoed && hasNonAscii) {
      try {
        const forced = await callClaude(
          'Translate the following non-English text into English. Output ONLY the English translation. No source language label, no quotes, no explanation.',
          `Source text (translate to English):\n${trimmed}`,
          { maxTokens: 800, temperature: 0 }
        );
        if (forced && forced.trim() !== trimmed.trim()) {
          result = forced;
        }
      } catch (_) { /* fall back to first result */ }
    }
    return result;
  } catch (e) {
    _markAiFailure(e);
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
    'Inside the DOCUMENTS section you may see one or more [STRUCTURED HINTS] … [/STRUCTURED HINTS] blocks: those contain ~1200-char windows centred on the SPECIFIC heading anchors ("Selection criteria", "Solvencia técnica", "Eignungskriterien", "Critères de sélection", etc.) where the qualification thresholds, certification names, and award-criteria weights live. Treat the text inside [STRUCTURED HINTS] as the PRIMARY source for `requirementsForSupplier`, `qualificationRequirements`, and `offerWeighingCriteria` — only fall back to scanning the surrounding flat text when the hints block is missing or doesn\'t cover a particular field. ' +
    'Return ONLY a JSON object (no prose, no markdown fences) with these keys: ' +
    'maxBudget, estimatedBudgetEur, duration, requirementsForSupplier, qualificationRequirements, offerWeighingCriteria, scopeOfAgreement, rejectReason, rejectCategory.\n' +
    'Rules:\n' +
    '- maxBudget: total ceiling / max contract value AS STATED in the tender or attached docs (with currency code, ex-VAT if specified). Examples: "1,200,000 EUR (ex VAT)", "8 500 000 SEK". Empty string if not explicitly stated anywhere.\n' +
    '- estimatedBudgetEur: integer EUR estimate, ONLY fill if maxBudget is empty AND the description/documents give enough basis (scope, deliverables, duration, country, complexity). Use realistic public-sector IT contract rates for that country. Output a plain integer like 850000 (no separators, no currency, no words). Empty string if you cannot estimate responsibly.\n' +
    '- duration: contract length in months or years. Example: "36 months" or "2 years + 2 x 1 year option". Empty string if not stated.\n' +
    '- requirementsForSupplier: concise bullet-style summary (≤600 chars) of MANDATORY supplier/bidder requirements. Include CONCRETE values verbatim where present (e.g. "ISO 27001 certificate", "minimum 3 years operation", "SARA-PdP accreditation", "Plan de Igualdad inscrito", "≥2% trabajadores con discapacidad", "Tier IV CPD certified"). Look in DOCUMENTS for: "Requirements", "Mandatory requirements", "Reikalavimai tiekėjui", "Wymagania", "Anforderungen an den Bieter", "Krav til leverandør", "Eisen aan inschrijver", "Exigences", "Requisitos", "Condiciones de admisión", "Requisitos de participación de los licitadores", "Aptitud para contratar". Empty string if truly absent.\n' +
    '- qualificationRequirements: concise bullet-style summary (≤700 chars) of SELECTION / qualification criteria. Copy CONCRETE NUMBERS VERBATIM — turnover thresholds in EUR, technical-experience minimums in EUR/years, certification names (ISO 27001/27017/27018, ENS Alto, Eurprivacy, ENI, SARA-PdP), reference counts ("≥2 verifiable references"), team-size minimums. When the document gives PER-LOTE values (Lote 1/2/3), include all of them. Look for: "Selection criteria", "Qualification", "Kvalifikaciniai reikalavimai", "Kwalifikacja", "Eignungskriterien", "Kvalifikasjonskrav", "Solvencia económica, financiera y técnica", "Solvencia técnica o profesional", "Solvencia económica y financiera", "Criterio de Solvencia Técnica-Profesional", "Criterio de Solvencia Económica-Financiera", "Cláusula 11", "Cláusula 14", "Cláusula 15", "Apartado 15", "Cuadro de Características", "ANEXO 3", "Volumen anual de negocios", "Cifra anual de negocio", "Importe anual acumulado". The PLACSP / Spanish PCAP format puts the concrete numbers in ANEXO 3 (page 49–55 typically) under "SOLVENCIA ECONÓMICA Y FINANCIERA" and "SOLVENCIA TÉCNICA". Spanish German Vergabe puts them under "Eignungskriterien". Empty string if truly absent.\n' +
    '- offerWeighingCriteria: award criteria with weights if present. Example: "Price 40%, Quality 35%, Delivery time 25%" or "MEAT — lowest price". Look for "Award criteria", "Evaluation", "Vertinimo kriterijai", "Kryteria oceny", "Zuschlagskriterien", "Tildelingskriterier", "Criterios de adjudicación", "Criterios evaluables mediante aplicación de fórmulas", "Criterios evaluables mediante un juicio de valor", "Apartado 21", "Ponderación". When weights add up to 100, list each named criterion with its weight. Empty string if truly absent.\n' +
    '- scopeOfAgreement: 1–3 sentence English summary of what is being procured. Must be English.\n' +
    '- rejectReason: short English string (≤120 chars) explaining WHY this tender is a poor fit for our company, OR empty string if a good fit. We are a small custom-software development & consulting firm. We BUILD our own software from scratch and provide development/advisory services. We DO NOT resell licences, deliver hardware, install branded products, or do on-site work. Reject (set rejectReason) when ANY of these apply, with priority on the FIRST match found:\n' +
    '   • License/reseller partnership required: tender wants an "authorized partner", "license partner", "licence reseller", "OEM partner", "channel partner", "official representative" of a named vendor (Microsoft, Oracle, SAP, Cisco, IBM, VMware, Adobe, Salesforce, Atlassian, ServiceNow, AWS, Azure, GCP, etc.). Set rejectReason="license_partner_required: <vendor>".\n' +
    '   • Branded/named product supply or installation: tender procures specific named software/hardware (e.g. "supply and install Cisco switches", "Milestone XProtect maintenance", "SAP S/4HANA implementation", "Oracle DB licences"). Set rejectReason="branded_product_supply: <product>".\n' +
    '   • SaaS development for a third party (we don\'t build SaaS platforms for others to resell). Set rejectReason="saas_development".\n' +
    '   • Physical / on-site / contact-based work: equipment delivery, hardware installation, cabling, on-premises implementation requiring presence at client site, field service, biuro/objekto remontas. Set rejectReason="physical_onsite_work".\n' +
    '   • Network / telecom infrastructure: LAN/WAN setup, switches/routers/firewalls, telephony, ISP services, network monitoring infrastructure. Set rejectReason="network_infrastructure".\n' +
    '   • AI research projects (academic-style ML research, not applied AI integration). Set rejectReason="ai_research".\n' +
    '   • Cybersecurity-only services (penetration testing, SOC, incident response, security audits as primary deliverable). Set rejectReason="cybersecurity_only".\n' +
    '   • Helpdesk / end-user support (TIER-1 / first-level only). REJECT only if the tender CLEARLY requires staffing a call centre / ticket-triage queue for ordinary end-users — look for explicit signals: "atención a usuarios", "primer nivel de atención", "call centre", "ticket triage", "soporte de primera línea", "Anwenderbetreuung", "Helpdesk de usuarios". DO NOT REJECT if the tender mentions "soporte técnico" alongside "mantenimiento", "evolución", "desarrollo", "L2/L3", "soporte avanzado", "consultoría", or describes maintenance of CUSTOM systems (servicios de soporte y mantenimiento de sistemas) — that is application maintenance / dev-ops support and ACCEPTED. When in doubt, ACCEPT and let the human review. Set rejectReason="helpdesk_support" only on clear tier-1 cases.\n' +
    '   • Authorized representation requirement: tender requires being an authorized agent / certified representative of a specific organization for the deliverable. Set rejectReason="authorized_representation".\n' +
    '   AMBIGUOUS PROCUREMENT — when the tender says "procurement of a system" / "system implementation": look for clarifying signals. If documents indicate it\'s a NEW system being built from scratch, custom development, bespoke solution → ACCEPT (empty rejectReason). If it\'s installation of an existing finished product / off-the-shelf software / branded vendor product → REJECT with rejectReason="branded_product_supply: <product>". If unclear, default to ACCEPT and add rejectReason="ambiguous_procurement_check_manually" so the human can decide.\n' +
    '   ACCEPT (empty rejectReason) when the tender is: custom software development, system development, application development, web/mobile app development, software consulting, advisory services, technical analysis, business analysis, requirements engineering, architecture design, software maintenance/evolution of custom systems, code-level support, agile delivery teams.\n' +
    '- rejectCategory: short machine-readable category matching the rejectReason prefix (e.g. "license_partner_required", "branded_product_supply", "saas_development", "physical_onsite_work", "network_infrastructure", "ai_research", "cybersecurity_only", "helpdesk_support", "authorized_representation", "ambiguous_procurement_check_manually"). Empty string if not rejected.\n' +
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
    // Claude sometimes wraps JSON in fences AND trails commentary
    // ("Here's the extracted data: {...}\nNote that the duration was
    // estimated."). The previous JSON.parse(cleaned) blew up on any
    // trailing non-whitespace and we lost the entire extraction (real-
    // world: "Unexpected non-whitespace character after JSON at
    // position 637" on a tenderned tender, dropped its requirements
    // /qualifications). Strategy: walk through the cleaned string
    // tracking string-state and brace depth, slice from the first `{`
    // up to the matching `}`, and parse just that substring. Falls
    // back to whole-string parse if no balanced block is found.
    const stripped = out
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();
    const sliceFirstJsonObject = (s) => {
      const start = s.indexOf('{');
      if (start === -1) return null;
      let depth = 0;
      let inStr = false;
      let escape = false;
      for (let i = start; i < s.length; i++) {
        const ch = s[i];
        if (escape) { escape = false; continue; }
        if (inStr) {
          if (ch === '\\') escape = true;
          else if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') { inStr = true; continue; }
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) return s.slice(start, i + 1);
        }
      }
      return null;
    };
    const candidateJson = sliceFirstJsonObject(stripped) || stripped;
    let parsed;
    try {
      parsed = JSON.parse(candidateJson);
    } catch (parseErr) {
      // Last-resort recovery: if Claude truncated the JSON mid-string
      // (max-tokens hit), try a heuristic: append `"}` and retry.
      // Only triggers when the error mentions an unterminated string.
      const msg = String(parseErr.message || '');
      if (/Unterminated string/i.test(msg)) {
        try { parsed = JSON.parse(candidateJson + '"}'); }
        catch (_) { throw parseErr; }
      } else {
        throw parseErr;
      }
    }
    return {
      maxBudget: (parsed.maxBudget || '').toString().trim(),
      estimatedBudgetEur: (parsed.estimatedBudgetEur || '').toString().trim(),
      duration: (parsed.duration || '').toString().trim(),
      requirementsForSupplier: (parsed.requirementsForSupplier || '').toString().trim(),
      qualificationRequirements: (parsed.qualificationRequirements || '').toString().trim(),
      offerWeighingCriteria: (parsed.offerWeighingCriteria || '').toString().trim(),
      scopeOfAgreement: (parsed.scopeOfAgreement || '').toString().trim(),
      rejectReason: (parsed.rejectReason || '').toString().trim(),
      rejectCategory: (parsed.rejectCategory || '').toString().trim(),
    };
  } catch (e) {
    _markAiFailure(e);
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

// ---------------------------------------------------------------------
// clickRobust
// ---------------------------------------------------------------------
// Robust click that survives Puppeteer's "Node is either not clickable
// or not an Element" error. This happens when the element exists in the
// DOM (waitForSelector succeeded) but Puppeteer's clickable-point check
// fails — typical causes:
//   - The element is animating in (opacity/transform transition)
//   - A modal/overlay/cookie banner is covering it
//   - The element is off-screen (needs scroll)
//   - The element is hidden by parent display:none / visibility:hidden
//
// Strategy:
//   1. Wait for selector to exist (caller may have done this already, no-op if so)
//   2. Try scroll into view + native page.click()
//   3. If native click throws, fall back to el.click() via page.evaluate()
//      — DOM click() bypasses Puppeteer's clickability heuristic and works
//      on elements that are technically in the DOM tree even if not yet
//      visually interactive
//
// Returns true on any successful click, false on hard failure.
// =====================================================================
async function clickRobust(page, selector, opts = {}) {
  const { timeout = 15000, retryDelay = 500 } = opts;
  // Make sure the element is present
  try {
    await page.waitForSelector(selector, { timeout });
  } catch (e) {
    console.log(`    ⚠️  clickRobust: selector "${selector}" not found within ${timeout}ms`);
    return false;
  }
  // Try scroll + native click first
  try {
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el && typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      }
    }, selector).catch(() => null);
    await new Promise((r) => setTimeout(r, 100));
    await page.click(selector);
    return true;
  } catch (e1) {
    const msg = (e1 && e1.message || '').slice(0, 80);
    console.log(`    ⚠️  clickRobust: native click failed (${msg}) — falling back to DOM click`);
  }
  // Fallback — DOM .click() via page.evaluate (bypasses clickable-point check)
  await new Promise((r) => setTimeout(r, retryDelay));
  try {
    const clicked = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      if (typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ block: 'center', inline: 'center' });
      }
      // Try native HTMLElement.click() first; if missing, dispatch a click event
      if (typeof el.click === 'function') {
        el.click();
      } else {
        const rect = el.getBoundingClientRect();
        const evt = new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
        });
        el.dispatchEvent(evt);
      }
      return true;
    }, selector).catch(() => false);
    if (clicked) {
      console.log(`    ✓ clickRobust: DOM click fallback succeeded for "${selector}"`);
      return true;
    }
  } catch (e2) {
    console.log(`    ⚠️  clickRobust: DOM click fallback also failed: ${(e2.message || '').slice(0, 80)}`);
  }
  return false;
}

async function clickSpanContainsText(page, text) {
  // 2026-05-16 — upgraded from raw el.click() in page.evaluate to a
  // stamp + Puppeteer native page.click() pattern (same approach line
  // 1073 uses for accordion checkboxes). Reason: el.click() called
  // from page.evaluate often fails to trigger React's onClick handler
  // on PrimeVue components (Mercell uses PrimeVue). Puppeteer's real
  // page.click() dispatches a full mousedown/mouseup/click sequence
  // that React's synthetic event system reliably catches.
  //
  // Real-world (2026-05-16 SE test run): clickSpanContainsText(page,
  // 'Location') returned true (span was found and el.click() invoked)
  // but the dropdown never opened — the subsequent waitForSelector
  // 'span.p-treenode-label' timed out at 15s and aborted the whole
  // scrape. Stamp+native-click pattern fixed it.
  const tagged = await page.evaluate((t) => {
    // Clear any stale stamps from prior calls
    document.querySelectorAll('[data-mx-span-click="1"]').forEach((el) =>
      el.removeAttribute('data-mx-span-click')
    );
    const spans = Array.from(document.querySelectorAll('span'));
    const el = spans.find((s) => (s.textContent || '').trim().startsWith(t));
    if (!el) return { ok: false, reason: 'no matching span' };
    el.setAttribute('data-mx-span-click', '1');
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) {}
    return { ok: true };
  }, text).catch((e) => ({ ok: false, reason: 'evaluate error: ' + (e.message || '') }));

  if (!tagged.ok) {
    console.log(`    ⚠️  clickSpanContainsText("${text}"): ${tagged.reason}`);
    return false;
  }
  try {
    await page.click('[data-mx-span-click="1"]', { delay: 20 });
    return true;
  } catch (e1) {
    // Native click failed (rare — span may have moved during scroll).
    // Fall back to DOM dispatch with full mouseEvent sequence.
    const ok = await page.evaluate(() => {
      const el = document.querySelector('[data-mx-span-click="1"]');
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const opts = {
        bubbles: true, cancelable: true, view: window,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      };
      try {
        el.dispatchEvent(new MouseEvent('mousedown', opts));
        el.dispatchEvent(new MouseEvent('mouseup', opts));
        el.dispatchEvent(new MouseEvent('click', opts));
        return true;
      } catch (_) { return false; }
    }).catch(() => false);
    if (ok) {
      console.log(`    ✓ clickSpanContainsText("${text}"): mouse-event fallback succeeded`);
      return true;
    }
    console.log(`    ⚠️  clickSpanContainsText("${text}"): all click strategies failed (${(e1.message || '').slice(0, 80)})`);
    return false;
  }
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

// --- PORTAL LOGIN HELPER -----------------------------------------------
//
// Generic best-effort login for portals that proxy the Mercell "Go to
// source" link (UK MyTenders, Cloudia/tarjouspalvelu.fi, e-avrop, DEUTSCHE
// EVERGABE, Vergabeportal AT, contrataciondelestado.es, etc.). Looks up
// creds via getPortalCreds() — host stripping + suffix matching are done
// there. Opens a fresh page, follows whatever redirect the portal does
// for an unauthenticated visitor, fills the most common form patterns,
// submits, and verifies the password field is gone afterwards. Cookies
// are stored on the default browserContext, so a subsequent
// fetchSourcePageDetails() call from a fresh page will run authenticated.
//
// Returns true on apparent success, false on any failure (no creds, form
// not found, submission did not clear password field, exception). Logs
// 🔑 / 🔐 / ✅ / ❌ markers for grep-ability in CI logs.
// =====================================================================
async function attemptPortalLogin(browser, sourceUrl, creds, hostLabel) {
  if (!creds || !creds.password) return false;
  const page = await browser.newPage();
  try {
    page.setDefaultNavigationTimeout(30000);

    // Dedicated login URL? Some portals (e-avrop, marches-publics-gouv,
    // FMV / kommersannons) serve their login form on a fixed URL rather
    // than redirecting from the tender page. In that case, navigate to
    // the dedicated URL first — the browser cookie jar persists, so a
    // post-login fetchSourcePageDetails(sourceUrl) will be authenticated.
    const dedicatedLoginUrl = getDedicatedLoginUrl(hostLabel, sourceUrl);
    const loginNavTarget = dedicatedLoginUrl || sourceUrl;
    if (dedicatedLoginUrl) {
      console.log(`    ↪️  using dedicated login URL: ${dedicatedLoginUrl}`);
    }
    try {
      await page.goto(loginNavTarget, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e) {
      console.log(`    ❌ login goto failed for ${hostLabel}: ${(e.message || '').slice(0, 120)}`);
    }
    // Allow client-side redirects / SPA login forms to settle.
    await new Promise((r) => setTimeout(r, 1500));

    // SPA RENDER POLL — Cloudia (login.cloudia.net) and a handful of
    // other login pages are JS-rendered: the password input doesn't
    // exist in the initial HTML and only appears after React/Angular
    // mounts. The 1.5s settle above isn't enough; the pre-check below
    // misses the form, the trigger scorer doesn't find a Login button
    // either, and we fail with "no password field". Poll up to 6s
    // looking for a visible password input or a logged-in marker
    // before falling through. Returns fast (~50ms) for portals whose
    // form is already there, so it doesn't penalize the common path.
    // 2026-05-11 fix for tarjouspalvelu.fi/cloudia regression.
    try {
      await page.waitForFunction(() => {
        try {
          for (const el of document.querySelectorAll('input[type="password"]:not([disabled]):not([aria-hidden="true"])')) {
            if (el && el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0) return true;
          }
          const RX_LOGGED = /\b(?:log\s*out|log\s*off|logout|logga\s*ut|sign\s*out|d[eé]connexion|abmelden|cerrar\s*sesi[oó]n|kirjaudu\s*ulos|wyloguj|my\s*pages|my\s*account|min(?:a)?\s*(?:profil|sidor|side)|mein\s*konto|mon\s*compte|mitt\s*konto)\b/i;
          return RX_LOGGED.test(((document.body && document.body.innerText) || '').slice(0, 4000));
        } catch (_) { return false; }
      }, { timeout: 6000, polling: 250 }).catch(() => null);
    } catch (_) { /* best-effort */ }

    // ALREADY-LOGGED-IN CHECK — when a prior tender's login left cookies
    // in this browser context, navigating to /login.aspx (or equivalent)
    // typically renders the logged-in shell instead of a login form:
    // "My pages", "Log off", "Mina sidor", etc. visible, no password
    // input. If we fall through to the click scorer in that state, the
    // matcher picks an account-dropdown anchor ("My pages") that has
    // login-ish attributes and navigates us into an account page. Early
    // return saves the round-trip and avoids polluting the session.
    // 2026-05-11 e-avrop fix: tenders #2/#6 failed with "clicked login
    // trigger 'My pages'" after tender #1 logged in successfully.
    try {
      const sessionState = await page.evaluate(() => {
        // Same vocabulary as outer LOGGED_IN_MARKER, kept in-sync with
        // additions like "log\s*off" and "my\s*pages" that the e-avrop
        // template uses verbatim.
        const RX_LOGGED = /\b(?:log\s*out|log\s*off|logout|logga\s*ut|logg\s*ut|cerrar\s*sesi[oó]n|d[eé]connexion|abmelden|uitloggen|kirjaudu\s*ulos|wyloguj|sign\s*out|min(?:a)?\s*(?:profil|sidor|side)|mein\s*konto|mon\s*compte|my\s*account|my\s*pages|mitt\s*konto|moja\s*strona)\b/i;
        const text = (document.body && document.body.innerText || '').slice(0, 4000);
        const hasMarker = RX_LOGGED.test(text);
        // visible password input present? (mirrors findVisible logic)
        let hasVisiblePass = false;
        try {
          for (const el of document.querySelectorAll('input[type="password"]:not([disabled]):not([aria-hidden="true"])')) {
            if (el && el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0) {
              hasVisiblePass = true;
              break;
            }
          }
        } catch (_) {}
        return { hasMarker, hasVisiblePass };
      }).catch(() => ({ hasMarker: false, hasVisiblePass: false }));
      if (sessionState.hasMarker && !sessionState.hasVisiblePass) {
        console.log(`    ✅ already authenticated on ${hostLabel} (logged-in marker present, no password form) — skipping login flow`);
        // SSO BOUNCE — when we used a dedicated-login URL on a different
        // host than the actual source (e.g. login.cloudia.net for
        // tarjouspalvelu.fi), the dedicated host's session cookie does
        // NOT propagate to the source host without a redirect chain that
        // origin-side identity provider would have triggered if the user
        // had logged in via the source. Navigate the SAME page to
        // sourceUrl now — the source will redirect to cloudia (which is
        // already authenticated) and back, setting the source-host
        // cookies along the way. Without this, the caller's retry on
        // the original tender page still hits the auth wall.
        // 2026-05-12 fix for tarjouspalvelu.fi ZIP fetch.
        if (dedicatedLoginUrl && sourceUrl) {
          try {
            console.log(`    ↪️  SSO bounce-back: navigating to ${sourceUrl.slice(0, 80)} to propagate session`);
            await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => null);
            try { await page.waitForNetworkIdle({ idleTime: 1000, timeout: 8000 }); } catch (_) {}
            await new Promise((r) => setTimeout(r, 1200));
            // SSO TRIGGER CLICK — bounce-back navigation alone doesn't
            // fire the SSO check; the tarjouspalvelu tender page shows
            // its auth wall until user clicks the "Log in" button which
            // redirects to cloudia (where session is set) and back with
            // an auth token. Click that trigger now. User-confirmed
            // 2026-05-12 DOM: <button id="continue">Log in</button>.
            const triggerInfo = await page.evaluate(() => {
              const RX_TRIG = /^\s*(log\s*in|login|logga\s*in|kirjaudu(?:\s*sis[äa][äa]n)?|logg\s*inn|prisijungti|connexion|anmelden|iniciar\s*sesi[óo]n)\s*$/i;
              const findVisible = (el) => el && el.offsetParent !== null && !el.hasAttribute('disabled');
              // Diagnostic pass: report ALL "Log in"-ish candidates so we
              // can see WHICH element actually got clicked.
              const cands = [];
              for (const el of document.querySelectorAll('button, a, [role="button"]')) {
                const t = (el.textContent || '').trim();
                if (t.length === 0 || t.length > 40) continue;
                if (!RX_TRIG.test(t)) continue;
                cands.push({
                  text: t.slice(0, 30),
                  tag: el.tagName,
                  id: el.id || '',
                  cls: (el.className || '').toString().slice(0, 60),
                  visible: !!findVisible(el),
                  href: (el.getAttribute('href') || '').slice(0, 60),
                });
              }
              // Click strategy: prefer button#continue (tender page's
              // SSO trigger per user-confirmed DOM 2026-05-13), else
              // button.button--positive, else first visible text match
              // that is NOT the bare "Log in" cookie banner / footer
              // link (filter out anchors going to /privacy, /terms, etc).
              // Known stable selectors — click WITHOUT visibility check.
              // User-confirmed DOM 2026-05-13 on tarjouspalvelu.fi tender
              // pages: <button id="continue" class="button--positive
              // hidden-content hidden-content--show">Log in</button>.
              // The `hidden-content` base class CSS-hides the element by
              // default; the `--show` modifier overrides at runtime. Our
              // offsetParent check sees the BASE state and rejects the
              // button. Skip the visibility check when matching by id
              // since we know this is the intended SSO trigger.
              const trySelectors = [
                'button#continue:not([disabled])',
                'button[id="continue"]:not([disabled])',
                'button.button--positive:not([disabled])',
              ];
              for (const sel of trySelectors) {
                try {
                  const el = document.querySelector(sel);
                  if (el && !el.hasAttribute('disabled')) {
                    // Try to make it visible first (Vaadin sometimes
                    // toggles via JS post-hydration).
                    try { el.scrollIntoView({ block: 'center' }); el.focus(); } catch (_) {}
                    el.click();
                    return { clicked: sel, candidates: cands };
                  }
                } catch (_) {}
              }
              // Text fallback — exclude anchors to non-auth pages.
              const RX_SKIP_HREF = /\/(?:privacy|terms|help|support|cookies?|policy|gdpr)\b/i;
              for (const el of document.querySelectorAll('button, a, [role="button"]')) {
                if (!findVisible(el)) continue;
                const t = (el.textContent || '').trim();
                if (t.length === 0 || t.length > 30) continue;
                if (!RX_TRIG.test(t)) continue;
                const href = el.getAttribute('href') || '';
                if (RX_SKIP_HREF.test(href)) continue;
                try {
                  el.click();
                  return {
                    clicked: `text:${t.slice(0, 20)} (tag=${el.tagName}, id=${el.id || 'none'}, href=${href.slice(0, 40)})`,
                    candidates: cands,
                  };
                } catch (_) {}
              }
              return { clicked: null, candidates: cands };
            }).catch(() => ({ clicked: null, candidates: [] }));

            // Log all candidates so we can debug element selection.
            if (triggerInfo.candidates && triggerInfo.candidates.length > 1) {
              console.log(
                `    ↪️  SSO trigger candidates (${triggerInfo.candidates.length}): ` +
                triggerInfo.candidates.slice(0, 5).map((c) =>
                  `[${c.tag}#${c.id || '_'}.${(c.cls.split(/\s+/)[0] || '_').slice(0, 20)} "${c.text}"${c.visible ? '' : ' HIDDEN'}]`
                ).join(' ')
              );
            }
            if (triggerInfo.clicked) {
              console.log(`    ↪️  SSO trigger clicked (${triggerInfo.clicked}) — waiting for redirect chain`);
              try { await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 12000 }); } catch (_) {}
              try { await page.waitForNetworkIdle({ idleTime: 1000, timeout: 6000 }); } catch (_) {}
              await new Promise((r) => setTimeout(r, 1500));
              // Post-click verification: did the page transition to an
              // authed state? bodyLen jump from ~1k to >5k is a strong
              // signal SSO completed. Log password-field presence too.
              try {
                const postState = await page.evaluate(() => {
                  const RX_LOGGED = /\b(?:log\s*out|kirjaudu\s*ulos|logga\s*ut|sign\s*out|d[eé]connexion|abmelden|cerrar\s*sesi[oó]n)\b/i;
                  const body = (document.body && document.body.innerText || '');
                  return {
                    url: location.href.slice(0, 120),
                    bodyLen: body.length,
                    hasLoggedMarker: RX_LOGGED.test(body),
                    hasPasswordField: !!document.querySelector('input[type="password"]:not([disabled]):not([aria-hidden="true"])'),
                  };
                }).catch(() => null);
                if (postState) {
                  console.log(
                    `    ↪️  post-SSO state: url=${postState.url.slice(-60)}, bodyLen=${postState.bodyLen}, ` +
                    `loggedMarker=${postState.hasLoggedMarker}, passwordField=${postState.hasPasswordField}`
                  );
                }
              } catch (_) {}
            } else {
              console.log(`    ↪️  no SSO trigger found on bounce-back page (already passed-through or auto-redirected)`);
            }
          } catch (_) {}
        }
        return true;
      }
    } catch (_) { /* fall through to normal login flow */ }

    // Some portals (e-avrop.com, marches-publics.gouv.fr, certain
    // TendSign / Cloudia variants) land on a page whose login form is
    // either inside a popup that opens after a "Logga in" / "Login" /
    // "Connexion" / "Identification entreprise" click, or whose form
    // exists in the DOM but is initially aria-hidden. The popup-trigger
    // button is normally the SMALL header item, not the form's own
    // submit button (whose text is also some variant of "Log in"). We
    // ALWAYS attempt this click — even when a password field appears
    // present — because the apparent visibility check is unreliable
    // (popup form may be in DOM but inside a display:none container
    // that fools offsetParent on Chromium). Clicking is harmless when
    // the form is already open: at worst we click the submit button
    // before fields are filled, but no submission goes through (csrf /
    // empty fields). The `excludeSubmit` filter avoids clicking inside
    // a form's own submit input/button when a real form is open.
    const clickInfo = await page.evaluate(() => {
      // PRE-CHECK: if a visible password input already exists somewhere
      // on the page, we're already on a login form — clicking ANY
      // "Login" trigger now would navigate AWAY (header link to a
      // marketing/info subdomain, popup-opener that already opened the
      // form we see, etc.). 2026-05-11 log showed e-avrop /login.aspx
      // had the form visible AND a header `Header1_LoginControl1_blogLink`
      // that, when clicked, redirected to info.e-avrop.com (marketing).
      // Returning early here keeps us on the form so the direct fill
      // path below works.
      try {
        const visiblePass = Array.from(document.querySelectorAll(
          'input[type="password"]:not([disabled]):not([aria-hidden="true"])'
        )).find((el) => el && el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0);
        if (visiblePass) {
          return { clicked: null, sample: [], passwordAlreadyVisible: true };
        }
      } catch (_) { /* fall through to normal trigger search */ }
      // STRICT regex for visible-text matching — requires word boundaries
      // on both sides so we don't pick up "Author" / "Authority" / nav
      // headings. Covers EN/SV/FR/DE/ES/PT/FI/NO/SI/SK/CZ/HU/RO/EL/LV/
      // LT/Cyrillic synonyms.
      const RX_TEXT = /\b(login|log[-\s]?in|logga[-\s]?in|logon|sign[-\s]?in|signin|auth|anmelden|connexion|se[-\s]?connecter|identification|s'identifier|iniciar[-\s]?sesi[oó]n|acceder|entrar|kirjaudu|logg[-\s]?inn|prijava|prihl[aá]senie|p[rř]ihl[aá]sit|bejelentkez[eé]s|conectare|είσοδος|pieslēgties|prisijungti|ulogi[ts]e|вход|mon[-\s]?compte|espace[-\s]?(entreprise|personnel|fournisseur))\b/i;
      // PERMISSIVE regex for ASP.NET / framework-generated identifiers
      // where "login" / "auth" appear as camelCase tokens INSIDE a single
      // underscore-joined id (e.g. `Header1_LoginControl1_blogLink` on
      // e-avrop, where `_` is a word char and `\b` never matches inside).
      // Drops boundary requirements but uses distinct enough tokens so
      // false-positives are unlikely: "login" doesn't substring inside
      // "logout"/"logo"/"logical"; "signin" is one word; "connexion" is
      // distinctively French. We keep "auth" but exclude "author"/
      // "authority" via negative lookahead.
      const RX_ATTR = /(login|signin|sign-in|logon|auth(?!or)|connexion|connect-entreprise|entreprise-auth|identification|s-identifier|iniciar-sesion|kirjaudu|loggainn|prisijungti)/i;
      // Skip-list for common navigation buttons whose attributes
      // sometimes accidentally match (e.g. a help link containing
      // "auth-help" in its href). We apply this when the visible
      // text clearly indicates the element is NOT a login trigger.
      // CRITICAL: includes "register"/"sign up" because portals
      // (publicprocurement.be) commonly group a "Login" container
      // and a "Register" sibling under the same parent with
      // login-related ids/classes — without this guard we'd click
      // Register and end up on the wrong page. Also covers EN/FR/
      // DE/NL/ES/SE/FI register synonyms.
      const SKIP_TEXT = /\b(aller\s*au|skip\s*to|menu|contenu|content|contact|accueil|home|search|recherche|lancer|toggle\s*navigation|kontakt|footer|impressum|datenschutz|register|sign[\s-]?up|create\s*account|s'enregistrer|s'inscrire|inscription|registrieren|neu\s*registrieren|konto\s*erstellen|registreren|nieuw\s*account|aanmelden\s*als\s*nieuw|crear\s*cuenta|registrar(?:se)?|registrera(?:\s*dig)?|rekister[öo]ity[ää]?|forgot\s*password|mot\s*de\s*passe\s*oublié|passwort\s*vergessen)\b/i;
      const candidates = Array.from(document.querySelectorAll(
        'button, a, [role="button"], input[type="button"], input[type="submit"]'
      ));
      // Skip elements that are inside a form already showing a VISIBLE
      // password field — those are the form's own submit button, not a
      // popup-opening trigger. CRITICAL: we must check visibility, not
      // just existence + aria-hidden, because some pages (e-avrop's
      // /login.aspx) render a hidden password input via display:none
      // for password-manager autofill hints. Without the visibility
      // check, ALL elements inside that form (including header "Login"
      // links) get filtered out and we never click anything.
      const insideOpenForm = (el) => {
        try {
          const f = el.closest('form');
          if (!f) return false;
          const passInputs = f.querySelectorAll('input[type="password"]:not([aria-hidden="true"])');
          for (const p of passInputs) {
            // offsetParent is null when the element OR any ancestor has
            // display:none. Width/height === 0 covers visibility:hidden.
            if (p.offsetParent !== null && p.offsetWidth > 0 && p.offsetHeight > 0) {
              return true;
            }
          }
        } catch (_) {}
        return false;
      };
      // Cross-host marketing-redirect filter — some portals' "Login"
      // header links point to a separate marketing/info subdomain
      // (e-avrop.com's Header1_LoginControl1_blogLink → info.e-avrop.com)
      // instead of staying on the same host. Clicking those navigates
      // us away from the login form and into a marketing landing page.
      // We resolve each candidate's href against current location and
      // reject when the resolved hostname is on a different "info-ish"
      // subdomain of the same registrable domain (or differs entirely
      // and looks like marketing). 2026-05-11 e-avrop fix.
      const currentHost = (location.host || '').toLowerCase().replace(/^www\./, '');
      const MARKETING_HOST_PREFIX = /^(info|marketing|help|support|docs|kb|status|blog|community|forum|learn|news)\b/i;
      const isMarketingHref = (rawHref) => {
        if (!rawHref) return false;
        const s = String(rawHref).trim();
        if (!s || s.startsWith('#') || /^javascript:/i.test(s)) return false;
        try {
          const u = new URL(s, location.href);
          const h2 = (u.host || '').toLowerCase().replace(/^www\./, '');
          if (!h2 || h2 === currentHost) return false;
          // Same registrable domain but different subdomain: only
          // marketing-prefixed subdomains are blocked (avoids killing
          // legit cross-subdomain SSO like login.cloudia.net).
          if (currentHost && h2.endsWith('.' + currentHost.replace(/^[^.]+\./, ''))) {
            const sub = h2.replace(/\.[^.]+\.[^.]+$/, '');
            return MARKETING_HOST_PREFIX.test(sub);
          }
          // Different domain entirely: only block if hostname
          // itself starts with a marketing prefix.
          return MARKETING_HOST_PREFIX.test(h2);
        } catch (_) { return false; }
      };
      // Logged-in nav-element filter — when the session is already
      // authenticated (cookies from a prior tender's login), the page
      // shows account-dropdown links like "My pages", "Mina sidor",
      // "Mon compte", "Log off". Those sometimes carry login-ish
      // attributes (legacy class names, container ids) and score on
      // the attribute branch — clicking them takes us to an account
      // page where no password form exists. The early-return check
      // above usually catches this state, but in case it doesn't fire
      // (subset of markers present, body too short, etc.), this guard
      // rejects per-element. 2026-05-11 e-avrop tenders #2/#6 fix.
      const RX_LOGGED_IN_NAV = /^\s*(?:log\s*off|log\s*out|logout|logga\s*ut|sign\s*out|d[eé]connexion|abmelden|cerrar\s*sesi[oó]n|kirjaudu\s*ulos|wyloguj|atsijungti|min(?:a)?\s*(?:profil|sidor|side)|my\s*pages|my\s*account|mon\s*compte|mein\s*konto|mitt\s*konto|moja\s*strona)\s*$/i;
      const scoreEl = (el) => {
        if (!el || el.offsetParent === null) return -1;
        if (insideOpenForm(el)) return -1;
        // Marketing-href filter — only on <a> elements (buttons don't
        // navigate by href, so the check is irrelevant).
        if (el.tagName === 'A' && isMarketingHref(el.getAttribute('href'))) {
          return -1;
        }
        const innerText = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
        // Logged-in nav filter: short, exactly-matching account-link
        // text (anchored on both sides) gets rejected outright.
        if (innerText && innerText.length <= 30 && RX_LOGGED_IN_NAV.test(innerText)) {
          return -1;
        }
        // Primary: visible text matches (HIGH confidence, score 3)
        if (innerText && innerText.length <= 40 && RX_TEXT.test(innerText)) {
          if (SKIP_TEXT.test(innerText)) return -1;
          return 3;
        }
        // Fallback: attribute-based (LOWER confidence, score 1).
        // Use the permissive RX_ATTR so we catch identifiers like
        // `Header1_LoginControl1_blogLink` (e-avrop) where word
        // boundaries don't fire inside underscore-joined ids.
        const attrBlob = [
          el.id || '',
          el.className || '',
          el.getAttribute('href') || '',
          el.getAttribute('aria-label') || '',
          el.getAttribute('data-target') || '',
          el.getAttribute('data-toggle') || '',
        ].join(' ').toLowerCase();
        if (RX_ATTR.test(attrBlob)) {
          if (innerText && SKIP_TEXT.test(innerText)) return -1;
          return 1;
        }
        return -1;
      };
      const scored = candidates
        .map((el) => ({ el, score: scoreEl(el) }))
        .filter((x) => x.score > 0);
      if (scored.length === 0) {
        const sample = candidates
          .filter((el) => el.offsetParent !== null)
          .slice(0, 12)
          .map((el) => {
            const t = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim();
            const i = el.id ? `#${el.id}` : '';
            return (t || i || '').slice(0, 30);
          })
          .filter(Boolean);
        return { clicked: null, sample };
      }
      // Prefer high-confidence (text) matches; among same score prefer
      // shorter text (header link vs. paragraph).
      scored.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        const aLen = (a.el.innerText || a.el.value || '').length;
        const bLen = (b.el.innerText || b.el.value || '').length;
        return aLen - bLen;
      });
      try {
        const target = scored[0].el;
        // Capture the href BEFORE click — some single-page-app handlers
        // mutate the element's href on click (or replace it entirely).
        // We need the original to follow it as a fallback if the click
        // itself didn't trigger navigation.
        const hrefRaw = (target.tagName === 'A') ? (target.getAttribute('href') || '') : '';
        const urlBefore = location.href;
        target.click();
        const usedText = (target.innerText || target.value || target.getAttribute('aria-label') || '').trim();
        const usedId = target.id ? `#${target.id}` : '';
        return {
          clicked: (usedText || usedId).slice(0, 40),
          sample: [],
          confidence: scored[0].score,
          href: hrefRaw,
          urlBefore,
        };
      } catch (_) { return { clicked: null, sample: [] }; }
    }).catch(() => ({ clicked: null, sample: [] }));
    if (clickInfo.clicked) {
      const conf = clickInfo.confidence === 3 ? 'text' : 'attr';
      console.log(`    ↪️  clicked login trigger "${clickInfo.clicked}" on ${hostLabel} (match=${conf})`);
      // Nav-aware settle — if the click triggered a real navigation
      // (typical for ASP.NET LoginControl links that navigate to a
      // separate /secure/login page), wait for it to finish before
      // checking selectors. Without this we'd hit the OLD page's DOM
      // and conclude "no password field" while the real one was still
      // loading. Race against a 3s upper bound so we don't hang when
      // the click is a no-op (JS handler with no nav).
      await Promise.race([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => null),
        new Promise((r) => setTimeout(r, 3000)),
      ]);
      // Href fallback — if the click attached to an <a> with a real
      // URL but did NOT change page location (handler stopped event
      // propagation, returned false, or used a JS modal we can't see),
      // navigate to that URL directly. Skips javascript: hrefs and
      // anchor-only "#foo" fragments. This handles e-avrop's
      // Header1_LoginControl1_blogLink which sometimes only swaps the
      // header DOM in-place without exposing a password input.
      try {
        const currentUrl = page.url();
        const sameLocation = currentUrl === clickInfo.urlBefore;
        const href = String(clickInfo.href || '').trim();
        if (sameLocation && href && !/^javascript:/i.test(href) && !/^#/.test(href)) {
          let target = href;
          if (target.startsWith('/')) {
            try {
              const u = new URL(currentUrl);
              target = u.origin + target;
            } catch (_) {}
          } else if (!/^https?:\/\//i.test(target)) {
            // Relative path — resolve against currentUrl
            try { target = new URL(href, currentUrl).toString(); } catch (_) {}
          }
          if (/^https?:\/\//i.test(target) && target !== currentUrl) {
            console.log(`    ↪️  click stayed on same URL — following href directly: ${target.slice(0, 80)}`);
            try {
              await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 10000 });
              await new Promise((r) => setTimeout(r, 1500));
            } catch (e) {
              console.log(`    ⚠️  href-fallback nav failed: ${(e.message || '').slice(0, 80)}`);
            }
          }
        }
      } catch (_) { /* best-effort */ }
    } else if (clickInfo.passwordAlreadyVisible) {
      // Form is already on the page — direct fill path will handle it.
      console.log(`    ↪️  password field already visible on ${hostLabel} — skipping popup-trigger click`);
    } else if (clickInfo.sample && clickInfo.sample.length) {
      // Only log when we couldn't find a match — helps diagnose silent
      // failures like "no password field" without indicating a click.
      console.log(`    ⚠️  no login-trigger button matched on ${hostLabel}; visible buttons: ${JSON.stringify(clickInfo.sample.slice(0, 8))}`);
    }

    const sels = await page.evaluate(() => {
      const findVisible = (selectors) => {
        for (const sel of selectors) {
          try {
            const el = document.querySelector(sel);
            if (el && el.offsetParent !== null) return sel;
          } catch (_) { /* invalid selector — skip */ }
        }
        return null;
      };
      const userSel = findVisible([
        'input[type="email"]:not([disabled]):not([aria-hidden="true"])',
        'input[name="email"]:not([disabled])',
        'input[id*="email" i]:not([disabled])',
        'input[name="username"]:not([disabled])',
        'input[id*="user" i]:not([disabled])',
        'input[name*="user" i]:not([disabled])',
        'input[name="login"]:not([disabled])',
        'input[name*="login" i]:not([disabled])',
        'input[type="text"]:not([disabled]):not([aria-hidden="true"])',
      ]);
      const passSel = findVisible([
        'input[type="password"]:not([disabled]):not([aria-hidden="true"])',
      ]);
      return { userSel, passSel, currentHost: location.host, currentUrl: location.href };
    }).catch(() => ({ userSel: null, passSel: null, currentHost: hostLabel, currentUrl: '' }));

    // MULTI-STEP LOGIN — when a username field is visible but password
    // isn't, the page MIGHT be using the email-first / username-first
    // pattern (Microsoft Entra, modern AspNet). But the same shape is
    // also produced by newsletter signup, search bars, and "request
    // demo" forms — which is exactly what bit us on e-avrop.com (the
    // detected userSel turned out to be a search/newsletter field,
    // and submitting it sent us to info.e-avrop.com). To distinguish,
    // require that the userSel's parent form ALSO has a password
    // input somewhere (visible OR hidden via display:none — that's
    // the autofill hint pattern real login forms use, but newsletter
    // forms never do). Skip the multi-step branch otherwise.
    let userInLoginForm = false;
    if (sels.userSel) {
      userInLoginForm = await page.evaluate((sel) => {
        try {
          const el = document.querySelector(sel);
          if (!el) return false;
          const f = el.closest('form');
          if (!f) return false; // not in a form at all → likely a search box
          return !!f.querySelector('input[type="password"]');
        } catch (_) { return false; }
      }, sels.userSel).catch(() => false);
    }
    if (sels.userSel && !sels.passSel && creds.username && !userInLoginForm) {
      console.log(`    ⚠️  userSel is NOT inside a form containing a password input — skipping multi-step (likely a search/newsletter field, would mis-submit credentials)`);
    }
    if (sels.userSel && !sels.passSel && creds.username && userInLoginForm) {
      console.log(`    ↪️  multi-step login detected (username field present, password hidden, form has password input) — typing username + advancing`);
      try { await page.click(sels.userSel, { clickCount: 3 }); } catch (_) {}
      try { await page.type(sels.userSel, String(creds.username), { delay: 25 }); }
      catch (e) { console.log(`    ⚠️ multi-step username type failed: ${(e.message || '').slice(0, 80)}`); }
      // Click the submit button that's PART OF THE SAME FORM as the
      // username field — that's almost always the right one. Pure
      // text-match ("Next") works in ~half of multi-step pages but
      // fails on ASP.NET pages where the button text is something
      // unrelated like "Logga in" / "Lähetä". Form-scope match is
      // more reliable. Real-world failure (e-avrop run on 2026-05-09):
      // generic "first button" fallback clicked a contact/info form's
      // submit and we were redirected to info.e-avrop.com instead of
      // the password step.
      const advanced = await page.evaluate((userSelStr) => {
        const TXT = /^\s*(next|continue|weiter|suivant|siguiente|seuraava|nästa|pirmyn|toliau|dalej|další|další\s*krok|→|logga\s*in|log\s*in|login|sign\s*in|kirjaudu|lähetä|prisijungti)\s*$/i;
        const userEl = userSelStr ? document.querySelector(userSelStr) : null;
        const userForm = userEl ? userEl.closest('form') : null;
        const all = Array.from(document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]'));
        // Tier 1: submit/button that's INSIDE the same form as the username field.
        if (userForm) {
          const inForm = all.filter((el) => {
            if (!el || el.offsetParent === null) return false;
            return el.closest('form') === userForm;
          });
          // Among in-form candidates, prefer ones whose text matches
          // login/next, then any submit type.
          const inFormByText = inForm.find((el) => {
            const t = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim();
            return t.length <= 20 && TXT.test(t);
          });
          if (inFormByText) {
            try { inFormByText.click(); return 'form-text:' + (inFormByText.innerText || inFormByText.value || '').trim().slice(0, 20); } catch (_) {}
          }
          const inFormSubmit = inForm.find((el) => {
            const tag = el.tagName.toLowerCase();
            if (tag === 'input') return el.type === 'submit';
            if (tag === 'button') return el.type === 'submit' || el.type === '';
            return false;
          });
          if (inFormSubmit) {
            try { inFormSubmit.click(); return 'form-submit:' + inFormSubmit.tagName; } catch (_) {}
          }
        }
        // Tier 2 (fallback): visible button with matching text anywhere
        // on the page. Restricted to login/next vocabulary to avoid
        // hitting Search or Subscribe buttons.
        const byText = all.find((el) => {
          if (!el || el.offsetParent === null) return false;
          const t = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim();
          return t.length <= 20 && TXT.test(t);
        });
        if (byText) {
          try { byText.click(); return 'text:' + (byText.innerText || byText.value || '').trim().slice(0, 20); } catch (_) {}
        }
        // No reliable candidate — DON'T click random buttons (prevents
        // the e-avrop info.e-avrop.com redirect failure mode).
        return null;
      }, sels.userSel).catch(() => null);
      if (advanced) {
        console.log(`    ↪️  advanced multi-step (${advanced})`);
        // Long settle window — Microsoft / AspNet round-trips take 2-4s
        await new Promise((r) => setTimeout(r, 4000));
      } else {
        // No submit found — try Enter as last resort
        try { await page.keyboard.press('Enter'); } catch (_) {}
        await new Promise((r) => setTimeout(r, 4000));
      }
      // Re-query selectors after the multi-step advance.
      const sels2 = await page.evaluate(() => {
        const findVisible = (selectors) => {
          for (const sel of selectors) {
            try {
              const el = document.querySelector(sel);
              if (el && el.offsetParent !== null) return sel;
            } catch (_) {}
          }
          return null;
        };
        const passSel = findVisible([
          'input[type="password"]:not([disabled]):not([aria-hidden="true"])',
        ]);
        return { passSel, currentHost: location.host, currentUrl: location.href };
      }).catch(() => ({ passSel: null }));
      if (sels2.passSel) {
        sels.passSel = sels2.passSel;
        if (sels2.currentHost) sels.currentHost = sels2.currentHost;
        sels.userSel = null; // already typed
        console.log(`    ✓ password field appeared after multi-step advance`);
      }
    }

    if (!sels.passSel) {
      console.log(`    ❌ no password field on ${hostLabel} (post-redirect: ${sels.currentHost})`);
      return false;
    }
    if (sels.currentHost && sels.currentHost !== hostLabel) {
      console.log(`    ↪️  login form is on ${sels.currentHost} (redirected from ${hostLabel})`);
    }

    if (sels.userSel && creds.username) {
      try { await page.click(sels.userSel, { clickCount: 3 }); } catch (_) {}
      try { await page.type(sels.userSel, String(creds.username), { delay: 25 }); }
      catch (e) { console.log(`    ⚠️ username type failed: ${(e.message || '').slice(0, 80)}`); }
    }
    try { await page.click(sels.passSel, { clickCount: 3 }); } catch (_) {}
    try { await page.type(sels.passSel, String(creds.password), { delay: 25 }); }
    catch (e) {
      console.log(`    ❌ password type failed on ${hostLabel}: ${(e.message || '').slice(0, 120)}`);
      return false;
    }

    const submitSel = await page.evaluate((passSelStr) => {
      // Tier 0: FORM-SCOPED — when the password input lives inside a
      // <form>, prefer the submit element inside THAT form over any
      // global match. This prevents picking a stray search/contact-form
      // <input type="submit"> elsewhere on the page (kommersannons.se's
      // /<tenant>/Account/Login.aspx renders header search + footer
      // contact alongside the actual login form, so a global
      // `input[type="submit"]` query returned the wrong button on
      // 2026-05-11). ASP.NET pages typically have ID suffix
      // "LoginButton" / "btnLogin" / "$LoginButton" — but text match
      // is the safest disambiguator across locales.
      try {
        const passEl0 = passSelStr ? document.querySelector(passSelStr) : null;
        const passForm0 = passEl0 ? passEl0.closest('form') : null;
        if (passForm0) {
          const inForm = Array.from(passForm0.querySelectorAll(
            'button[type="submit"]:not([disabled]),' +
            ' input[type="submit"]:not([disabled]),' +
            ' button[type="button"]:not([disabled])'
          )).filter((el) => el && el.offsetParent !== null);
          // ASP.NET LoginButton id/name pattern first.
          const ATTR_LOGIN = /(loginbutton|btnlogin|signin|btnsubmit|login\$|\$login)/i;
          const byAttr = inForm.find((el) => {
            const blob = [
              el.id || '',
              el.getAttribute('name') || '',
              el.className || '',
            ].join(' ').toLowerCase();
            return ATTR_LOGIN.test(blob);
          });
          if (byAttr) { byAttr.click(); return 'form0-attr:' + (byAttr.id || byAttr.name || '').slice(0, 30); }
          // Text-match login vocabulary inside the form.
          const TXT_LOGIN = /^\s*(login|log[\s-]?in|logga[\s-]?in|sign[\s-]?in|signin|connexion|se[\s-]?connecter|anmelden|kirjaudu|iniciar\s*sesi[oó]n|acceder|entrar|prisijungti|logg[\s-]?inn|prijava)\s*$/i;
          const byText = inForm.find((el) => {
            const t = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim();
            return t.length > 0 && t.length <= 20 && TXT_LOGIN.test(t);
          });
          if (byText) { byText.click(); return 'form0-text:' + (byText.innerText || byText.value || '').trim().slice(0, 20); }
          // Single in-form submit candidate — safe to click.
          if (inForm.length === 1) {
            inForm[0].click();
            return 'form0-only:' + inForm[0].tagName + ':' + (inForm[0].id || inForm[0].name || '').slice(0, 30);
          }
        }
      } catch (_) { /* fall through to global */ }
      // Tier 1: standard semantic submit selectors. Catches normal HTML
      // forms and ASP.NET pages whose LoginButton renders as a real
      // <input type="submit" id="...LoginButton">.
      const candidates = [
        'button[type="submit"]:not([disabled])',
        'input[type="submit"]:not([disabled])',
        // Vaadin / Cloudia SSO: <button type="button" id="continue">Log in</button>
        // (user-confirmed DOM 2026-05-12). Vaadin uses non-form layouts so
        // Tier 2 form-scoped search misses; match by stable id directly.
        'button#continue:not([disabled])',
        'button[id="continue"]:not([disabled])',
        'button[name*="login" i]:not([disabled])',
        'button[id*="login" i]:not([disabled])',
        'button[class*="login" i]:not([disabled])',
        'button[name*="signin" i]:not([disabled])',
        'button[id*="signin" i]:not([disabled])',
        'button[id*="submit" i]:not([disabled])',
        // Vaadin "button--positive" pattern (Cloudia uses this class for
        // primary action buttons; non-disabled positive button after
        // password field is the submit).
        'button.button--positive:not([disabled])',
      ];
      for (const sel of candidates) {
        try {
          const el = document.querySelector(sel);
          if (el && el.offsetParent !== null) { el.click(); return sel; }
        } catch (_) {}
      }
      // Tier 2: ASP.NET LoginControl variants that render the submit as
      // an <a href="javascript:__doPostBack('...$LoginButton','')">Login</a>
      // — semantic selectors above miss those entirely. 2026-05-11 log
      // showed kommersannons.se /<tenant>/Default.aspx in this state:
      // password field filled, but clicking nothing because the "Login"
      // element was an anchor. We now look INSIDE the form that owns
      // the password input for any visible <a>/<button>/[role="button"]
      // whose text matches login vocabulary, and click that.
      const TXT_SUBMIT = /^\s*(login|log[\s-]?in|logga[\s-]?in|sign[\s-]?in|signin|connexion|se[\s-]?connecter|anmelden|kirjaudu|iniciar\s*sesi[oó]n|acceder|entrar|prisijungti|logg[\s-]?inn|prijava)\s*$/i;
      try {
        const passEl = passSelStr ? document.querySelector(passSelStr) : null;
        const passForm = passEl ? passEl.closest('form') : null;
        // When the page uses a non-form layout (Vaadin / Cloudia SSO,
        // some Angular SPAs), passForm is null. Fall back to scanning
        // the entire document — limited risk because TXT_SUBMIT is
        // strict ("login", "log in", localized variants) and only
        // visible elements pass `offsetParent !== null`.
        const scopeRoot = passForm || document;
        {
          const inForm = Array.from(scopeRoot.querySelectorAll(
            'a, button, [role="button"], input[type="button"]'
          ));
          // Prefer text match within the same form.
          const byText = inForm.find((el) => {
            if (!el || el.offsetParent === null) return false;
            if (el.hasAttribute('disabled')) return false;
            const t = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
            return t.length > 0 && t.length <= 20 && TXT_SUBMIT.test(t);
          });
          // Helper: when the element is an <a href="javascript:...">
          // (ASP.NET LoginControl's typical render for its submit
          // button — `<a href="javascript:__doPostBack('...$LoginButton','')">`),
          // .click() doesn't always fire the JS handler reliably in
          // Puppeteer. Evaluate the javascript: payload directly so
          // the postback fires deterministically.
          const fireClick = (el) => {
            try {
              if (el.tagName === 'A') {
                const href = el.getAttribute('href') || '';
                const m = /^\s*javascript:\s*(.*)$/i.exec(href);
                if (m && m[1]) {
                  // eslint-disable-next-line no-eval
                  (function () { eval(m[1]); }).call(window);
                  return true;
                }
              }
            } catch (_) { /* fall through to .click() */ }
            try { el.click(); return true; } catch (_) { return false; }
          };
          if (byText) {
            if (fireClick(byText)) return 'in-form-text:' + (byText.innerText || byText.value || '').trim().slice(0, 20);
          }
          // Attribute fallback within the same form — ASP.NET ids like
          // `Header1_LoginControl1_LoginButton` are common.
          const ATTR_SUBMIT = /(loginbutton|signinbutton|btnlogin|btnsignin|btnsubmit|loginlink|logbtn)/i;
          const byAttr = inForm.find((el) => {
            if (!el || el.offsetParent === null) return false;
            if (el.hasAttribute('disabled')) return false;
            const blob = [
              el.id || '',
              el.className || '',
              el.getAttribute('name') || '',
              el.getAttribute('href') || '',
            ].join(' ').toLowerCase();
            return ATTR_SUBMIT.test(blob);
          });
          if (byAttr) {
            if (fireClick(byAttr)) return 'in-form-attr:' + (byAttr.id || byAttr.className || '').slice(0, 30);
          }
        }
      } catch (_) { /* fall through to Enter-key path */ }
      return null;
    }, sels.passSel).catch(() => null);
    if (!submitSel) {
      console.log(`    ↪️  no submit element matched on ${hostLabel} — falling back to Enter key`);
      try { await page.keyboard.press('Enter'); } catch (_) {}
    } else {
      console.log(`    ↪️  clicked submit (${submitSel}) on ${hostLabel}`);
    }

    // Wait for either navigation or a settled network. Don't throw if
    // neither happens — some SPAs just swap the DOM client-side.
    // Window bumped from 20s → 30s for slow ASP.NET LoginControl
    // postbacks (kommersannons.se Roslagsvatten run on 2026-05-11
    // showed >20s round-trips with no nav event firing).
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 })
      .catch(() => null);
    await new Promise((r) => setTimeout(r, 2500));

    const stillLogin = await page.evaluate(() => {
      try {
        const el = document.querySelector(
          'input[type="password"]:not([disabled]):not([aria-hidden="true"])'
        );
        return !!(el && el.offsetParent !== null);
      } catch (_) { return false; }
    }).catch(() => false);
    if (stillLogin) {
      console.log(`    ❌ login submission did not clear password field on ${hostLabel}`);
      return false;
    }
    console.log(`    ✅ login OK on ${hostLabel} (submit=${submitSel || 'Enter'})`);
    // SSO BOUNCE-BACK — see comment in the already-authenticated branch
    // above. When dedicatedLoginUrl is on a different host than the
    // source (cloudia.net vs tarjouspalvelu.fi), the auth-provider's
    // session cookie won't reach the source host unless the source
    // initiates an SSO check. Navigate to sourceUrl now to fire that
    // chain so the caller's retry sees authenticated content.
    if (dedicatedLoginUrl && sourceUrl) {
      try {
        console.log(`    ↪️  SSO bounce-back: navigating to ${sourceUrl.slice(0, 80)} to propagate session`);
        await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => null);
        try { await page.waitForNetworkIdle({ idleTime: 1000, timeout: 8000 }); } catch (_) {}
        await new Promise((r) => setTimeout(r, 1200));
        // SSO TRIGGER CLICK (mirrors the already-authenticated branch).
        const triggerSel = await page.evaluate(() => {
          const RX_TRIG = /^\s*(log\s*in|login|logga\s*in|kirjaudu(?:\s*sis[äa][äa]n)?|logg\s*inn|prisijungti|connexion|anmelden|iniciar\s*sesi[óo]n)\s*$/i;
          for (const sel of [
            'button#continue:not([disabled])',
            'button[id="continue"]:not([disabled])',
            'button.button--positive:not([disabled])',
          ]) {
            try {
              const el = document.querySelector(sel);
              if (el && el.offsetParent !== null) {
                el.click();
                return sel;
              }
            } catch (_) {}
          }
          const all = Array.from(document.querySelectorAll('button, a, [role="button"]'));
          for (const el of all) {
            if (!el || el.offsetParent === null || el.hasAttribute('disabled')) continue;
            const t = (el.textContent || '').trim();
            if (t.length > 30) continue;
            if (RX_TRIG.test(t)) {
              try { el.click(); return `text:${t.slice(0, 20)}`; } catch (_) {}
            }
          }
          return null;
        }).catch(() => null);
        if (triggerSel) {
          console.log(`    ↪️  SSO trigger clicked (${triggerSel}) — waiting for redirect chain`);
          try { await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 12000 }); } catch (_) {}
          try { await page.waitForNetworkIdle({ idleTime: 1000, timeout: 6000 }); } catch (_) {}
          await new Promise((r) => setTimeout(r, 1500));
        } else {
          console.log(`    ↪️  no SSO trigger found on bounce-back page (already passed-through or auto-redirected)`);
        }
      } catch (_) {}
    }
    return true;
  } catch (e) {
    console.log(`    ❌ login error on ${hostLabel}: ${(e.message || String(e)).slice(0, 200)}`);
    return false;
  } finally {
    try { await page.close(); } catch (_) {}
  }
}

// --- ŠALTINIO PUSLAPIO NUSKAITYMAS -------------------------------------
//
// Atidaro naują tabą, nueina į šaltinio URL, nuskaito kelis laukus pagal
// daugiakalbius raktažodžius (EN/SV/NO/DA/FI/DE/FR/NL/ES/PT/IT) ir grąžina
// objektą. Netrikdo pagrindinio `page` konteksto.
// =====================================================================

// =====================================================================
// resolveMarchesPublicsDeepLink
// ---------------------------------------------------------------------
// Mercell's "Go to source" target for marches-publics.gouv.fr is almost
// always the bare root URL ("https://www.marches-publics.gouv.fr/") or
// the advanced-search index — NOT the actual tender detail page. After
// we successfully login (via attemptPortalLogin), we still can't read
// the tender content because we don't know its real URL.
//
// This helper takes the `fileReferenceNumber` field that Mercell DOES
// give us (e.g. "B26-01823-MP", "A2026-018"), opens the logged-in
// advanced-search page, fills the reference field, submits, and parses
// the result list looking for an anchor whose row text contains the
// reference. Returns that anchor's URL (resolved to absolute) or null
// if any step fails.
//
// The browser context is shared with the post-login session, so the
// cookies set by attemptPortalLogin authenticate this navigation.
// Best-effort + heavy diagnostic logging so we can iterate on selectors
// across portal-platform versions without re-deploying blind.
// =====================================================================
async function resolveMarchesPublicsDeepLink(browser, referenceNumber, hostLabel) {
  if (!referenceNumber || typeof referenceNumber !== 'string') return null;
  const ref = referenceNumber.trim();
  if (ref.length < 3 || ref.length > 60) return null;
  const searchPage = `https://www.marches-publics.gouv.fr/?page=Entreprise.EntrepriseAdvancedSearch&AllCons`;
  let page = null;
  try {
    page = await browser.newPage();
    page.setDefaultNavigationTimeout(15000);
    await page.goto(searchPage, { waitUntil: 'domcontentloaded', timeout: 15000 });
    // Longer wait — marches-publics is ASP.NET, takes 2-3s to render
    // forms even on warm requests
    await new Promise((r) => setTimeout(r, 3000));

    // STEP 0 — landing diagnostic + Recherche avancée fallback.
    //
    // 2026-05-16: when the user is logged in, marches-publics often
    // redirects /?page=Entreprise.EntrepriseAdvancedSearch&AllCons to
    // the /entreprise/ DASHBOARD ("Bienvenue Mon compte Déconnexion ...
    // Mon panier Consultations en cours") instead of rendering the
    // advanced search form. The form has zero visible inputs because
    // it's on a DIFFERENT page reachable via the "Recherche avancée"
    // link in the side menu.
    //
    // Detect that we landed on dashboard (no text inputs visible) and
    // click "Recherche avancée" link to reach the real search form.
    const landing = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type])'));
      const visibleInputs = inputs.filter((i) => i.offsetParent !== null);
      const links = Array.from(document.querySelectorAll('a'));
      const advancedLink = links.find((a) => {
        const t = (a.innerText || a.textContent || '').trim();
        return /^\s*recherche\s+avanc[eé]e\s*$/i.test(t);
      });
      return {
        url: location.href,
        title: document.title,
        visibleInputCount: visibleInputs.length,
        hasAdvancedLink: !!advancedLink,
      };
    }).catch(() => null);
    if (landing) {
      console.log(
        `    🔎 marches-publics landing: url=${(landing.url || '').slice(-80)} ` +
        `title="${(landing.title || '').slice(0, 60)}" ` +
        `visibleInputs=${landing.visibleInputCount} ` +
        `hasAdvancedLink=${landing.hasAdvancedLink}`
      );
    }
    if (landing && landing.visibleInputCount === 0 && landing.hasAdvancedLink) {
      console.log(`    ↪️  no inputs on landing — clicking "Recherche avancée" link to reach search form`);
      const clicked = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a'));
        const advancedLink = links.find((a) => {
          const t = (a.innerText || a.textContent || '').trim();
          return /^\s*recherche\s+avanc[eé]e\s*$/i.test(t);
        });
        if (!advancedLink) return false;
        advancedLink.setAttribute('data-mx-rech-click', '1');
        try { advancedLink.scrollIntoView({ block: 'center' }); } catch (_) {}
        return true;
      }).catch(() => false);
      if (clicked) {
        try {
          await Promise.race([
            page.click('[data-mx-rech-click="1"]'),
            new Promise((_, rej) => setTimeout(() => rej(new Error('click timeout')), 4000)),
          ]);
        } catch (_) {
          // Fallback: DOM-click via evaluate
          await page.evaluate(() => {
            const el = document.querySelector('[data-mx-rech-click="1"]');
            if (el) el.click();
          }).catch(() => null);
        }
        await Promise.race([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => null),
          new Promise((r) => setTimeout(r, 3500)),
        ]);
        await new Promise((r) => setTimeout(r, 1500));
        const afterClick = await page.evaluate(() => {
          const inputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type])'));
          return {
            url: location.href,
            visibleInputCount: inputs.filter((i) => i.offsetParent !== null).length,
          };
        }).catch(() => null);
        if (afterClick) {
          console.log(`    🔎 after Recherche avancée click: url=${(afterClick.url || '').slice(-80)} visibleInputs=${afterClick.visibleInputCount}`);
        }
      }
    }

    // Step 1: find an input that looks like a reference/numéro de
    // consultation field. marches-publics uses ASP.NET-style ids
    // (`ctl0_CONTENU_PAGE_AdvancedSearch_reference`) so we match by
    // id/name/placeholder/label-text substrings.
    const filled = await page.evaluate((refVal) => {
      const inputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type])'));
      const visible = inputs.filter((i) => i.offsetParent !== null);
      // Score each visible input — higher = more likely the reference field.
      const score = (el) => {
        const id = (el.id || '').toLowerCase();
        const name = (el.name || '').toLowerCase();
        const ph = (el.placeholder || '').toLowerCase();
        const aria = (el.getAttribute('aria-label') || '').toLowerCase();
        const blob = `${id} ${name} ${ph} ${aria}`;
        let s = 0;
        if (/\breference\b|\bréférence\b|\bref$|numero(_)?cons|num(_)?cons|numéro\s*de\s*consultation/i.test(blob)) s += 10;
        if (/intitul[eé]|object|libell[eé]/i.test(blob)) s += 1; // weaker — title-by-keyword field
        // Adjacent <label> text gives strong evidence
        try {
          const lbl = (el.labels && el.labels[0]) || document.querySelector(`label[for="${el.id}"]`);
          if (lbl) {
            const lt = (lbl.innerText || '').toLowerCase();
            if (/référence|reference|numéro\s*de\s*consultation|consultation/.test(lt)) s += 8;
          }
        } catch (_) {}
        return s;
      };
      const scored = visible.map((el) => ({ el, s: score(el) })).filter((x) => x.s > 0);
      if (scored.length === 0) {
        // Fallback: return diagnostic listing so we can refine selectors.
        const sample = visible.slice(0, 8).map((el) => ({
          id: el.id || '',
          name: el.name || '',
          placeholder: el.placeholder || '',
        }));
        return { ok: false, sample };
      }
      scored.sort((a, b) => b.s - a.s);
      const target = scored[0].el;
      try {
        target.focus();
        target.value = refVal;
        target.dispatchEvent(new Event('input', { bubbles: true }));
        target.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, used: target.id || target.name || target.placeholder, score: scored[0].s };
      } catch (e) {
        return { ok: false, error: String(e && e.message || e) };
      }
    }, ref).catch((e) => ({ ok: false, error: String(e && e.message || e) }));
    if (!filled || !filled.ok) {
      const sampleStr = filled && filled.sample
        ? ` (visible inputs: ${JSON.stringify(filled.sample.slice(0, 6))})`
        : '';
      console.log(`    ⚠️  marches-publics search: no reference field matched${sampleStr}`);
      return null;
    }
    console.log(`    ↪️  marches-publics search: filled "${filled.used}" (score=${filled.score}) with reference "${ref}"`);
    // Step 2: submit the form. Prefer the actual reference field's
    // parent form's submit button to avoid hitting the global header
    // search bar.
    const submitted = await page.evaluate((refVal) => {
      const inputs = Array.from(document.querySelectorAll('input'));
      const refInput = inputs.find((i) => i.value === refVal && i.offsetParent !== null);
      const form = refInput ? refInput.closest('form') : null;
      const candidates = form
        ? Array.from(form.querySelectorAll('input[type="submit"], button[type="submit"], button:not([type])'))
        : Array.from(document.querySelectorAll('input[type="submit"], button[type="submit"]'));
      const visible = candidates.filter((b) => b.offsetParent !== null);
      // Prefer button with "rechercher" / "search" text
      const byText = visible.find((b) => {
        const t = (b.innerText || b.value || '').trim().toLowerCase();
        return /rechercher|search|valider|lancer\s*la\s*recherche/.test(t);
      });
      const target = byText || visible[0];
      if (!target) return null;
      try { target.click(); return (target.innerText || target.value || target.id || 'submit').toString().slice(0, 30); }
      catch (_) { return null; }
    }, ref).catch(() => null);
    if (!submitted) {
      console.log(`    ⚠️  marches-publics search: no submit button found`);
      return null;
    }
    console.log(`    ↪️  marches-publics search: submitted ("${submitted}")`);
    // Step 3: wait for navigation OR network idle (the page may post
    // and re-render in-place without changing URL).
    await Promise.race([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => null),
      new Promise((r) => setTimeout(r, 4000)),
    ]);
    await new Promise((r) => setTimeout(r, 1500));
    // Step 4: find a link in the results matching the reference.
    const tenderUrl = await page.evaluate((refVal) => {
      const refLow = refVal.toLowerCase();
      // Most marches-publics result rows are <tr> with the reference in
      // one cell and a link in another. Look for any <tr> containing the
      // reference text, then return the first <a href> inside.
      const rows = Array.from(document.querySelectorAll('tr, .ligne, .consultation, .resultat'));
      for (const row of rows) {
        const text = (row.innerText || '').toLowerCase();
        if (text.includes(refLow)) {
          const link = row.querySelector('a[href]:not([href*="mailto"])');
          if (link && link.href) return link.href;
        }
      }
      // Fallback 1: anchor whose own text includes the reference
      const allLinks = Array.from(document.querySelectorAll('a[href]'));
      const byTextLink = allLinks.find((a) => {
        const t = (a.innerText || '').toLowerCase();
        return t.includes(refLow);
      });
      if (byTextLink && byTextLink.href) return byTextLink.href;
      // Fallback 2: anchor whose href includes the reference (some
      // portals encode the reference into the URL).
      const byHrefLink = allLinks.find((a) => {
        const h = (a.href || '').toLowerCase();
        return h.includes(refLow);
      });
      return byHrefLink ? byHrefLink.href : null;
    }, ref).catch(() => null);
    if (!tenderUrl) {
      console.log(`    ⚠️  marches-publics search: no result link matched reference "${ref}"`);
      return null;
    }
    console.log(`    ✅ marches-publics search → tender URL: ${tenderUrl.slice(0, 100)}`);
    return tenderUrl;
  } catch (e) {
    console.log(`    ⚠️  marches-publics search error: ${(e.message || String(e)).slice(0, 120)}`);
    return null;
  } finally {
    try { if (page) await page.close(); } catch (_) {}
  }
}

// =====================================================================
// fetchEuSupplyDocuments
// ---------------------------------------------------------------------
// eu.eu-supply.com (CTM platform — Norwegian Doffin tenders, EU-Supply
// hosted) shows tender info on `rwlentrance_s.asp` but hides the actual
// procurement documents behind a separate `publicpurchase_docs.asp`
// page. The documents themselves are downloaded via a JavaScript call:
//   <a onclick="DownloadPublicDocument('11603409','sDoc_11603409','322375');">
// There's no static href — the JS function builds a download URL at
// runtime. We reverse-engineer this by trying multiple URL patterns
// observed across CTM deployments and saving the first response that
// returns a real PDF (matches %PDF- magic bytes).
//
// Public-purchase pages don't require login, so a fresh browser context
// page works fine — we use a side page to avoid disturbing the entrance
// page's body-text capture in the main extractor.
// Real-world: this unlocks the "DYNAMISK INNKJØPSORDNING ...
// KVALIFIKASJONSKRAV" content for Norwegian DPS tenders that were
// previously empty in the spreadsheet.
// =====================================================================
async function fetchEuSupplyDocuments(browser, sourceUrl) {
  // Detect eu-supply public-purchase URL.
  let pid = null;
  let entranceHost = null;
  try {
    const u = new URL(sourceUrl);
    if (!/(^|\.)eu-supply\.com$/i.test(u.hostname)) return [];
    if (!/rwlentrance_s\.asp|PublicPurchase/i.test(u.pathname + u.search)) return [];
    pid = u.searchParams.get('PID');
    if (!pid || !/^\d+$/.test(pid)) return [];
    entranceHost = u.hostname;
  } catch (_) { return []; }

  let page = null;
  try {
    page = await browser.newPage();
    page.setDefaultNavigationTimeout(20000);
    page.setDefaultTimeout(20000);

    // Step 1 — load the entrance page and look for any href that points
    // to publicpurchase_docs.asp, extract LID (list/lot ID).
    try {
      await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    } catch (e) {
      console.log(`    🇳🇴 eu-supply: entrance nav warn: ${(e.message || '').slice(0, 80)}`);
    }
    await new Promise((r) => setTimeout(r, 1500));
    const lid = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href]'));
      for (const a of links) {
        const href = a.getAttribute('href') || '';
        const m = href.match(/[?&]LID=(\d+)/i);
        if (m) return m[1];
      }
      // Fallback — scan whole HTML for LID=xxx
      const html = document.documentElement.outerHTML;
      const m2 = html.match(/LID=(\d+)/i);
      return m2 ? m2[1] : null;
    }).catch(() => null);
    if (!lid) {
      console.log(`    🇳🇴 eu-supply: PID=${pid} but no LID found on entrance page`);
      return [];
    }
    console.log(`    🇳🇴 eu-supply: PID=${pid}, LID=${lid} — navigating to docs page`);

    // Step 2 — navigate to the documents page.
    const docsUrl = `https://${entranceHost}/app/rfq/publicpurchase_docs.asp?PID=${pid}&LID=${lid}&AllowPrint=1`;
    try {
      await page.goto(docsUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    } catch (e) {
      console.log(`    🇳🇴 eu-supply: docs page nav warn: ${(e.message || '').slice(0, 80)}`);
    }
    await new Promise((r) => setTimeout(r, 1500));

    // Step 3 — parse DownloadPublicDocument JS calls + document names.
    const found = await page.evaluate(() => {
      const RX = /DownloadPublicDocument\(\s*['"]?(\d+)['"]?\s*,\s*['"]?([^'"]+)['"]?\s*,\s*['"]?(\d+)['"]?\s*\)/g;
      const html = document.documentElement.outerHTML;
      const seen = new Map();
      // Walk DOM rows first — gives us doc NAMES alongside doc IDs.
      const rows = document.querySelectorAll('tr, .doc-row, [data-doc-id], li');
      for (const row of rows) {
        const links = row.querySelectorAll('a[href], [onclick]');
        for (const link of links) {
          const handler = (link.getAttribute('onclick') || link.getAttribute('href') || '');
          const m = handler.match(/DownloadPublicDocument\(\s*['"]?(\d+)['"]?\s*,\s*['"]?([^'"]+)['"]?\s*,\s*['"]?(\d+)['"]?\s*\)/);
          if (!m) continue;
          const docId = m[1];
          if (seen.has(docId)) continue;
          const name = (link.innerText || link.textContent || row.innerText || '')
            .trim().replace(/\s+/g, ' ').slice(0, 200);
          seen.set(docId, { docId, elemId: m[2], lid: m[3], name });
        }
      }
      // Fallback — pull from raw HTML if we missed any in DOM walk.
      let m;
      while ((m = RX.exec(html)) !== null) {
        if (!seen.has(m[1])) {
          seen.set(m[1], { docId: m[1], elemId: m[2], lid: m[3], name: '' });
        }
      }
      return Array.from(seen.values());
    }).catch(() => []);

    if (!found.length) {
      console.log(`    🇳🇴 eu-supply: no DownloadPublicDocument calls found on docs page`);
      return [];
    }
    console.log(`    🇳🇴 eu-supply: ${found.length} document(s) detected on docs page`);

    // Step 4 — build the real download URL using the JS function's own
    // formula. The JS source (revealed by diagnostic in earlier run) is:
    //   var strURL = strDownloadPublicDocumentURL
    //              + '?FMT=5&AT=' + strArchiveType
    //              + '&LID=' + strLotID
    //              + '&DVID=' + strFileID;
    // Two key facts the earlier guess-and-fetch approach missed:
    //   • The query param is `DVID` (not `DID`) — server rejected our
    //     `DID=...` requests and returned a generic HTML error page.
    //   • The base path comes from the global `strDownloadPublicDocumentURL`
    //     which we now read at runtime. Across CTM deployments it tends
    //     to be `/app/rfq/downloadpublicdocument.asp` but we don't have
    //     to hard-code it.
    // Response interception (the previous attempt) failed because the
    // function falls through to `window.open(strURL)` when ActiveX
    // FileMgr isn't loaded — that opens a popup whose responses aren't
    // visible on this page's response stream.
    let pdfParseLib = null;
    try { pdfParseLib = require('pdf-parse'); } catch (_) {}
    const texts = [];
    const MAX_DOCS = 6;

    // Read the JS globals the page's DownloadPublicDocument uses.
    const ctmGlobals = await page.evaluate(() => {
      // Helpers — these vars are defined as plain `var` in the page,
      // so they live on `window`. Provide safe defaults.
      const out = {
        basePath: null,
        archiveType: '',
        fmt: '5',
        rawFnSnippet: null,
      };
      try {
        if (typeof strDownloadPublicDocumentURL === 'string' && strDownloadPublicDocumentURL.length) {
          out.basePath = strDownloadPublicDocumentURL;
        } else if (typeof window.strDownloadPublicDocumentURL === 'string') {
          out.basePath = window.strDownloadPublicDocumentURL;
        }
      } catch (_) {}
      try {
        if (typeof strArchiveType !== 'undefined' && strArchiveType !== null) {
          out.archiveType = String(strArchiveType);
        } else if (typeof window.strArchiveType !== 'undefined') {
          out.archiveType = String(window.strArchiveType);
        }
      } catch (_) {}
      try {
        if (typeof DownloadPublicDocument === 'function') {
          out.rawFnSnippet = DownloadPublicDocument.toString().slice(0, 400);
        }
      } catch (_) {}
      return out;
    }).catch(() => ({ basePath: null, archiveType: '', fmt: '5', rawFnSnippet: null }));

    if (ctmGlobals.rawFnSnippet) {
      console.log(`    🇳🇴 eu-supply: DownloadPublicDocument source: ${ctmGlobals.rawFnSnippet.replace(/\s+/g, ' ').slice(0, 260)}`);
    }
    if (!ctmGlobals.basePath) {
      console.log(`    ⚠️  eu-supply: strDownloadPublicDocumentURL global not found — cannot build download URL`);
      return [];
    }
    // Resolve to absolute URL — basePath may be relative ("/app/rfq/...")
    // or absolute. Use the docs page as base for relative resolution.
    let downloadEndpoint = ctmGlobals.basePath;
    try {
      const u = new URL(downloadEndpoint, page.url());
      downloadEndpoint = u.toString();
    } catch (_) {}
    console.log(`    🇳🇴 eu-supply: download endpoint resolved to ${downloadEndpoint.slice(0, 100)} (AT="${ctmGlobals.archiveType}")`);

    for (const doc of found.slice(0, MAX_DOCS)) {
      const eLid = doc.lid || lid;
      const labelName = (doc.name || `Document ${doc.docId}`).slice(0, 80);
      // Build the URL exactly like the JS function does.
      const downloadUrl = `${downloadEndpoint}?FMT=${encodeURIComponent(ctmGlobals.fmt)}&AT=${encodeURIComponent(ctmGlobals.archiveType)}&LID=${encodeURIComponent(eLid)}&DVID=${encodeURIComponent(doc.docId)}`;
      // Fetch with browser cookies + follow redirects. CTM sometimes
      // returns a 302 to a presigned S3-like URL; the browser handles
      // that for us.
      const result = await page.evaluate(async (u) => {
        try {
          const r = await fetch(u, { credentials: 'include', redirect: 'follow' });
          const ct = r.headers.get('content-type') || '';
          const cd = r.headers.get('content-disposition') || '';
          if (!r.ok) return { ok: false, status: r.status, ct, cd };
          const buf = await r.arrayBuffer();
          return {
            ok: true,
            status: r.status,
            ct,
            cd,
            url: r.url,
            data: Array.from(new Uint8Array(buf)),
          };
        } catch (e) { return { ok: false, error: String(e) }; }
      }, downloadUrl).catch(() => null);
      let bytes = null;
      let capturedUrl = null;
      if (result && result.ok && result.data && result.data.length > 1000) {
        const buf = Buffer.from(result.data);
        // Accept PDF magic OR generic octet-stream/attachment.
        const isPdf = buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46;
        const ctL = (result.ct || '').toLowerCase();
        const cdL = (result.cd || '').toLowerCase();
        const looksBinary = isPdf
          || ctL.includes('application/pdf')
          || ctL.includes('octet-stream')
          || cdL.includes('attachment');
        if (looksBinary) {
          bytes = buf;
          capturedUrl = result.url || downloadUrl;
        }
      }

      if (!bytes) {
        const status = result?.status || '?';
        const ct = (result?.ct || '').slice(0, 40);
        console.log(`    ⚠️  eu-supply: download failed for "${labelName}" (id=${doc.docId}, status=${status}, ct=${ct})`);
        continue;
      }
      if (!pdfParseLib) {
        console.log(`    ⚠️  eu-supply: pdf-parse unavailable, can't extract "${labelName}"`);
        continue;
      }
      try {
        const parsed = await pdfParseLib(bytes);
        const text = ((parsed && parsed.text) || '').trim();
        if (text.length > 100) {
          const clipped = text.slice(0, 80000);
          texts.push(`--- (eu-supply) ${labelName} ---\n${clipped}`);
          console.log(`    🇳🇴 eu-supply: parsed PDF "${labelName}" (${bytes.length}B → ${clipped.length}ch from ${(capturedUrl || '').slice(0, 80)})`);
        } else {
          console.log(`    ⚠️  eu-supply: PDF "${labelName}" extracted text too short (${text.length}ch)`);
        }
      } catch (e) {
        console.log(`    ⚠️  eu-supply: PDF parse failed for "${labelName}": ${(e.message || '').slice(0, 80)}`);
      }
    }
    return texts;
  } catch (e) {
    console.log(`    ⚠️  eu-supply handler error: ${(e.message || String(e)).slice(0, 140)}`);
    return [];
  } finally {
    try { if (page) await page.close(); } catch (_) {}
  }
}

// =====================================================================
// fetchTenderNedDocuments
// ---------------------------------------------------------------------
// Mercell tenders sourced from tenderned.nl (~all NL public tenders)
// expose attachments via Mercell's `files[]` JSON, but the URLs all
// point to old-dc-import-notices-prod.s3.eu... — the S3 bucket returns
// 403 for our session. TenderNed itself hosts the SAME documents on
// its own domain with public download. We open the announcement page,
// scrape in-page anchors that point to tenderned.nl document download
// endpoints, fetch each PDF/DOCX directly, and parse text. Returns a
// list of text snippets (one per parsed doc) that the caller merges
// into result.sourceFilesText.
//
// Priority terms (Dutch / EU procurement):
//   Selectieleidraad      — selection guide (top-priority qualifications)
//   Selectiecriterium     — selection criterion (most direct match)
//   Programma van Eisen   — requirements programme (technical reqs)
//   UEA / ESPD            — Uniform European Procurement Document
//   Aanbestedingsleidraad — procurement guide (often contains both reqs and quals)
// =====================================================================
async function fetchTenderNedDocuments(browser, sourceUrl) {
  let noticeId = null;
  try {
    const u = new URL(sourceUrl);
    if (!/(^|\.)tenderned\.nl$/i.test(u.hostname)) return [];
    const m = u.pathname.match(/\/aankondigingen\/overzicht\/(\d+)/i);
    if (!m) return [];
    noticeId = m[1];
  } catch (_) { return []; }

  // Optional libs — same lazy-load pattern as fetchEuSupplyDocuments.
  let pdfParseLib = null;
  let mammothLib = null;
  let admZipLib = null;
  try { pdfParseLib = require('pdf-parse'); } catch (_) {}
  try { mammothLib  = require('mammoth');   } catch (_) {}
  try { admZipLib   = require('adm-zip');   } catch (_) {}

  let page = null;
  try {
    page = await browser.newPage();
    page.setDefaultNavigationTimeout(30000);
    page.setDefaultTimeout(30000);
    // v6 fix: bigger viewport. Puppeteer default (800×600) was too
    // small — Documenten tab rendered but scrollIntoView+mouse.click
    // at (x,y) coordinates landed outside the actual hit area. With
    // a desktop-sized viewport the tab bar fits in the visible
    // window and selector-based page.click handles scroll itself.
    try { await page.setViewport({ width: 1280, height: 900 }); } catch (_) {}

    // Anti-headless stealth. TenderNed Angular bundle (confirmed via
    // user incognito test 2026-05-12: 4 tabs visible WITHOUT login)
    // appears to gate render on absence of webdriver flag — our
    // previous handlers found 0 tab elements and 0 h4 filenames in
    // DOM. Spoofing the standard headless-detection vectors before
    // the page loads its scripts is the cleanest fix.
    try {
      await page.evaluateOnNewDocument(() => {
        // navigator.webdriver — primary headless tell
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        // navigator.plugins — real browsers have ≥1
        Object.defineProperty(navigator, 'plugins', {
          get: () => [1, 2, 3, 4, 5],
        });
        // navigator.languages — real browsers have a populated list
        Object.defineProperty(navigator, 'languages', {
          get: () => ['nl-NL', 'nl', 'en-US', 'en'],
        });
        // window.chrome — real Chrome has it, headless usually does too
        // but some bundles check explicit shape.
        // eslint-disable-next-line no-undef
        if (!window.chrome) window.chrome = { runtime: {} };
      });
    } catch (_) {}
    // Use a realistic Chrome user-agent (Puppeteer's default ends in
    // "HeadlessChrome/..." which some bot detectors regex against).
    try {
      const ua = await page.browser().userAgent();
      const realUa = ua.replace(/HeadlessChrome/i, 'Chrome');
      await page.setUserAgent(realUa);
    } catch (_) {}

    // v10 API interception. The Download-all button click goes nowhere
    // (Material wrapper without a working handler from our perspective),
    // BUT when the Documenten tab activates, Angular's HttpClient fires
    // a REST call to /papi/tenderned-rs-tns/v2/... that returns the
    // documenten list as JSON. Capture those responses so we can extract
    // per-file URLs / IDs without touching the click handler.
    const capturedJsonResponses = [];
    const papiResponseHandler = async (resp) => {
      try {
        const url = resp.url();
        if (!/tenderned\.nl/i.test(url)) return;
        // Match likely documenten/aanbesteding endpoints.
        if (!/\/(?:papi|api)\b.*\/(?:aanbestedingen?|aankondiging|documenten?|documents?|files|stuk|attachments?)\b/i.test(url)) return;
        const ct = (resp.headers()['content-type'] || '').toLowerCase();
        if (!ct.includes('json') && !ct.includes('javascript')) return;
        if (resp.status() >= 400) return;
        const body = await resp.text().catch(() => null);
        if (!body || body.length < 50) return;
        capturedJsonResponses.push({ url, ct, body: body.slice(0, 200000) });
      } catch (_) {}
    };
    page.on('response', papiResponseHandler);

    try {
      await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e) {
      console.log(`    🇳🇱 tenderned: nav warn: ${(e.message || '').slice(0, 80)}`);
    }
    // TenderNed is an Angular SPA — Documenten tab content needs
    // Angular Material hydration + initial REST fetch to populate.
    // 6s timeout was too tight; bump to 12s networkidle + 2.5s extra
    // settle for slow CI runners.
    try { await page.waitForNetworkIdle({ idleTime: 1000, timeout: 12000 }); }
    catch (_) { /* timeout ok */ }
    await new Promise((r) => setTimeout(r, 2500));

    // Diagnostic: count tabs and report aria-selected state so we can
    // verify Angular Material rendered before our click attempt.
    try {
      const tabDiag = await page.evaluate(() => {
        const tabs = Array.from(document.querySelectorAll('[role="tab"], .mat-mdc-tab, .mdc-tab'));
        return {
          count: tabs.length,
          tabs: tabs.slice(0, 8).map((t) => ({
            text: ((t.textContent || '') + '').trim().slice(0, 40),
            selected: t.getAttribute('aria-selected') === 'true',
            tag: t.tagName,
            id: t.id || '',
          })),
        };
      }).catch(() => ({ count: 0, tabs: [] }));
      console.log(
        `    🇳🇱 tenderned: pre-click tab diag — ` +
        `${tabDiag.count} tab(s) found. ${tabDiag.tabs.map(t => `[${t.text}${t.selected ? '*' : ''}]`).join(' ')}`
      );
    } catch (_) {}

    // TenderNed uses Angular Material mat-tab — Documents is a tab in
    // the same URL. Click activation in headless Chromium needs a
    // real OS-level mouse event (page.mouse.click), not just
    // element.dispatchEvent — Angular Material's gesture detector
    // requires CDP-level pointer events to fire all ripple/state
    // handlers correctly. We find the tab in evaluate, scroll into
    // view, return its centre rect, then click via page.mouse.
    // 2026-05-12 fix: v4 dispatchEvent caused "Documenten tab not
    // found" even when diag showed it; root cause was textContent +
    // innerText concatenation breaking the anchored regex.
    let tabClicked = false;
    let tabRect = null;
    try {
      tabRect = await page.evaluate(() => {
        const RX_TAB = /^\s*(documenten|bijlagen|bestanden|documents|attachments)\s*$/i;
        const cands = Array.from(document.querySelectorAll(
          '[role="tab"], .mat-mdc-tab, .mdc-tab, button, a, [role="button"], summary'
        ));
        // CSS.escape polyfill for older bundles — needed for ids with
        // colons like "mat-tab-group-0:label-2" (rare, but harmless).
        const esc = (s) => (window.CSS && CSS.escape) ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
        for (const el of cands) {
          // Use textContent ONLY — innerText concatenation duplicated
          // the label ("Documenten Documenten") and broke the anchored
          // regex. textContent reliably returns "Documenten" for the
          // mat-tab DOM structure (nested mdc-tab__text-label span).
          const t = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
          if (RX_TAB.test(t)) {
            try {
              el.scrollIntoView({ block: 'center' });
              const rect = el.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                // Build a stable selector — Puppeteer's page.click()
                // auto-scrolls and clicks reliably (better than raw
                // mouse.click(x,y) which misses tabs that aren't yet
                // in viewport). Prefer id; fall back to a sibling-
                // independent attribute selector.
                let selector = null;
                if (el.id) selector = '#' + esc(el.id);
                else if (el.getAttribute('data-test-id')) selector = `[data-test-id="${el.getAttribute('data-test-id')}"]`;
                return {
                  x: rect.left + rect.width / 2,
                  y: rect.top + rect.height / 2,
                  text: t,
                  selector,
                  id: el.id || null,
                };
              }
            } catch (_) {}
          }
        }
        return null;
      }).catch(() => null);
    } catch (_) {}

    if (tabRect) {
      console.log(`    🇳🇱 tenderned: tab match — text="${tabRect.text}", id="${tabRect.id || '(none)'}", coords=(${Math.round(tabRect.x)},${Math.round(tabRect.y)})`);
      // v7 fix: Angular Material 14+ MDC tabs don't reliably activate
      // from Puppeteer's CDP-level synthetic mouse events (v6 ran
      // page.click without error but post-click tab stayed "Details").
      // Strategy: fire page.click() for native pointer-event coverage
      // AND el.click() in evaluate (DOM-level fallback). Material's
      // click handler is attached to role="tab"; el.click() directly
      // invokes it bypassing all pointer-event chain. Idempotent.
      if (tabRect.selector) {
        try {
          await page.click(tabRect.selector, { delay: 50 });
          tabClicked = true;
        } catch (e) {
          console.log(`    🇳🇱 tenderned: page.click(${tabRect.selector}) failed: ${(e.message || '').slice(0, 80)} — falling back to mouse.click`);
        }
        // ALSO call el.click() in DOM context — this is the only thing
        // that reliably fires Material's tab-activation handler.
        try {
          await page.evaluate((sel) => {
            const el = document.querySelector(sel);
            if (el) {
              try { el.focus(); } catch (_) {}
              el.click();
            }
          }, tabRect.selector);
        } catch (_) {}
      }
      if (!tabClicked) {
        try {
          // CDP-level mouse click fallback for Angular Material
          // gesture handlers. Hover first so the tab gets :hover state.
          await page.mouse.move(tabRect.x, tabRect.y);
          await new Promise((r) => setTimeout(r, 150));
          await page.mouse.click(tabRect.x, tabRect.y, { delay: 50 });
          tabClicked = true;
        } catch (e) {
          console.log(`    🇳🇱 tenderned: mouse.click failed: ${(e.message || '').slice(0, 80)}`);
        }
      }
    }
    if (tabClicked) {
      console.log(`    🇳🇱 tenderned: clicked Documenten tab — waiting for content`);
      // Tab activation triggers XHR (api/documenten/...) — wait for it
      // to settle, then a bit more for Angular to render the list.
      try { await page.waitForNetworkIdle({ idleTime: 1000, timeout: 10000 }); }
      catch (_) {}
      await new Promise((r) => setTimeout(r, 2500));
      // Post-click verify: did the active tab actually change?
      try {
        const post = await page.evaluate(() => {
          const tabs = Array.from(document.querySelectorAll('[role="tab"], .mat-mdc-tab, .mdc-tab'));
          const active = tabs.find((t) => t.getAttribute('aria-selected') === 'true');
          return {
            activeText: active ? ((active.textContent || '').trim().slice(0, 40)) : null,
            h4Count: document.querySelectorAll('h4').length,
          };
        }).catch(() => ({}));
        console.log(`    🇳🇱 tenderned: post-click — active tab: "${post.activeText || 'none'}", h4 count: ${post.h4Count}`);
      } catch (_) {}
    } else {
      console.log(`    🇳🇱 tenderned: ⚠️ Documenten tab not found (will scan current DOM as-is)`);
    }

    // TenderNed's Documenten panel renders filenames as plain <h4>
    // elements (Angular click handler downloads via XHR — no <a href>).
    // First pass: scan h4 text for diagnostic (lets us verify the tab
    // click actually revealed content). Second pass: try the "Download
    // alle documenten" / "Download all documents" button, which
    // returns a ZIP containing every document. We intercept the
    // network response and parse the ZIP — much simpler than fetching
    // each doc individually and avoids needing to reverse-engineer
    // per-doc URL patterns. User-confirmed DOM 2026-05-12.
    const filenamesProbe = await page.evaluate(() => {
      const RX_FILE = /\.(pdf|docx?|xlsx?|zip|rtf|odt|ods)\b/i;
      const h4s = Array.from(document.querySelectorAll('h4'));
      const names = [];
      for (const h of h4s) {
        const t = (h.textContent || '').trim();
        if (t && RX_FILE.test(t) && t.length <= 250) names.push(t);
        if (names.length >= 50) break;
      }
      return { filenames: names, totalH4: h4s.length };
    }).catch(() => ({ filenames: [], totalH4: 0 }));
    console.log(
      `    🇳🇱 tenderned: notice ${noticeId} — ` +
      `${filenamesProbe.filenames.length}/${filenamesProbe.totalH4} h4 filename(s) detected on tab. ` +
      `Top: ${filenamesProbe.filenames.slice(0, 4).map(n => n.slice(0, 60)).join(' | ')}`
    );

    // Try the "Download alle documenten" / "Download all documents"
    // button. Set up a response interceptor BEFORE the click so we
    // catch the ZIP whatever URL it comes from. The button text comes
    // verbatim from the user's DOM: <span class="text-nowrap">
    // Download alle documenten </span>.
    const texts = [];

    // v11 — direct bulk ZIP fetch via the actual TenderNed REST URL.
    // User-confirmed 2026-05-14 (chrome://downloads/ source URL):
    //   https://www.tenderned.nl/papi/tenderned-rs-tns/v2/publicaties/
    //       {noticeId}/documenten/zip                            ← bulk
    //   https://www.tenderned.nl/papi/tenderned-rs-tns/v2/publicaties/
    //       {noticeId}/documenten/{docId}/content                ← per-file
    // Files are publicly accessible — no auth required. This bypasses
    // ALL click-based logic (the Download-all click never fires any
    // network request from headless Chromium, see v8/v9 failures).
    if (admZipLib) {
      const bulkUrl = `https://www.tenderned.nl/papi/tenderned-rs-tns/v2/publicaties/${noticeId}/documenten/zip`;
      console.log(`    🇳🇱 tenderned: v11 direct bulk-ZIP fetch → ${bulkUrl.slice(-70)}`);
      try {
        // v12 retry — "TypeError: Failed to fetch" hits ~25% of large
        // (5-13MB) responses, likely Chromium race condition between
        // fetch + CORS preflight + connection reuse. Three attempts
        // with 1.5s back-off resolves nearly all transients.
        let r = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
          r = await page.evaluate(async (url) => {
            try {
              const resp = await fetch(url, { credentials: 'include', redirect: 'follow' });
              if (!resp.ok) return { ok: false, status: resp.status };
              const ct = resp.headers.get('content-type') || '';
              const ab = await resp.arrayBuffer();
              return { ok: true, status: resp.status, ct, url: resp.url || url, data: Array.from(new Uint8Array(ab)) };
            } catch (e) { return { ok: false, error: String(e).slice(0, 200) }; }
          }, bulkUrl).catch(() => null);
          if (r && r.ok && r.data && r.data.length > 1024) break; // success
          // Only retry on transient errors — not on HTTP error codes.
          const isTransient = r && !r.ok && r.error && /failed\s*to\s*fetch|network\s*error|err_|aborted/i.test(r.error);
          if (!isTransient || attempt === 3) break;
          console.log(`    🇳🇱 tenderned: v11 attempt ${attempt} transient (${r.error.slice(0, 60)}) — retrying after 1.5s`);
          await new Promise((rs) => setTimeout(rs, 1500));
        }
        if (r && r.ok && r.data && r.data.length > 1024) {
          const buf = Buffer.from(r.data);
          if (buf[0] === 0x50 && buf[1] === 0x4b) {
            console.log(`    🇳🇱 tenderned: v11 bulk ZIP OK (${buf.length}B, ct=${r.ct})`);
            try {
              const zip = new admZipLib(buf);
              const entries = zip.getEntries();
              const SCORE_RULES = [
                { rx: /selectie\s*leidraad|selectiecriteri|selectie[-\s]?eisen|selection\s*criteria/i, score: 25 },
                { rx: /aanbestedings?\s*leidraad|procurement\s*guide|request\s*for\s*quotation/i, score: 18 },
                { rx: /programma\s*van\s*eisen|statement\s*of\s*requirements/i, score: 12 },
                { rx: /uea|espd|uniform\s*europees|uniform\s*european\s*procurement/i, score: 8 },
                { rx: /aankondiging|contract\s*notice|EF\d+/i, score: 5 },
              ];
              const scoreOf = (n) => {
                let s = 0;
                for (const r of SCORE_RULES) if (r.rx.test(n)) s = Math.max(s, r.score);
                return s;
              };
              const docEntries = entries
                .filter((e) => !e.isDirectory && /\.(pdf|docx?)$/i.test(e.entryName))
                .map((e) => ({ entry: e, score: scoreOf(e.entryName) }))
                .sort((a, b) => b.score - a.score)
                .slice(0, 6);
              console.log(`    🇳🇱 tenderned: ZIP has ${entries.length} entries, parsing top ${docEntries.length}`);
              for (const item of docEntries) {
                const entry = item.entry;
                const name = entry.entryName.slice(-100);
                try {
                  const data = entry.getData();
                  let text = '';
                  const isPdf = data[0] === 0x25 && data[1] === 0x50 && data[2] === 0x44 && data[3] === 0x46;
                  const isDocx = /\.docx$/i.test(name);
                  if (isPdf && pdfParseLib) {
                    const parsed = await pdfParseLib(data);
                    text = ((parsed && parsed.text) || '').trim();
                  } else if (isDocx && mammothLib) {
                    const out = await mammothLib.extractRawText({ buffer: data });
                    text = ((out && out.value) || '').trim();
                  }
                  if (text.length > 200) {
                    const clipped = text.slice(0, 80000);
                    texts.push(`--- (tenderned) ${name} ---\n${clipped}`);
                    console.log(`    🇳🇱 tenderned: parsed "${name}" (${data.length}B → ${clipped.length}ch, score=${item.score})`);
                  }
                } catch (e) {
                  console.log(`    ⚠️  tenderned: parse failed "${name}": ${(e.message || '').slice(0, 80)}`);
                }
              }
            } catch (e) {
              console.log(`    ⚠️  tenderned: ZIP parse error: ${(e.message || '').slice(0, 100)}`);
            }
            // If we got any text, return early — skip all click logic.
            if (texts.length > 0) {
              try { page.off('response', papiResponseHandler); } catch (_) {}
              return texts;
            }
          } else {
            console.log(`    ⚠️  tenderned: v11 bulk ZIP wrong magic (got ${buf.slice(0, 4).toString('hex')}, ct=${r.ct})`);
          }
        } else {
          console.log(`    ⚠️  tenderned: v11 bulk ZIP fetch failed (status=${r?.status || r?.error || '?'})`);
        }
      } catch (e) {
        console.log(`    ⚠️  tenderned: v11 bulk fetch error: ${(e.message || '').slice(0, 100)}`);
      }
    }

    if (admZipLib && filenamesProbe.filenames.length > 0) {
      // v8 fix: Download-all-ZIP can return Content-Disposition:attachment
      // which Chromium routes to the download manager (response stream
      // closes, buffer unavailable). Listen for the REQUEST URL too —
      // we re-fetch via page.evaluate using the session's auth cookies,
      // which bypasses Chromium's download-decision logic.
      let capturedReqUrl = null;
      const reqHandler = (req) => {
        if (capturedReqUrl) return;
        try {
          const url = req.url();
          if (!/(^https?:\/\/)?[^/]*tenderned\.nl/i.test(url)) return;
          // Match likely Download-all endpoints. TenderNed serves the
          // ZIP via a `documenten` or `zip` path segment — both noted in
          // user inspection 2026-05-12.
          if (!/\b(?:zip|documenten\/all|download(?:all)?\/?|alle)\b/i.test(url)) return;
          // Skip static assets, CSS/JS chunks.
          if (/\.(?:js|css|png|svg|woff2?|ico|map)\b/i.test(url)) return;
          const rt = req.resourceType();
          // 'fetch', 'xhr', 'document' (nav-triggered downloads) all OK
          if (rt === 'image' || rt === 'stylesheet' || rt === 'script' || rt === 'font') return;
          capturedReqUrl = url;
        } catch (_) {}
      };
      page.on('request', reqHandler);

      // v9 fix: Puppeteer's default behaviour BLOCKS downloads silently.
      // v8 logs showed "no request URL captured either" — the click on
      // Download-all triggered a download attempt but Chromium aborted
      // it without emitting any request the response listener could see
      // (because the navigation target was a Content-Disposition asset
      // and download manager was disabled). Enable CDP-level allow +
      // tmp directory so the file is actually written to disk; we then
      // poll the directory for a new .zip and read it back.
      let downloadDir = null;
      let cdpSession = null;
      try {
        const os = require('os');
        const fs = require('fs');
        const path = require('path');
        downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenderned-dl-'));
        cdpSession = await page.target().createCDPSession();
        await cdpSession.send('Browser.setDownloadBehavior', {
          behavior: 'allow',
          downloadPath: downloadDir,
        }).catch(() => null);
        // Page-level fallback for older Chromium where Browser.* is gated.
        await cdpSession.send('Page.setDownloadBehavior', {
          behavior: 'allow',
          downloadPath: downloadDir,
        }).catch(() => null);
      } catch (_) { /* CDP setup best-effort; we still try the request path */ }

      const zipResponsePromise = new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), 20000);
        const handler = async (resp) => {
          try {
            const ct = (resp.headers()['content-type'] || '').toLowerCase();
            const cd = (resp.headers()['content-disposition'] || '').toLowerCase();
            const looksZip = ct.includes('application/zip')
              || ct.includes('application/x-zip')
              || ct.includes('application/octet-stream')
              || /\.zip\b/i.test(cd)
              || /attachment/i.test(cd);
            if (!looksZip) return;
            if (resp.request().resourceType() === 'document') return; // page nav
            const buf = await resp.buffer().catch(() => null);
            if (!buf || buf.length < 1024) return;
            // ZIP magic: PK\003\004
            if (buf[0] !== 0x50 || buf[1] !== 0x4b) return;
            clearTimeout(timer);
            page.off('response', handler);
            resolve({ buf, url: resp.url(), ct });
          } catch (_) {}
        };
        page.on('response', handler);
      });

      const downloadRect = await page.evaluate(() => {
        const RX_BTN = /Download\s*(?:alle\s*documenten|all\s*documents)/i;
        const esc = (s) => (window.CSS && CSS.escape) ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
        // Search across all clickable-ish elements + walk up to find
        // the actual <button>/<a> ancestor. User confirmed the label
        // span lives inside a wrapping button (DOM 2026-05-12:
        // <span class="text-nowrap"> Download alle documenten </span>).
        const all = Array.from(document.querySelectorAll('span, button, a, [role="button"]'));
        for (const el of all) {
          const t = (el.textContent || '').trim().replace(/\s+/g, ' ');
          if (!RX_BTN.test(t) || t.length > 80) continue;
          let target = el;
          for (let i = 0; i < 4; i++) {
            if (target.tagName === 'BUTTON' || target.tagName === 'A') break;
            if (target.parentElement) target = target.parentElement;
            else break;
          }
          try {
            target.scrollIntoView({ block: 'center' });
            const rect = target.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              let selector = null;
              if (target.id) selector = '#' + esc(target.id);
              else if (target.getAttribute('data-test-id')) selector = `[data-test-id="${target.getAttribute('data-test-id')}"]`;
              return {
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2,
                tag: target.tagName,
                text: t.slice(0, 40),
                selector,
                id: target.id || null,
              };
            }
          } catch (_) {}
        }
        return null;
      }).catch(() => null);

      let downloadClicked = null;
      if (downloadRect) {
        if (downloadRect.selector) {
          try {
            await page.click(downloadRect.selector, { delay: 50 });
            downloadClicked = `${downloadRect.tag} "${downloadRect.text}" via ${downloadRect.selector}`;
          } catch (e) {
            console.log(`    🇳🇱 tenderned: Download-all page.click(${downloadRect.selector}) failed: ${(e.message || '').slice(0, 80)} — falling back to mouse.click`);
          }
          // v7: also DOM-click for Material event chain (idempotent).
          try {
            await page.evaluate((sel) => {
              const el = document.querySelector(sel);
              if (el) {
                try { el.focus(); } catch (_) {}
                el.click();
              }
            }, downloadRect.selector);
          } catch (_) {}
        }
        if (!downloadClicked) {
          try {
            await page.mouse.move(downloadRect.x, downloadRect.y);
            await new Promise((r) => setTimeout(r, 150));
            await page.mouse.click(downloadRect.x, downloadRect.y, { delay: 50 });
            downloadClicked = `${downloadRect.tag} "${downloadRect.text}" via mouse coords`;
          } catch (e) {
            console.log(`    🇳🇱 tenderned: Download-all mouse.click failed: ${(e.message || '').slice(0, 80)}`);
          }
        }
      }

      if (downloadClicked) {
        console.log(`    🇳🇱 tenderned: clicked Download-all (${downloadClicked}) — waiting for ZIP`);
        let zipResp = await zipResponsePromise;
        page.off('request', reqHandler);
        // v8 fallback: response stream may have been hijacked by the
        // download manager. If we captured a Download-all request URL,
        // re-fetch it via page.evaluate with the session cookies — this
        // avoids the download routing entirely.
        if ((!zipResp || !zipResp.buf) && capturedReqUrl) {
          console.log(`    🇳🇱 tenderned: response capture failed — refetching ${capturedReqUrl.slice(0, 100)} via page session`);
          try {
            const refetch = await page.evaluate(async (url) => {
              try {
                const r = await fetch(url, { credentials: 'include', redirect: 'follow' });
                if (!r.ok) return { ok: false, status: r.status };
                const ab = await r.arrayBuffer();
                return {
                  ok: true,
                  status: r.status,
                  ct: r.headers.get('content-type') || '',
                  url: r.url || url,
                  data: Array.from(new Uint8Array(ab)),
                };
              } catch (e) { return { ok: false, error: String(e).slice(0, 200) }; }
            }, capturedReqUrl);
            if (refetch && refetch.ok && refetch.data && refetch.data.length > 1024) {
              const buf = Buffer.from(refetch.data);
              if (buf[0] === 0x50 && buf[1] === 0x4b) {
                zipResp = { buf, url: refetch.url, ct: refetch.ct };
                console.log(`    🇳🇱 tenderned: session refetch OK (${buf.length}B)`);
              } else {
                console.log(`    ⚠️  tenderned: refetched bytes don't have ZIP magic (got ct=${refetch.ct}, first 2 bytes: ${buf[0].toString(16)} ${buf[1].toString(16)})`);
              }
            } else {
              console.log(`    ⚠️  tenderned: session refetch failed: status=${refetch?.status || refetch?.error || '?'}`);
            }
          } catch (e) {
            console.log(`    ⚠️  tenderned: refetch error: ${(e.message || '').slice(0, 100)}`);
          }
        } else if (!zipResp || !zipResp.buf) {
          console.log(`    ⚠️  tenderned: no request URL captured either — click may not have triggered any download endpoint`);
        }
        // v9 fallback: if still no ZIP, poll the CDP download directory.
        // Chromium routes Content-Disposition:attachment directly to the
        // download manager (bypasses our request listener entirely). With
        // Browser.setDownloadBehavior:allow + downloadPath, the file is
        // written to disk. Poll up to 15s for a .zip / .crdownload to
        // appear, then read it back.
        if ((!zipResp || !zipResp.buf) && downloadDir) {
          try {
            const fs = require('fs');
            const path = require('path');
            const deadline = Date.now() + 15000;
            let zipPath = null;
            while (Date.now() < deadline) {
              await new Promise((r) => setTimeout(r, 500));
              let names = [];
              try { names = fs.readdirSync(downloadDir); } catch (_) {}
              // Skip in-flight .crdownload — wait for finalized name.
              const finished = names.filter((n) => !/\.crdownload$/i.test(n));
              if (finished.length > 0) {
                // Pick the largest finished file (downloads typically settle
                // to one file; multiple would mean multi-document download).
                let biggest = null;
                for (const n of finished) {
                  try {
                    const p = path.join(downloadDir, n);
                    const st = fs.statSync(p);
                    if (st.isFile() && st.size > 1024) {
                      if (!biggest || st.size > biggest.size) biggest = { path: p, size: st.size, name: n };
                    }
                  } catch (_) {}
                }
                if (biggest) { zipPath = biggest.path; break; }
              }
            }
            if (zipPath) {
              const buf = fs.readFileSync(zipPath);
              if (buf.length > 1024 && buf[0] === 0x50 && buf[1] === 0x4b) {
                zipResp = { buf, url: `file://${zipPath}`, ct: 'application/zip' };
                console.log(`    🇳🇱 tenderned: ZIP captured from disk (${buf.length}B → ${path.basename(zipPath)})`);
              } else {
                console.log(`    ⚠️  tenderned: disk file "${path.basename(zipPath)}" not a ZIP (${buf.length}B, magic=${buf.slice(0, 4).toString('hex')})`);
              }
            } else {
              console.log(`    ⚠️  tenderned: download dir polling timed out — no file appeared in ${downloadDir.slice(-40)}`);
            }
          } catch (e) {
            console.log(`    ⚠️  tenderned: disk read error: ${(e.message || '').slice(0, 100)}`);
          }
        }
        if (zipResp && zipResp.buf) {
          console.log(`    🇳🇱 tenderned: ZIP captured (${zipResp.buf.length}B) from ${zipResp.url.slice(0, 100)}`);
          try {
            const zip = new admZipLib(zipResp.buf);
            const entries = zip.getEntries();
            // Priority entries first — Selectieleidraad / Programma van
            // Eisen / Aanbestedingsleidraad / UEA, then fall through.
            const SCORE_RULES = [
              { rx: /selectie\s*leidraad|selectiecriteri|selectie[-\s]?eisen|selection\s*criteria/i, score: 25 },
              { rx: /aanbestedings?\s*leidraad|procurement\s*guide|request\s*for\s*quotation/i, score: 18 },
              { rx: /programma\s*van\s*eisen|statement\s*of\s*requirements/i, score: 12 },
              { rx: /uea|espd|uniform\s*europees|uniform\s*european\s*procurement/i, score: 8 },
              { rx: /aankondiging|contract\s*notice|EF\d+/i, score: 5 },
            ];
            const scoreOf = (n) => {
              let s = 0;
              for (const r of SCORE_RULES) if (r.rx.test(n)) s = Math.max(s, r.score);
              return s;
            };
            const docEntries = entries
              .filter((e) => !e.isDirectory && /\.(pdf|docx?)$/i.test(e.entryName))
              .map((e) => ({ entry: e, score: scoreOf(e.entryName) }))
              .sort((a, b) => b.score - a.score)
              .slice(0, 6);
            console.log(`    🇳🇱 tenderned: ZIP has ${entries.length} entries, parsing top ${docEntries.length} (PDFs/DOCXs)`);
            for (const item of docEntries) {
              const entry = item.entry;
              const name = entry.entryName.slice(-100);
              try {
                const data = entry.getData();
                let text = '';
                const isPdf = data[0] === 0x25 && data[1] === 0x50 && data[2] === 0x44 && data[3] === 0x46;
                const isDocx = /\.docx$/i.test(name);
                if (isPdf && pdfParseLib) {
                  const parsed = await pdfParseLib(data);
                  text = ((parsed && parsed.text) || '').trim();
                } else if (isDocx && mammothLib) {
                  const out = await mammothLib.extractRawText({ buffer: data });
                  text = ((out && out.value) || '').trim();
                }
                if (text.length > 200) {
                  const clipped = text.slice(0, 80000);
                  texts.push(`--- (tenderned) ${name} ---\n${clipped}`);
                  console.log(`    🇳🇱 tenderned: parsed "${name}" (${data.length}B → ${clipped.length}ch, score=${item.score})`);
                } else {
                  console.log(`    ⚠️  tenderned: "${name}" extracted text too short (${text.length}ch)`);
                }
              } catch (e) {
                console.log(`    ⚠️  tenderned: parse failed for "${name}": ${(e.message || '').slice(0, 80)}`);
              }
            }
          } catch (e) {
            console.log(`    ⚠️  tenderned: ZIP parse error: ${(e.message || '').slice(0, 100)}`);
          }
        } else {
          console.log(`    ⚠️  tenderned: Download-all click fired but no ZIP response captured`);
        }
      } else {
        console.log(`    ⚠️  tenderned: Download-all button not found on page`);
        // Clean up request listener if we never clicked.
        try { page.off('request', reqHandler); } catch (_) {}
      }
      // v9: detach CDP session and rm tmp download dir if we set them up.
      try { if (cdpSession) await cdpSession.detach(); } catch (_) {}
      try {
        if (downloadDir) {
          const fs = require('fs');
          fs.rmSync(downloadDir, { recursive: true, force: true });
        }
      } catch (_) {}
    }

    // v10 API fallback — Angular fires /papi/.../documenten when the
    // Documenten tab activates. We captured all such responses above;
    // parse them for per-file URLs / IDs. Run only if ZIP path failed.
    if (texts.length === 0 && capturedJsonResponses.length > 0) {
      console.log(`    🇳🇱 tenderned: API fallback — ${capturedJsonResponses.length} JSON response(s) captured during tab activation`);
      const apiDocs = [];
      for (const cap of capturedJsonResponses) {
        let json;
        try { json = JSON.parse(cap.body); } catch (_) { continue; }
        // Walk JSON looking for arrays of objects with file-like fields.
        const collect = (node, depth) => {
          if (apiDocs.length >= 30) return;
          if (depth > 6) return;
          if (Array.isArray(node)) { for (const x of node) collect(x, depth + 1); return; }
          if (!node || typeof node !== 'object') return;
          // Detect file-shaped objects — common TenderNed keys: id,
          // bestandsnaam, naam, filename, name, contentType, type, size.
          const keys = Object.keys(node);
          const hasName = keys.some((k) => /^(?:bestandsnaam|filename|fileName|naam|name)$/i.test(k));
          const hasId = keys.some((k) => /^(?:id|fileId|documentId|stukId|bestandId)$/i.test(k));
          if (hasName && hasId) {
            const name = node.bestandsnaam || node.filename || node.fileName || node.naam || node.name || '';
            const id   = node.id || node.fileId || node.documentId || node.stukId || node.bestandId || '';
            if (name && id && /\.(?:pdf|docx?|xlsx?|zip|rtf|odt|ods)$/i.test(name)) {
              apiDocs.push({ name: String(name).slice(0, 200), id: String(id), src: cap.url.slice(0, 80) });
            }
          }
          for (const k of keys) collect(node[k], depth + 1);
        };
        try { collect(json, 0); } catch (_) {}
      }
      if (apiDocs.length === 0) {
        console.log(`    ⚠️  tenderned: API responses captured but no file-shaped objects found. URLs: ${capturedJsonResponses.slice(0, 4).map((c) => c.url.slice(-60)).join(' | ')}`);
        // v12 diagnostic — dump top-level keys + sample object shapes
        // from the first response so we can refine the file-shape
        // detector. Limited to 1 response and 400 chars to avoid noise.
        try {
          const first = capturedJsonResponses[0];
          if (first) {
            const parsed = JSON.parse(first.body);
            const summary = (() => {
              if (Array.isArray(parsed)) return `array(len=${parsed.length}), first[0] keys=${parsed[0] ? Object.keys(parsed[0]).slice(0, 10).join(',') : 'none'}`;
              if (parsed && typeof parsed === 'object') return `object keys=${Object.keys(parsed).slice(0, 10).join(',')}`;
              return `primitive(${typeof parsed})`;
            })();
            const snippet = JSON.stringify(parsed).slice(0, 400);
            console.log(`    🔎 tenderned: JSON shape — ${summary}. Snippet: ${snippet}`);
          }
        } catch (_) {}
      } else {
        // De-dup by (id, name)
        const seen = new Set();
        const uniq = [];
        for (const d of apiDocs) {
          const k = `${d.id}|${d.name}`;
          if (seen.has(k)) continue;
          seen.add(k);
          uniq.push(d);
        }
        console.log(`    🇳🇱 tenderned: API discovered ${uniq.length} document(s) — sample: ${uniq.slice(0, 4).map((d) => d.name.slice(0, 50)).join(' | ')}`);
        // Score & prioritise — same vocab as ZIP path.
        const API_SCORE = [
          { rx: /selectie\s*leidraad|selectiecriteri|selectie[-\s]?eisen/i, score: 25 },
          { rx: /aanbestedings?\s*leidraad|procurement\s*guide/i, score: 18 },
          { rx: /programma\s*van\s*eisen/i, score: 12 },
          { rx: /uea|espd|uniform\s*europees/i, score: 8 },
          { rx: /aankondiging|EF\d+/i, score: 5 },
        ];
        for (const d of uniq) {
          d.score = 0;
          for (const r of API_SCORE) if (r.rx.test(d.name)) d.score = Math.max(d.score, r.score);
        }
        uniq.sort((a, b) => b.score - a.score);
        // Try a few URL patterns per document — TenderNed exposes file
        // downloads under multiple aliases. The right one is hard to
        // guess from outside, so we try each in order and use the first
        // that yields a valid PDF/DOCX. Heuristics built from observed
        // /papi paths in captured response URLs.
        // User-confirmed 2026-05-14: per-file URL pattern is
        // /publicaties/{noticeId}/documenten/{docId}/content
        const URL_PATTERNS = (id) => [
          `https://www.tenderned.nl/papi/tenderned-rs-tns/v2/publicaties/${noticeId}/documenten/${id}/content`,
          `https://www.tenderned.nl/papi/tenderned-rs-tns/v2/publicaties/${noticeId}/documenten/${id}`,
        ];
        const topDocs = uniq.slice(0, 6);
        if (admZipLib || pdfParseLib || mammothLib) {
          for (const doc of topDocs) {
            let fetched = null;
            for (const candUrl of URL_PATTERNS(doc.id)) {
              const r = await page.evaluate(async (url) => {
                try {
                  const resp = await fetch(url, { credentials: 'include', redirect: 'follow' });
                  if (!resp.ok) return { ok: false, status: resp.status };
                  const ct = resp.headers.get('content-type') || '';
                  const ab = await resp.arrayBuffer();
                  return { ok: true, status: resp.status, ct, url: resp.url || url, data: Array.from(new Uint8Array(ab)) };
                } catch (e) { return { ok: false, error: String(e).slice(0, 200) }; }
              }, candUrl).catch(() => null);
              if (r && r.ok && r.data && r.data.length > 500) {
                const buf = Buffer.from(r.data);
                // Accept PDF magic OR Office-ZIP (DOCX/XLSX).
                if ((buf[0] === 0x25 && buf[1] === 0x50) || (buf[0] === 0x50 && buf[1] === 0x4b)) {
                  fetched = { buf, ct: r.ct, url: candUrl };
                  break;
                }
              }
            }
            if (!fetched) {
              console.log(`    ⚠️  tenderned: API download failed for "${doc.name.slice(0, 50)}" — all URL patterns rejected`);
              continue;
            }
            try {
              const buf = fetched.buf;
              const isPdf = buf[0] === 0x25 && buf[1] === 0x50;
              const isDocx = (buf[0] === 0x50 && buf[1] === 0x4b) && /\.docx$/i.test(doc.name);
              let text = '';
              if (isPdf && pdfParseLib) {
                const parsed = await pdfParseLib(buf);
                text = ((parsed && parsed.text) || '').trim();
              } else if (isDocx && mammothLib) {
                const out = await mammothLib.extractRawText({ buffer: buf });
                text = ((out && out.value) || '').trim();
              }
              if (text.length > 200) {
                const clipped = text.slice(0, 80000);
                texts.push(`--- (tenderned API) ${doc.name} ---\n${clipped}`);
                console.log(`    🇳🇱 tenderned: API parsed "${doc.name.slice(0, 60)}" (${buf.length}B → ${clipped.length}ch, score=${doc.score})`);
              } else {
                console.log(`    ⚠️  tenderned: API "${doc.name.slice(0, 50)}" text too short (${text.length}ch)`);
              }
            } catch (e) {
              console.log(`    ⚠️  tenderned: API parse failed "${doc.name.slice(0, 50)}": ${(e.message || '').slice(0, 80)}`);
            }
          }
        }
      }
    }
    // Cleanup the response listener now that we're done with API path.
    try { page.off('response', papiResponseHandler); } catch (_) {}

    // If ZIP path returned content, we're done. Otherwise (no ZIP lib,
    // no button, no docs detected), fall back to the original anchor-
    // based scan for tenders that DO expose direct download links.
    if (texts.length > 0) return texts;

    const probe = await page.evaluate(() => {
      const RX_DOC_EXT  = /\.(pdf|docx?|xlsx?|zip|rtf|odt|ods)(?:[?#]|$)/i;
      const RX_DOC_PATH = /\/(?:document(?:en)?|bestand(?:en)?|attachment|download|papi\/.*?\/documenten|bijlag|stuk)\b/i;
      const RX_DOC_TXT  = /\b(?:Bijlage|Aanbestedings(?:leidraad|document)|Selectie(?:leidraad|criteri)|Programma\s*van\s*Eisen|UEA|ESPD|TN\d{4,}|EF\d+\s*Aankondiging)\b/i;
      const RX_FILE_TXT = /\.(?:pdf|docx?|xlsx?|zip|rtf|odt|ods)\b/i;
      const seen = new Set();
      const out = [];
      const sampleHrefs = [];
      const allAnchors = Array.from(document.querySelectorAll('a[href]'));
      for (const a of allAnchors) {
        const hrefRaw = a.getAttribute('href') || '';
        if (!hrefRaw || hrefRaw.startsWith('#') || /^javascript:/i.test(hrefRaw)) continue;
        let abs, absHost;
        try {
          abs = new URL(hrefRaw, location.href).toString();
          absHost = new URL(abs).hostname.toLowerCase();
        } catch (_) { continue; }
        if (!/(^|\.)tenderned\.nl$/i.test(absHost)) continue;
        if (seen.has(abs)) continue;
        seen.add(abs);
        const path = (new URL(abs)).pathname;
        const search = (new URL(abs)).search;
        const text = ((a.innerText || a.textContent || '') + ' ' + (a.getAttribute('title') || ''))
          .trim().replace(/\s+/g, ' ').slice(0, 200);
        const isDocByPath = RX_DOC_EXT.test(path) || RX_DOC_EXT.test(search) || RX_DOC_PATH.test(path);
        const isDocByText = RX_DOC_TXT.test(text) || RX_FILE_TXT.test(text);
        if (isDocByPath || isDocByText) {
          out.push({ url: abs, name: text || abs.slice(-80), reason: isDocByPath ? 'path' : 'text' });
        }
        if (sampleHrefs.length < 12) {
          sampleHrefs.push({ url: abs.slice(0, 140), text: text.slice(0, 80) });
        }
        if (out.length >= 50) break;
      }
      return { docs: out, totalAnchors: allAnchors.length, sampleHrefs };
    }).catch(() => ({ docs: [], totalAnchors: 0, sampleHrefs: [] }));

    const docs = probe.docs;
    if (!docs.length) {
      console.log(
        `    🇳🇱 tenderned: notice ${noticeId} — no document anchors found ` +
        `(scanned ${probe.totalAnchors} same-domain links). Sample: ` +
        JSON.stringify(probe.sampleHrefs.slice(0, 6))
      );
      return [];
    }
    console.log(`    🇳🇱 tenderned: notice ${noticeId} — ${docs.length} document anchor(s) found`);

    // Priority — Selectieleidraad / Selectiecriterium > Aanbestedingsleidraad
    // > Programma van Eisen > UEA/ESPD > rest. Higher score = fetched first.
    // We hard-cap at the top 6 docs to bound runtime.
    const SCORE_RULES = [
      { rx: /selectie\s*leidraad|selectiecriteri|selectie[-\s]?eisen|selection\s*criteria/i, score: 25 },
      { rx: /aanbestedings?\s*leidraad|procurement\s*guide/i, score: 18 },
      { rx: /programma\s*van\s*eisen|requirements\s*programme/i, score: 12 },
      { rx: /uea|espd|uniform\s*europees\s*aanbestedingsdocument/i, score: 8 },
      { rx: /aankondiging|EF16/i, score: 5 },
    ];
    for (const d of docs) {
      d.score = 0;
      for (const r of SCORE_RULES) {
        if (r.rx.test(d.name) || r.rx.test(d.url)) { d.score = Math.max(d.score, r.score); }
      }
    }
    docs.sort((a, b) => b.score - a.score);
    const topDocs = docs.slice(0, 6);
    console.log(`    🇳🇱 tenderned: priority docs: ${topDocs.map(d => `${d.name.slice(0, 40)}[s=${d.score}]`).join(' | ')}`);

    // Reuse outer `texts` (declared above before the ZIP path) — the
    // anchor fallback runs only if ZIP capture returned nothing.
    for (const doc of topDocs) {
      const labelName = doc.name.slice(0, 100);
      // Fetch via page.evaluate so we keep the same session cookies.
      const result = await page.evaluate(async (url) => {
        try {
          const resp = await fetch(url, {
            credentials: 'include',
            redirect: 'follow',
          });
          if (!resp.ok) return { ok: false, status: resp.status };
          const ct = resp.headers.get('content-type') || '';
          const cd = resp.headers.get('content-disposition') || '';
          const ab = await resp.arrayBuffer();
          return {
            ok: true,
            status: resp.status,
            ct,
            cd,
            url: resp.url || url,
            data: Array.from(new Uint8Array(ab)),
          };
        } catch (e) {
          return { ok: false, error: String(e).slice(0, 200) };
        }
      }, doc.url).catch((e) => ({ ok: false, error: e.message }));

      if (!result || !result.ok || !result.data || result.data.length < 500) {
        const status = result?.status || result?.error || '?';
        console.log(`    ⚠️  tenderned: download failed for "${labelName}" (status=${status})`);
        continue;
      }
      const buf = Buffer.from(result.data);
      const ctL = (result.ct || '').toLowerCase();
      const isPdf = buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46;
      const isDocx = ctL.includes('officedocument.wordprocessingml')
        || (buf[0] === 0x50 && buf[1] === 0x4b && /\.docx(?:[?#]|$)/i.test(doc.url));
      try {
        let text = '';
        if (isPdf && pdfParseLib) {
          const parsed = await pdfParseLib(buf);
          text = ((parsed && parsed.text) || '').trim();
        } else if (isDocx && mammothLib) {
          const out = await mammothLib.extractRawText({ buffer: buf });
          text = ((out && out.value) || '').trim();
        } else {
          console.log(`    ⚠️  tenderned: "${labelName}" — unsupported type (ct=${ctL.slice(0, 40)})`);
          continue;
        }
        if (text.length > 200) {
          const clipped = text.slice(0, 80000);
          texts.push(`--- (tenderned) ${labelName} ---\n${clipped}`);
          console.log(`    🇳🇱 tenderned: parsed "${labelName}" (${buf.length}B → ${clipped.length}ch, score=${doc.score})`);
        } else {
          console.log(`    ⚠️  tenderned: "${labelName}" extracted text too short (${text.length}ch)`);
        }
      } catch (e) {
        console.log(`    ⚠️  tenderned: parse failed for "${labelName}": ${(e.message || '').slice(0, 80)}`);
      }
    }
    return texts;
  } catch (e) {
    console.log(`    ⚠️  tenderned handler error: ${(e.message || String(e)).slice(0, 140)}`);
    return [];
  } finally {
    try { if (page) await page.close(); } catch (_) {}
  }
}

// =====================================================================
// fetchTarjouspalveluDocuments
// ---------------------------------------------------------------------
// Mercell tenders sourced from tarjouspalvelu.fi (Finnish national
// tender front-end on Cloudia SaaS) expose a direct ZIP download URL
// at /Zip/TarjousPyynnonLiitteet/<noticeId> after authentication.
// User-confirmed DOM 2026-05-12:
//   <a href="/Zip/TarjousPyynnonLiitteet/611615" target="_blank">
//     Download all documents (ZIP)
//   </a>
//
// The noticeId is the `id` query parameter on the source URL, e.g.
//   https://tarjouspalvelu.fi/keuda?id=611615&tpk=...
// → ZIP: https://tarjouspalvelu.fi/Zip/TarjousPyynnonLiitteet/611615
//
// We open a new tab with the SAME browser context so the Cloudia
// session cookies set by attemptPortalLogin are available, navigate
// to the source URL once to anchor location, then page.evaluate(fetch)
// the ZIP URL. Parse with adm-zip, prioritise Finnish keyword docs:
//   Tarjouspyyntö (Request for Quotation) — top
//   Soveltuvuusvaatimukset (Suitability requirements)
//   Valintaperusteet (Selection criteria)
//   UEA / ESPD
// =====================================================================
async function fetchTarjouspalveluDocuments(browser, sourceUrl) {
  let noticeId = null;
  let tenant = null;
  try {
    const u = new URL(sourceUrl);
    if (!/(^|\.)tarjouspalvelu\.fi$/i.test(u.hostname)) return [];
    const idParam = u.searchParams.get('id');
    if (!idParam || !/^\d+$/.test(idParam)) return [];
    noticeId = idParam;
    const segs = u.pathname.split('/').filter(Boolean);
    tenant = segs[0] || ''; // e.g. "keuda"
  } catch (_) { return []; }

  let pdfParseLib = null;
  let mammothLib = null;
  let admZipLib = null;
  try { pdfParseLib = require('pdf-parse'); } catch (_) {}
  try { mammothLib  = require('mammoth');   } catch (_) {}
  try { admZipLib   = require('adm-zip');   } catch (_) {}
  if (!admZipLib || !pdfParseLib) {
    console.log(`    🇫🇮 tarjouspalvelu: pdf-parse or adm-zip unavailable — skipping`);
    return [];
  }

  let page = null;
  try {
    page = await browser.newPage();
    page.setDefaultNavigationTimeout(25000);
    page.setDefaultTimeout(25000);

    // Anchor location at the source URL so the fetch() runs with the
    // correct origin/cookies. This also ensures we have an authenticated
    // session — attemptPortalLogin sets cookies on the browser context,
    // so this fresh page inherits them.
    try {
      await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
    } catch (e) {
      console.log(`    🇫🇮 tarjouspalvelu: nav warn: ${(e.message || '').slice(0, 80)}`);
    }
    await new Promise((r) => setTimeout(r, 1500));

    // EMAIL-FIRST MULTI-PAGE LOGIN (2026-05-15 fix).
    //
    // User-confirmed real auth flow for tarjouspalvelu.fi:
    //   1. Visit tarjouspalvelu.fi/<tenant>?id=X (anonymous tender page)
    //   2. Top-corner has email input + "Kirjaudu/Login" button
    //   3. Fill email + click → redirects to
    //      login.cloudia.net/user/login?username=X&application=redirect:UUID
    //      (email pre-filled, UUID = tarjouspalvelu's Cloudia app id)
    //   4. Fill password + submit
    //   5. Cloudia auth → redirects back to tarjouspalvelu.fi (or to
    //      cloudia.net/user/user; we then re-nav back to source URL)
    //   6. Now authenticated on tarjouspalvelu.fi — session cookie set
    //
    // Our previous SSO warmup approach used the dedicated
    // login.cloudia.net/user/login URL WITHOUT the application=redirect
    // parameter, so Cloudia auth granted Cloudia dashboard access but
    // NOT tarjouspalvelu tender access. The correct flow starts from
    // tarjouspalvelu's own corner Login button, which sets the
    // application=redirect:UUID parameter on the redirect to Cloudia.
    const tpCreds = getPortalCreds('tarjouspalvelu.fi');
    if (!tpCreds || !tpCreds.username || !tpCreds.password) {
      console.log(`    ⚠️  tarjouspalvelu: no credentials configured — bailing`);
      return [];
    }

    // Step 1: Cookie state before login.
    try {
      const cookiesBefore = await page.cookies('https://tarjouspalvelu.fi', 'https://login.cloudia.net');
      const cloudia = cookiesBefore.filter((c) => /cloudia/i.test(c.domain)).map((c) => c.name);
      const tp = cookiesBefore.filter((c) => /tarjouspalvelu/i.test(c.domain)).map((c) => c.name);
      console.log(`    🇫🇮 tarjouspalvelu: cookies before login — cloudia=[${cloudia.join(',')}] tarjouspalvelu=[${tp.join(',')}]`);
    } catch (_) {}

    // Step 1.5: ALREADY-AUTHENTICATED detection (2026-05-15 fix).
    // FI run revealed `TarjPalv` cookie persists across runs (SSO from
    // a previous scraper run still valid). When that's set, the source
    // URL renders WITHOUT login form — instead we see the authenticated
    // supplier portal ("My profile / Log out / sales@cornercasetech.com").
    // Detection signals:
    //   1. `TarjPalv` cookie on tarjouspalvelu.fi domain
    //   2. Body contains "Log out" / "Kirjaudu ulos" / our email
    //   3. URL contains /UX/TP/ (authenticated supplier portal route)
    // If authenticated, SKIP the entire email/login flow and proceed
    // directly to ZIP fetch.
    let alreadyAuthenticated = false;
    try {
      const allCookies = await page.cookies('https://tarjouspalvelu.fi');
      const hasTarjPalv = allCookies.some((c) => /^TarjPalv$/i.test(c.name));
      const authMarker = await page.evaluate((email) => {
        const body = (document.body && document.body.innerText || '').toLowerCase();
        const RX_LOGGED = /\b(log\s*out|kirjaudu\s*ulos|log\s*off|my\s*profile|oma\s*profiili)\b/i;
        return {
          url: location.href,
          hasLoggedOut: RX_LOGGED.test(body),
          hasOurEmail: email ? body.toLowerCase().includes(email.toLowerCase()) : false,
        };
      }, tpCreds.username).catch(() => null);
      const onAuthRoute = authMarker && /\/UX\/TP\//i.test(authMarker.url || '');
      alreadyAuthenticated = hasTarjPalv && (authMarker?.hasLoggedOut || authMarker?.hasOurEmail || onAuthRoute);
      if (alreadyAuthenticated) {
        console.log(
          `    ✅ tarjouspalvelu: ALREADY authenticated (TarjPalv=${hasTarjPalv}, ` +
          `logOutMarker=${!!authMarker?.hasLoggedOut}, emailInBody=${!!authMarker?.hasOurEmail}, ` +
          `onAuthRoute=${onAuthRoute}) — skipping login, proceeding to ZIP fetch`
        );
      }
    } catch (_) {}

    // Step 2: Find email input + Login button on tarjouspalvelu corner.
    // SKIP this entire block if already authenticated.
    if (alreadyAuthenticated) {
      // Jump directly to ZIP fetch.
    } else { /* keep open — closing brace before zipUrl below */ }
    if (!alreadyAuthenticated) {
    // 2026-05-15 fix v2: prior version's strict email-keyword filter
    // missed tarjouspalvelu's email field (it doesn't have obvious
    // email/username keywords in its id/name/placeholder). New approach:
    // BROADER input search + diagnostic dump showing all visible inputs
    // if no match. Strategy: find a visible button/link with "Kirjaudu"/
    // "Login" text first, then pick the nearest visible input above it.
    const emailFieldFilled = await page.evaluate((email) => {
      const RX_LOGIN_BTN = /^\s*(kirjaudu(?:\s*sis[äa][äa]n)?|log[\s-]?in|sign[\s-]?in)\s*$/i;
      const RX_EMAIL_HINT = /email|username|user|käyttäjä|sähköposti|tunnus/i;
      const RX_REJECT_HINT = /search|haku|sökning|zip|postnumero|phone|puhelin|address|osoite|cookie/i;
      // Diagnostic snapshot — all visible inputs.
      const allInputs = Array.from(document.querySelectorAll('input:not([disabled]):not([type="hidden"])'));
      const visibleInputs = allInputs.filter((el) => el.offsetParent !== null);
      const sample = visibleInputs.slice(0, 8).map((el) => ({
        type: el.type || '',
        id: el.id || '',
        name: el.name || '',
        placeholder: el.placeholder || '',
        aria: el.getAttribute('aria-label') || '',
      }));
      // Strategy 1: input with email/username keyword hint.
      let target = visibleInputs.find((el) => {
        if (el.type === 'password') return false;
        const blob = ((el.id || '') + ' ' + (el.name || '') + ' ' + (el.placeholder || '') + ' ' + (el.getAttribute('aria-label') || '')).toLowerCase();
        if (RX_REJECT_HINT.test(blob)) return false;
        return RX_EMAIL_HINT.test(blob) || el.type === 'email';
      });
      // Strategy 2: find a button with login text, then look for an input
      // immediately above/before it in DOM order.
      if (!target) {
        const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], a'));
        const loginBtn = buttons.find((b) => {
          if (b.offsetParent === null) return false;
          const t = (b.innerText || b.value || b.textContent || '').trim();
          return t.length > 0 && t.length <= 30 && RX_LOGIN_BTN.test(t);
        });
        if (loginBtn) {
          // Find input that's a sibling/cousin of loginBtn — same form
          // OR within 4 ancestors up. We pick the FIRST text-style input
          // (not password, not hidden, not search).
          let container = loginBtn.closest('form') || loginBtn.parentElement;
          for (let i = 0; i < 4 && container; i++) {
            const candidates = Array.from(container.querySelectorAll('input:not([disabled]):not([type="hidden"])'));
            const pick = candidates.find((el) => {
              if (el.type === 'password') return false;
              if (el.offsetParent === null) return false;
              const blob = ((el.id || '') + ' ' + (el.name || '') + ' ' + (el.placeholder || '') + ' ' + (el.getAttribute('aria-label') || '')).toLowerCase();
              if (RX_REJECT_HINT.test(blob)) return false;
              return true;
            });
            if (pick) { target = pick; break; }
            container = container.parentElement;
          }
        }
      }
      if (!target) {
        return { ok: false, reason: 'no-email-field', sample, totalInputs: allInputs.length, visibleInputs: visibleInputs.length };
      }
      try {
        target.focus();
        target.value = email;
        target.dispatchEvent(new Event('input', { bubbles: true }));
        target.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, sel: target.id ? '#' + target.id : (target.name || target.type || 'input'), placeholder: target.placeholder || '' };
      } catch (e) {
        return { ok: false, reason: 'fill-error: ' + String(e).slice(0, 60) };
      }
    }, tpCreds.username).catch(() => ({ ok: false, reason: 'evaluate-error' }));
    if (!emailFieldFilled.ok) {
      console.log(
        `    ⚠️  tarjouspalvelu: email input not found (${emailFieldFilled.reason}) — ` +
        `${emailFieldFilled.visibleInputs || 0}/${emailFieldFilled.totalInputs || 0} visible inputs. ` +
        `Sample: ${JSON.stringify((emailFieldFilled.sample || []).slice(0, 5))}`
      );
      // 2026-05-15 fix v3: even without email pre-fill, try clicking the
      // Login button. Maybe the click navigates to cloudia.net where we
      // can fill BOTH email and password fields. Don't bail entirely.
      console.log(`    🇫🇮 tarjouspalvelu: attempting Login click WITHOUT email pre-fill (will fill on Cloudia page)`);
    } else {
      console.log(`    🇫🇮 tarjouspalvelu: email filled (${emailFieldFilled.sel}, placeholder="${emailFieldFilled.placeholder}") — clicking Login`);
    }

    // Step 3: Click Login button. Could be a submit input/button,
    // or a link. Look for one near the email field with "Kirjaudu/Login" text.
    const loginClicked = await page.evaluate(() => {
      const RX_LOGIN = /^\s*(kirjaudu(?:\s*sis[äa][äa]n)?|log[\s-]?in|sign[\s-]?in)\s*$/i;
      const candidates = Array.from(document.querySelectorAll(
        'button:not([disabled]), input[type="submit"]:not([disabled]), input[type="button"]:not([disabled]), a:not([href="#"])'
      ));
      for (const el of candidates) {
        if (el.offsetParent === null) continue;
        const t = (el.innerText || el.value || el.textContent || el.getAttribute('aria-label') || '').trim();
        if (!t || t.length > 30) continue;
        if (RX_LOGIN.test(t)) {
          try { el.click(); return { ok: true, text: t.slice(0, 30) }; }
          catch (_) {}
        }
      }
      return { ok: false };
    }).catch(() => ({ ok: false }));
    if (!loginClicked.ok) {
      console.log(`    ⚠️  tarjouspalvelu: Login button not found — bailing`);
      return [];
    }
    console.log(`    🇫🇮 tarjouspalvelu: Login clicked ("${loginClicked.text}") — waiting for Cloudia page`);

    // Step 4: Wait for navigation to login.cloudia.net page.
    try {
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 25000 });
    } catch (_) {}
    try { await page.waitForNetworkIdle({ idleTime: 800, timeout: 8000 }); } catch (_) {}
    await new Promise((r) => setTimeout(r, 1200));

    // Step 5: Multi-step login state machine. 2026-05-15 fix v3:
    // FI run revealed the actual flow has THREE pages:
    //   Page A: tarjouspalvelu.fi/<tenant>?id=X — only LOG IN button
    //           (no email field visible, hidden via CSS/modal)
    //   Page B: tarjouspalvelu.fi/UX/TP/SiirryTarjouspyyntoon/?tpId=X&p=Y
    //           — intermediate page with email input (NO password yet)
    //   Page C: login.cloudia.net/user/login?username=X&application=redirect:UUID
    //           — password input
    // After password submit → redirects back to tarjouspalvelu.fi (auth).
    //
    // State machine: up to 4 iterations of "look for inputs, fill, submit, wait".
    // Each iteration handles one page of the chain.
    let passFilled = { ok: false, reason: 'not-attempted' };
    for (let step = 0; step < 4; step++) {
      const stepResult = await page.evaluate((email, password) => {
        const findVisible = (sel) => {
          for (const el of Array.from(document.querySelectorAll(sel))) {
            if (el.offsetParent !== null && !el.disabled) return el;
          }
          return null;
        };
        const passInp = findVisible('input[type="password"]');
        const emailInp = findVisible(
          'input[type="email"]:not([disabled]), ' +
          'input[name*="email" i]:not([disabled]), ' +
          'input[id*="email" i]:not([disabled]), ' +
          'input[name*="username" i]:not([disabled]), ' +
          'input[id*="username" i]:not([disabled]), ' +
          'input[type="text"]:not([disabled])'
        );
        // Both fields visible → fill both, submit, done.
        if (passInp) {
          try {
            if (emailInp && !emailInp.value) {
              emailInp.focus();
              emailInp.value = email;
              emailInp.dispatchEvent(new Event('input', { bubbles: true }));
              emailInp.dispatchEvent(new Event('change', { bubbles: true }));
            }
            passInp.focus();
            passInp.value = password;
            passInp.dispatchEvent(new Event('input', { bubbles: true }));
            passInp.dispatchEvent(new Event('change', { bubbles: true }));
            return { state: 'both-filled', url: location.href, emailWasFilled: emailInp ? (emailInp.value === email) : false };
          } catch (e) {
            return { state: 'fill-error', err: String(e).slice(0, 60), url: location.href };
          }
        }
        // Only email visible (intermediate page) → fill email, submit will fire in caller.
        if (emailInp) {
          try {
            emailInp.focus();
            emailInp.value = email;
            emailInp.dispatchEvent(new Event('input', { bubbles: true }));
            emailInp.dispatchEvent(new Event('change', { bubbles: true }));
            return { state: 'email-only-filled', url: location.href };
          } catch (e) {
            return { state: 'fill-error', err: String(e).slice(0, 60), url: location.href };
          }
        }
        return { state: 'no-field', url: location.href };
      }, tpCreds.username, tpCreds.password).catch(() => ({ state: 'evaluate-error' }));

      console.log(`    🇫🇮 tarjouspalvelu: login step ${step + 1} — state=${stepResult.state}, url=${(stepResult.url || '').slice(-60)}`);

      if (stepResult.state === 'both-filled') {
        passFilled = { ok: true, url: stepResult.url };
        break;
      } else if (stepResult.state === 'email-only-filled') {
        // Submit email form (intermediate page → password page).
        try {
          await page.click('button[type="submit"]:not([disabled])');
        } catch (_) {
          try { await page.click('input[type="submit"]:not([disabled])'); }
          catch (_) { try { await page.keyboard.press('Enter'); } catch (_) {} }
        }
        try {
          await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 });
        } catch (_) {}
        try { await page.waitForNetworkIdle({ idleTime: 800, timeout: 6000 }); } catch (_) {}
        await new Promise((r) => setTimeout(r, 1200));
        // Continue loop — next iteration looks for password.
      } else {
        // no-field / evaluate-error / fill-error — bail out of loop.
        passFilled = { ok: false, reason: stepResult.state, url: stepResult.url };
        break;
      }
    }
    if (!passFilled.ok) {
      console.log(`    ⚠️  tarjouspalvelu: password field not found on ${(passFilled.url || '').slice(-60)} (${passFilled.reason}) — bailing`);
      return [];
    }
    console.log(`    🇫🇮 tarjouspalvelu: password filled on ${(passFilled.url || '').slice(-60)} — submitting`);

    // Step 6: Click submit button.
    let pwSubmitFired = false;
    try {
      await page.click('button[type="submit"]:not([disabled])');
      pwSubmitFired = true;
    } catch (_) {
      try {
        await page.click('input[type="submit"]:not([disabled])');
        pwSubmitFired = true;
      } catch (_) {
        try { await page.keyboard.press('Enter'); pwSubmitFired = true; }
        catch (_) {}
      }
    }
    if (!pwSubmitFired) {
      console.log(`    ⚠️  tarjouspalvelu: no submit method worked — bailing`);
      return [];
    }
    try {
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 25000 });
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 2000));

    // Step 7: Verify login by checking auth cookies + URL.
    let loginVerified = false;
    try {
      const cookiesAfter = await page.cookies('https://tarjouspalvelu.fi', 'https://login.cloudia.net');
      const cloudia = cookiesAfter.filter((c) => /cloudia/i.test(c.domain)).map((c) => c.name);
      const tp = cookiesAfter.filter((c) => /tarjouspalvelu/i.test(c.domain)).map((c) => c.name);
      const finalUrl = page.url();
      console.log(`    🇫🇮 tarjouspalvelu: cookies after login — cloudia=[${cloudia.join(',')}] tarjouspalvelu=[${tp.join(',')}] | URL=${finalUrl.slice(-80)}`);
      // Auth-cookie heuristic — if we have ANY cookie name suggesting
      // auth (Auth/Login/Token/Session beyond the basic SessionId we
      // had pre-login), consider it OK.
      const newCookies = [...cloudia, ...tp];
      loginVerified = newCookies.some((n) => /auth|login|token|sso|signin/i.test(n)) || /tarjouspalvelu/i.test(finalUrl);
    } catch (_) {}
    if (!loginVerified) {
      console.log(`    ⚠️  tarjouspalvelu: login verification weak — proceeding anyway`);
    } else {
      console.log(`    ✅ tarjouspalvelu: login verified`);
    }

    // Step 8: Navigate back to source URL — Cloudia might have landed
    // us on /user/user dashboard instead of tarjouspalvelu.
    try {
      await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      try { await page.waitForNetworkIdle({ idleTime: 1000, timeout: 8000 }); } catch (_) {}
      await new Promise((r) => setTimeout(r, 1500));
      console.log(`    🇫🇮 tarjouspalvelu: re-anchored to source URL — ${page.url().slice(-80)}`);
    } catch (_) { /* best-effort */ }
    } // close `if (!alreadyAuthenticated) {` block — login flow only runs when not already auth.

    // Build the ZIP URL — tenant-relative.
    const zipUrl = `https://tarjouspalvelu.fi/Zip/TarjousPyynnonLiitteet/${noticeId}`;
    console.log(`    🇫🇮 tarjouspalvelu: tender ${noticeId} (tenant=${tenant || 'n/a'}) — fetching ZIP from ${zipUrl}`);

    const result = await page.evaluate(async (url) => {
      try {
        const resp = await fetch(url, {
          credentials: 'include',
          redirect: 'follow',
        });
        if (!resp.ok) return { ok: false, status: resp.status };
        const ct = resp.headers.get('content-type') || '';
        const cd = resp.headers.get('content-disposition') || '';
        const ab = await resp.arrayBuffer();
        return {
          ok: true,
          status: resp.status,
          ct,
          cd,
          url: resp.url || url,
          data: Array.from(new Uint8Array(ab)),
        };
      } catch (e) {
        return { ok: false, error: String(e).slice(0, 200) };
      }
    }, zipUrl).catch((e) => ({ ok: false, error: e.message }));

    if (!result || !result.ok || !result.data || result.data.length < 1024) {
      const status = result?.status || result?.error || '?';
      console.log(`    ⚠️  tarjouspalvelu: ZIP fetch failed (status=${status}, len=${result?.data?.length || 0})`);
      return [];
    }
    const buf = Buffer.from(result.data);
    // Verify ZIP magic — sometimes auth wall returns HTML with 200.
    if (buf[0] !== 0x50 || buf[1] !== 0x4b) {
      const sniff = buf.slice(0, 80).toString('utf8').replace(/\s+/g, ' ').slice(0, 80);
      console.log(`    ⚠️  tarjouspalvelu: response is not a ZIP (ct=${result.ct}, sniff="${sniff}"). Likely auth wall — login session may be invalid.`);
      return [];
    }
    console.log(`    🇫🇮 tarjouspalvelu: ZIP captured (${buf.length}B, ct=${result.ct})`);

    const texts = [];
    try {
      const zip = new admZipLib(buf);
      const entries = zip.getEntries();
      const SCORE_RULES = [
        { rx: /tarjouspyynt[öo]|request\s*for\s*quotation/i, score: 30 },
        { rx: /soveltuvuus\s*vaatimuks|soveltuvuuden|valintaperusteet|selection\s*criteria/i, score: 25 },
        { rx: /tekninen\s*(ja\s*ammatillinen)?\s*p[äa]tevyys|technical\s*capability/i, score: 18 },
        { rx: /taloudellinen|economic.*financial/i, score: 12 },
        { rx: /uea|espd|yhteinen\s*eurooppalainen/i, score: 10 },
        { rx: /vertailuperusteet|award\s*criteria/i, score: 8 },
      ];
      const scoreOf = (n) => {
        let s = 0;
        for (const r of SCORE_RULES) if (r.rx.test(n)) s = Math.max(s, r.score);
        return s;
      };
      const docEntries = entries
        .filter((e) => !e.isDirectory && /\.(pdf|docx?)$/i.test(e.entryName))
        .map((e) => ({ entry: e, score: scoreOf(e.entryName) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 6);
      console.log(`    🇫🇮 tarjouspalvelu: ZIP has ${entries.length} entries, parsing top ${docEntries.length} (PDFs/DOCXs)`);
      for (const item of docEntries) {
        const entry = item.entry;
        const name = entry.entryName.slice(-100);
        try {
          const data = entry.getData();
          let text = '';
          const isPdf = data[0] === 0x25 && data[1] === 0x50 && data[2] === 0x44 && data[3] === 0x46;
          const isDocx = /\.docx$/i.test(name);
          if (isPdf && pdfParseLib) {
            const parsed = await pdfParseLib(data);
            text = ((parsed && parsed.text) || '').trim();
          } else if (isDocx && mammothLib) {
            const out = await mammothLib.extractRawText({ buffer: data });
            text = ((out && out.value) || '').trim();
          }
          if (text.length > 200) {
            const clipped = text.slice(0, 80000);
            texts.push(`--- (tarjouspalvelu) ${name} ---\n${clipped}`);
            console.log(`    🇫🇮 tarjouspalvelu: parsed "${name}" (${data.length}B → ${clipped.length}ch, score=${item.score})`);
          } else {
            console.log(`    ⚠️  tarjouspalvelu: "${name}" extracted text too short (${text.length}ch)`);
          }
        } catch (e) {
          console.log(`    ⚠️  tarjouspalvelu: parse failed for "${name}": ${(e.message || '').slice(0, 80)}`);
        }
      }
    } catch (e) {
      console.log(`    ⚠️  tarjouspalvelu: ZIP parse error: ${(e.message || '').slice(0, 100)}`);
    }
    return texts;
  } catch (e) {
    console.log(`    ⚠️  tarjouspalvelu handler error: ${(e.message || String(e)).slice(0, 140)}`);
    return [];
  } finally {
    try { if (page) await page.close(); } catch (_) {}
  }
}

// =====================================================================
// fetchTendSignDocuments
// ---------------------------------------------------------------------
// TendSign (Visma Commerce) is a Swedish/Norwegian e-procurement
// platform used by many public buyers. Tender URLs are typically
// tendsign.com/Notice.aspx?UnikID=... — the announcement page itself
// is mostly metadata; the actual procurement-document attachments
// (Förfrågningsunderlag, Kvalificeringskrav, Bilagor) sit on the same
// domain under DownloadAttachment.aspx / DownloadDocument.aspx /
// GetFile.aspx routes that require a logged-in session. The portal is
// already in ALWAYS_LOGIN_HOSTS so by the time this handler runs the
// session cookie should be valid.
//
// Strategy (mirrors TenderNed handler):
//   1. Stealth + 1280×900 viewport (TendSign uses Vue/jQuery — not as
//      aggressive about headless detection as TenderNed's Angular but
//      doesn't hurt).
//   2. Navigate to source URL, settle DOM.
//   3. Diagnostic anchor probe so we can iterate if the heuristic
//      misses a tenant variant (TendSign has multiple skins).
//   4. Scan anchors for download patterns + score by Swedish/Norwegian
//      qualification vocabulary.
//   5. Top 6 docs fetched via in-page fetch() (carries auth cookie).
// =====================================================================
async function fetchTendSignDocuments(browser, sourceUrl) {
  try {
    const u = new URL(sourceUrl);
    if (!/(^|\.)tendsign\.com$/i.test(u.hostname)) return [];
    // Defense in depth — if the source URL is still the gated doc.aspx
    // variant (e.g. handler entered through a code path that bypassed
    // the rewriter in fetchSourcePageDetails), rewrite it now.
    if (/\/doc\.aspx/i.test(u.pathname)) {
      const noticeId = u.searchParams.get('MeFormsNoticeId') || u.searchParams.get('UnikID');
      if (noticeId && /^\d+$/.test(noticeId)) {
        sourceUrl = `https://tendsign.com/public/p_meformsnotice.aspx?MeFormsNoticeId=${noticeId}`;
      }
    }
  } catch (_) { return []; }

  let pdfParseLib = null, mammothLib = null, admZipLib = null;
  try { pdfParseLib = require('pdf-parse'); } catch (_) {}
  try { mammothLib  = require('mammoth');   } catch (_) {}
  try { admZipLib   = require('adm-zip');   } catch (_) {}

  let page = null;
  try {
    page = await browser.newPage();
    page.setDefaultNavigationTimeout(30000);
    page.setDefaultTimeout(30000);
    try { await page.setViewport({ width: 1280, height: 900 }); } catch (_) {}

    // Light stealth — TendSign mostly doesn't fingerprint, but some
    // Visma microservices reject the default HeadlessChrome UA.
    try {
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        Object.defineProperty(navigator, 'languages', {
          get: () => ['sv-SE', 'sv', 'en-US', 'en'],
        });
      });
      const ua = await page.browser().userAgent();
      await page.setUserAgent(ua.replace(/HeadlessChrome/i, 'Chrome'));
    } catch (_) {}

    try {
      await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e) {
      console.log(`    🇸🇪 tendsign: nav warn: ${(e.message || '').slice(0, 80)}`);
    }
    try { await page.waitForNetworkIdle({ idleTime: 1000, timeout: 10000 }); } catch (_) {}
    await new Promise((r) => setTimeout(r, 1200));

    // STEP 1 — find the Documents tab anchor on the Advertisement
    // (p_meformsnotice.aspx) page. User-confirmed DOM 2026-05-13:
    //   <a class="topmenulinkhighlight"
    //      href="p_documents.aspx?UniqueId=&MeFormsNoticeId=91596&DocumentID=&BuyerProjectID=<opaque>">
    //     Document
    //   </a>
    // BuyerProjectID is an opaque session token we can't construct —
    // must scrape it from the rendered page.
    if (/\/p_meformsnotice\.aspx/i.test(new URL(page.url()).pathname)) {
      // v4: handle THREE distinct TendSign Documents-tab anchor shapes:
      //   Flow A:  <a href="p_documents.aspx?MeFormsNoticeId=X&BuyerProjectID=Y">
      //   Flow B:  <a href="s_view_advertfiles.aspx?UniqueId=X&BuyerProjectID=Y">
      //   Flow C:  <a href="../doc.aspx?MeFormsNoticeId=X&Goto=Docs">
      // Flow C is what the PUBLIC anonymous view emits when no buyer-
      // session cookie is present (user-confirmed DOM 2026-05-14 for
      // MeFormsNoticeId=91377). Clicking lands on a login wall; once
      // attemptPortalLogin (tendsign now in ALWAYS_LOGIN_HOSTS) has
      // set cookies, the same doc.aspx URL redirects through the buyer
      // session and emits Flow A or Flow B at the next page. So we
      // accept doc.aspx?...&Goto=Docs as a valid Documents-tab match
      // and follow it; the existing Flow A/B post-redirect logic
      // handles whatever lands.
      // Flow B already leads to a "Next step" intermediate page that
      // posts to /supplier/s_view_advertfiles.aspx where the actual
      // document download links live.
      const docsTabUrl = await page.evaluate(() => {
        const anchors = Array.from(document.querySelectorAll('a[href]'));
        // Priority pass — Flow A/B with BuyerProjectID (buyer-authenticated
        // view; landing here means cookies already valid).
        for (const a of anchors) {
          const href = a.getAttribute('href') || '';
          if (!/(?:p_documents|s_view_advertfiles)\.aspx/i.test(href)) continue;
          if (!/BuyerProjectID=/i.test(href)) continue;
          try { return new URL(href, location.href).toString(); }
          catch (_) {}
        }
        return null;
      }).catch(() => null);

      // v5 — when Flow A/B with BuyerProjectID is NOT in the public
      // view, the page only exposes a Flow C anchor
      // (../doc.aspx?MeFormsNoticeId=X&Goto=Docs). Empirically (SE run
      // 2026-05-14, tenders 91538/91424/91377), navigating to that
      // Goto=Docs URL hits a login wall — apparently the buyer-side
      // session uses a different cookie scope than what login.aspx
      // sets when invoked from /public/. Sidestep this by navigating
      // to the bare doc.aspx?MeFormsNoticeId=<id> URL (NO Goto param);
      // with auth cookies present, tendsign renders the BUYER view of
      // the tender, which exposes Flow A or B anchors with proper
      // BuyerProjectID. Then we follow that anchor as usual.
      let resolvedDocsTabUrl = docsTabUrl;
      if (!resolvedDocsTabUrl) {
        // Extract MeFormsNoticeId from current URL (already on public
        // view) and probe doc.aspx without Goto.
        let noticeIdProbe = null;
        try {
          const cur = new URL(page.url());
          noticeIdProbe = cur.searchParams.get('MeFormsNoticeId') || cur.searchParams.get('UnikID');
        } catch (_) {}
        if (noticeIdProbe && /^\d+$/.test(noticeIdProbe)) {
          const buyerProbeUrl = `https://tendsign.com/doc.aspx?MeFormsNoticeId=${noticeIdProbe}`;
          console.log(`    🇸🇪 tendsign: no Flow A/B with BuyerProjectID on public view — probing buyer-view ${buyerProbeUrl}`);
          try {
            await page.goto(buyerProbeUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
            try { await page.waitForNetworkIdle({ idleTime: 1000, timeout: 8000 }); } catch (_) {}
            await new Promise((r) => setTimeout(r, 1200));
          } catch (e) {
            console.log(`    ⚠️  tendsign: buyer-view nav failed: ${(e.message || '').slice(0, 80)}`);
          }
          // Did we land on a login form? If so, cookies didn't carry —
          // bail; the Flow C path below would just hit the same wall.
          const buyerStillLogin = await page.evaluate(() => {
            const pathOk = /\/doc\.aspx/i.test(location.pathname);
            const passField = !!document.querySelector(
              'input[type="password"]:not([disabled]):not([aria-hidden="true"])'
            );
            return { onDocAspx: pathOk, hasPasswordField: passField, url: location.href };
          }).catch(() => ({ onDocAspx: false, hasPasswordField: false, url: '' }));
          if (buyerStillLogin.hasPasswordField || /\/login\.aspx/i.test(buyerStillLogin.url || '')) {
            // 2026-05-15 fix: tendsign's session is bound to the URL
            // navigation referrer — auth cookies from attemptPortalLogin
            // (set in a separate page context) DON'T carry into doc.aspx
            // fresh navigation. User-confirmed flow that DOES work in a
            // real browser:
            //   1. Visit doc.aspx?MeFormsNoticeId=X
            //   2. Tendsign 302s to login.aspx?URL=s_meformsnotice.aspx?MeFormsNoticeId=X
            //   3. Fill credentials INLINE in same tab + submit
            //   4. Tendsign creates session tied to THIS tender's URL
            //   5. Lands on buyer view with Documents tab visible
            // So we need to submit credentials in THIS page (not give up).
            console.log(`    🇸🇪 tendsign: buyer-view probe hit login wall — attempting INLINE login to establish tender-bound session`);
            const tsCreds = getPortalCreds('tendsign.com');
            if (!tsCreds || !tsCreds.username || !tsCreds.password) {
              console.log(`    ⚠️  tendsign: no credentials for inline login — bailing`);
            } else {
              // Find username + password fields on the login page.
              const sels = await page.evaluate(() => {
                const findVis = (selectors) => {
                  for (const sel of selectors) {
                    try {
                      const el = document.querySelector(sel);
                      if (el && el.offsetParent !== null) return sel;
                    } catch (_) {}
                  }
                  return null;
                };
                return {
                  userSel: findVis([
                    'input[type="email"]:not([disabled])',
                    'input[name="email" i]:not([disabled])',
                    'input[id*="username" i]:not([disabled])',
                    'input[id*="user" i]:not([disabled])',
                    'input[name*="user" i]:not([disabled])',
                    'input[type="text"]:not([disabled])',
                  ]),
                  passSel: findVis(['input[type="password"]:not([disabled])']),
                };
              }).catch(() => ({ userSel: null, passSel: null }));
              if (!sels.passSel) {
                console.log(`    ⚠️  tendsign: inline login — password field not found, bailing`);
              } else {
                try {
                  if (sels.userSel) {
                    await page.click(sels.userSel, { clickCount: 3 }).catch(() => null);
                    await page.type(sels.userSel, String(tsCreds.username), { delay: 20 });
                  }
                  await page.click(sels.passSel, { clickCount: 3 }).catch(() => null);
                  await page.type(sels.passSel, String(tsCreds.password), { delay: 20 });
                  // Find and submit. Tendsign's login form has
                  // UcomLogin_btn_Submit per earlier successful login.
                  let submitFired = false;
                  try {
                    await page.click('#UcomLogin_btn_Submit');
                    submitFired = true;
                  } catch (_) {
                    try {
                      await page.click('input[type="submit"]');
                      submitFired = true;
                    } catch (_) {
                      try { await page.keyboard.press('Enter'); submitFired = true; }
                      catch (_) {}
                    }
                  }
                  if (submitFired) {
                    console.log(`    🇸🇪 tendsign: inline login submitted — waiting for buyer view`);
                    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 25000 })
                      .catch(() => null);
                    await new Promise((r) => setTimeout(r, 1500));
                    // Verify we're past the login wall.
                    const afterLogin = await page.evaluate(() => ({
                      url: location.href,
                      hasPass: !!document.querySelector('input[type="password"]:not([disabled]):not([aria-hidden="true"])'),
                      bodyLen: (document.body?.innerText || '').length,
                    })).catch(() => null);
                    if (afterLogin && !afterLogin.hasPass) {
                      console.log(`    ✅ tendsign: inline login OK — on ${(afterLogin.url || '').slice(-60)}, bodyLen=${afterLogin.bodyLen}`);
                      // 2026-05-15 fix v2: when bodyLen is suspiciously
                      // small (e.g. 0) RIGHT after login, page might not
                      // have rendered yet — give it 3 more seconds.
                      if (afterLogin.bodyLen < 500) {
                        console.log(`    🇸🇪 tendsign: bodyLen=${afterLogin.bodyLen} suspicious — waiting extra 3s for render`);
                        await new Promise((r) => setTimeout(r, 3000));
                      }
                      // Now scan for Flow A/B anchor on this buyer view.
                      resolvedDocsTabUrl = await page.evaluate(() => {
                        const anchors = Array.from(document.querySelectorAll('a[href]'));
                        for (const a of anchors) {
                          const href = a.getAttribute('href') || '';
                          if (!/(?:p_documents|s_view_advertfiles)\.aspx/i.test(href)) continue;
                          if (!/BuyerProjectID=/i.test(href)) continue;
                          try { return new URL(href, location.href).toString(); }
                          catch (_) {}
                        }
                        return null;
                      }).catch(() => null);
                      if (resolvedDocsTabUrl) {
                        console.log(`    🇸🇪 tendsign: inline-login → Flow A/B URL with BuyerProjectID resolved`);
                      } else {
                        // 2026-05-15 fix v2: when inline login lands on
                        // /supplier/start.aspx (dashboard, not tender),
                        // navigate explicitly to the supplier-side
                        // tender URL — Tendsign serves a supplier view
                        // of each tender at /supplier/s_meformsnotice.aspx
                        // which includes the Documents tab anchor.
                        const onSupplierStart = /\/supplier\/start\.aspx/i.test(afterLogin.url || '');
                        if (onSupplierStart && noticeIdProbe) {
                          const supplierTenderUrl = `https://tendsign.com/supplier/s_meformsnotice.aspx?MeFormsNoticeId=${noticeIdProbe}`;
                          console.log(`    🇸🇪 tendsign: landed on /supplier/start.aspx — navigating to specific tender URL ${supplierTenderUrl}`);
                          try {
                            await page.goto(supplierTenderUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
                            try { await page.waitForNetworkIdle({ idleTime: 1000, timeout: 8000 }); } catch (_) {}
                            await new Promise((r) => setTimeout(r, 1500));
                            const supplierState = await page.evaluate(() => ({
                              url: location.href,
                              hasPass: !!document.querySelector('input[type="password"]:not([disabled]):not([aria-hidden="true"])'),
                              bodyLen: (document.body?.innerText || '').length,
                            })).catch(() => null);
                            console.log(`    🇸🇪 tendsign: supplier-tender page state: url=${(supplierState?.url || '').slice(-60)}, bodyLen=${supplierState?.bodyLen || 0}, hasPass=${supplierState?.hasPass || false}`);
                            // Re-scan for Flow A/B anchor on supplier view.
                            resolvedDocsTabUrl = await page.evaluate(() => {
                              const anchors = Array.from(document.querySelectorAll('a[href]'));
                              for (const a of anchors) {
                                const href = a.getAttribute('href') || '';
                                if (!/(?:p_documents|s_view_advertfiles)\.aspx/i.test(href)) continue;
                                if (!/BuyerProjectID=/i.test(href)) continue;
                                try { return new URL(href, location.href).toString(); }
                                catch (_) {}
                              }
                              return null;
                            }).catch(() => null);
                            if (resolvedDocsTabUrl) {
                              console.log(`    ✅ tendsign: supplier-tender nav → Flow A/B URL resolved`);
                            } else {
                              console.log(`    ⚠️  tendsign: supplier-tender page has no Flow A/B anchor — likely buyer hasn't approved our account for this tender`);
                            }
                          } catch (e) {
                            console.log(`    ⚠️  tendsign: supplier-tender nav failed: ${(e.message || '').slice(0, 80)}`);
                          }
                        } else {
                          console.log(`    ⚠️  tendsign: inline login OK but no Flow A/B anchor in DOM`);
                        }
                      }
                    } else {
                      // 2026-05-15 diagnostic: capture error messages /
                      // validation hints on the login page so we know
                      // WHY submit didn't clear password. Look for
                      // common Swedish/English login-fail signals
                      // (Invalid / Felaktig / Captcha / Account locked).
                      const failDiag = await page.evaluate(() => {
                        const body = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
                        // Heuristic — extract error-looking sentences.
                        const RX_ERR = /(invalid|incorrect|fel(aktig)?|wrong|locked|sp[äa]rrad|too\s*many|captcha|verifie?r|verify|s[äa]kerhets|tunnu(spa|spalv|sluo)|kontot)/i;
                        const sentences = body.split(/[.!?]\s+/).filter((s) => RX_ERR.test(s)).slice(0, 5);
                        return {
                          url: location.href,
                          bodyLen: body.length,
                          bodyHead: body.slice(0, 300),
                          errorHints: sentences,
                          // Look for elements with error-style class names.
                          errorElements: Array.from(document.querySelectorAll('[class*="error" i], [class*="alert" i], [class*="invalid" i], [class*="warning" i], .text-danger, .has-error, [role="alert"]'))
                            .slice(0, 5)
                            .map((el) => (el.innerText || '').trim().slice(0, 120))
                            .filter((t) => t.length > 0),
                        };
                      }).catch(() => null);
                      console.log(`    ⚠️  tendsign: inline login didn't clear password field — url=${(afterLogin?.url || '').slice(-60)}`);
                      if (failDiag) {
                        console.log(`    🔍 tendsign post-fail diag: bodyLen=${failDiag.bodyLen}, errorHints=${JSON.stringify(failDiag.errorHints)}, errorElements=${JSON.stringify(failDiag.errorElements)}`);
                        if (failDiag.bodyHead) console.log(`    🔍 tendsign post-fail body head: "${failDiag.bodyHead.slice(0, 250)}"`);
                      }
                    }
                  } else {
                    console.log(`    ⚠️  tendsign: inline login submit failed (no button matched)`);
                  }
                } catch (e) {
                  console.log(`    ⚠️  tendsign: inline login error: ${(e.message || '').slice(0, 80)}`);
                }
              }
            }
          } else {
            // Re-scan for Flow A/B anchors on the buyer view.
            resolvedDocsTabUrl = await page.evaluate(() => {
              const anchors = Array.from(document.querySelectorAll('a[href]'));
              for (const a of anchors) {
                const href = a.getAttribute('href') || '';
                if (!/(?:p_documents|s_view_advertfiles)\.aspx/i.test(href)) continue;
                if (!/BuyerProjectID=/i.test(href)) continue;
                try { return new URL(href, location.href).toString(); }
                catch (_) {}
              }
              return null;
            }).catch(() => null);
            if (resolvedDocsTabUrl) {
              console.log(`    🇸🇪 tendsign: buyer-view resolved → Flow A/B URL with BuyerProjectID`);
            } else {
              console.log(`    ⚠️  tendsign: buyer-view rendered but no Flow A/B anchor found`);
            }
          }
        }
      }
      // Re-bind for the navigation block below.
      const finalDocsTabUrl = resolvedDocsTabUrl;

      if (finalDocsTabUrl) {
        const flowLabel = /s_view_advertfiles/i.test(finalDocsTabUrl) ? 'B' : 'A';
        console.log(`    🇸🇪 tendsign: Documents tab (Flow ${flowLabel}) → ${finalDocsTabUrl.slice(0, 110)}`);
        try {
          await page.goto(finalDocsTabUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          try { await page.waitForNetworkIdle({ idleTime: 1000, timeout: 10000 }); } catch (_) {}
          await new Promise((r) => setTimeout(r, 1200));
        } catch (e) {
          console.log(`    ⚠️  tendsign: Documents tab nav failed: ${(e.message || '').slice(0, 80)}`);
        }

        // Flow B continuation — if we're on s_view_advertfiles.aspx
        // (NOT in /supplier/ yet), look for the "Next step" button.
        // User-confirmed onclick payload:
        //   document.location.href='../supplier/s_view_advertfiles.aspx?UniqueId=X&BuyerProjectID=Y'
        if (/s_view_advertfiles\.aspx/i.test(new URL(page.url()).pathname)
            && !/\/supplier\//i.test(new URL(page.url()).pathname)) {
          const nextStepUrl = await page.evaluate(() => {
            const RX_JS_HREF = /document\.location\.href\s*=\s*['"]([^'"]+)['"]/i;
            const inputs = Array.from(document.querySelectorAll('input[type="button"], input[type="submit"], button'));
            for (const el of inputs) {
              const val = (el.value || el.innerText || '').trim();
              if (!/^next\s*step$/i.test(val)) continue;
              const onclick = el.getAttribute('onclick') || '';
              const m = RX_JS_HREF.exec(onclick);
              if (m && m[1]) {
                try { return new URL(m[1], location.href).toString(); }
                catch (_) {}
              }
            }
            return null;
          }).catch(() => null);
          if (nextStepUrl) {
            console.log(`    🇸🇪 tendsign: Next step → ${nextStepUrl.slice(0, 110)}`);
            try {
              await page.goto(nextStepUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
              try { await page.waitForNetworkIdle({ idleTime: 1000, timeout: 10000 }); } catch (_) {}
              await new Promise((r) => setTimeout(r, 1200));
            } catch (e) {
              console.log(`    ⚠️  tendsign: Next step nav failed: ${(e.message || '').slice(0, 80)}`);
            }
          } else {
            console.log(`    ⚠️  tendsign: on s_view_advertfiles but no "Next step" button found`);
          }
        }
      } else {
        console.log(`    ⚠️  tendsign: no Documents tab anchor on p_meformsnotice.aspx — staying on Advertisement view`);
      }
    }

    // STEP 2 — scan for download URLs. Per user-confirmed DOM
    // 2026-05-13, each document is a <a href="javascript:void(0);"
    // onclick="javascript:window.open('../tools/download.aspx?Filename=
    //   X&ObjectType=1&ObjectID=<opaque>&PathType=1&Report=1', ...);">
    // <text>Document name</text></a>. The href is meaningless —
    // the real URL is inside the onclick string. Extract it with a
    // regex, resolve relative to the current page (which is on
    // /public/p_documents.aspx so ../tools/download.aspx →
    // /tools/download.aspx).
    const probe = await page.evaluate(() => {
      const RX_WINDOW_OPEN = /window\.open\(\s*['"]([^'"]+)['"]/i;
      const RX_DOC_PATH    = /\/(?:tools\/download|DownloadAttachment|DownloadDocument|DownloadFile|GetFile|GetDocument|Attachment(?:s)?|Document(?:s)?)\.aspx/i;
      const RX_DOC_EXT     = /\.(pdf|docx?|xlsx?|pptx?|zip|rtf|odt|ods)(?:[?&]|$)/i;
      const seen = new Set();
      const docs = [];
      const sampleHrefs = [];

      // Scan ALL anchors. TendSign mixes onclick-based JS download
      // anchors (the common case for downloadable files) with regular
      // href links (rare here but covered for safety).
      const anchors = Array.from(document.querySelectorAll('a'));
      for (const a of anchors) {
        const onclick = a.getAttribute('onclick') || '';
        const hrefRaw = a.getAttribute('href') || '';
        let candidate = null;

        // Case A — onclick contains window.open('<url>', ...)
        if (onclick) {
          const m = RX_WINDOW_OPEN.exec(onclick);
          if (m && m[1]) candidate = m[1];
        }
        // Case B — plain href to download.aspx or similar
        if (!candidate && hrefRaw && hrefRaw !== '#' && !/^javascript:/i.test(hrefRaw)
            && (RX_DOC_PATH.test(hrefRaw) || RX_DOC_EXT.test(hrefRaw))) {
          candidate = hrefRaw;
        }
        if (!candidate) continue;

        let abs, absHost;
        try {
          abs = new URL(candidate, location.href).toString();
          absHost = new URL(abs).hostname.toLowerCase();
        } catch (_) { continue; }
        if (!/(^|\.)tendsign\.com$/i.test(absHost)) continue;
        if (seen.has(abs)) continue;
        seen.add(abs);

        const text = ((a.innerText || a.textContent || '') + ' ' + (a.getAttribute('title') || ''))
          .trim().replace(/\s+/g, ' ').slice(0, 200);
        // Filter: must look like a doc download — either path is a
        // known download endpoint or URL has a file extension query.
        const url = new URL(abs);
        const isDownload = RX_DOC_PATH.test(url.pathname)
          || RX_DOC_EXT.test(url.pathname)
          || RX_DOC_EXT.test(url.search);
        if (!isDownload) continue;

        // Filename hint — TendSign passes the original filename in the
        // ?Filename= query. Use it for both display and scoring.
        const filenameParam = url.searchParams.get('Filename')
                            || url.searchParams.get('filename')
                            || '';
        const filename = filenameParam ? decodeURIComponent(filenameParam.replace(/\+/g, ' ')) : '';
        docs.push({
          url: abs,
          name: text || filename || abs.slice(-80),
          filename,
          source: onclick ? 'onclick' : 'href',
        });
        if (sampleHrefs.length < 12) {
          sampleHrefs.push({ url: abs.slice(0, 140), text: text.slice(0, 80), filename });
        }
        if (docs.length >= 60) break;
      }
      return { docs, totalAnchors: anchors.length, sampleHrefs };
    }).catch(() => ({ docs: [], totalAnchors: 0, sampleHrefs: [] }));

    console.log(
      `    🇸🇪 tendsign: page=${(new URL(page.url())).pathname.slice(-32)}, ${probe.totalAnchors} anchor(s), ` +
      `${probe.docs.length} doc candidate(s)`
    );
    if (!probe.docs.length) {
      console.log(
        `    🇸🇪 tendsign: no download anchors matched — sample hrefs: ` +
        JSON.stringify(probe.sampleHrefs.slice(0, 6))
      );
      return [];
    }

    // Score by Swedish/Norwegian qualification-doc vocabulary. Highest:
    // Kvalificeringskrav / Krav på anbudsgivaren / Skakrav (must-haves)
    // — the document classes the user explicitly cares about. Vocab
    // refined per user-confirmed DOM 2026-05-13 (Administrativa krav,
    // Generella krav, Krav på anbudsgivaren are recurring section
    // names on TendSign-hosted Swedish tenders).
    const SCORE_RULES = [
      { rx: /Kvalificering(?:skrav)?|Krav\s+p[åa]\s+(?:anbudsgivare|leverant[öo]r|leverand[øo]r)|Lev(?:erant[öo]r)?krav|Skakrav|qualification\s*criteria|tender(?:er)?\s+requirements/i, score: 30 },
      { rx: /Administrativa\s+krav|Generella\s+krav|Krav\s+p[åa]\s+(?:tj[äa]nsten|varan|leveransen)|Uteslutningsgrund/i, score: 25 },
      { rx: /F[öo]rfr[åa]gningsunderlag|FFU|Anbudsforesp[øo]rsel|Konkurransegrunnlag|Anskaffelsesdokument|RFT|RFP|tender\s*document|Upphandlingsf[öo]reskrifter/i, score: 18 },
      { rx: /AUC\b|Administrativa\s+f[öo]reskrifter|administrative\s*provisions/i, score: 12 },
      { rx: /Anbudsformul[äa]r|Tilbudsformular|tender\s*form|bid\s*form|Egenf[öo]rs[äa]kran|ESPD|UEA|Uniform\s*European|Anbudsinbjudan/i, score: 10 },
      { rx: /Utv[äa]rderingskriterier|Grund\s+f[öo]r\s+tilldelning|tilldelningskriterier|award\s*criteria|evaluation\s*criteria/i, score: 8 },
      { rx: /Bilaga|Bilagor|Attachment|Vedlegg|appendix|H[åa]llbarhet|Sanningsf[öo]rs[äa]kran/i, score: 5 },
    ];
    for (const d of probe.docs) {
      d.score = 0;
      // Score against the human-readable anchor text, the URL, AND
      // the decoded filename (often the most specific signal — e.g.
      // "2.Administrativa+krav-1.pdf" → "Administrativa krav").
      const targets = [d.name || '', d.url || '', d.filename || ''];
      for (const r of SCORE_RULES) {
        for (const t of targets) {
          if (r.rx.test(t)) { d.score = Math.max(d.score, r.score); break; }
        }
      }
    }
    probe.docs.sort((a, b) => b.score - a.score);
    const topDocs = probe.docs.slice(0, 6);
    console.log(
      `    🇸🇪 tendsign: priority docs: ` +
      topDocs.map((d) => `${(d.filename || d.name).slice(0, 40)}[s=${d.score}]`).join(' | ')
    );

    // v3 — CDP download manager. /tools/download.aspx returns HTML for
    // anonymous fetch() requests (ASP.NET ViewState/auth wall), even on
    // /public/ pages. Real browser uses window.open() which inherits
    // the page's session AND triggers a real download. We enable
    // Browser.setDownloadBehavior so files land on disk; if fetch path
    // fails we navigate to the URL directly (mirroring window.open).
    let cdpSession = null, downloadDir = null;
    try {
      const os = require('os');
      const fs = require('fs');
      const path = require('path');
      downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tendsign-dl-'));
      cdpSession = await page.target().createCDPSession();
      await cdpSession.send('Browser.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: downloadDir,
      }).catch(() => null);
      await cdpSession.send('Page.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: downloadDir,
      }).catch(() => null);
    } catch (_) {}

    const texts = [];
    for (const doc of topDocs) {
      const labelName = (doc.filename || doc.name).slice(0, 100);
      // STEP 1 — try fetch first (faster, no disk I/O). If it returns
      // a real PDF/DOCX it's a win; if it returns HTML (auth wall) we
      // fall through to STEP 2.
      const result = await page.evaluate(async (url) => {
        try {
          const resp = await fetch(url, { credentials: 'include', redirect: 'follow' });
          if (!resp.ok) return { ok: false, status: resp.status };
          const ct = resp.headers.get('content-type') || '';
          const cd = resp.headers.get('content-disposition') || '';
          const ab = await resp.arrayBuffer();
          return {
            ok: true,
            status: resp.status,
            ct, cd,
            url: resp.url || url,
            data: Array.from(new Uint8Array(ab)),
          };
        } catch (e) {
          return { ok: false, error: String(e).slice(0, 200) };
        }
      }, doc.url).catch((e) => ({ ok: false, error: e.message }));

      let buf = null;
      let viaDisk = false;
      if (result && result.ok && result.data && result.data.length > 500) {
        const tmpBuf = Buffer.from(result.data);
        const isHtmlAuthWall = /<!doctype\s+html|<html|<head/i.test(tmpBuf.slice(0, 200).toString('utf8'));
        if (!isHtmlAuthWall) {
          buf = tmpBuf;
        } else {
          console.log(`    🇸🇪 tendsign: "${labelName.slice(0, 40)}" — fetch got HTML, trying CDP download`);
        }
      }
      // STEP 2 — CDP download via navigation. ASP.NET /tools/download.aspx
      // serves PDFs only when the request comes through a session-bearing
      // browser navigation. page.goto on a download URL triggers Chromium's
      // download manager (with downloadPath set), writes file to disk.
      if (!buf && cdpSession && downloadDir) {
        try {
          const fs = require('fs');
          const path = require('path');
          // Snapshot existing files so we can detect the new one.
          const before = new Set();
          try { for (const n of fs.readdirSync(downloadDir)) before.add(n); } catch (_) {}
          // Navigate to the URL — for downloads, page.goto throws
          // "net::ERR_ABORTED" once the response is treated as download.
          // That's expected; the file still writes to disk.
          await page.goto(doc.url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null);
          // Poll for new file appearing.
          const deadline = Date.now() + 12000;
          let downloadedPath = null;
          while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 400));
            let names = [];
            try { names = fs.readdirSync(downloadDir); } catch (_) {}
            const fresh = names.filter((n) => !before.has(n) && !/\.crdownload$/i.test(n));
            if (fresh.length > 0) {
              let biggest = null;
              for (const n of fresh) {
                try {
                  const p = path.join(downloadDir, n);
                  const st = fs.statSync(p);
                  if (st.isFile() && st.size > 500) {
                    if (!biggest || st.size > biggest.size) biggest = { path: p, size: st.size };
                  }
                } catch (_) {}
              }
              if (biggest) { downloadedPath = biggest.path; break; }
            }
          }
          if (downloadedPath) {
            buf = fs.readFileSync(downloadedPath);
            viaDisk = true;
            console.log(`    🇸🇪 tendsign: "${labelName.slice(0, 40)}" — CDP download OK (${buf.length}B)`);
          } else {
            console.log(`    ⚠️  tendsign: "${labelName.slice(0, 40)}" — CDP polling timed out`);
          }
        } catch (e) {
          console.log(`    ⚠️  tendsign: CDP download error for "${labelName.slice(0, 40)}": ${(e.message || '').slice(0, 80)}`);
        }
      }
      if (!buf) {
        const status = result?.status || result?.error || '?';
        console.log(`    ⚠️  tendsign: download failed for "${labelName}" (fetch=${status}, disk=${viaDisk})`);
        continue;
      }
      // ct only meaningful for fetch path; CDP path uses magic bytes.
      const ctL = (result && result.ok ? (result.ct || '') : '').toLowerCase();
      // Filename hint check — TendSign's download.aspx wraps every
      // file with the same path so we can't rely on URL path extension;
      // the original filename comes through doc.filename (decoded from
      // ?Filename= query). Combine ext detection across path + query +
      // filename hint + content-type.
      const filenameHint = (doc.filename || '').toLowerCase();
      const isPdf = (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46);
      const isDocx = ctL.includes('officedocument.wordprocessingml')
        || /\.docx?$/i.test(filenameHint)
        || (buf[0] === 0x50 && buf[1] === 0x4b && /\.docx(?:[?#]|$)/i.test(doc.url));
      const isZip = !isDocx && buf[0] === 0x50 && buf[1] === 0x4b
        && (ctL.includes('zip') || /\.zip(?:[?#]|$)/i.test(doc.url) || /\.zip$/i.test(filenameHint));
      try {
        let text = '';
        if (isPdf && pdfParseLib) {
          const parsed = await pdfParseLib(buf);
          text = ((parsed && parsed.text) || '').trim();
        } else if (isDocx && mammothLib) {
          const out = await mammothLib.extractRawText({ buffer: buf });
          text = ((out && out.value) || '').trim();
        } else if (isZip && admZipLib) {
          // ZIP fallback — Bilagor sometimes ship as a single archive.
          // Parse first 4 PDF/DOCX entries, concatenate.
          try {
            const zip = new admZipLib(buf);
            const entries = zip.getEntries()
              .filter((e) => !e.isDirectory && /\.(pdf|docx?)$/i.test(e.entryName))
              .slice(0, 4);
            for (const e of entries) {
              const d = e.getData();
              const isInnerPdf = d[0] === 0x25 && d[1] === 0x50 && d[2] === 0x44 && d[3] === 0x46;
              if (isInnerPdf && pdfParseLib) {
                const p = await pdfParseLib(d);
                if (p && p.text) text += `\n--- ${e.entryName.slice(-80)} ---\n${p.text.trim()}`;
              } else if (/\.docx$/i.test(e.entryName) && mammothLib) {
                const o = await mammothLib.extractRawText({ buffer: d });
                if (o && o.value) text += `\n--- ${e.entryName.slice(-80)} ---\n${o.value.trim()}`;
              }
            }
            text = text.trim();
          } catch (_) {}
        }
        if (text.length > 200) {
          const clipped = text.slice(0, 80000);
          texts.push(`--- (tendsign) ${labelName} ---\n${clipped}`);
          console.log(`    🇸🇪 tendsign: parsed "${labelName}" (${buf.length}B → ${clipped.length}ch, score=${doc.score})`);
        } else {
          console.log(
            `    ⚠️  tendsign: "${labelName}" extracted text too short ` +
            `(${text.length}ch, isPdf=${isPdf}, isDocx=${isDocx}, isZip=${isZip}, ct=${ctL.slice(0, 40)})`
          );
        }
      } catch (e) {
        console.log(`    ⚠️  tendsign: parse failed for "${labelName}": ${(e.message || '').slice(0, 80)}`);
      }
    }
    // v3 cleanup — detach CDP + rm tmp download dir.
    try { if (cdpSession) await cdpSession.detach(); } catch (_) {}
    try {
      if (downloadDir) {
        const fs = require('fs');
        fs.rmSync(downloadDir, { recursive: true, force: true });
      }
    } catch (_) {}
    return texts;
  } catch (e) {
    console.log(`    ⚠️  tendsign handler error: ${(e.message || String(e)).slice(0, 140)}`);
    return [];
  } finally {
    try { if (page) await page.close(); } catch (_) {}
  }
}

// =====================================================================
// fetchEavropDocuments
// ---------------------------------------------------------------------
// e-avrop.com (Antirio platform) tender pages render a "Documents"
// section after login (Announcement.aspx). Each individual document is
// listed inside an iframe (which the post-auth iframe-merge in
// fetchSourcePageDetails already picks up for text-extraction). But
// the SAME section also exposes a single one-click bulk-download:
//
//   <a id="mainContent_createZip"
//      title="Download ZIP-file including full documentation"
//      href="javascript:__doPostBack('ctl00$mainContent$createZip','')">
//     All documents
//   </a>
//
// Clicking this fires an ASP.NET postback that streams back a ZIP
// containing every attachment. That gives us PDF/DOCX content for the
// qualification-requirements extractor — without iframe parsing or
// per-document download URLs (which aren't trivially extractable; they
// require ASPX ViewState replay).
//
// Strategy (mirrors tendsign Flow B + tenderned bulk-ZIP):
//   1. New page, stealth.
//   2. Navigate to source URL (assumes login already done — host is in
//      ALWAYS_LOGIN_HOSTS, so the browser's cookie jar carries auth).
//   3. Set up CDP download manager pointing to a tmp dir.
//   4. Wait for #mainContent_createZip to appear (max 10s).
//   5. Fire __doPostBack('ctl00$mainContent$createZip','') via eval —
//      ASP.NET will write the ZIP to the download stream and Chromium
//      writes it to disk.
//   6. Poll the tmp dir for the new .zip file.
//   7. Parse with adm-zip, extract PDFs/DOCXs, score by qualification
//      vocabulary, concatenate up to 4 docs' text.
//   8. Return [] no-op for non-e-avrop sources.
// =====================================================================
async function fetchEavropDocuments(browser, sourceUrl) {
  try {
    const u = new URL(sourceUrl);
    if (!/(^|\.)e-avrop\.com$/i.test(u.hostname)) return [];
  } catch (_) { return []; }

  let pdfParseLib = null, mammothLib = null, admZipLib = null;
  try { pdfParseLib = require('pdf-parse'); } catch (_) {}
  try { mammothLib  = require('mammoth');   } catch (_) {}
  try { admZipLib   = require('adm-zip');   } catch (_) {}
  if (!admZipLib) {
    console.log(`    ⚠️  e-avrop: adm-zip not available — skipping bulk ZIP fetch`);
    return [];
  }

  let page = null;
  let cdpSession = null;
  let downloadDir = null;
  try {
    const os = require('os');
    const fs = require('fs');
    const path = require('path');

    page = await browser.newPage();
    page.setDefaultNavigationTimeout(30000);
    page.setDefaultTimeout(30000);
    try { await page.setViewport({ width: 1280, height: 900 }); } catch (_) {}

    // Light stealth — Antirio occasionally rejects default HeadlessChrome.
    try {
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        Object.defineProperty(navigator, 'languages', {
          get: () => ['sv-SE', 'sv', 'en-US', 'en'],
        });
      });
      const ua = await page.browser().userAgent();
      await page.setUserAgent(ua.replace(/HeadlessChrome/i, 'Chrome'));
    } catch (_) {}

    // CDP download manager — set up BEFORE navigation so the createZip
    // postback's response is intercepted as a download.
    try {
      downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eavrop-dl-'));
      cdpSession = await page.target().createCDPSession();
      await cdpSession.send('Browser.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: downloadDir,
      }).catch(() => null);
      await cdpSession.send('Page.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: downloadDir,
      }).catch(() => null);
    } catch (_) {}

    try {
      await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e) {
      console.log(`    🇸🇪 e-avrop: nav warn: ${(e.message || '').slice(0, 80)}`);
    }
    try { await page.waitForNetworkIdle({ idleTime: 1000, timeout: 8000 }); } catch (_) {}
    await new Promise((r) => setTimeout(r, 1500));
    // Belt-and-braces — e-avrop's Announcement.aspx loads its main
    // content (including Documents section) via deferred XHR; the
    // post-auth-settle path in fetchSourcePageDetails uses 5s + 1.5s.
    // Wait specifically for the createZip anchor to appear, max 10s.
    let createZipFound = false;
    try {
      await page.waitForSelector('#mainContent_createZip', { timeout: 10000 });
      createZipFound = true;
    } catch (_) { /* will look in iframe / SubscribeBtn fallback */ }

    if (!createZipFound) {
      // 2026-05-15 fix v3: SubscribeBtn FIRST (on Announcement.aspx
      // main page where it exists), THEN iframe URL navigation.
      // Earlier v2 order navigated to iframe URL FIRST and looked for
      // SubscribeBtn AFTER — but SubscribeBtn lives on Announcement.aspx,
      // not on the supplier iframe URL, so the click never happened.
      // SE run 2026-05-15 confirmed: iframe URL has "Documents" section
      // but #mainContent_createZip anchor is missing until user is
      // registered as interested supplier (via SubscribeBtn click on
      // main page).
      //
      // Fallback A: click SubscribeBtn on Announcement.aspx (registers
      // user as interested supplier — invasive but unblocks docs).
      const hasSubscribeBtn = await page.evaluate(() => {
        return !!document.querySelector('#navigationContent_SubscribeBtn');
      }).catch(() => false);
      if (hasSubscribeBtn) {
        console.log(`    🇸🇪 e-avrop: createZip not found on main → firing SubscribeBtn (registers user as interested supplier)`);
        let fired = 'no-attempt';
        try {
          await page.click('#navigationContent_SubscribeBtn');
          fired = 'page.click';
        } catch (_) {
          try {
            fired = await page.evaluate(() => {
              const el = document.querySelector('#navigationContent_SubscribeBtn');
              if (!el) return 'no-element';
              const href = el.getAttribute('href') || '';
              const m = /^\s*javascript:\s*(.*)$/i.exec(href);
              if (m && m[1]) {
                try { (0, eval)(m[1]); return 'eval-href'; }
                catch (e) { return 'eval-error:' + String(e).slice(0, 40); }
              }
              return 'no-href';
            }).catch((e) => 'evaluate-error:' + (e.message || '').slice(0, 40));
          } catch (e) { fired = 'click-error:' + (e.message || '').slice(0, 40); }
        }
        console.log(`    🇸🇪 e-avrop: SubscribeBtn trigger = ${fired}`);
        try { await page.waitForNetworkIdle({ idleTime: 1000, timeout: 10000 }); } catch (_) {}
        await new Promise((r) => setTimeout(r, 2000));
        // Check createZip on main page after SubscribeBtn — postback
        // may have re-rendered with createZip now visible.
        try {
          await page.waitForSelector('#mainContent_createZip', { timeout: 5000 });
          createZipFound = true;
          console.log(`    🇸🇪 e-avrop: createZip now visible on main page after SubscribeBtn`);
        } catch (_) { /* may need iframe URL nav next */ }
      }
    }

    if (!createZipFound) {
      // Fallback B: navigate to the supplier-side procurement view.
      // After SubscribeBtn click (above), user is registered as
      // interested supplier and the supplier-side iframe URL
      // (/<tenant>/e-Upphandling/leverantor/annons/procurement.aspx?id=X&ownerid=Y)
      // should now expose #mainContent_createZip. We navigate there
      // because some tenders only show createZip on the supplier
      // iframe page (not on Announcement.aspx).
      const iframeUrl = await page.evaluate(() => {
        const iframes = Array.from(document.querySelectorAll('iframe'));
        for (const f of iframes) {
          const src = f.getAttribute('src') || '';
          if (!src) continue;
          if (/leverantor\/annons\/procurement\.aspx\?/i.test(src)) {
            try { return new URL(src, location.href).toString(); }
            catch (_) {}
          }
        }
        return null;
      }).catch(() => null);
      if (iframeUrl) {
        console.log(`    🇸🇪 e-avrop: trying supplier iframe URL after SubscribeBtn → ${iframeUrl.slice(0, 110)}`);
        try {
          await page.goto(iframeUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
          try { await page.waitForNetworkIdle({ idleTime: 1000, timeout: 8000 }); } catch (_) {}
          await new Promise((r) => setTimeout(r, 1500));
        } catch (e) {
          console.log(`    ⚠️  e-avrop: iframe URL nav failed: ${(e.message || '').slice(0, 80)}`);
        }
        try {
          await page.waitForSelector('#mainContent_createZip', { timeout: 8000 });
          createZipFound = true;
          console.log(`    🇸🇪 e-avrop: createZip visible on supplier iframe URL`);
        } catch (_) { /* still missing — bail */ }
      }
    }

    if (!createZipFound) {
      // Diagnostic — log whether the Documents section exists at all,
      // and dump the first few <a id="mainContent_*"> anchors so we can
      // iterate if Antirio re-renames the ID.
      const diag = await page.evaluate(() => {
        const sections = Array.from(document.querySelectorAll('.section, h1, h2, h3'))
          .map((el) => (el.innerText || '').trim().slice(0, 40))
          .filter((t) => t.length > 0);
        const anchors = Array.from(document.querySelectorAll('a[id*="mainContent" i], a[href*="createZip" i], a[href*="__doPostBack" i]'))
          .slice(0, 8)
          .map((a) => ({
            id: a.id || '',
            href: (a.getAttribute('href') || '').slice(0, 80),
            text: (a.innerText || '').trim().slice(0, 30),
          }));
        return {
          url: location.href,
          bodyLen: (document.body?.innerText || '').length,
          sections: sections.slice(0, 12),
          anchors,
        };
      }).catch(() => null);
      console.log(`    ⚠️  e-avrop: #mainContent_createZip not found (after iframe + SubscribeBtn fallbacks) — ${JSON.stringify(diag).slice(0, 300)}`);
      return [];
    }

    console.log(`    🇸🇪 e-avrop: #mainContent_createZip found — firing __doPostBack for bulk ZIP`);

    // Snapshot existing files before triggering the postback.
    const before = new Set();
    try { for (const n of fs.readdirSync(downloadDir)) before.add(n); } catch (_) {}

    // Fire the postback. 2026-05-14 fix v2 — avoid the strict-mode
    // pitfall (Antirio's __doPostBack uses `arguments.callee` which
    // V8 rejects when called from page.evaluate strict scope). Prefer
    // page.click() which navigates via the page's non-strict context;
    // fall back to indirect-eval `(0, eval)(payload)` of the href's
    // javascript: payload.
    let fired = 'no-attempt';
    try {
      await page.click('#mainContent_createZip');
      fired = 'page.click';
    } catch (_) {
      try {
        fired = await page.evaluate(() => {
          const el = document.querySelector('#mainContent_createZip');
          if (!el) return 'no-element';
          const href = el.getAttribute('href') || '';
          const m = /^\s*javascript:\s*(.*)$/i.exec(href);
          if (m && m[1]) {
            try {
              (0, eval)(m[1]);
              return 'eval-href';
            } catch (e) {
              return 'eval-error:' + String(e).slice(0, 50);
            }
          }
          return 'no-href';
        }).catch((e) => 'evaluate-error:' + (e.message || '').slice(0, 50));
      } catch (e) { fired = 'click-error:' + (e.message || '').slice(0, 50); }
    }
    console.log(`    🇸🇪 e-avrop: postback trigger result = ${fired}`);

    // Poll the download dir for a fresh .zip — bulk ZIP can take a few
    // seconds for big tenders. 30s total, 400ms poll interval.
    const deadline = Date.now() + 30000;
    let zipPath = null;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 400));
      let names = [];
      try { names = fs.readdirSync(downloadDir); } catch (_) {}
      // Ignore .crdownload (in-flight) — wait for the rename to final.
      const fresh = names.filter((n) => !before.has(n) && !/\.crdownload$/i.test(n));
      if (fresh.length > 0) {
        let biggest = null;
        for (const n of fresh) {
          try {
            const p = path.join(downloadDir, n);
            const st = fs.statSync(p);
            if (st.isFile() && st.size > 500) {
              if (!biggest || st.size > biggest.size) biggest = { path: p, size: st.size };
            }
          } catch (_) {}
        }
        if (biggest) { zipPath = biggest.path; break; }
      }
    }
    if (!zipPath) {
      console.log(`    ⚠️  e-avrop: ZIP download polling timed out (no new file in ${downloadDir})`);
      return [];
    }
    const zipBuf = fs.readFileSync(zipPath);
    console.log(`    🇸🇪 e-avrop: ZIP downloaded (${zipBuf.length}B) — parsing entries`);

    // Verify magic bytes — must be PK\003\004.
    if (!(zipBuf[0] === 0x50 && zipBuf[1] === 0x4b && zipBuf[2] === 0x03 && zipBuf[3] === 0x04)) {
      console.log(
        `    ⚠️  e-avrop: downloaded file is not a ZIP ` +
        `(magic=${zipBuf.slice(0, 4).toString('hex')}, head=${zipBuf.slice(0, 80).toString('utf8').replace(/[^\x20-\x7e]/g, '?').slice(0, 60)})`
      );
      return [];
    }

    // Parse + score ZIP entries. Vocabulary mirrors tendsign's Swedish
    // qualification rules so the highest-priority files (Kvalificerings-
    // krav, Administrativa krav, FFU) bubble to the top.
    const SCORE_RULES = [
      { rx: /Kvalificering(?:skrav)?|Krav\s+p[åa]\s+(?:anbudsgivare|leverant[öo]r|leverand[øo]r)|Lev(?:erant[öo]r)?krav|Skakrav|qualification\s*criteria|tender(?:er)?\s+requirements/i, score: 30 },
      { rx: /Administrativa\s+krav|Generella\s+krav|Krav\s+p[åa]\s+(?:tj[äa]nsten|varan|leveransen)|Uteslutningsgrund/i, score: 25 },
      { rx: /F[öo]rfr[åa]gningsunderlag|FFU|Anbudsforesp[øo]rsel|Konkurransegrunnlag|Anskaffelsesdokument|RFT|RFP|tender\s*document|Upphandlingsf[öo]reskrifter/i, score: 18 },
      { rx: /AUC\b|Administrativa\s+f[öo]reskrifter|administrative\s*provisions/i, score: 12 },
      { rx: /Anbudsformul[äa]r|Tilbudsformular|tender\s*form|bid\s*form|Egenf[öo]rs[äa]kran|ESPD|UEA|Uniform\s*European|Anbudsinbjudan/i, score: 10 },
      { rx: /Utv[äa]rderingskriterier|Grund\s+f[öo]r\s+tilldelning|tilldelningskriterier|award\s*criteria|evaluation\s*criteria/i, score: 8 },
      { rx: /Bilaga|Bilagor|Attachment|Vedlegg|appendix|H[åa]llbarhet|Sanningsf[öo]rs[äa]kran/i, score: 5 },
    ];
    let entries;
    try {
      const zip = new admZipLib(zipBuf);
      entries = zip.getEntries()
        .filter((e) => !e.isDirectory && /\.(pdf|docx?)$/i.test(e.entryName))
        .map((e) => {
          let score = 0;
          for (const r of SCORE_RULES) {
            if (r.rx.test(e.entryName)) { score = Math.max(score, r.score); break; }
          }
          return { entry: e, name: e.entryName, score };
        })
        .sort((a, b) => b.score - a.score);
    } catch (e) {
      console.log(`    ⚠️  e-avrop: adm-zip parse failed: ${(e.message || '').slice(0, 100)}`);
      return [];
    }
    if (!entries.length) {
      console.log(`    ⚠️  e-avrop: ZIP had no PDF/DOCX entries`);
      return [];
    }
    console.log(
      `    🇸🇪 e-avrop: priority docs in ZIP: ` +
      entries.slice(0, 8).map((x) => `${x.name.split('/').pop().slice(0, 40)}[s=${x.score}]`).join(' | ')
    );

    const texts = [];
    for (const x of entries.slice(0, 4)) {
      try {
        const data = x.entry.getData();
        const isPdf = data[0] === 0x25 && data[1] === 0x50 && data[2] === 0x44 && data[3] === 0x46;
        let text = '';
        if (isPdf && pdfParseLib) {
          const parsed = await pdfParseLib(data);
          text = ((parsed && parsed.text) || '').trim();
        } else if (/\.docx$/i.test(x.name) && mammothLib) {
          const out = await mammothLib.extractRawText({ buffer: data });
          text = ((out && out.value) || '').trim();
        }
        if (text.length > 200) {
          const clipped = text.slice(0, 80000);
          texts.push(`--- (e-avrop) ${x.name.split('/').pop()} ---\n${clipped}`);
          console.log(`    🇸🇪 e-avrop: parsed "${x.name.split('/').pop().slice(0, 40)}" (${data.length}B → ${clipped.length}ch, score=${x.score})`);
        } else {
          console.log(`    ⚠️  e-avrop: "${x.name.split('/').pop().slice(0, 40)}" extracted text too short (${text.length}ch)`);
        }
      } catch (e) {
        console.log(`    ⚠️  e-avrop: parse failed for "${x.name.slice(0, 40)}": ${(e.message || '').slice(0, 80)}`);
      }
    }
    return texts;
  } catch (e) {
    console.log(`    ⚠️  e-avrop handler error: ${(e.message || String(e)).slice(0, 140)}`);
    return [];
  } finally {
    try { if (cdpSession) await cdpSession.detach(); } catch (_) {}
    try {
      if (downloadDir) {
        const fs = require('fs');
        fs.rmSync(downloadDir, { recursive: true, force: true });
      }
    } catch (_) {}
    try { if (page) await page.close(); } catch (_) {}
  }
}

// =====================================================================
// fetchKommersAnnonsDocuments
// ---------------------------------------------------------------------
// kommersannons.se (Kommers Annons / "FMV" platform, ASP.NET WebForms)
// is a Swedish multi-tenant procurement portal. Each tender lives under
// /<tenant>/Notice/NoticeDispatch.aspx?NoticeId=X. The default landing
// shows only the announcement summary — actual documents are revealed
// under explicit nav tabs after login. The standard post-login body
// looks like:
//
//   "Tender notice overview / Registration / Decline participation /
//    Contract documents / Entire tender form / Appendices /
//    Questions and answers / Additions / Create tender"
//
// "Contract documents" / "Entire tender form" / "Appendices" are the
// useful tabs for qualification extraction. Each is typically an
// ASP.NET __doPostBack anchor or a regular href like:
//   /<tenant>/Notice/Documents.aspx?NoticeId=X
//   /<tenant>/Notice/RequestForTender.aspx?NoticeId=X
//   /<tenant>/Notice/Appendices.aspx?NoticeId=X
//
// Strategy:
//   1. New page, Swedish locale, auth cookies from attemptPortalLogin.
//   2. Navigate to source URL (NoticeDispatch.aspx?NoticeId=X).
//   3. Find tab anchors by text match (EN/SV/NO synonyms).
//   4. For each found tab URL, navigate, scan for PDF/DOCX/ZIP anchors.
//   5. Fetch + parse via in-page fetch (carries session cookies).
//   6. Score by Swedish qualification vocab, parse top 6 docs.
//   7. Return [`--- (kommersannons) name ---\ntext`].
//
// Diagnostic-heavy because we don't have full DOM inspection of all
// possible tab URL variants — log every step so we can iterate.
// =====================================================================
async function fetchKommersAnnonsDocuments(browser, sourceUrl) {
  try {
    const u = new URL(sourceUrl);
    if (!/(^|\.)kommersannons\.se$/i.test(u.hostname)) return [];
  } catch (_) { return []; }

  let pdfParseLib = null, mammothLib = null, admZipLib = null;
  try { pdfParseLib = require('pdf-parse'); } catch (_) {}
  try { mammothLib  = require('mammoth');   } catch (_) {}
  try { admZipLib   = require('adm-zip');   } catch (_) {}

  let page = null;
  try {
    page = await browser.newPage();
    page.setDefaultNavigationTimeout(25000);
    page.setDefaultTimeout(25000);
    try { await page.setViewport({ width: 1280, height: 900 }); } catch (_) {}

    try {
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        Object.defineProperty(navigator, 'languages', {
          get: () => ['sv-SE', 'sv', 'en-US', 'en'],
        });
      });
      const ua = await page.browser().userAgent();
      await page.setUserAgent(ua.replace(/HeadlessChrome/i, 'Chrome'));
    } catch (_) {}

    try {
      await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
    } catch (e) {
      console.log(`    🇸🇪 kommersannons: nav warn: ${(e.message || '').slice(0, 80)}`);
    }
    try { await page.waitForNetworkIdle({ idleTime: 1000, timeout: 8000 }); } catch (_) {}
    await new Promise((r) => setTimeout(r, 1500));

    // STEP 1 — find the document-tab anchors. They're typically <a> with
    // href to a sibling /Notice/<TabName>.aspx?NoticeId=X URL, OR an
    // __doPostBack anchor that triggers a navigate via JS. Match by
    // text: EN ("Contract documents" / "Entire tender form" /
    // "Appendices"), SV ("Avtalshandlingar" / "Förfrågningsunderlag" /
    // "Bilagor"), NO ("Kontraktsdokumenter" / "Konkurransegrunnlag" /
    // "Vedlegg"). Score order — higher = more likely to contain
    // qualifications.
    const TAB_RULES = [
      // "Entire tender form" / "Hela förfrågningsunderlaget" — usually
      // contains everything including qualifications. Highest priority.
      { rx: /entire\s*tender\s*form|hela\s*f[öo]rfr[åa]gningsunderlaget|f[öo]rfr[åa]gningsunderlag|konkurransegrunnlag|tender\s*documents|whole\s*tender\s*form/i, score: 40, label: 'TenderForm' },
      // "Appendices" / "Bilagor" — contains Pliegos / annexes.
      { rx: /^\s*appendices\s*$|^\s*bilagor\s*$|^\s*vedlegg\s*$|^\s*attachments\s*$/i, score: 35, label: 'Appendices' },
      // "Contract documents" / "Avtalshandlingar" — contract draft + docs.
      { rx: /contract\s*documents|avtalshandlingar|kontraktsdokumenter|kontrakts(?:\s*dokument)?/i, score: 25, label: 'Contract' },
    ];

    const tabProbe = await page.evaluate((rules) => {
      const anchors = Array.from(document.querySelectorAll('a, button, [role="button"], input[type="button"], input[type="submit"]'));
      const allTexts = [];
      const matched = [];
      const seenUrl = new Set();
      for (const a of anchors) {
        const text = (a.innerText || a.value || a.textContent || a.getAttribute('aria-label') || '').trim();
        if (!text || text.length > 100) continue;
        allTexts.push(text.slice(0, 60));
        for (const r of rules) {
          const rx = new RegExp(r.rx.source, r.rx.flags);
          if (!rx.test(text)) continue;
          const hrefRaw = a.getAttribute('href') || '';
          const onclick = a.getAttribute('onclick') || '';
          let target = null;
          if (hrefRaw && !/^javascript:/i.test(hrefRaw) && hrefRaw !== '#') {
            try { target = new URL(hrefRaw, location.href).toString(); }
            catch (_) {}
          }
          // __doPostBack anchors — record the eventTarget so we can
          // navigate via the resulting URL parameter (kommersannons
          // often uses Response.Redirect post-postback).
          if (!target && /__doPostBack\(/.test(hrefRaw + ' ' + onclick)) {
            target = `postback:${(hrefRaw || onclick).match(/__doPostBack\(\s*['"]([^'"]+)['"]/)?.[1] || ''}`;
          }
          if (!target) continue;
          if (seenUrl.has(target)) continue;
          seenUrl.add(target);
          matched.push({
            url: target,
            text: text.slice(0, 60),
            score: r.score,
            label: r.label,
          });
          break;
        }
      }
      matched.sort((a, b) => b.score - a.score);
      return {
        matched: matched.slice(0, 6),
        totalAnchors: anchors.length,
        sampleTexts: allTexts.slice(0, 25),
      };
    }, TAB_RULES.map((r) => ({ rx: { source: r.rx.source, flags: r.rx.flags }, score: r.score, label: r.label })))
      .catch((e) => ({ matched: [], totalAnchors: 0, sampleTexts: [], error: e.message }));

    console.log(
      `    🇸🇪 kommersannons: ${tabProbe.totalAnchors} anchor(s), ` +
      `${tabProbe.matched.length} tab match(es)` +
      (tabProbe.matched.length ? ` — ${tabProbe.matched.map((m) => `${m.label}[s=${m.score}]`).join(' | ')}` : '')
    );
    if (!tabProbe.matched.length) {
      console.log(`    ⚠️  kommersannons: no document-tab anchors matched. Sample texts: ${JSON.stringify(tabProbe.sampleTexts.slice(0, 12))}`);
      return [];
    }

    // STEP 2 — for each matched tab, navigate (or fire postback), scan
    // for download links. Aggregate all unique doc URLs.
    const allDocAnchors = [];
    const seenDocUrl = new Set();
    for (const tab of tabProbe.matched) {
      try {
        if (tab.url.startsWith('postback:')) {
          const eventTarget = tab.url.slice('postback:'.length);
          if (!eventTarget) continue;
          console.log(`    🇸🇪 kommersannons: firing __doPostBack('${eventTarget}') for ${tab.label}`);
          // 2026-05-14 fix v2: avoid strict-mode TypeError (some
          // ASP.NET __doPostBack variants use arguments.callee).
          // Use indirect-eval which runs in global non-strict scope.
          await page.evaluate((et) => {
            try {
              // eslint-disable-next-line no-eval
              (0, eval)(`__doPostBack('${et.replace(/'/g, "\\'")}', '')`);
            } catch (_) {}
          }, eventTarget).catch(() => null);
          try { await page.waitForNetworkIdle({ idleTime: 1000, timeout: 8000 }); } catch (_) {}
          await new Promise((r) => setTimeout(r, 1500));
        } else {
          console.log(`    🇸🇪 kommersannons: navigating to ${tab.label} → ${tab.url.slice(-80)}`);
          await page.goto(tab.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
          try { await page.waitForNetworkIdle({ idleTime: 1000, timeout: 8000 }); } catch (_) {}
          await new Promise((r) => setTimeout(r, 1200));
        }
        // 2026-05-15 fix: BEFORE scanning for downloads, the tab page
        // usually requires the user to click "Anmäl intresse" (Register
        // Interest). User-confirmed DOM:
        //   <a id="ctl00_ctl00_ctl00_content_Content_NoticeInnerContent_lbRegister"
        //      class="btn btn-primary"
        //      href="javascript:__doPostBack('ctl00$ctl00$ctl00$content$Content$NoticeInnerContent$lbRegister','')">
        //     Anmäl intresse
        //   </a>
        // Fire that postback first; document anchors only render after.
        // Use page.click() (non-strict native context) — same approach as
        // the e-avrop SubscribeBtn fix.
        const hasRegisterBtn = await page.evaluate(() => {
          const el = document.querySelector('#ctl00_ctl00_ctl00_content_Content_NoticeInnerContent_lbRegister')
            || document.querySelector('a[href*="lbRegister"]')
            || Array.from(document.querySelectorAll('a, button, input[type="button"]')).find((b) => {
                const t = (b.innerText || b.value || '').trim();
                return /^\s*(anm[äa]l\s*intresse|register\s*interest)\s*$/i.test(t);
              });
          return !!el;
        }).catch(() => false);
        if (hasRegisterBtn) {
          console.log(`    🇸🇪 kommersannons: "Anmäl intresse" found on ${tab.label} — firing postback to reveal docs`);
          let regFired = 'no-attempt';
          try {
            await page.click('#ctl00_ctl00_ctl00_content_Content_NoticeInnerContent_lbRegister');
            regFired = 'page.click';
          } catch (_) {
            try {
              regFired = await page.evaluate(() => {
                const el = document.querySelector('#ctl00_ctl00_ctl00_content_Content_NoticeInnerContent_lbRegister')
                  || document.querySelector('a[href*="lbRegister"]');
                if (!el) return 'no-element';
                const href = el.getAttribute('href') || '';
                const m = /^\s*javascript:\s*(.*)$/i.exec(href);
                if (m && m[1]) {
                  try { (0, eval)(m[1]); return 'eval-href'; }
                  catch (e) { return 'eval-error:' + String(e).slice(0, 40); }
                }
                return 'no-href';
              }).catch((e) => 'evaluate-error:' + (e.message || '').slice(0, 40));
            } catch (_) { regFired = 'click-error'; }
          }
          console.log(`    🇸🇪 kommersannons: Anmäl intresse trigger = ${regFired}`);
          try { await page.waitForNetworkIdle({ idleTime: 1000, timeout: 10000 }); } catch (_) {}
          await new Promise((r) => setTimeout(r, 1500));
        }
        const docs = await page.evaluate(() => {
          // Match anchors that look like document downloads.
          // 2026-05-15 fix: user-confirmed kommersannons uses
          // /<tenant>/Utils/FileDownload.aspx?FileId=<id> — added
          // FileDownload.aspx to the path regex. Previously we
          // matched only Download.aspx / Documents.aspx / GetFile.aspx
          // patterns and silently missed every kommersannons doc.
          //
          // 2026-05-16 fix v3:
          //   (a) Bug 1 — /Documents.aspx is the tab-page URL we just
          //       navigated to (Notice/Request/Documents.aspx?
          //       ProcurementId=X), not a real download. It used to
          //       pollute the priority list and waste fetch cycles on
          //       HTML auth-walls. Explicitly exclude same-URL self-
          //       links AND any /Documents.aspx without a file-style
          //       query param (FileId / DocId / AttachmentId).
          //   (b) Bug 2 — FileDownload.aspx?FileId=X anchors often
          //       have empty <a> text (the visible filename lives in
          //       a sibling <span> or parent <td>). Walk parent
          //       containers to find a displayable filename so the
          //       priority scorer can match qualification vocab.
          const RX_DL_PATH = /\/(?:Download|DownloadFile|FileDownload|GetFile|DownloadAttachment)\.(?:aspx|ashx)|\/Notice\/.*\/Download|\/Utils\/FileDownload/i;
          const RX_DOCS_TAB = /\/Documents\.aspx(?:\?|$)/i;
          const RX_DL_EXT  = /\.(pdf|docx?|xlsx?|pptx?|zip|rtf|odt|ods)(?:[?&#]|$)/i;

          // Parent-walking helper: find the closest ancestor's text
          // that contains a file-like token (extension or "filename"
          // word). Walks up at most 4 levels.
          const findContainerText = (el) => {
            let cur = el.parentElement;
            for (let i = 0; i < 4 && cur; i++) {
              // Prefer typical row containers
              const t = (cur.innerText || cur.textContent || '').trim();
              if (t && t.length < 300 && /\.(pdf|docx?|xlsx?|pptx?|zip|rtf|odt|ods)\b/i.test(t)) {
                // Strip the anchor's own text repeats; trim to first line.
                const firstLine = t.split('\n').map((s) => s.trim()).filter(Boolean)[0] || '';
                if (firstLine.length > 3 && firstLine.length < 200) return firstLine;
              }
              // Stop at obvious page-level containers
              if (/(BODY|MAIN|NAV|HEADER|FOOTER|FORM)/.test(cur.tagName || '')) break;
              cur = cur.parentElement;
            }
            return '';
          };

          const out = [];
          const anchors = Array.from(document.querySelectorAll('a[href]'));
          const currentUrl = location.href.split('#')[0];
          for (const a of anchors) {
            const hrefRaw = a.getAttribute('href') || '';
            if (!hrefRaw || /^javascript:/i.test(hrefRaw) || hrefRaw === '#') continue;
            let abs;
            try { abs = new URL(hrefRaw, location.href).toString(); }
            catch (_) { continue; }
            // Same-origin guard.
            try {
              if (new URL(abs).host !== location.host) continue;
            } catch (_) { continue; }

            // Self-link guard — Documents.aspx tab-page pointing to
            // itself or to /Documents.aspx without a file-style query
            // param (FileId / DocId / AttachmentId). User-confirmed
            // kommersannons file URLs ALWAYS carry FileId.
            if (RX_DOCS_TAB.test(abs)) {
              let absNoHash = abs.split('#')[0];
              if (absNoHash === currentUrl) continue;
              try {
                const u = new URL(abs);
                const hasFileParam = ['FileId', 'fileId', 'DocId', 'docId', 'AttachmentId', 'attachmentId']
                  .some((k) => u.searchParams.has(k));
                if (!hasFileParam) continue;
              } catch (_) { continue; }
            }

            const isDl = RX_DL_PATH.test(abs) || RX_DL_EXT.test(abs) || RX_DOCS_TAB.test(abs);
            if (!isDl) continue;

            // Capture anchor text — direct first, then title/aria-label.
            let text = ((a.innerText || a.textContent || '').trim() || a.getAttribute('title') || a.getAttribute('aria-label') || '')
              .slice(0, 200);

            // Parent-text fallback (Bug 2 fix) — when anchor text is
            // empty/icon-only, walk ancestors to find filename text.
            if (!text || text.length < 4 || /^(download|h[äa]mta|t[eé]l[eé]charger|herunterladen)$/i.test(text)) {
              const containerText = findContainerText(a);
              if (containerText) text = containerText.slice(0, 200);
            }

            // Pull filename hint from URL if present.
            let filename = '';
            try {
              const url = new URL(abs);
              filename = url.searchParams.get('filename')
                || url.searchParams.get('Filename')
                || url.searchParams.get('fileName')
                || url.pathname.split('/').pop()
                || '';
              if (filename) filename = decodeURIComponent(filename.replace(/\+/g, ' '));
            } catch (_) {}
            // kommersannons FileDownload.aspx URLs have ?FileId=<id> but
            // no filename in URL — the filename lives in the anchor's
            // visible text. Prefer text as the display name.
            out.push({ url: abs, text, filename: filename || text });
          }
          return out;
        }).catch(() => []);
        for (const d of docs) {
          if (seenDocUrl.has(d.url)) continue;
          seenDocUrl.add(d.url);
          allDocAnchors.push(d);
        }
        console.log(`    🇸🇪 kommersannons: ${tab.label} → ${docs.length} doc anchor(s)`);
      } catch (e) {
        console.log(`    ⚠️  kommersannons: tab ${tab.label} error: ${(e.message || '').slice(0, 80)}`);
      }
    }

    if (!allDocAnchors.length) {
      console.log(`    ⚠️  kommersannons: no document download anchors found across tabs`);
      // ZERO-ANCHOR DIAGNOSTIC — dump sample button/anchor texts from
      // the current page so we can identify what trigger we're missing.
      // Real-world (goteborg.kommersannons.se 2026-05-15): the Documents
      // tab shows 0 anchors because the page needs a tenant-specific
      // button (e.g. "Visa upphandlingsdokument" / "Begär tillgång")
      // that doesn't match the "Anmäl intresse" selector. Capture text
      // samples so next iteration can extend the trigger regex.
      try {
        const sample = await page.evaluate(() => {
          const els = Array.from(document.querySelectorAll('a, button, input[type="button"], input[type="submit"], [role="button"]'));
          const texts = [];
          const seen = new Set();
          for (const el of els) {
            const t = (el.innerText || el.value || el.textContent || el.getAttribute('aria-label') || '').trim();
            if (!t || t.length > 80 || seen.has(t)) continue;
            seen.add(t);
            texts.push(t);
            if (texts.length >= 30) break;
          }
          return { url: location.href, totalEls: els.length, texts };
        }).catch(() => null);
        if (sample) {
          console.log(`    🔍 kommersannons zero-anchor diag: url=${sample.url.slice(0, 100)} totalEls=${sample.totalEls}`);
          console.log(`    🔍 kommersannons clickable text samples: ${JSON.stringify(sample.texts.slice(0, 20))}`);
        }
      } catch (_) {}
      return [];
    }
    console.log(`    🇸🇪 kommersannons: collected ${allDocAnchors.length} unique doc anchor(s) across tabs`);

    // STEP 3 — score by Swedish qualification vocab (same rules as
    // tendsign + e-avrop handlers).
    const SCORE_RULES = [
      { rx: /Kvalificering(?:skrav)?|Krav\s+p[åa]\s+(?:anbudsgivare|leverant[öo]r|leverand[øo]r)|Lev(?:erant[öo]r)?krav|Skakrav|qualification\s*criteria|tender(?:er)?\s+requirements/i, score: 30 },
      { rx: /Administrativa\s+krav|Generella\s+krav|Krav\s+p[åa]\s+(?:tj[äa]nsten|varan|leveransen)|Uteslutningsgrund/i, score: 25 },
      { rx: /F[öo]rfr[åa]gningsunderlag|FFU|Anbudsforesp[øo]rsel|Konkurransegrunnlag|Anskaffelsesdokument|tender\s*document|Upphandlingsf[öo]reskrifter/i, score: 18 },
      { rx: /AUC\b|Administrativa\s+f[öo]reskrifter/i, score: 12 },
      { rx: /Anbudsformul[äa]r|Tilbudsformular|Egenf[öo]rs[äa]kran|ESPD|UEA/i, score: 10 },
      { rx: /Utv[äa]rderingskriterier|Grund\s+f[öo]r\s+tilldelning|tilldelningskriterier|award\s*criteria/i, score: 8 },
      { rx: /Bilaga|Bilagor|Attachment|Vedlegg|appendix/i, score: 5 },
    ];
    for (const d of allDocAnchors) {
      d.score = 0;
      const targets = [d.text || '', d.filename || '', d.url || ''];
      for (const r of SCORE_RULES) {
        for (const t of targets) {
          if (r.rx.test(t)) { d.score = Math.max(d.score, r.score); break; }
        }
      }
    }
    allDocAnchors.sort((a, b) => b.score - a.score);
    const topDocs = allDocAnchors.slice(0, 6);
    console.log(
      `    🇸🇪 kommersannons: priority docs: ` +
      topDocs.map((d) => `${(d.filename || d.text || d.url.split('/').pop()).slice(0, 40)}[s=${d.score}]`).join(' | ')
    );

    // STEP 4 — fetch + parse top 6.
    const detectFormat = (buf) => {
      if (!buf || buf.length < 4) return 'unknown';
      const b0 = buf[0], b1 = buf[1], b2 = buf[2], b3 = buf[3];
      if (b0 === 0x25 && b1 === 0x50 && b2 === 0x44 && b3 === 0x46) return 'pdf';
      if (b0 === 0x50 && b1 === 0x4B && (b2 === 0x03 || b2 === 0x05 || b2 === 0x07)) return 'zip';
      if (b0 === 0xD0 && b1 === 0xCF && b2 === 0x11 && b3 === 0xE0) return 'cfb';
      const head = buf.slice(0, 64).toString('utf8').trim().toLowerCase();
      if (head.startsWith('<!doctype') || head.startsWith('<html')) return 'html';
      return 'unknown';
    };

    const texts = [];
    for (const doc of topDocs) {
      const labelName = (doc.filename || doc.text || doc.url.split('/').pop()).slice(0, 100);
      const result = await page.evaluate(async (url) => {
        try {
          const resp = await fetch(url, { credentials: 'include', redirect: 'follow' });
          if (!resp.ok) return { ok: false, status: resp.status };
          const ct = resp.headers.get('content-type') || '';
          const ab = await resp.arrayBuffer();
          return {
            ok: true,
            status: resp.status,
            ct,
            url: resp.url || url,
            data: Array.from(new Uint8Array(ab)),
          };
        } catch (e) {
          return { ok: false, error: String(e).slice(0, 200) };
        }
      }, doc.url).catch((e) => ({ ok: false, error: e.message }));

      if (!result || !result.ok || !result.data || result.data.length < 500) {
        const status = result?.status || result?.error || '?';
        console.log(`    ⚠️  kommersannons: fetch failed "${labelName.slice(0, 40)}" (status=${status})`);
        continue;
      }
      const buf = Buffer.from(result.data);
      const fmt = detectFormat(buf);
      console.log(
        `    🇸🇪 kommersannons: fetched "${labelName.slice(0, 40)}" ` +
        `(${buf.length}B, magic=${fmt}, ct=${(result.ct || '').slice(0, 30)})`
      );

      try {
        let text = '';
        if (fmt === 'pdf' && pdfParseLib) {
          const parsed = await pdfParseLib(buf);
          text = ((parsed && parsed.text) || '').trim();
        } else if (fmt === 'zip' && admZipLib) {
          // ZIP bundle — extract inner PDF/DOCX entries.
          try {
            const zip = new admZipLib(buf);
            const entries = zip.getEntries()
              .filter((e) => !e.isDirectory && /\.(pdf|docx?)$/i.test(e.entryName))
              .slice(0, 4);
            const parts = [];
            for (const e of entries) {
              const d = e.getData();
              const inner = detectFormat(d);
              if (inner === 'pdf' && pdfParseLib) {
                const p = await pdfParseLib(d);
                if (p && p.text) parts.push(`--- ${e.entryName.slice(-80)} ---\n${p.text.trim().slice(0, 60000)}`);
              } else if (/\.docx$/i.test(e.entryName) && mammothLib) {
                const o = await mammothLib.extractRawText({ buffer: d });
                if (o && o.value) parts.push(`--- ${e.entryName.slice(-80)} ---\n${o.value.trim().slice(0, 60000)}`);
              }
            }
            text = parts.join('\n\n').trim();
          } catch (_) {}
        } else if (/\.docx$/i.test(labelName) && mammothLib) {
          // Magic might be 'zip' (DOCX is a ZIP container) — handled above
          // but fallback by extension if magic says zip and filename is docx.
          const out = await mammothLib.extractRawText({ buffer: buf });
          text = ((out && out.value) || '').trim();
        } else if (fmt === 'html') {
          console.log(`    ⚠️  kommersannons: "${labelName.slice(0, 40)}" served HTML — likely auth-wall`);
        }
        if (text.length > 200) {
          const clipped = text.slice(0, 80000);
          texts.push(`--- (kommersannons) ${labelName} ---\n${clipped}`);
          console.log(`    🇸🇪 kommersannons: parsed "${labelName.slice(0, 40)}" (${buf.length}B → ${clipped.length}ch, score=${doc.score})`);
        } else {
          console.log(`    ⚠️  kommersannons: "${labelName.slice(0, 40)}" extracted text too short (${text.length}ch)`);
        }
      } catch (e) {
        console.log(`    ⚠️  kommersannons: parse failed for "${labelName.slice(0, 40)}": ${(e.message || '').slice(0, 80)}`);
      }
    }
    return texts;
  } catch (e) {
    console.log(`    ⚠️  kommersannons handler error: ${(e.message || String(e)).slice(0, 140)}`);
    return [];
  } finally {
    try { if (page) await page.close(); } catch (_) {}
  }
}

// =====================================================================
// fetchPlacspDocuments
// ---------------------------------------------------------------------
// contrataciondelestado.es (Plataforma de Contratación del Sector
// Público — PLACSP) is Spain's national e-procurement portal. Each
// tender lists its documents as anchors pointing at
// /FileSystem/servlet/GetDocumentByIdServlet — the servlet streams
// PDFs (Pliego de Cláusulas Administrativas, Pliego de Prescripciones
// Técnicas, Anuncio de Licitación), occasionally a single ZIP
// "Documento de Pliegos" bundling everything.
//
// There is ALREADY a comprehensive inline PLACSP harvest inside the
// main fetchSourcePageDetails page.evaluate. That logic:
//   - Detects 4 servlet URL patterns (GetDocumentByIdServlet, docAccCmpnt,
//     GetDocumentsById, deeplink:detalle_pliego)
//   - Reads doc type from <tr>'s tipoDocumento cell (PCAP > PPT > etc.)
//   - Has snapshot-rescue if main eval missed
//   - Bumps char caps to 150k/file 180k/total
//
// This DEDICATED handler complements the inline logic by addressing
// THREE gaps the inline scan can't:
//
//   1. Hardcoded ext='pdf' — inline sets every PLACSP doc as PDF, so
//      "Documento de Pliegos" (which is ALWAYS a ZIP bundle) fails the
//      magic-byte check and is silently skipped. The dedicated handler
//      detects format from magic bytes and uses adm-zip to recurse.
//
//   2. Main document only — inline scan misses anchors hosted inside
//      same-origin iframes (some PLACSP portlets render the documents
//      table inside an iframe).
//
//   3. No per-doc parse diagnostic — inline harvest goes through the
//      generic prefetch loop; failures appear as "magic mismatch" with
//      no PLACSP-specific context.
//
// Strategy:
//   1. New page, Spanish locale.
//   2. Navigate to source URL, settle.
//   3. Strict cookie-banner dismissal (excludes "aceptar la cesión" /
//      "aceptar términos" — those are tender-acceptance triggers).
//   4. Scan main doc + same-origin iframes for PLACSP doc anchors.
//   5. Score by doc type (PCAP > PPT > Pliego > Anuncio > DocPliegos
//      > Decreto), like the inline logic.
//   6. Fetch top 6 docs via page.evaluate fetch (carries session
//      cookies if any).
//   7. Determine format from magic bytes:
//        %PDF -> pdf-parse
//        PK\x03\x04 -> adm-zip (extract inner PDF/DOCX, recurse)
//        D0 CF 11 E0 -> CFB (Office 97 .doc / .xls) — log + skip
//        else -> log + skip
//   8. Return [`--- (placsp) name ---\ntext`] array.
// =====================================================================
async function fetchPlacspDocuments(browser, sourceUrl) {
  try {
    const u = new URL(sourceUrl);
    if (!/(^|\.)contrataciondelestado\.es$/i.test(u.hostname)) return [];
  } catch (_) { return []; }

  let pdfParseLib = null, mammothLib = null, admZipLib = null;
  try { pdfParseLib = require('pdf-parse'); } catch (_) {}
  try { mammothLib  = require('mammoth');   } catch (_) {}
  try { admZipLib   = require('adm-zip');   } catch (_) {}
  if (!pdfParseLib && !mammothLib && !admZipLib) {
    console.log(`    ⚠️  PLACSP: no parser libs available — skipping`);
    return [];
  }

  let page = null;
  try {
    page = await browser.newPage();
    page.setDefaultNavigationTimeout(30000);
    page.setDefaultTimeout(30000);
    try { await page.setViewport({ width: 1280, height: 900 }); } catch (_) {}

    // Spanish locale — some PLACSP portlets render different markup based
    // on Accept-Language. Also disable webdriver flag.
    try {
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        Object.defineProperty(navigator, 'languages', {
          get: () => ['es-ES', 'es', 'en-US', 'en'],
        });
      });
      const ua = await page.browser().userAgent();
      await page.setUserAgent(ua.replace(/HeadlessChrome/i, 'Chrome'));
    } catch (_) {}

    try {
      await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e) {
      console.log(`    🇪🇸 PLACSP: nav warn: ${(e.message || '').slice(0, 80)}`);
    }
    try { await page.waitForNetworkIdle({ idleTime: 1000, timeout: 10000 }); } catch (_) {}
    await new Promise((r) => setTimeout(r, 1500));

    // STRICT cookie-banner dismissal — only matches buttons whose text
    // is EXACTLY "aceptar"/"aceptar todas"/"aceptar cookies"/etc. The
    // existing main-loop cookie-accept logic skips PLACSP entirely
    // because "aceptar la cesión" / "aceptar términos" anchors share
    // the prefix. Here we use exact-match with word boundaries to
    // exclude those (no "la cesión" / "términos" follow-up word).
    try {
      const dismissed = await page.evaluate(() => {
        const RX_COOKIE = /^\s*(aceptar(?:\s+(?:todas|cookies))?|acepto\s+todas|de\s*acuerdo|entendido)\s*$/i;
        const btns = Array.from(document.querySelectorAll('button, a, input[type="button"]'));
        for (const b of btns) {
          const t = (b.textContent || b.value || '').trim();
          if (!t || t.length > 30) continue;
          if (!RX_COOKIE.test(t)) continue;
          // Avoid clicking inside the document table — only outer banner
          // elements (typically fixed-position with high z-index).
          try {
            const r = b.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
          } catch (_) {}
          try { b.click(); return `clicked:${t.slice(0, 30)}`; }
          catch (_) {}
        }
        return null;
      }).catch(() => null);
      if (dismissed) {
        console.log(`    🇪🇸 PLACSP: cookie banner ${dismissed}`);
        await new Promise((r) => setTimeout(r, 500));
      }
    } catch (_) {}

    // Find PLACSP doc anchors in main doc + same-origin iframes.
    const probe = await page.evaluate(() => {
      const URL_RE = [
        /\/FileSystem\/servlet\/GetDocumentByIdServlet/i,
        /docAccCmpnt/i,
        /GetDocumentsById/i,
        /uri=deeplink:detalle_(?:pliego|anuncio)/i,
      ];
      const ROW_TYPE_RE = [
        { rank: 0, name: 'PCAP',       re: /pliego\s+cl[aá]usulas\s+administrativas|cl[aá]usulas\s+administrativas\s+particulares/i },
        { rank: 1, name: 'PPT',        re: /pliego\s+prescripciones\s+t[eé]cnicas|prescripciones\s+t[eé]cnicas\s+particulares/i },
        { rank: 2, name: 'Pliego',     re: /\bpliego\b/i },
        { rank: 3, name: 'Anuncio',    re: /anuncio\s+de\s+licitaci[oó]n/i },
        { rank: 4, name: 'DocPliegos', re: /documento\s+de\s+pliegos/i },
        { rank: 5, name: 'Decreto',    re: /decreto\s+aprobando\s+(?:el\s+)?pliego/i },
      ];
      const collectFromRoot = (root, sourceLabel) => {
        const out = [];
        const seen = new Set();
        const anchors = Array.from(root.querySelectorAll('a[href]'));
        for (const a of anchors) {
          const hrefRaw = a.getAttribute('href') || '';
          if (!hrefRaw || /^javascript:/i.test(hrefRaw) || hrefRaw === '#') continue;
          let abs;
          try { abs = new URL(hrefRaw, location.href).toString(); }
          catch (_) { continue; }
          if (seen.has(abs)) continue;
          const urlMatch = URL_RE.some(re => re.test(abs));
          const ownText = (a.textContent || a.getAttribute('title') || '').trim();
          const row = a.closest('tr');
          const rowText = row
            ? (row.innerText || row.textContent || '').replace(/\s+/g, ' ').trim()
            : '';
          let chosenType = null;
          for (const rt of ROW_TYPE_RE) {
            if (rt.re.test(rowText) || rt.re.test(ownText)) {
              chosenType = rt;
              break;
            }
          }
          if (!urlMatch && !chosenType) continue;
          seen.add(abs);
          out.push({
            url: abs,
            name: chosenType
              ? `${chosenType.name}: ${(rowText || ownText).slice(0, 100)}`
              : (ownText || `placsp-doc-${out.length + 1}`).slice(0, 120),
            rank: chosenType ? chosenType.rank : 50,
            type: chosenType ? chosenType.name : 'unknown',
            source: sourceLabel,
          });
        }
        return out;
      };
      // Main document scan.
      const mainDocs = collectFromRoot(document, 'main');
      // Same-origin iframe scan.
      const iframeDocs = [];
      const iframes = Array.from(document.querySelectorAll('iframe'));
      for (const f of iframes) {
        try {
          const doc = f.contentDocument;
          if (doc && doc.body) {
            const ifSrc = (f.getAttribute('src') || 'no-src').slice(0, 60);
            const found = collectFromRoot(doc, `iframe:${ifSrc}`);
            iframeDocs.push(...found);
          }
        } catch (_) { /* cross-origin — skip */ }
      }
      // Dedupe by URL — main wins over iframe.
      const seen = new Set(mainDocs.map((d) => d.url));
      const merged = [
        ...mainDocs,
        ...iframeDocs.filter((d) => !seen.has(d.url)),
      ];
      merged.sort((a, b) => a.rank - b.rank);
      // 2026-05-15 diagnostic: when zero matches found, sample anchors
      // so we can see WHAT IS on the page and iterate URL_RE/ROW_TYPE_RE.
      let anchorSample = [];
      if (!merged.length) {
        const allAnchors = Array.from(document.querySelectorAll('a[href]'));
        anchorSample = allAnchors.slice(0, 30)
          .map((a) => {
            const href = (a.getAttribute('href') || '').slice(0, 70);
            const text = ((a.textContent || a.getAttribute('title') || '').trim() || '').slice(0, 50);
            const rowText = (a.closest('tr')?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80);
            return { href, text, rowText };
          })
          .filter((a) => a.href && !/^javascript:|^#/.test(a.href));
      }
      return {
        docs: merged,
        totalIframes: iframes.length,
        mainCount: mainDocs.length,
        iframeCount: iframeDocs.length,
        anchorSample,
        totalAnchors: document.querySelectorAll('a[href]').length,
      };
    }).catch(() => ({ docs: [], totalIframes: 0, mainCount: 0, iframeCount: 0 }));

    console.log(
      `    🇪🇸 PLACSP: ${probe.docs.length} doc candidate(s) ` +
      `(main=${probe.mainCount}, iframes=${probe.iframeCount}/${probe.totalIframes})`
    );
    if (!probe.docs.length) {
      // Log diagnostic so we can identify new anchor patterns to add to
      // URL_RE / ROW_TYPE_RE. Real-world value: 2026-05-15 ES run had
      // "Servicio de análisis..." tender that returned 0 docs despite
      // being a normal PLACSP tender — the body presumably uses a
      // different anchor structure (or PCAP is behind a tab/click).
      console.log(
        `    ⚠️  PLACSP: zero doc anchors matched out of ${probe.totalAnchors || 0} total. ` +
        `Sample: ${JSON.stringify((probe.anchorSample || []).slice(0, 10))}`
      );
      return [];
    }
    // Log priority list — first 6.
    console.log(
      `    🇪🇸 PLACSP priority: ` +
      probe.docs.slice(0, 6).map((d) =>
        `${d.type}[${d.source.startsWith('iframe') ? 'if' : 'main'}](r=${d.rank})`
      ).join(' | ')
    );

    // Magic-byte format detection.
    const detectFormat = (buf) => {
      if (!buf || buf.length < 4) return 'unknown';
      const b0 = buf[0], b1 = buf[1], b2 = buf[2], b3 = buf[3];
      if (b0 === 0x25 && b1 === 0x50 && b2 === 0x44 && b3 === 0x46) return 'pdf';
      if (b0 === 0x50 && b1 === 0x4B && (b2 === 0x03 || b2 === 0x05 || b2 === 0x07)) return 'zip';
      if (b0 === 0xD0 && b1 === 0xCF && b2 === 0x11 && b3 === 0xE0) return 'cfb';
      if (b0 === 0x7B && b1 === 0x5C && b2 === 0x72 && b3 === 0x74) return 'rtf';
      const head = buf.slice(0, 64).toString('utf8').trim().toLowerCase();
      if (head.startsWith('<!doctype') || head.startsWith('<html')) return 'html';
      if (head.startsWith('<?xml') || head.startsWith('<')) return 'xml';
      return 'unknown';
    };

    const texts = [];
    const topDocs = probe.docs.slice(0, 6);
    for (const doc of topDocs) {
      const labelName = doc.name.slice(0, 100);
      // Fetch via page.evaluate (carries session cookies).
      const result = await page.evaluate(async (url) => {
        try {
          const resp = await fetch(url, { credentials: 'include', redirect: 'follow' });
          if (!resp.ok) return { ok: false, status: resp.status };
          const ct = resp.headers.get('content-type') || '';
          const ab = await resp.arrayBuffer();
          return {
            ok: true,
            status: resp.status,
            ct,
            url: resp.url || url,
            data: Array.from(new Uint8Array(ab)),
          };
        } catch (e) {
          return { ok: false, error: String(e).slice(0, 200) };
        }
      }, doc.url).catch((e) => ({ ok: false, error: e.message }));

      if (!result || !result.ok || !result.data || result.data.length < 500) {
        const status = result?.status || result?.error || '?';
        console.log(`    ⚠️  PLACSP: fetch failed "${labelName.slice(0, 40)}" (status=${status})`);
        continue;
      }
      const buf = Buffer.from(result.data);
      const fmt = detectFormat(buf);
      console.log(
        `    🇪🇸 PLACSP: fetched "${labelName.slice(0, 40)}" ` +
        `(${buf.length}B, magic=${fmt}, ct=${(result.ct || '').slice(0, 30)})`
      );

      try {
        let text = '';
        if (fmt === 'pdf' && pdfParseLib) {
          const parsed = await pdfParseLib(buf);
          text = ((parsed && parsed.text) || '').trim();
        } else if (fmt === 'zip' && admZipLib) {
          // ZIP bundle — extract inner PDF/DOCX entries and concat.
          // Per-entry cap of 80k chars to fit ~3 files in a typical
          // "Documento de Pliegos" bundle without blowing the AI input.
          try {
            const zip = new admZipLib(buf);
            const entries = zip.getEntries()
              .filter((e) => !e.isDirectory && /\.(pdf|docx?)$/i.test(e.entryName))
              .slice(0, 5);
            const parts = [];
            for (const e of entries) {
              const d = e.getData();
              const inner = detectFormat(d);
              if (inner === 'pdf' && pdfParseLib) {
                const p = await pdfParseLib(d);
                if (p && p.text) parts.push(`--- ${e.entryName.slice(-80)} ---\n${p.text.trim().slice(0, 80000)}`);
              } else if (/\.docx$/i.test(e.entryName) && mammothLib) {
                const o = await mammothLib.extractRawText({ buffer: d });
                if (o && o.value) parts.push(`--- ${e.entryName.slice(-80)} ---\n${o.value.trim().slice(0, 80000)}`);
              }
            }
            text = parts.join('\n\n').trim();
            if (parts.length) {
              console.log(`    🇪🇸 PLACSP: ZIP parsed ${parts.length} inner entries from "${labelName.slice(0, 40)}"`);
            }
          } catch (e) {
            console.log(`    ⚠️  PLACSP: ZIP parse failed for "${labelName.slice(0, 40)}": ${(e.message || '').slice(0, 80)}`);
          }
        } else if (fmt === 'cfb') {
          console.log(`    ⚠️  PLACSP: "${labelName.slice(0, 40)}" is legacy Office .doc/.xls (CFB) — no parser, skipping`);
        } else if (fmt === 'html') {
          console.log(`    ⚠️  PLACSP: "${labelName.slice(0, 40)}" served HTML (likely auth-wall or error page) — skipping`);
        } else {
          console.log(`    ⚠️  PLACSP: "${labelName.slice(0, 40)}" unknown format (magic=${fmt}) — skipping`);
        }
        if (text.length > 200) {
          // Per-priority-file cap at 150k chars (PCAP bodies routinely
          // run 50-70 pages; ANEXO 3 with the actual thresholds lives
          // around page 50, so caps below 100k drop it).
          const clipped = text.slice(0, 150000);
          texts.push(`--- (placsp ${doc.type}) ${labelName} ---\n${clipped}`);
          console.log(`    🇪🇸 PLACSP: parsed "${labelName.slice(0, 40)}" (${clipped.length}ch, rank=${doc.rank})`);
        } else if (fmt === 'pdf' || fmt === 'zip') {
          console.log(`    ⚠️  PLACSP: "${labelName.slice(0, 40)}" extracted text too short (${text.length}ch)`);
        }
      } catch (e) {
        console.log(`    ⚠️  PLACSP: parse failed for "${labelName.slice(0, 40)}": ${(e.message || '').slice(0, 80)}`);
      }
    }
    return texts;
  } catch (e) {
    console.log(`    ⚠️  PLACSP handler error: ${(e.message || String(e)).slice(0, 140)}`);
    return [];
  } finally {
    try { if (page) await page.close(); } catch (_) {}
  }
}

async function fetchSourcePageDetails(browser, sourceUrl) {
  // URL scheme normalisation — Mercell sometimes returns sourceUrl
  // values like "www.conselleriadefacenda.es/silex" without an
  // http(s):// scheme. Puppeteer's page.goto() rejects those with
  // "Cannot navigate to invalid URL" and the call lands on Chrome's
  // chromewebdata error page (which our dead-site bail then catches —
  // but we waste 8s and lose the source). Best to prefix https://
  // upfront for any URL that lacks a scheme but otherwise looks
  // valid (has a dot). Real-world impact (Spanish PLACSP run on
  // 2026-05-05): 3 of 9 tenders had this issue.
  if (sourceUrl && typeof sourceUrl === 'string' && !/^[a-z][a-z0-9+.-]*:\/\//i.test(sourceUrl)) {
    const trimmed = sourceUrl.trim();
    if (trimmed && /\./.test(trimmed)) {
      const fixed = `https://${trimmed.replace(/^\/+/, '')}`;
      console.log(`    ↪️  source URL missing scheme — normalising "${sourceUrl}" → "${fixed}"`);
      sourceUrl = fixed;
    }
  }

  // marchespublics.gouv.fr typo fix — Mercell occasionally returns the
  // domain WITHOUT the hyphen (`www.marchespublics.gouv.fr`), but the
  // real hostname is `www.marches-publics.gouv.fr` (with hyphen). The
  // no-hyphen variant doesn't resolve → net::ERR_NAME_NOT_RESOLVED.
  // Real-world impact (FR run 2026-05-15): tender 607617143
  // (Prestations de Tierce Maintenance Applicative des Logiciels)
  // failed with the DNS error and we lost the source. Rewrite the
  // typo'd domain upfront. We use a strict literal match so we don't
  // accidentally hyphenate other domains.
  try {
    const u = new URL(sourceUrl);
    if (u.hostname === 'www.marchespublics.gouv.fr' || u.hostname === 'marchespublics.gouv.fr') {
      u.hostname = 'www.marches-publics.gouv.fr';
      // Also force HTTPS — Mercell's typo'd URL was http:// which is
      // a 301→https on the real domain anyway.
      u.protocol = 'https:';
      const fixed = u.toString();
      console.log(`    ↪️  marchespublics: rewriting Mercell typo → ${fixed.slice(0, 80)}`);
      sourceUrl = fixed;
    }
  } catch (_) {}

  // dtvp.de URL normaliser — Mercell's "Go to source" for DTVP can land
  // on several path variants of the notice page:
  //   /Satellite/notice/<id>                  (notice summary, no docs)
  //   /Satellite/notice/<id>/                 (trailing slash variant)
  //   /Satellite/notice/<id>/projectSpace     (project space landing)
  //   /Satellite/notice/<id>/documents        (doc list page — what we want)
  //
  // The bulk-ZIP link "Alle Dokumente als ZIP-Datei herunterladen" is
  // rendered on the /documents page specifically. Other entry points
  // either don't show it at all, or hide it behind a click that triggers
  // a tab change. Rewriting any DTVP notice URL to the /documents form
  // upfront skips that nav and lands the generic source-page handler on
  // the page that has the link we need.
  //
  // Legal context: German Vergabeverordnung §41 requires anonymous
  // public access to procurement documents — so the /documents page is
  // always accessible without authentication. No login flow needed.
  // (Confirmed via DTVP info-center FAQ + BaFin Hilfestellung guide.)
  try {
    const u = new URL(sourceUrl);
    if (u.hostname === 'www.dtvp.de' || u.hostname === 'dtvp.de') {
      const noticeMatch = u.pathname.match(/^\/Satellite\/notice\/([A-Z0-9]{6,40})(?:\/.*)?$/i);
      if (noticeMatch && !/\/documents\/?$/i.test(u.pathname)) {
        const noticeId = noticeMatch[1];
        u.pathname = `/Satellite/notice/${noticeId}/documents`;
        // Reset search/hash — query params on the notice landing page
        // (e.g. ?tab=overview) don't apply to /documents.
        u.search = '';
        u.hash = '';
        const fixed = u.toString();
        console.log(`    ↪️  dtvp: rewriting to /documents endpoint → ${fixed.slice(0, 90)}`);
        sourceUrl = fixed;
      }
    }
  } catch (_) {}

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

  // tendsign.com URL rewrite — doc.aspx?MeFormsNoticeId=X is the
  // login-walled buyer-restricted view; our login succeeds but the
  // page stays gated (sample run 2026-05-13: bodyLen=487 post-login,
  // gated=true). The user-confirmed anonymous public view is at
  // /public/p_meformsnotice.aspx?MeFormsNoticeId=<same-id> (visible
  // in the doc.aspx page as the link "Klicka här för att se annonsen
  // anonymt"). The anonymous view exposes the announcement summary
  // and any non-restricted document links without requiring auth, so
  // we get further content out of TendSign tenders by bypassing the
  // login wall entirely.
  try {
    const u = new URL(sourceUrl);
    if (/(^|\.)tendsign\.com$/i.test(u.hostname) && /\/doc\.aspx/i.test(u.pathname)) {
      const noticeId = u.searchParams.get('MeFormsNoticeId') || u.searchParams.get('UnikID');
      if (noticeId && /^\d+$/.test(noticeId)) {
        const publicUrl = `https://tendsign.com/public/p_meformsnotice.aspx?MeFormsNoticeId=${noticeId}`;
        console.log(`    🇸🇪 tendsign: rewriting login-gated doc.aspx → public anonymous view (${publicUrl.slice(0, 80)})`);
        sourceUrl = publicUrl;
      }
    }
  } catch (_) {}

  let srcPage = null;
  try {
    srcPage = await browser.newPage();
    await srcPage.setDefaultNavigationTimeout(SOURCE_NAV_TIMEOUT);
    await srcPage.setDefaultTimeout(SOURCE_NAV_TIMEOUT);

    // Detect PLACSP source URLs ahead of interception so we can keep
    // stylesheets enabled — the IBM WebSphere portal that PLACSP uses
    // ships portlet rendering logic in CSS-coupled scripts; aborting
    // stylesheets leaves the documents table un-rendered (real-world
    // run on 2026-05-04 returned only the 6-language welcome banner +
    // 31 nav anchors instead of the full 63 with Pliego links).
    const isPlacspSource = (() => {
      try { return /(^|\.)contrataciondelestado\.es$/i.test(new URL(sourceUrl).hostname); }
      catch (_) { return false; }
    })();
    if (isPlacspSource) {
      console.log(`    🇪🇸 PLACSP host detected — keeping stylesheets/fonts enabled for full portlet render`);
    }

    // Block heavy resources (skip for PLACSP — see comment above).
    await srcPage.setRequestInterception(true);
    const blockHandler = (req) => {
      const type = req.resourceType();
      const blocked = isPlacspSource
        ? ['image', 'media']                              // minimal block — keep CSS+fonts
        : ['image', 'media', 'font', 'stylesheet'];       // default — block all heavy
      if (blocked.includes(type)) {
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
      // Dead-site early bail — when the source DNS-fails or the server
      // never responds, Chrome lands on its built-in error page whose
      // host is "chromewebdata". Without this guard we'd burn the full
      // 12s waitForFunction + cookie-banner sleep + per-tender file
      // prefetch loop on the error page. Real-world cost (run on
      // 2026-05-04): 134s wasted on a single dead host.
      const isDeadChromePage = finalUrl.hostname === 'chromewebdata' ||
        finalUrl.hostname === '' ||
        srcPage.url().startsWith('chrome-error://');
      if (isDeadChromePage) {
        const bodyPreview = await srcPage.evaluate(
          () => (document.body?.innerText || '').slice(0, 200)
        ).catch(() => '');
        console.log(`    source dead — Chrome error page (host: ${finalUrl.hostname || 'empty'}, preview: "${bodyPreview.replace(/\s+/g, ' ').slice(0, 120)}") — skipping`);
        srcPage.off('request', blockHandler);
        try { await srcPage.setRequestInterception(false); } catch (_) {}
        return {
          skipped: 'dead-site',
          sourceHost: finalUrl.hostname || 'chromewebdata',
          error: 'Chrome error page (DNS / connection / timeout)',
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

    // PLACSP portlets load asynchronously via AJAX — the 800-char body
    // threshold above resolves on the welcome banner alone (Bienvenidos
    // / Ongi Etorri / etc.), well before the documents table appears.
    // Wait specifically for `td.tipoDocumento` (the cell that holds
    // each document's type label, e.g. "Pliego" / "Anuncio de
    // Licitación") with a 15s ceiling. If the wait times out, we still
    // proceed — the URL pattern fallback may catch GetDocumentByIdServlet
    // anchors even without the type cell.
    // Snapshot for PLACSP — captured RIGHT after portlet renders so a
    // later step (cookie banner click, navigation, etc.) can't wipe
    // the document table before main extraction runs. The main eval
    // below merges this into result.sourceFiles.
    let placspSnapshot = null;
    if (isPlacspSource) {
      const t0 = Date.now();
      const tipoFound = await srcPage.waitForFunction(() => {
        return document.querySelector('td.tipoDocumento, .tipoDocumento') !== null;
      }, { timeout: 15000 }).then(() => true).catch(() => false);
      const elapsed = Date.now() - t0;
      const anchorCount = await srcPage.evaluate(
        () => document.querySelectorAll('a[href]').length
      ).catch(() => 0);
      console.log(`    🇪🇸 PLACSP portlet wait: tipoDocumento=${tipoFound} (${elapsed}ms), anchors=${anchorCount}`);

      // Capture document anchors NOW — before any further await /
      // navigation can disturb the DOM. We replicate the same
      // text+url matching logic the main IIFE does so the snapshot
      // is interchangeable with placspResult.files.
      placspSnapshot = await srcPage.evaluate(() => {
        const ROW_TYPE_RE = [
          { rank: 0, name: 'PCAP',       re: /pliego\s+cl[aá]usulas\s+administrativas|cl[aá]usulas\s+administrativas\s+particulares/i },
          { rank: 1, name: 'PPT',        re: /pliego\s+prescripciones\s+t[eé]cnicas|prescripciones\s+t[eé]cnicas\s+particulares/i },
          { rank: 2, name: 'Pliego',     re: /\bpliego\b/i },
          { rank: 3, name: 'Anuncio',    re: /anuncio\s+de\s+licitaci[oó]n/i },
          { rank: 4, name: 'DocPliegos', re: /documento\s+de\s+pliegos/i },
          { rank: 5, name: 'Decreto',    re: /decreto\s+aprobando\s+(?:el\s+)?pliego/i },
        ];
        const URL_RE = [
          /\/FileSystem\/servlet\/GetDocumentByIdServlet/i,
          /docAccCmpnt/i,
          /GetDocumentsById/i,
        ];
        const seen = new Set();
        const out = [];
        const allAnchors = Array.from(document.querySelectorAll('a[href]'));
        for (const a of allAnchors) {
          const hrefRaw = a.getAttribute('href') || '';
          if (!hrefRaw || /^javascript:/i.test(hrefRaw) || hrefRaw === '#') continue;
          let abs;
          try { abs = new URL(hrefRaw, location.href).toString(); }
          catch (_) { continue; }
          if (seen.has(abs)) continue;
          const ownText = (a.textContent || a.getAttribute('title') || '').trim();
          const row = a.closest('tr');
          const rowText = row ? (row.innerText || row.textContent || '').replace(/\s+/g, ' ').trim() : '';
          const urlMatch = URL_RE.some(re => re.test(abs));
          let chosenType = null;
          for (const rt of ROW_TYPE_RE) {
            if (rt.re.test(rowText) || rt.re.test(ownText)) { chosenType = rt; break; }
          }
          if (!urlMatch && !chosenType) continue;
          const finalRank = chosenType ? chosenType.rank : 50;
          const finalName = chosenType
            ? `${chosenType.name}: ${(rowText || ownText).slice(0, 100)}`
            : (ownText || `placsp-doc-${out.length + 1}`).slice(0, 120);
          seen.add(abs);
          out.push({
            url: abs,
            name: finalName,
            ext: 'pdf',
            priority: true,
            priorityRank: finalRank,
            matchType: chosenType && urlMatch ? 'text+url' : (chosenType ? 'text' : 'url'),
          });
        }
        out.sort((a, b) => a.priorityRank - b.priorityRank);
        return { files: out, anchorCountAtSnapshot: allAnchors.length };
      }).catch(e => ({ files: [], snapshotError: e.message }));

      console.log(`    🇪🇸 PLACSP snapshot: ${placspSnapshot.files.length} document(s), anchorCount=${placspSnapshot.anchorCountAtSnapshot || 0}${placspSnapshot.snapshotError ? `, err=${placspSnapshot.snapshotError}` : ''}`);

      // Extra settle time so any tail anchors finish painting.
      await new Promise(r => setTimeout(r, 1500));
    }

    // Bandome uždaryti cookie banner'us, kurie dažnai uždengia turinį.
    //
    // SKIP for PLACSP — contrataciondelestado.es detail pages contain
    // anchors with text like "aceptar la cesión" / "aceptar términos"
    // that match our cookie-accept regex. Clicking them navigates the
    // page away from the document table (real-world cost: anchors
    // dropped 65→31, killing PCAP detection). Cookie banners aren't a
    // concern on PLACSP anyway — it doesn't show one.
    if (!isPlacspSource) {
      await srcPage.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"]'));
        const acc = btns.find(b => /accept|godkänn|godkend|aksepter|hyväksy|akzeptier|accepter|aanvaard|aceptar|accetta/i
          .test((b.textContent || b.value || '').trim()));
        acc?.click?.();
      }).catch(() => {});
      await new Promise(r => setTimeout(r, 200));
    }

    // --- simap.ch INTERESSE-BEKUNDEN HANDLER --------------------------
    //
    // simap.ch (Swiss federal procurement) hides the documents list behind
    // an "Interesse bekunden" / "Manifester l'intérêt" / "Manifestare
    // l'interesse" button — until the visitor explicitly expresses interest,
    // the tender attachments are not shown. We try to click that button so
    // the document list materialises on the next render. We deliberately
    // avoid the inverse "Interesse zurückziehen" / "Retirer l'intérêt"
    // button (which would withdraw an already-registered interest).
    //
    // Some flows pop a confirmation dialog ("Bestätigen" / "Confirmer" /
    // "Conferma") — we click that too if it appears. The whole step is
    // best-effort; any failure leaves the page state unchanged so the
    // standard extractor can still pull whatever public text is there.
    let simapInterestClicked = false;
    try {
      const finalHostNow = (() => {
        try { return new URL(srcPage.url()).hostname.toLowerCase(); }
        catch (_) { return ''; }
      })();
      if (/(^|\.)simap\.ch$/i.test(finalHostNow)) {
        const clickRes = await srcPage.evaluate(() => {
          const POSITIVE = /interesse\s*bekunden|manifester\s*(?:l'|l\s*’\s*)?intér[eè]t|manifestare\s*(?:l'|l\s*’\s*)?interesse|express\s*interest|register\s*interest/i;
          const NEGATIVE = /interesse\s*zur[üu]ckziehen|retirer\s*(?:l'|l\s*’\s*)?intér[eè]t|ritirare\s*(?:l'|l\s*’\s*)?interesse|withdraw\s*interest/i;
          const all = Array.from(document.querySelectorAll(
            'button, a, input[type="button"], input[type="submit"], [role="button"]'
          ));
          // Prefer enabled, visible candidates that match POSITIVE and not NEGATIVE.
          const candidates = all.filter(el => {
            const t = (el.textContent || el.value || '').trim();
            if (!t) return false;
            if (NEGATIVE.test(t)) return false;
            if (!POSITIVE.test(t)) return false;
            if (el.disabled) return false;
            const rect = el.getBoundingClientRect?.();
            if (rect && (rect.width === 0 || rect.height === 0)) return false;
            return true;
          });
          if (!candidates.length) return { clicked: false, reason: 'no-button' };
          const btn = candidates[0];
          btn.scrollIntoView?.({ block: 'center' });
          btn.click?.();
          return { clicked: true, label: (btn.textContent || btn.value || '').trim().slice(0, 80) };
        }).catch((e) => ({ clicked: false, reason: 'eval-error: ' + e.message }));

        if (clickRes && clickRes.clicked) {
          simapInterestClicked = true;
          console.log(`    simap: clicked "${clickRes.label}" — waiting for documents to render`);
          // Wait a bit, then attempt confirmation-dialog click if simap pops one.
          await new Promise(r => setTimeout(r, 1500));
          await srcPage.evaluate(() => {
            const CONFIRM = /^(?:bestätigen|best[äa]tigen|ja|confirmer|confirmer\s+l['’\s]intér[eè]t|conferma|confermare|confirm|ok)$/i;
            const NEG = /interesse\s*zur[üu]ckziehen|retirer|ritirare|abbrechen|annuler|cancella|cancel/i;
            const all = Array.from(document.querySelectorAll(
              'button, a, input[type="button"], input[type="submit"], [role="button"]'
            ));
            const btn = all.find(el => {
              const t = (el.textContent || el.value || '').trim();
              if (!t) return false;
              if (NEG.test(t)) return false;
              if (!CONFIRM.test(t)) return false;
              if (el.disabled) return false;
              const rect = el.getBoundingClientRect?.();
              if (rect && (rect.width === 0 || rect.height === 0)) return false;
              return true;
            });
            btn?.click?.();
          }).catch(() => {});
          // Give simap.ch a moment to re-render the documents list.
          await new Promise(r => setTimeout(r, 2500));
          // Wait for any download-looking link to appear (best-effort).
          await srcPage.waitForFunction(() => {
            const links = Array.from(document.querySelectorAll('a[href]'));
            return links.some(a => /\.(pdf|docx?|xlsx?|zip|rtf|odt|ods)(?:[?#]|$)/i.test(a.getAttribute('href') || ''));
          }, { timeout: 8000 }).catch(() => {});
        } else {
          console.log(`    simap: no "Interesse bekunden" button found (${clickRes?.reason || 'unknown'})`);
        }
      }
    } catch (e) {
      console.log(`    simap interest-button handler error: ${e.message}`);
    }

    // --- EXTRA SETTLE for ALWAYS_LOGIN_HOSTS post-auth pages ------------
    //
    // 2026-05-11 e-avrop diagnostic: after a successful login, the
    // Announcement.aspx page loads its main render in TWO phases. The
    // first paint settles around domcontentloaded + 1.2s — that's just
    // the masterpage nav chrome ("My pages / Log off / ANNOUNCEMENTS /
    // Language SV EN"). The actual tender body comes in via XHR roughly
    // 4-8s later, often inside an <iframe> the ASPX renderer injects
    // dynamically. The existing waitForFunction(>800ch) timed out at
    // 12s with only ~200ch of chrome, so we shipped to the eval with
    // an empty body.
    //
    // Workaround in two parts:
    //   1. Networkidle settle (5s) so deferred XHRs land.
    //   2. The main eval below walks same-origin <iframe>s and merges
    //      their innerText into bodyText so all qualification/regex
    //      extractors see the actual tender content.
    let postAuthHostMatch = false;
    try {
      const currentHost = new URL(srcPage.url()).hostname.toLowerCase();
      postAuthHostMatch = hostRequiresLogin(currentHost);
    } catch (_) { /* keep false */ }
    if (postAuthHostMatch) {
      try {
        await srcPage.waitForNetworkIdle({ idleTime: 800, timeout: 6000 }).catch(() => {});
        // Belt-and-braces: short additional settle for slow ASPX iframes
        // that hydrate after the network goes idle.
        await new Promise(r => setTimeout(r, 1500));
      } catch (_) { /* best-effort */ }
      // Quick diagnostic so we can iterate on the extraction strategy
      // without re-deploying blind. Logs iframe count + same-origin
      // accessible iframe content lengths.
      try {
        const diag = await srcPage.evaluate(() => {
          const iframes = Array.from(document.querySelectorAll('iframe'));
          const summary = iframes.slice(0, 6).map((f) => {
            const src = f.getAttribute('src') || '(no src)';
            let accessible = false;
            let textLen = 0;
            try {
              const doc = f.contentDocument;
              if (doc && doc.body) {
                accessible = true;
                textLen = (doc.body.innerText || '').length;
              }
            } catch (_) { /* cross-origin — leave inaccessible */ }
            return { src: src.slice(0, 120), accessible, textLen };
          });
          return {
            count: iframes.length,
            url: location.href,
            bodyLen: (document.body?.innerText || '').length,
            iframes: summary,
          };
        });
        console.log(
          `    🔎 post-auth diag: bodyLen=${diag.bodyLen}, iframes=${diag.count}` +
          (diag.iframes.length ? ` (${diag.iframes.map(f => `${f.accessible ? '✓' : '✗'}${f.textLen ? ' '+f.textLen+'ch' : ''} ${f.src.slice(0, 60)}`).join('; ')})` : '')
        );
      } catch (_) { /* diag is best-effort */ }
    }

    const result = await srcPage.evaluate((simapInterestClicked, mergeIframes) => {
      // Walk same-origin iframes and concatenate their innerText into
      // a combined body string. Falls back to just document.body
      // when no iframes are present or all are cross-origin. Enabled
      // only for ALWAYS_LOGIN_HOSTS so we don't slow down hosts that
      // don't need it. 2026-05-11 e-avrop fix: Announcement.aspx
      // wraps the tender content inside <iframe id="ctl00_..."> after
      // login, and document.body alone returns only header/footer.
      let bodyText = (document.body?.innerText || '').trim();
      if (mergeIframes) {
        try {
          const iframes = Array.from(document.querySelectorAll('iframe'));
          for (const f of iframes) {
            try {
              const doc = f.contentDocument;
              if (doc && doc.body) {
                const t = (doc.body.innerText || '').trim();
                if (t && t.length > 50) {
                  bodyText += '\n\n[iframe:' + (f.getAttribute('src') || '').slice(0, 80) + ']\n' + t;
                }
              }
            } catch (_) { /* cross-origin — skip */ }
          }
        } catch (_) { /* keep document.body fallback */ }
      }

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
      // A visible password field + at least one login-related word in the
      // page text is a strong enough signal on its own. Cloudia / Mercell
      // wholesale-portal patterns (tarjouspalvelu.fi, vergabeportal, etc.)
      // commonly inline a tender-description teaser ABOVE the login form,
      // which used to push the page over the previous 4000-char cap and
      // cause the gated detection to silently miss. Body-length only
      // matters now when there is NO password field at all (rare).
      const loginGated =
        (matchedMarkers >= 2 && (hasPasswordField || shortBody)) ||
        (hasPasswordField && matchedMarkers >= 1);

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

      // --- SOURCE-PAGE FILE-LINK INVENTORY ---------------------------
      //
      // Some portals (notably simap.ch after "Interesse bekunden" was
      // clicked) render document download links as plain <a href>'s
      // pointing at PDFs / DOCX / ZIPs / etc. We harvest those here so
      // the outer fetch loop can pull and parse them just like the
      // Mercell-internal collectedFiles.
      //
      // Heuristic: anchor href whose URL path or query ends in a known
      // document extension. Resolve relative URLs against the current
      // page. Deduplicate by absolute URL.
      const sourceFiles = (() => {
        const DOC_RE = /\.(pdf|docx?|xlsx?|zip|rtf|odt|ods|txt)(?:[?#]|$)/i;
        const seen = new Set();
        const out = [];
        const anchors = Array.from(document.querySelectorAll('a[href]'));
        for (const a of anchors) {
          const hrefRaw = a.getAttribute('href') || '';
          if (!hrefRaw || /^javascript:/i.test(hrefRaw)) continue;
          let abs = hrefRaw;
          try { abs = new URL(hrefRaw, location.href).toString(); } catch (_) { continue; }
          // simap.ch sometimes routes downloads through a "downloadFile"
          // handler that doesn't carry a doc extension in the URL but
          // does carry one in the link text. Catch those too.
          const linkText = (a.textContent || '').trim();
          const extFromUrl  = (abs.match(DOC_RE) || [])[1];
          const extFromName = (linkText.match(DOC_RE) || [])[1];
          const looksLikeDownload = /download|herunterladen|télécharger|scarica|attach|anhang|dokument|document|datei|fichier|allegato/i.test(linkText) ||
            /download|datei|file|attach|allegat/i.test(abs);
          const ext = (extFromUrl || extFromName || '').toLowerCase();
          if (!ext && !looksLikeDownload) continue;
          if (!ext) continue; // skip if we can't even guess an extension
          if (seen.has(abs)) continue;
          seen.add(abs);
          out.push({
            url: abs,
            name: linkText || abs.split('/').pop() || `source-file.${ext}`,
            ext,
          });
          if (out.length >= 20) break;
        }
        return out;
      })();

      // --- PLACSP (contrataciondelestado.es) PRIORITY HUNT -----------
      //
      // Spanish public procurement portal (Plataforma de Contratación
      // del Sector Público) lists each tender's documents as anchors
      // pointing at /FileSystem/servlet/GetDocumentByIdServlet — that
      // servlet streams the actual PDF (Pliego Cláusulas Administrativas,
      // Pliego Prescripciones Técnicas, Anuncio de Licitación). The
      // anchor's visible text is ALWAYS the generic tooltip "Este
      // documento se abrirá en una nueva ventana" — the document type
      // (Pliego / Anuncio / Decreto / etc.) lives in a SIBLING
      // <td class="tipoDocumento"> cell of the same <tr>. We therefore:
      //   1. URL-match the GetDocumentByIdServlet servlet (catches all
      //      document anchors regardless of their text)
      //   2. Read the document type from the closest <tr>'s row text
      //      so PCAP gets prioritised over Anuncio/Decreto in the
      //      per-file/total char caps downstream.
      // PCAP holds qualification requirements (cl. 11, 14, 15.3.1,
      // 15.3.2 + Cuadro de Características apartado 15) and award
      // criteria (apartado 21) — i.e. exactly the columns the sheet
      // needs.
      const placspResult = (() => {
        const isPlacsp = /(^|\.)contrataciondelestado\.es$/i.test(location.host);
        if (!isPlacsp) {
          return { files: [], stats: null };
        }
        // Document-type patterns we look for in the row's <td class=
        // "tipoDocumento"> cell. Order = priority (lower index wins).
        const ROW_TYPE_RE = [
          { rank: 0, name: 'PCAP',       re: /pliego\s+cl[aá]usulas\s+administrativas|cl[aá]usulas\s+administrativas\s+particulares/i },
          { rank: 1, name: 'PPT',        re: /pliego\s+prescripciones\s+t[eé]cnicas|prescripciones\s+t[eé]cnicas\s+particulares/i },
          { rank: 2, name: 'Pliego',     re: /\bpliego\b/i },                  // generic "Pliego" — the PCAP-or-bundle case
          { rank: 3, name: 'Anuncio',    re: /anuncio\s+de\s+licitaci[oó]n/i },
          { rank: 4, name: 'DocPliegos', re: /documento\s+de\s+pliegos/i },
          { rank: 5, name: 'Decreto',    re: /decreto\s+aprobando\s+(?:el\s+)?pliego/i },
        ];
        // PLACSP servlet patterns — these cover all document download
        // anchors regardless of which sub-portlet generated them.
        const URL_RE = [
          /\/FileSystem\/servlet\/GetDocumentByIdServlet/i,    // primary — observed in real DOM
          /docAccCmpnt/i,                                       // alt variant (older portlets)
          /GetDocumentsById/i,                                  // alt variant
          /uri=deeplink:detalle_(?:pliego|anuncio)/i,           // deeplink-style
        ];

        const seenPriority = new Set();
        const out2 = [];
        const allAnchors = Array.from(document.querySelectorAll('a[href]'));
        const totalAnchors = allAnchors.length;
        let textMatches = 0;
        let urlMatches = 0;
        const sampleTexts = [];

        // For every anchor, check (a) its text, (b) its closest <tr>'s
        // row text, (c) the URL pattern. If ANY of those identify it as
        // a PLACSP document, include it. Document type is decided by
        // matching the row text against ROW_TYPE_RE — that's how we
        // distinguish PCAP from PPT from Anuncio when all anchors say
        // "Este documento se abrirá en una nueva ventana".
        for (const a of allAnchors) {
          const hrefRaw = a.getAttribute('href') || '';
          if (!hrefRaw || /^javascript:/i.test(hrefRaw) || hrefRaw === '#') continue;
          let abs;
          try { abs = new URL(hrefRaw, location.href).toString(); }
          catch (_) { continue; }
          if (seenPriority.has(abs)) continue;

          const ownText = (a.textContent || a.getAttribute('title') || '').trim();
          const row = a.closest('tr');
          const rowText = row ? (row.innerText || row.textContent || '').replace(/\s+/g, ' ').trim() : '';
          const urlMatch = URL_RE.some(re => re.test(abs));

          // Determine document type from row text. Walk ROW_TYPE_RE in
          // order; first hit wins. If nothing matches the row, fall
          // back to the anchor's own text (some portlets embed the
          // document name directly).
          let chosenType = null;
          for (const rt of ROW_TYPE_RE) {
            if (rt.re.test(rowText) || rt.re.test(ownText)) {
              chosenType = rt;
              break;
            }
          }

          // Skip anchors that are neither URL-matched NOR text-matched.
          // This filters out navigation / footer / boilerplate links.
          if (!urlMatch && !chosenType) continue;

          // If we URL-matched but couldn't ID a type, accept anyway
          // (the anchor still leads to a PLACSP document — better to
          // grab it than to miss it).
          const finalRank = chosenType ? chosenType.rank : 50;
          const finalName = chosenType
            ? `${chosenType.name}: ${(rowText || ownText).slice(0, 100)}`
            : (ownText || `placsp-doc-${out2.length + 1}`).slice(0, 120);
          const matchType = chosenType && urlMatch ? 'text+url'
                          : chosenType            ? 'text'
                          :                         'url';

          seenPriority.add(abs);
          out2.push({
            url: abs,
            name: finalName,
            ext: 'pdf',
            priority: true,
            priorityRank: finalRank,
            matchType,
          });
          if (chosenType) textMatches += 1;
          if (urlMatch && !chosenType) urlMatches += 1;
        }
        // Sort by rank — PCAP first, PPT next, etc.
        out2.sort((a, b) => a.priorityRank - b.priorityRank);

        // Diagnostic sample of first 6 anchor texts so we can see what
        // the page actually looked like when nothing matched.
        for (const a of allAnchors.slice(0, 30)) {
          const t = (a.textContent || '').trim().slice(0, 80);
          if (t) sampleTexts.push(t);
          if (sampleTexts.length >= 6) break;
        }

        return {
          files: out2,
          stats: { totalAnchors, textMatches, urlMatches, sampleTexts },
        };
      })();
      const placspFiles = placspResult.files;

      // Merge PLACSP priority docs at the FRONT of the file list, drop
      // duplicates from the generic harvest. Cap the combined list at
      // 20 entries (same as before) so the prefetch loop terminates.
      const sourceFilesMerged = (() => {
        if (!placspFiles.length) return sourceFiles;
        const priorityUrls = new Set(placspFiles.map(f => f.url));
        const generic = sourceFiles.filter(f => !priorityUrls.has(f.url));
        return [...placspFiles, ...generic].slice(0, 20);
      })();

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
        bodyLength: bodyText.length,
        sourceFiles: sourceFilesMerged,
        placspDocsFound: placspFiles.length,
        placspStats: placspResult.stats,
        simapInterestClicked: !!simapInterestClicked,
      };
    }, simapInterestClicked, postAuthHostMatch);

    // Defense-in-depth: if the early PLACSP snapshot found docs but the
    // main eval didn't (page state changed in between), use the
    // snapshot. We prepend; dedupe by URL against existing files.
    if (placspSnapshot && placspSnapshot.files && placspSnapshot.files.length) {
      const existingUrls = new Set((result.sourceFiles || []).map(f => f.url));
      const fromSnapshot = placspSnapshot.files.filter(f => !existingUrls.has(f.url));
      if (fromSnapshot.length) {
        result.sourceFiles = [...fromSnapshot, ...(result.sourceFiles || [])].slice(0, 20);
        result.placspDocsFound = (result.placspDocsFound || 0) + fromSnapshot.length;
        console.log(`    🇪🇸 PLACSP snapshot rescue: prepended ${fromSnapshot.length} doc(s) the main eval missed`);
      }
    }

    // --- PRE-FETCH + PARSE source-page document bytes -------------------
    //
    // sourceFiles point at absolute URLs that often live on the source
    // portal's own domain (simap.ch, etc.) — meaning their authenticated
    // session cookies are bound to *this* tab, not Mercell's. We fetch
    // them now (while srcPage is still open) using the page's own fetch
    // (carries simap.ch cookies + Interesse-bekunden state), then parse
    // each buffer with the same multi-format toolset that the Mercell
    // pipeline uses. The combined text is returned as
    // `result.sourceFilesText` so the outer pipeline can append it to
    // `details.pdfText` without needing to know about the source domain.
    try {
      if (Array.isArray(result?.sourceFiles) && result.sourceFiles.length) {
        const hasPriority = result.sourceFiles.some(f => f && f.priority);
        if (result.placspDocsFound) {
          console.log(`    🇪🇸 PLACSP: ${result.placspDocsFound} priority document(s) detected (PCAP/PPT/Anuncio) — bumping char caps`);
        }
        const MAX_SRC_FILES = 8;
        // PLACSP PCAP files routinely run 50–70 pages (≈100–180k chars).
        // The detailed solvency / award-criteria numbers (ANEXO 3 with
        // hard turnover thresholds, technical-experience minimums, ISO
        // certificate lists, and Cuadro de Características apartado 21
        // weights) are typically on pages 45–55 of the PDF, deep in
        // the body. Originally we capped each priority file at 60k
        // chars (≈25 pages) — that cut off ANEXO 3 entirely and the
        // AI was left only with the 1–15 generic legal preamble
        // (DEUC / Social Security boilerplate every Spanish tender
        // shares). Bumping per-file to 150k captures the full PCAP,
        // and 180k total fits Anuncio + PCAP + PPT in one AI prompt.
        // Claude Haiku 4.5 has 200k context so it has headroom.
        const SRC_DOC_CHAR_CAP_DEFAULT  = 30000;       // per non-priority file
        const SRC_DOC_CHAR_CAP_PRIORITY = 150000;      // per PLACSP priority file
        const SRC_TOTAL_CHAR_CAP        = hasPriority ? 180000 : 80000;
        // Keep legacy name `SRC_DOC_CHAR_CAP` for the inner zip recursion
        // — for zip entries we always use the default cap, since priority
        // PCAP/PPT docs themselves are PDFs, not zips.
        const SRC_DOC_CHAR_CAP = SRC_DOC_CHAR_CAP_DEFAULT;
        // Lazy-load optional deps; missing ones just degrade per-format.
        let pdfParse2 = null, mammoth2 = null, XLSX2 = null, AdmZip2 = null;
        try { pdfParse2 = require('pdf-parse'); } catch (_) {}
        try { mammoth2  = require('mammoth');   } catch (_) {}
        try { XLSX2     = require('xlsx');      } catch (_) {}
        try { AdmZip2   = require('adm-zip');   } catch (_) {}

        const detectFormat2 = (buf) => {
          if (!buf || buf.length < 4) return 'unknown';
          const b0 = buf[0], b1 = buf[1], b2 = buf[2], b3 = buf[3];
          if (b0 === 0x25 && b1 === 0x50 && b2 === 0x44 && b3 === 0x46) return 'pdf';
          if (b0 === 0x50 && b1 === 0x4B && (b2 === 0x03 || b2 === 0x05 || b2 === 0x07)) return 'zip';
          if (b0 === 0xD0 && b1 === 0xCF && b2 === 0x11 && b3 === 0xE0) return 'cfb';
          if (b0 === 0x7B && b1 === 0x5C && b2 === 0x72 && b3 === 0x74) return 'rtf';
          const head = buf.slice(0, 64).toString('utf8').trim().toLowerCase();
          if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml') || head.startsWith('<')) return 'html';
          if (head.startsWith('{') || head.startsWith('[')) return 'json';
          return 'unknown';
        };
        const magicMatchesExt2 = (buf, ext) => {
          const got = detectFormat2(buf);
          const ex = String(ext || '').toLowerCase();
          if (ex === 'pdf') return got === 'pdf';
          if (['docx', 'xlsx', 'odt', 'ods', 'zip'].includes(ex)) return got === 'zip';
          if (ex === 'doc' || ex === 'xls') return got === 'cfb';
          if (ex === 'rtf') return got === 'rtf';
          if (ex === 'txt') return got !== 'html';
          return true;
        };

        const parseBuf = async (name, ext, bytes) => {
          if (!bytes || !bytes.length) return '';
          const ex = String(ext || '').toLowerCase();
          if (!magicMatchesExt2(bytes, ex)) {
            const got = detectFormat2(bytes);
            console.log(`    ⚠️ src ${ex.toUpperCase()} "${name}" magic mismatch (got=${got}, ${bytes.length}B) — skipping`);
            return '';
          }
          try {
            if (ex === 'pdf') {
              if (!pdfParse2) return '';
              const parsed = await pdfParse2(bytes);
              return (parsed && parsed.text ? parsed.text : '').trim();
            }
            if (ex === 'docx' || ex === 'odt') {
              if (!mammoth2) return '';
              const out = await mammoth2.extractRawText({ buffer: bytes });
              return (out && out.value ? out.value : '').trim();
            }
            if (ex === 'xlsx' || ex === 'xls' || ex === 'ods') {
              if (!XLSX2) return '';
              const wb = XLSX2.read(bytes, { type: 'buffer' });
              const parts = [];
              for (const sn of wb.SheetNames) {
                const csv = XLSX2.utils.sheet_to_csv(wb.Sheets[sn]);
                if (csv && csv.trim()) parts.push(`# Sheet: ${sn}\n${csv}`);
              }
              return parts.join('\n\n').trim();
            }
            if (ex === 'rtf' || ex === 'txt') {
              const raw = bytes.toString('utf8');
              if (ex === 'txt') return raw.trim();
              return raw.replace(/\\[a-z]+-?\d*\s?/gi, ' ').replace(/[{}]/g, ' ').replace(/\s+/g, ' ').trim();
            }
            if (ex === 'zip') {
              if (!AdmZip2) return '';
              const zip = new AdmZip2(bytes);
              const entries = zip.getEntries().filter(e => !e.isDirectory).slice(0, 5);
              const parts = [];
              for (const z of entries) {
                const innerBytes = z.getData();
                const innerExt = (z.entryName.match(/\.([a-z0-9]{1,5})$/i) || [])[1] || '';
                const t = await parseBuf(z.entryName, innerExt, innerBytes);
                if (t) parts.push(`--- (zip:${name}) ${z.entryName} ---\n${t.slice(0, SRC_DOC_CHAR_CAP)}`);
              }
              return parts.join('\n\n');
            }
          } catch (e) {
            console.log(`    ⚠️ src ${ex.toUpperCase()} parse failed for "${name}": ${e.message}`);
            return '';
          }
          return '';
        };

        // --- PDF ANNOTATION URI EXTRACTOR ----------------------------
        //
        // PLACSP "Documento de Pliegos" PDFs embed clickable hyperlinks
        // (e.g. anchor "Pliego Cláusulas Administrativas" → real PCAP
        // PDF) as PDF link annotations. pdf-parse only returns rendered
        // text, so the URLs are invisible in `parsed.text`. We scan the
        // raw buffer for `/URI (https://...)` annotation entries — works
        // for uncompressed object streams (which PLACSP-generated PDFs
        // typically have). FlateDecode-compressed PDFs would hide them;
        // those need pdf-lib, but in practice the gov-issued PLACSP
        // bundles ship uncompressed annotations.
        const extractPdfAnnotationUrls = (bytes) => {
          if (!bytes || !bytes.length) return [];
          let raw;
          try { raw = bytes.toString('latin1'); }
          catch (_) { return []; }
          const out = new Set();
          const re = /\/URI\s*\(([^)]{8,500})\)/g;
          let m;
          while ((m = re.exec(raw)) !== null) {
            // PDF strings can be padded with whitespace and may contain
            // escaped chars — strip the obvious ones.
            const url = m[1].replace(/\\([rnt()\\])/g, ' ').trim();
            if (/^https?:\/\//i.test(url)) out.add(url);
          }
          return Array.from(out);
        };
        // Recognise the URL patterns that PLACSP uses for PCAP / Pliego
        // downloads. Anchor text "Pliego Cláusulas Administrativas"
        // typically links to a `docAccCmpnt` servlet URL with a
        // DocumentIdParam query param. We also accept any URL that
        // mentions "Pliego" or "Cláusulas" outright.
        const isPlacspPliegoUrl = (url) => {
          if (!url) return false;
          if (!/contrataciondelestado\.es/i.test(url)) return false;
          return /docAccCmpnt|GetDocumentsById|cl[aá]usulas|pliego/i.test(url);
        };

        // Track URLs we've already fetched so we don't loop on
        // self-referencing PDFs (the "Documento de Pliegos" sometimes
        // includes its own link, etc.).
        const fetchedUrls = new Set();

        // Inner helper: fetch + parse one URL, append text to docTexts,
        // return the buffer so callers can mine annotations.
        const fetchParseOne = async (sf, capOverride) => {
          if (fetchedUrls.has(sf.url)) return { skipped: true };
          fetchedUrls.add(sf.url);
          const fetched = await srcPage.evaluate(async (url) => {
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
          }, sf.url);
          if (!(fetched && fetched.ok && fetched.size > 100)) {
            const tail = fetched ? `status=${fetched.status || '?'}, ct=${(fetched.contentType || '').slice(0, 40)}` : 'no-response';
            console.log(`    ⚠️ src fetch failed "${sf.name}" (${tail})`);
            return { error: 'fetch-failed' };
          }
          const buf = Buffer.from(fetched.data);
          const text = await parseBuf(sf.name, sf.ext, buf);
          if (text) {
            const perFileCap = capOverride
              || (sf.priority ? SRC_DOC_CHAR_CAP_PRIORITY : SRC_DOC_CHAR_CAP_DEFAULT);
            const clipped = text.slice(0, perFileCap);
            docTexts.push(`--- (source) ${sf.name} ---\n${clipped}`);
            totalChars += clipped.length;
            okCount += 1;
            const tag = sf.priority ? '⭐ PRIORITY' : '📄';
            console.log(`    ${tag} parsed source ${String(sf.ext).toUpperCase()} "${sf.name}" (${buf.length}B → ${clipped.length}ch${sf.priority ? `, cap=${perFileCap}` : ''})`);
          } else {
            console.log(`    ⚠️ src ${String(sf.ext).toUpperCase()} "${sf.name}" had no extractable text`);
          }
          return { buf, hadText: !!text };
        };

        const docTexts = [];
        let okCount = 0;
        let totalChars = 0;

        // GENERIC-HELP-DOC FILTER
        //
        // Some portals (notably metromadrid.es, juntadeandalucia.es) list
        // "how to use this portal" PDFs as their only public-facing files
        // — things like "Cómo Descargar pliegos", "Dudas frecuentes",
        // "Obtención del Certificado Digital", "User guide", "Manual",
        // "FAQ", etc. These are NOT tender content and parsing them into
        // pdfText pollutes the AI's input with generic instructions, which
        // can lead to AI hallucinating that the tender is "about portal
        // certificate obtention" or similar nonsense.
        //
        // 2026-05-12 ES run: Metro Madrid Documentum tender pulled 3 such
        // PDFs (Cómo Descargar 20370ch + Dudas 6166ch + Certificado 9628ch
        // = 36k chars of pure portal-howto noise). Budget filter saved us
        // that time (€475K < 500K) — but a €600K tender would have written
        // garbage scope/qualifications.
        //
        // The filter applies to filename + URL; if either matches a known
        // help/howto pattern, the file is skipped before fetch.
        const GENERIC_HELP_DOC_RE = new RegExp(
          [
            // Spanish
            'c[óo]mo\\s+descargar', 'descargar\\s+pliegos', 'presentar\\s+ofertas',
            'dudas\\s+frecuentes', 'preguntas\\s+frecuentes', 'obtenci[óo]n\\s+del?\\s+certificado',
            'manual\\s+(?:de\\s+)?(?:uso|usuario|licitador)', 'gu[íi]a\\s+(?:de\\s+)?(?:uso|usuario)',
            // English
            'how\\s+to\\s+(?:download|register|apply|use|submit|access)',
            'frequently\\s+asked', '\\bfaq\\b', 'user\\s+guide', 'user\\s+manual',
            'getting\\s+started', 'quick\\s+start',
            // French
            'guide\\s+d[\'’]?utilisation', 'mode\\s+d[\'’]?emploi', 'foire\\s+aux\\s+questions',
            'comment\\s+(?:t[ée]l[ée]charger|d[ée]poser|s[\'’]?inscrire)',
            // German
            'bedienungsanleitung', 'benutzerhandbuch', 'h[äa]ufige\\s+fragen',
            'anleitung', 'kurzanleitung',
            // Italian
            'manuale\\s+(?:utente|uso)', 'guida\\s+(?:utente|all[\'’]?uso)',
            'domande\\s+frequenti',
            // Dutch
            'gebruikershandleiding', 'veelgestelde\\s+vragen',
            // Generic
            'help\\s*(?:file|document|pdf)?\\b',
          ].join('|'),
          'i'
        );
        const isGenericHelpDoc = (sf) => {
          if (!sf) return false;
          const haystack = `${sf.name || ''} ${sf.url || ''}`;
          return GENERIC_HELP_DOC_RE.test(haystack);
        };

        // PASS 1 — fetch + parse the original sourceFiles (PLACSP
        // priority docs first thanks to the front-of-array merge).
        for (const sf of result.sourceFiles.slice(0, MAX_SRC_FILES)) {
          if (totalChars >= SRC_TOTAL_CHAR_CAP) break;
          if (isGenericHelpDoc(sf)) {
            console.log(`    🚫 skipping generic-help doc "${(sf.name || '').slice(0, 70)}" (matches howto/manual/FAQ pattern)`);
            continue;
          }
          try {
            const r1 = await fetchParseOne(sf);
            if (r1.skipped || r1.error || !r1.buf) continue;

            // PASS 2 — when this PDF was a PLACSP priority doc (e.g.
            // "Documento de Pliegos"), mine its link annotations for an
            // embedded PCAP URL and follow it. Cap recursion at 1 hop.
            if (sf.priority && sf.ext === 'pdf' && /(^|\.)contrataciondelestado\.es$/i.test(result.sourceHost || '')) {
              const innerUrls = extractPdfAnnotationUrls(r1.buf);
              const candidates = innerUrls
                .filter(isPlacspPliegoUrl)
                .filter(u => !fetchedUrls.has(u));
              if (innerUrls.length) {
                console.log(`    🔗 PDF "${sf.name}" embedded ${innerUrls.length} URL(s); ${candidates.length} match PCAP/Pliego pattern`);
              }
              // Heuristic: prefer URLs whose surrounding raw bytes
              // mention "Cláusulas Administrativas" (PCAP). We can't do
              // proper context-anchoring without a real PDF parser, so
              // we just pull at most 3 candidates and let pdf-parse
              // tell us which one had real PCAP body via char count.
              for (const url of candidates.slice(0, 3)) {
                if (totalChars >= SRC_TOTAL_CHAR_CAP) break;
                console.log(`    ↳ following embedded link: ${url.slice(0, 100)}`);
                await fetchParseOne({
                  url,
                  name: 'PCAP (embedded link from Documento de Pliegos)',
                  ext: 'pdf',
                  priority: true,
                  fromAnnotation: true,
                });
              }
            }
          } catch (e) {
            console.log(`    ⚠️ src file "${sf.name}" error: ${e.message}`);
          }
        }
        if (docTexts.length) {
          result.sourceFilesText = docTexts.join('\n\n').slice(0, SRC_TOTAL_CHAR_CAP);
        }
        console.log(`    source files prefetched/parsed: ${okCount}/${result.sourceFiles.length} (host: ${result.sourceHost})${fetchedUrls.size > result.sourceFiles.length ? `, +${fetchedUrls.size - result.sourceFiles.length} via embedded annotations` : ''}`);
        // Trim raw bytes from result (we no longer need them to leave the helper)
        result.sourceFiles = result.sourceFiles.map(sf => ({
          name: sf.name, ext: sf.ext, url: sf.url,
        }));
      }
    } catch (e) {
      console.log(`    source-file prefetch error: ${e.message}`);
    }

    // eu-supply.com Documents handler — fires only on CTM's
    // rwlentrance_s.asp / PublicPurchase URLs. The entrance page hides
    // the actual procurement docs behind a separate page reached via
    // a JavaScript DownloadPublicDocument() call. We open a side page
    // to navigate + extract those, then append the parsed text to
    // result.sourceFilesText. No-op for any non-eu-supply tender.
    try {
      const euSupplyTexts = await fetchEuSupplyDocuments(browser, sourceUrl);
      if (euSupplyTexts && euSupplyTexts.length) {
        const SRC_TOTAL_CAP = 200000;
        const existing = result.sourceFilesText || '';
        const sep = existing ? '\n\n' : '';
        const combined = (existing + sep + euSupplyTexts.join('\n\n')).slice(0, SRC_TOTAL_CAP);
        result.sourceFilesText = combined;
        console.log(`    🇳🇴 eu-supply: appended ${euSupplyTexts.length} doc(s) to sourceFilesText (total ${combined.length}ch)`);
      }
    } catch (e) {
      console.log(`    ⚠️ eu-supply handler outer error: ${(e.message || '').slice(0, 100)}`);
    }

    // TenderNed (www.tenderned.nl) Documents handler — NL public tenders.
    // The announcement page itself only contains metadata + scope; the
    // formal Selectiecriteria / Programma van Eisen sit in attached
    // PDFs/DOCXs that Mercell exposes as S3 URLs (all 403). TenderNed
    // hosts the same documents on its own domain — we harvest in-page
    // anchors and download directly. No-op for non-tenderned sources.
    try {
      const tenderNedTexts = await fetchTenderNedDocuments(browser, sourceUrl);
      if (tenderNedTexts && tenderNedTexts.length) {
        const SRC_TOTAL_CAP = 200000;
        const existing = result.sourceFilesText || '';
        const sep = existing ? '\n\n' : '';
        const combined = (existing + sep + tenderNedTexts.join('\n\n')).slice(0, SRC_TOTAL_CAP);
        result.sourceFilesText = combined;
        console.log(`    🇳🇱 tenderned: appended ${tenderNedTexts.length} doc(s) to sourceFilesText (total ${combined.length}ch)`);
      }
    } catch (e) {
      console.log(`    ⚠️ tenderned handler outer error: ${(e.message || '').slice(0, 100)}`);
    }

    // tarjouspalvelu.fi (Finnish Cloudia-fronted) Documents handler —
    // direct ZIP at /Zip/TarjousPyynnonLiitteet/<id> after login. No-op
    // for non-tarjouspalvelu sources.
    try {
      const tpTexts = await fetchTarjouspalveluDocuments(browser, sourceUrl);
      if (tpTexts && tpTexts.length) {
        const SRC_TOTAL_CAP = 200000;
        const existing = result.sourceFilesText || '';
        const sep = existing ? '\n\n' : '';
        const combined = (existing + sep + tpTexts.join('\n\n')).slice(0, SRC_TOTAL_CAP);
        result.sourceFilesText = combined;
        console.log(`    🇫🇮 tarjouspalvelu: appended ${tpTexts.length} doc(s) to sourceFilesText (total ${combined.length}ch)`);
      }
    } catch (e) {
      console.log(`    ⚠️ tarjouspalvelu handler outer error: ${(e.message || '').slice(0, 100)}`);
    }

    // tendsign.com Documents handler — Swedish/Norwegian Visma Commerce
    // platform. Session-protected attachment downloads on the same
    // domain. No-op for non-tendsign sources.
    try {
      const tendSignTexts = await fetchTendSignDocuments(browser, sourceUrl);
      if (tendSignTexts && tendSignTexts.length) {
        const SRC_TOTAL_CAP = 200000;
        const existing = result.sourceFilesText || '';
        const sep = existing ? '\n\n' : '';
        const combined = (existing + sep + tendSignTexts.join('\n\n')).slice(0, SRC_TOTAL_CAP);
        result.sourceFilesText = combined;
        console.log(`    🇸🇪 tendsign: appended ${tendSignTexts.length} doc(s) to sourceFilesText (total ${combined.length}ch)`);
      }
    } catch (e) {
      console.log(`    ⚠️ tendsign handler outer error: ${(e.message || '').slice(0, 100)}`);
    }

    // e-avrop.com Documents handler — Swedish Antirio platform.
    // Triggers ASP.NET __doPostBack('ctl00$mainContent$createZip','')
    // which streams a ZIP containing every attachment. Auth cookies
    // already set by attemptPortalLogin (e-avrop in ALWAYS_LOGIN_HOSTS).
    // No-op for non-e-avrop sources.
    try {
      const eavropTexts = await fetchEavropDocuments(browser, sourceUrl);
      if (eavropTexts && eavropTexts.length) {
        const SRC_TOTAL_CAP = 200000;
        const existing = result.sourceFilesText || '';
        const sep = existing ? '\n\n' : '';
        const combined = (existing + sep + eavropTexts.join('\n\n')).slice(0, SRC_TOTAL_CAP);
        result.sourceFilesText = combined;
        console.log(`    🇸🇪 e-avrop: appended ${eavropTexts.length} doc(s) to sourceFilesText (total ${combined.length}ch)`);
      }
    } catch (e) {
      console.log(`    ⚠️ e-avrop handler outer error: ${(e.message || '').slice(0, 100)}`);
    }

    // kommersannons.se Documents handler — Swedish Kommers Annons /
    // FMV platform. Post-login the notice page exposes nav tabs
    // ("Contract documents" / "Entire tender form" / "Appendices");
    // each leads to a documents subpage with PDF/DOCX/ZIP download
    // anchors. Handler clicks/navigates the tabs and harvests docs.
    // No-op for non-kommersannons sources.
    try {
      const kaTexts = await fetchKommersAnnonsDocuments(browser, sourceUrl);
      if (kaTexts && kaTexts.length) {
        const SRC_TOTAL_CAP = 200000;
        const existing = result.sourceFilesText || '';
        const sep = existing ? '\n\n' : '';
        const combined = (existing + sep + kaTexts.join('\n\n')).slice(0, SRC_TOTAL_CAP);
        result.sourceFilesText = combined;
        console.log(`    🇸🇪 kommersannons: appended ${kaTexts.length} doc(s) to sourceFilesText (total ${combined.length}ch)`);
      }
    } catch (e) {
      console.log(`    ⚠️ kommersannons handler outer error: ${(e.message || '').slice(0, 100)}`);
    }

    // contrataciondelestado.es (PLACSP) Documents handler — Spanish
    // public-procurement platform. Detects PCAP / PPT / Anuncio /
    // DocPliegos anchors (servlet URL + <tr> row text), fetches with
    // magic-byte format detection (PDFs + ZIP bundles), and parses.
    // Complements the inline PLACSP harvest by handling ZIP bundles
    // (which inline ext='pdf' hardcoding misses) and iframe-hosted
    // document tables. No-op for non-PLACSP sources.
    try {
      const placspTexts = await fetchPlacspDocuments(browser, sourceUrl);
      if (placspTexts && placspTexts.length) {
        const SRC_TOTAL_CAP = 200000;
        const existing = result.sourceFilesText || '';
        const sep = existing ? '\n\n' : '';
        const combined = (existing + sep + placspTexts.join('\n\n')).slice(0, SRC_TOTAL_CAP);
        result.sourceFilesText = combined;
        console.log(`    🇪🇸 PLACSP: appended ${placspTexts.length} doc(s) to sourceFilesText (total ${combined.length}ch)`);
      }
    } catch (e) {
      console.log(`    ⚠️ PLACSP handler outer error: ${(e.message || '').slice(0, 100)}`);
    }

    srcPage.off('request', blockHandler);
    try { await srcPage.setRequestInterception(false); } catch (_) {}
    return result;
  } catch (e) {
    const msg = e.message || String(e);
    // Some portals (notably www.mytenders.co.uk's NoticeBuilder_FileDownload
    // endpoint, Jaggaer's eu-supply gateway, etc.) trigger a hard redirect
    // to their login form during page.evaluate(), which Puppeteer surfaces
    // as "Execution context was destroyed, most likely because of a
    // navigation". That is functionally a login wall — we never got to
    // read the page body — so treat it as loginGated so the source-loop
    // retries with portal credentials instead of silently giving up.
    const navMidEval =
      /Execution context was destroyed/i.test(msg) ||
      /Target closed/i.test(msg) ||
      /Navigation timeout/i.test(msg) ||
      /detached Frame/i.test(msg);
    if (navMidEval) {
      let host = null;
      try { host = new URL(sourceUrl).hostname.toLowerCase(); } catch (_) {}
      // Try one last URL read from the live page in case it stabilised.
      let finalUrl = '';
      try { finalUrl = (srcPage && srcPage.url && srcPage.url()) || ''; } catch (_) {}
      if (finalUrl) {
        try { host = new URL(finalUrl).hostname.toLowerCase() || host; } catch (_) {}
      }
      console.log(`    source nav-mid-extract → treating as login-gated (host: ${host || 'n/a'})`);
      return {
        loginGated: true,
        sourceHost: host,
        matchedMarkers: 0,
        hasPasswordField: null,
        bodyLength: 0,
        bodyTextPreview: '',
        navError: msg.slice(0, 200),
      };
    }
    return { error: msg };
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
  // Bearer token captured from the SPA's own outgoing API requests.
  // Mercell's frontend stores its access token in localStorage and sends
  // it as `Authorization: Bearer <token>` on every XHR to *.discover.app.
  // mercell.com. Cookies alone aren't enough — the search-service-api
  // returns 401 without this header. We capture it once from the first
  // intercepted request and reuse it on direct file fetches via CDP.
  let mercellBearer = null;
  try {
    await page.setRequestInterception(true);
    blockHandler = (req) => {
      const type = req.resourceType();
      // Sniff the outgoing Authorization header for any Mercell-internal
      // API call. Captured ONCE and reused thereafter; the token is
      // session-scoped and stable for the lifetime of this page.
      try {
        if (!mercellBearer) {
          const reqUrl = req.url();
          if (/\.discover\.app\.mercell\.com\//.test(reqUrl)) {
            const headers = req.headers() || {};
            const auth = headers.authorization || headers.Authorization;
            if (auth && /^bearer\s+/i.test(auth)) {
              mercellBearer = auth;
              console.log(`    🔑 captured Mercell Bearer (${auth.length}ch) from ${new URL(reqUrl).hostname}`);
            }
          }
        }
      } catch (_) { /* ignore */ }
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

    // --- FILE-ROW DOM PROBE + CLICK ------------------------------------
    // Praeitam runn'e atradom, kad documents tab'as yra automatiškai
    // atidarytas (SPA'oje matėm „document name upload date file size ..."
    // antraštės eilutę DIV'e). Reiškia, failai jau renderinami DOM'e — tik
    // mes nemokam jų parsisiųsti. Šis blokas:
    //   1) Suskenuoja DOM ir randa elementus, kurių text'as panašus į
    //      failo vardą (turi .pdf/.docx/.xlsx/... plėtinį).
    //   2) Išspausdina jų href / data-* atributus — jei href yra, gausim
    //      URL be jokio click'o.
    //   3) Paspaudžia pirmą tokį elementą, kad pamatytume, kokį XHR'ą
    //      Mercell SPA iššaukia (visus host'us, ne tik mercell.com).
    const docsClickUrls = [];
    const docsClickResponseHandler = (res) => {
      try {
        const url = res.url();
        // NOISE_HOST_RE filter applied at log time, capture everything here
        const headers = res.headers() || {};
        const ctype = headers['content-type'] || '';
        const size = headers['content-length'] || '';
        docsClickUrls.push({
          url,
          status: res.status(),
          ctype,
          size,
        });
      } catch (_) { /* ignore */ }
    };
    const docsClickRequestHandler = (req) => {
      try {
        // Catch redirects / navigations / downloads that may not produce
        // a `response` event in this context.
        const url = req.url();
        const rt = req.resourceType();
        if (rt === 'document' || rt === 'xhr' || rt === 'fetch' || rt === 'other') {
          docsClickUrls.push({
            url,
            status: 'REQ',
            ctype: rt,
            size: '',
          });
        }
      } catch (_) { /* ignore */ }
    };
    page.on('response', docsClickResponseHandler);
    page.on('request', docsClickRequestHandler);

    // 1) Pasiklausom navigation events — kad nepraleistum top-level
    //    navigation'o, kuris gali būti file download trigger.
    let navUrls = [];
    const frameNavHandler = (frame) => {
      try {
        if (frame === page.mainFrame()) {
          navUrls.push(frame.url());
        }
      } catch (_) {}
    };
    page.on('framenavigated', frameNavHandler);

    // 2) DOM probe — search for filename-like text + capture surrounding
    //    anchor's href / data attributes. This often reveals the download
    //    URL without needing to click anything.
    let domProbe = [];
    let clickProbe = { clicked: false };
    try {
      domProbe = await page.evaluate(() => {
        const EXT_RE = /\.(pdf|docx?|xlsx?|zip|rtf|txt|odt|ods|xml|json|csv|tsv|pptx?)\b/i;
        const out = [];
        const seen = new Set();
        const all = Array.from(document.querySelectorAll('a, button, [role="link"], [role="button"], [class*="file" i], [class*="document" i], [class*="attach" i], [class*="download" i]'));
        for (const el of all) {
          const txt = ((el.innerText || el.textContent || '') + '').trim();
          if (!txt || txt.length > 250) continue;
          if (!EXT_RE.test(txt)) continue;
          // Walk up to find any anchor with an href
          let hrefEl = el.tagName === 'A' ? el : el.closest('a');
          const href = (hrefEl && hrefEl.getAttribute('href')) || '';
          const target = (hrefEl && hrefEl.getAttribute('target')) || '';
          const downloadAttr = (hrefEl && hrefEl.getAttribute('download')) || '';
          const dataAttrs = {};
          const probeEl = hrefEl || el;
          for (const attr of probeEl.attributes || []) {
            const n = attr.name.toLowerCase();
            if (/^(data-|ng-|on)/.test(n) || /url|src|file|doc|download/i.test(n)) {
              dataAttrs[attr.name] = (attr.value || '').slice(0, 240);
            }
          }
          // Also check parent row/li/tr for data attrs that often hold IDs
          const row = el.closest('tr,li,[class*="row" i]');
          const rowAttrs = {};
          if (row) {
            for (const attr of row.attributes || []) {
              const n = attr.name.toLowerCase();
              if (n.startsWith('data-') || /id$/i.test(n)) {
                rowAttrs[attr.name] = (attr.value || '').slice(0, 240);
              }
            }
          }
          const k = (probeEl.tagName || '') + '|' + txt.slice(0, 80);
          if (seen.has(k)) continue;
          seen.add(k);
          out.push({
            tag: probeEl.tagName,
            txt: txt.slice(0, 110),
            href: href.slice(0, 240),
            target,
            download: downloadAttr,
            data: dataAttrs,
            row: rowAttrs,
            outer: (probeEl.outerHTML || '').slice(0, 320),
          });
          if (out.length >= 12) break;
        }
        return out;
      });
    } catch (e) {
      console.log(`    📎 file-row DOM probe failed: ${e.message}`);
    }

    if (domProbe.length) {
      console.log(`    📎 file-row DOM probe: ${domProbe.length} candidate(s)`);
      for (const m of domProbe.slice(0, 6)) {
        const dataKeys = Object.keys(m.data || {}).filter((k) => m.data[k]);
        const rowKeys = Object.keys(m.row || {}).filter((k) => m.row[k]);
        console.log(`        <${m.tag}> "${m.txt}" href="${m.href || ''}" target="${m.target || ''}" dl="${m.download || ''}"`);
        if (dataKeys.length) {
          for (const k of dataKeys.slice(0, 5)) {
            console.log(`            [${k}] = ${m.data[k]}`);
          }
        }
        if (rowKeys.length) {
          for (const k of rowKeys.slice(0, 5)) {
            console.log(`            row[${k}] = ${m.row[k]}`);
          }
        }
      }
      // Dump first candidate's outerHTML for shape inspection
      console.log(`    📎 first candidate outerHTML preview: ${domProbe[0].outer}`);
    } else {
      console.log(`    📎 file-row DOM probe: 0 candidates (no filename-like text in DOM)`);
    }

    // 3) Click probe — only if no usable href found in DOM probe.
    //    We click ONCE on the first filename-like element and watch network.
    const hasUsableHref = domProbe.some((m) => m.href && /^https?:\/\//i.test(m.href));
    if (!hasUsableHref && domProbe.length > 0) {
      try {
        // Override window.open and location.assign so the page stays alive
        await page.evaluate(() => {
          try {
            window.__capturedOpens__ = [];
            const realOpen = window.open;
            window.open = function (...args) {
              try { window.__capturedOpens__.push(['open', String(args[0] || '')]); } catch (_) {}
              return null;
            };
            const realAssign = window.location.assign.bind(window.location);
            try {
              Object.defineProperty(window.location, 'assign', {
                configurable: true,
                value: function (u) { window.__capturedOpens__.push(['assign', String(u || '')]); }
              });
            } catch (_) {}
            try {
              Object.defineProperty(window.location, 'replace', {
                configurable: true,
                value: function (u) { window.__capturedOpens__.push(['replace', String(u || '')]); }
              });
            } catch (_) {}
          } catch (_) {}
        });

        clickProbe = await page.evaluate(() => {
          const EXT_RE = /\.(pdf|docx?|xlsx?|zip|rtf|txt|odt|ods|xml|json|csv|tsv|pptx?)\b/i;
          const all = Array.from(document.querySelectorAll('a, button, [role="link"], [role="button"]'));
          for (const el of all) {
            const txt = ((el.innerText || el.textContent || '') + '').trim();
            if (!txt || txt.length > 250) continue;
            if (!EXT_RE.test(txt)) continue;
            try {
              el.scrollIntoView({ block: 'center' });
              el.click();
              return { clicked: true, tag: el.tagName, txt: txt.slice(0, 100) };
            } catch (_) {}
          }
          return { clicked: false };
        });

        if (clickProbe.clicked) {
          console.log(`    📎 file-row clicked (<${clickProbe.tag}> "${clickProbe.txt}")`);
          await new Promise((r) => setTimeout(r, 3500));

          // Read back any window.open / location.assign captures
          try {
            const opens = await page.evaluate(() => window.__capturedOpens__ || []);
            if (Array.isArray(opens) && opens.length) {
              console.log(`    📎 captured navigation hooks (${opens.length}):`);
              for (const [kind, u] of opens.slice(0, 10)) {
                console.log(`        [${kind}] ${String(u).slice(0, 200)}`);
              }
            }
          } catch (_) {}
        }
      } catch (e) {
        console.log(`    📎 file-row click failed: ${e.message}`);
      }
    } else if (hasUsableHref) {
      console.log(`    📎 skipping click — DOM probe already revealed href(s)`);
    }

    try {
      page.off('response', docsClickResponseHandler);
      page.off('request', docsClickRequestHandler);
      page.off('framenavigated', frameNavHandler);
    } catch (_) {}

    // Filtruojam triukšmą — nereikia matyti notification/user-service/comments XHR'ų
    const NOISE_HOST_RE = /(notification-api|user-management-api|user-service\.|comments-service|telemetry|analytics|sentry|google-analytics|googletagmanager|hotjar|cookiebot|fonts\.googleapis|gstatic|cloudflareinsights)/i;
    const STATIC_RE = /\.(js|css|woff2?|ttf|eot|svg|png|jpg|jpeg|gif|ico|map)(\?|$)/i;
    const docsClickFiltered = docsClickUrls.filter((u) => !NOISE_HOST_RE.test(u.url) && !STATIC_RE.test(u.url));
    if (docsClickFiltered.length) {
      console.log(`    📎 docs-phase requests/responses (${docsClickFiltered.length}):`);
      for (const u of docsClickFiltered.slice(0, 30)) {
        console.log(`        [${u.status}] ${u.ctype} ${u.size}b ${u.url.slice(0, 200)}`);
      }
    } else if (docsClickUrls.length) {
      console.log(`    📎 docs-phase: ${docsClickUrls.length} captured but all filtered as noise/static`);
    }
    if (navUrls.length) {
      console.log(`    📎 frame navigations during probe: ${navUrls.map((u) => u.slice(0, 180)).join(' → ')}`);
    }

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

      // --- diagnostic: actual VALUES of fields the public-notice harvester
      // looks at. Confirmed empirically that `originalNotices` is a
      // literal "TODO" stub in the current Mercell schema (schema field
      // exists but is unimplemented), and `fileReferenceNumber` holds the
      // BUYER'S INTERNAL ref (e.g. "GNU 2026/67", "ET183") — NOT a TED
      // publication number. Skip logging known stubs so we still get a
      // signal if Mercell ever populates a real value on a future tender.
      const STUB_VALUES = new Set(['"TODO"', '"todo"', '"N/A"', '"n/a"', '""', 'null']);
      const dumpField = (label, value) => {
        if (value == null) return;
        try {
          const s = JSON.stringify(value);
          if (!s || s === 'null' || s === '""' || s === '{}' || s === '[]') return;
          if (STUB_VALUES.has(s)) return;
          console.log(`    🔎 ${label}: ${s.slice(0, 300)}${s.length > 300 ? '…' : ''}`);
        } catch (_) { /* ignore */ }
      };
      if (json && typeof json === 'object') {
        dumpField('fileReferenceNumber', json.fileReferenceNumber);
        dumpField('originalNotices', json.originalNotices);
        dumpField('publicationNumber', json.publicationNumber);
        dumpField('externalReferences', json.externalReferences);
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
      if (fields.sourceUrl) {
        // Apply early URL normalisation so all downstream consumers
        // (source fetch, login goto, deep-link resolver) see the
        // corrected URL — not just fetchSourcePageDetails.
        const normalized = normalizeSourceUrl(fields.sourceUrl);
        if (normalized !== fields.sourceUrl) {
          console.log(`    ↪️  normalised sourceUrl: ${fields.sourceUrl.slice(0, 60)} → ${normalized.slice(0, 80)}`);
        }
        details.sourceUrl = normalized;
      }
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
        // XML — Mercell often attaches ONLY the TED OriginalNotice in
        // eForms XML format (type=OriginalNotice). The XML is structured
        // and contains qualification criteria, award criteria, lots, and
        // contract value verbatim. Strip-tag extraction gives us the same
        // content that would otherwise sit in a ToR PDF.
        'xml',
        // JSON — UK Find-a-Tender (FTS) notices are attached as JSON
        // (type=OriginalNotice, ext=json). The schema mirrors TED eForms
        // semantically — qualification, award criteria, lots, value — but
        // is encoded as a flat JSON tree instead of XML. Pretty-printing
        // it with JSON.stringify gives the AI extraction prompt the same
        // verbatim text content it gets from XML notices.
        'json',
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
      // Bumped from 120k → 180k. Spanish PCAPs and German Vergabe ZIPs
      // routinely exceed 100k of body text once we follow embedded
      // links and the deep ANEXOs (solvency tables, award-criteria
      // weights). Claude Haiku 4.5 has a 200k context window so 180k
      // leaves enough headroom for system prompt + meta + question.
      const MAX_TOTAL_DOC_CHARS = 180000;     // total for AI prompt
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
        // XML — accept anything that detectFormat classified as 'html'
        // (which covers `<?xml`, `<html`, and any other `<…>`-prefixed
        // payload). We don't distinguish XML from HTML at the magic-byte
        // level; the parser strips both safely.
        if (ex === 'xml') return got === 'html';
        // JSON — matches the 'json' detector, but ALSO be permissive when
        // the bytes are plain text starting with `{` or `[`. Some servers
        // serve JSON with surrogate framing or BOMs that detectFormat
        // doesn't classify as 'json'.
        if (ex === 'json') return got === 'json';
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
          if (ex === 'xml') {
            // XML — naivus tag stripping. TED eForms XML talpina visus
            // mums reikalingus laukus (qualification criteria, award
            // criteria, lot scope, value). Schema sudėtinga (efbc:, efac:,
            // cbc:, cac: namespaces), bet text content'as suskaitomas po
            // tagų pašalinimo. Decode'inam XML entity'es — eForms turi
            // daug `&amp;`, `&#x2019;`, etc. Apkarpom žemyn iki MAX caps.
            const raw = bytes.toString('utf8');
            const stripped = raw
              // pašalinti CDATA wrapper'ius, paliekant turinį
              .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
              // pašalinti komentarus
              .replace(/<!--[\s\S]*?-->/g, ' ')
              // pašalinti processing instructions (<?xml ?>, <?xsl ?>)
              .replace(/<\?[\s\S]*?\?>/g, ' ')
              // pašalinti doctype
              .replace(/<!DOCTYPE[^>]*>/gi, ' ')
              // pašalinti VISUS XML/HTML tag'us
              .replace(/<\/?[a-zA-Z][^>]*>/g, ' ')
              // decode common entities
              .replace(/&amp;/g, '&')
              .replace(/&lt;/g, '<')
              .replace(/&gt;/g, '>')
              .replace(/&quot;/g, '"')
              .replace(/&apos;/g, "'")
              .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
                try { return String.fromCodePoint(parseInt(hex, 16)); }
                catch (_e) { return ' '; }
              })
              .replace(/&#(\d+);/g, (_, dec) => {
                try { return String.fromCodePoint(parseInt(dec, 10)); }
                catch (_e) { return ' '; }
              })
              // collapse whitespace
              .replace(/\s+/g, ' ')
              .trim();
            return stripped;
          }
          if (ex === 'json') {
            // JSON — UK FTS / Mercell-wrapped notice payloads. Try to
            // pretty-print so the AI extraction prompt sees a flat,
            // line-broken text representation of every key/value pair
            // (qualification, award criteria, lots, value). If parse
            // fails (rare; some servers wrap JSON in HTML), fall back
            // to raw UTF-8 text.
            const raw = bytes.toString('utf8').replace(/^\uFEFF/, '');
            try {
              const parsed = JSON.parse(raw);
              return JSON.stringify(parsed, null, 2).trim();
            } catch (_) {
              return raw.replace(/\s+/g, ' ').trim();
            }
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

      // --- Node-side https GET (no cookies, follows redirects) -------------
      //
      // Mercell now serves many attachments as presigned S3 URLs
      // (`old-dc-import-notices-prod.s3.eu-…amazonaws.com/...?X-Amz-Signature=...`).
      // These URLs are self-authenticating, but fetching them through
      // `page.evaluate(fetch, {credentials:'include'})` confuses S3 — the
      // browser sends Mercell session cookies + triggers a CORS preflight,
      // and S3 responds with an HTML/XML error page. So for any non-Mercell
      // URL we fetch from Node directly with no cookies; the presigned
      // signature is all S3 needs. Returns { ok, status, contentType, bytes:Buffer|null, error }.
      const isMercellHost = (url) => {
        try {
          const h = new URL(url).hostname.toLowerCase();
          return /(^|\.)mercell\.com$/.test(h);
        } catch (_) { return false; }
      };
      const fetchNode = (url, redirects = 5) => new Promise((resolve) => {
        try {
          const u = new URL(url);
          const lib = u.protocol === 'http:' ? require('http') : require('https');
          const req = lib.get({
            hostname: u.hostname,
            path: u.pathname + u.search,
            port: u.port || (u.protocol === 'http:' ? 80 : 443),
            // No `Cookie:` header on purpose — presigned URL is self-authenticating.
            // `Accept-Encoding: identity` so S3 doesn't return a gzip body that we'd
            // need to manually inflate; `Connection: close` so we don't reuse a
            // socket whose state could interfere across attempts.
            headers: {
              'User-Agent': 'Mozilla/5.0 (compatible; mercell-scraper/1.0)',
              'Accept': '*/*',
              'Accept-Encoding': 'identity',
              'Connection': 'close',
            },
            timeout: 30000,
          }, (res) => {
            // Follow redirects manually so we can keep the no-cookies posture
            // through the chain (S3 sometimes 302's to a different signed URL).
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
              const next = new URL(res.headers.location, url).toString();
              res.resume();
              fetchNode(next, redirects - 1).then(resolve);
              return;
            }
            const ct = res.headers['content-type'] || '';
            const chunks = [];
            res.on('data', (d) => chunks.push(d));
            res.on('end', () => {
              const bytes = Buffer.concat(chunks);
              resolve({
                ok: res.statusCode >= 200 && res.statusCode < 300,
                status: res.statusCode,
                contentType: ct,
                bytes,
                size: bytes.length,
              });
            });
            res.on('error', (e) => resolve({ ok: false, error: e.message }));
          });
          req.on('error', (e) => resolve({ ok: false, error: e.message }));
          req.on('timeout', () => { req.destroy(new Error('timeout')); });
        } catch (e) {
          resolve({ ok: false, error: e.message });
        }
      });

      // --- CDP-based fetch (browser network layer, bypasses CORS) -----------
      //
      // Diagnostic logs revealed that BOTH existing strategies fail for
      // Mercell attachments:
      //
      //  - NODE fetch of S3 presigned URL:
      //      `status=403 ct=application/xml sniff="<Error><Code>AccessDe…"`
      //    The presign in `fileReference` is signed for Mercell's own
      //    backend, not for end-user GET. AWS rejects with AccessDenied.
      //
      //  - PAGE fetch (page.evaluate) of file-service.discover.app.mercell.com:
      //      `status=? err=TypeError: Failed to fetch`
      //    file-service has no Access-Control-Allow-Origin header, so
      //    the browser blocks the cross-origin fetch BEFORE it reaches
      //    the network. (CORS is a JS-sandbox restriction.)
      //
      // Chrome DevTools Protocol's `Network.loadNetworkResource` runs at
      // the browser's *network* layer — it picks up the existing Mercell
      // session cookies (so file-service auth works), follows redirects
      // (so file-service → fresh presigned S3 URL works), and is NOT
      // subject to CORS. We open ONE CDP session per call to
      // fetchTenderDetails and reuse it across every candidate URL.
      let cdpSession = null;
      let cdpFrameId = null;
      // NOTE: Bearer-token injection via Network.setExtraHTTPHeaders has
      // been REMOVED. Empirically the captured token has /search/ audience
      // and search-service-api still 401s for /files/ endpoints, so the
      // injection had zero upside. It also broke 8/9 subsequent tender
      // navigations: enabling the Network domain + injecting headers on
      // the page's CDP session leaks state into page.goto() and the SPA
      // renders blank. We now skip Network.enable entirely and rely on
      // cookies (via includeCredentials) for any session auth.
      const ensureCdp = async () => {
        if (cdpSession) return cdpSession;
        try {
          cdpSession = await page.target().createCDPSession();
          const { frameTree } = await cdpSession.send('Page.getFrameTree');
          cdpFrameId = frameTree.frame.id;
          return cdpSession;
        } catch (e) {
          cdpSession = null;
          return null;
        }
      };
      // Detach the CDP session when we're done with this tender — orphaned
      // sessions accumulate per-tender and subtly affect page behavior.
      const detachCdp = async () => {
        if (!cdpSession) return;
        try { await cdpSession.detach(); } catch (_) { /* ignore */ }
        cdpSession = null;
        cdpFrameId = null;
      };
      // Drain a CDP IO.read stream into a Buffer. Returns Buffer.alloc(0)
      // on any error so the caller can still report status/headers.
      const drainCdpStream = async (sess, handle) => {
        const chunks = [];
        try {
          let done = false;
          for (let i = 0; i < 200 && !done; i++) {
            const chunk = await sess.send('IO.read', { handle });
            if (chunk && chunk.data) {
              chunks.push(Buffer.from(chunk.data, chunk.base64Encoded ? 'base64' : 'utf8'));
            }
            done = !!(chunk && chunk.eof);
          }
        } catch (_) { /* ignore */ }
        try { await sess.send('IO.close', { handle }); } catch (_) { /* ignore */ }
        return Buffer.concat(chunks);
      };
      const fetchViaCDP = async (url) => {
        try {
          const sess = await ensureCdp();
          if (!sess) return { ok: false, error: 'cdp-init-failed' };
          const r = await sess.send('Network.loadNetworkResource', {
            frameId: cdpFrameId,
            url,
            options: { disableCache: false, includeCredentials: true },
          });
          const resource = r && r.resource;
          if (!resource) return { ok: false, error: 'no-resource' };
          const status = resource.httpStatusCode || 0;
          const respHeaders = resource.headers || {};
          const ct = respHeaders['content-type']
            || respHeaders['Content-Type']
            || respHeaders['CONTENT-TYPE']
            || '';
          // Read body whether or not CDP marks success. CDP says
          // success=false for any non-2xx status, but the stream IS
          // populated and contains diagnostic XML/JSON — critical for
          // distinguishing "Request has expired" from "AccessDenied"
          // from "SignatureDoesNotMatch" on S3 presigned URLs.
          let bytes = Buffer.alloc(0);
          if (resource.stream) {
            bytes = await drainCdpStream(sess, resource.stream);
          }
          if (!resource.success) {
            return {
              ok: false,
              status,
              contentType: ct,
              error: resource.netErrorName || 'load-failed',
              bytes,
              size: bytes.length,
            };
          }
          return {
            ok: status >= 200 && status < 300,
            status,
            contentType: ct,
            bytes,
            size: bytes.length,
          };
        } catch (e) {
          return { ok: false, error: String(e && e.message || e) };
        }
      };

      // --- PUBLIC NOTICE FETCH (TED / Find-a-Tender / Doffin / etc.) -----
      //
      // Mercell's own file storage is locked behind two unbreakable walls:
      //   - S3 presigned URLs in `fileReference` are signed for the
      //     backend, not for end-user GET → AccessDenied (403).
      //   - search-service-api `/files/` endpoints want a Bearer with
      //     `/files/` audience, but our captured token has `/search/`.
      //
      // Mercell's tender JSON, however, contains references to the
      // ORIGINAL public notice (TED, UK Find-a-Tender, Doffin, etc.) —
      // either as a direct URL field or as a publication number that maps
      // to a canonical public URL. Those public pages serve the same
      // qualification / award criteria / lot scope / contract value
      // content as the Mercell-internal copy, but require NO auth and
      // NO CORS. We harvest them here and fetch via plain Node HTTP,
      // bypassing the entire Mercell auth wall.
      const publicNoticeUrls = [];
      {
        const seenPubUrls = new Set();
        const PUBLIC_HOSTS = /(?:^|\.)(ted\.europa\.eu|find-tender\.service\.gov\.uk|contractsfinder\.service\.gov\.uk|doffin\.no|hilma\.fi)$/i;
        const TED_REF_RE = /^\d{6,8}-\d{4}$/;
        const pushPublic = (rawUrl, label) => {
          if (!rawUrl) return;
          let u;
          try { u = new URL(String(rawUrl).trim()); } catch (_) { return; }
          if (!PUBLIC_HOSTS.test(u.hostname)) return;
          const key = u.toString();
          if (seenPubUrls.has(key)) return;
          seenPubUrls.add(key);
          publicNoticeUrls.push({ url: key, label: label || u.hostname });
        };
        const walkPublic = (node) => {
          if (!node || typeof node !== 'object') return;
          if (Array.isArray(node)) { for (const it of node) walkPublic(it); return; }
          for (const [k, v] of Object.entries(node)) {
            if (v == null) continue;
            if (typeof v === 'string') {
              const s = v.trim();
              if (/^https?:\/\//i.test(s)) {
                // Only consider URL-shaped strings whose key suggests
                // they're a *notice* link (not a logo, profile, banner).
                if (/url|link|href|source|notice|publication/i.test(k)) {
                  pushPublic(s, `${k}`);
                }
              } else if (
                TED_REF_RE.test(s) &&
                /reference|publication|notice/i.test(k)
              ) {
                // TED publication-number style → canonical TED URL.
                // Pattern matches both old (188432-2026) and new
                // (00288908-2026) eForms-era IDs.
                pushPublic(`https://ted.europa.eu/en/notice/-/detail/${s}`, `${k}->ted`);
              }
            } else if (typeof v === 'object') {
              walkPublic(v);
            }
          }
        };
        for (const { json } of capturedApis) walkPublic(json);
      }

      const publicNoticeTexts = [];
      if (publicNoticeUrls.length) {
        const preview = publicNoticeUrls
          .slice(0, 4)
          .map(p => `[${p.label}] ${p.url.slice(0, 70)}`)
          .join('; ');
        const tail = publicNoticeUrls.length > 4 ? ` (+${publicNoticeUrls.length - 4} more)` : '';
        console.log(`    🌐 public notice URLs: ${publicNoticeUrls.length} — ${preview}${tail}`);
        // Cap at 4 fetches per tender — these pages can be large and
        // we want to leave context budget for any Mercell-internal docs
        // that DO succeed.
        const toFetch = publicNoticeUrls.slice(0, 4);
        for (const p of toFetch) {
          let result;
          try {
            result = await fetchNode(p.url);
          } catch (e) {
            result = { ok: false, error: String(e && e.message || e) };
          }
          if (!result || !result.ok || !(result.size > 100)) {
            const statusTail = result && result.status != null ? `, status=${result.status}` : '';
            const errTail = result && result.error ? `, err=${String(result.error).slice(0, 60)}` : '';
            console.log(`    ⚠️ public notice fetch failed: ${p.url.slice(0, 70)}${statusTail}${errTail}`);
            continue;
          }
          // Sniff actual format from magic bytes — public-notice URLs
          // sometimes resolve to a ZIP attachment (Find-a-Tender's
          // /Notice/Attachment/A-… serves a 70KB ZIP of XML/PDF) or a
          // direct PDF. If we blindly passed ext='xml' here the
          // magic-mismatch guard in extractTextFromBuffer would skip
          // everything. Map the detected format → an extension the
          // multi-format extractor knows how to dispatch on, then let
          // it recurse into ZIP entries / parse PDF / strip XML/HTML
          // as appropriate.
          let detectedFmt = 'unknown';
          try { detectedFmt = detectFormat(result.bytes); } catch (_) {}
          // URL-tail hint as a tiebreaker for cases where the body
          // didn't match a known magic (e.g. plain text manifest).
          let urlExt = '';
          try {
            const urlPath = new URL(p.url).pathname.toLowerCase();
            urlExt = (urlPath.match(/\.([a-z0-9]{1,5})$/) || [])[1] || '';
          } catch (_) {}
          let parseExt;
          if (detectedFmt === 'zip') parseExt = 'zip';
          else if (detectedFmt === 'pdf') parseExt = 'pdf';
          else if (detectedFmt === 'cfb') parseExt = (urlExt === 'xls' ? 'xls' : 'doc');
          else if (detectedFmt === 'rtf') parseExt = 'rtf';
          else if (detectedFmt === 'json') parseExt = 'json';
          else if (detectedFmt === 'html') parseExt = 'xml'; // HTML/XML — strip-tag path
          else parseExt = (urlExt && /^(pdf|zip|docx|xlsx|odt|ods|doc|xls|rtf|json|xml|html|htm|txt)$/.test(urlExt))
            ? (urlExt === 'htm' || urlExt === 'html' ? 'xml' : urlExt)
            : 'xml';
          let isTedHost = false;
          try { isTedHost = /(^|\.)ted\.europa\.eu$/i.test(new URL(p.url).hostname); }
          catch (_) {}

          // TED HTML SPA SKIP
          //
          // Confirmed 2026-05-12 via fetch + extractor trace: TED's
          // /en/notice/-/detail/{id} page is a JS-rendered SPA whose raw
          // HTML body contains only nav menus + footer (~3KB real text).
          // The actual procurement content — Selection criteria, Award
          // criteria, lot scope — is fetched via AJAX after page load
          // and is NOT in the static HTML response.
          //
          // Previous runs were feeding ~30KB of menu/footer/legalese to
          // the AI under the assumption it was procurement metadata. AI
          // correctly ignored the noise and still filled `scope` from
          // Mercell JSON, but qualifications stayed empty because they
          // weren't present in the input — only nav text was.
          //
          // Best decision: skip TED HTML entirely. The AI gets a cleaner
          // input (Mercell JSON title+description + source-side PDFs/HTML)
          // and stops being misled by repetitive nav text. For Spanish
          // tenders, source-side PLACSP docs already provide rich
          // criteria; for auth-walled regional portals (Andalucía SiRec,
          // Euskadi BakQ), nothing is available anyway — better to know
          // that explicitly than pretend with nav noise.
          //
          // Future: revisit if/when TED exposes a server-rendered or
          // XML/API endpoint we can hit (TED Developer Portal links to
          // bulk download but per-notice API is rate-limited and gated).
          if (isTedHost && detectedFmt === 'html') {
            console.log(`    ⏭️  TED HTML notice skipped (JS-rendered SPA — raw HTML is nav-only, no procurement content): ${p.url.slice(0, 80)}`);
            continue;
          }

          let text = '';
          try {
            text = await extractTextFromBuffer(
              { name: p.label, ext: parseExt, bytes: result.bytes },
              0,
            );
          } catch (e) {
            console.log(`    ⚠️ public notice extractor failed for ${p.url.slice(0, 70)}: ${e.message}`);
            continue;
          }
          if (!text) {
            console.log(`    ⚠️ public notice empty after extract (fmt=${detectedFmt}, ext=${parseExt}): ${p.url.slice(0, 70)}`);
            continue;
          }
          const clipped = text.slice(0, MAX_DOC_TEXT_CHARS);
          publicNoticeTexts.push(`--- (public:${p.label}) ${p.url} ---\n${clipped}`);
          console.log(`    🌐 parsed public notice (${result.size}B/${detectedFmt} -> ${clipped.length}ch from ${p.url.slice(0, 70)})`);
        }
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
              // GUID-style — template'inam į žinomus endpoint'us.
              // file-service.discover.app.mercell.com PAŠALINTAS —
              // DNS NXDOMAIN, host'as neegzistuoja. Prieš tai gaišom 4
              // candidate'us per failą bandydami nepasiekiamą subdomeną.
              candidates.push(
                `https://search-service-api.discover.app.mercell.com/api/v1/files/${refStr}/download`,
                `https://search-service-api.discover.app.mercell.com/api/v1/files/${refStr}`,
                `https://app.mercell.com/files/${refStr}/download`,
                `https://app.mercell.com/api/v1/files/${refStr}`,
                `https://permalink.mercell.com/api/v1/files/${refStr}/download`,
              );
            }
          }
          // Integer ID variantai kaip fallback'as — kartais Mercell'is juos
          // priima legacy endpoint'uose. (file-service.* irgi pašalintas
          // čia — žr. komentarą aukščiau.)
          candidates.push(
            // search-service-api — pagrindinis API host'as. Su captured
            // Bearer'iu turėtų grąžinti file content arba presigned URL.
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
          let lastError = null;
          // per-attempt trace, dumped if we can't fetch — invaluable for
          // diagnosing why an entire batch comes back as ct=text/html.
          const attemptTrace = [];
          // Helper: build "PATH host status=… ct=… size=… sniff="…" err=…"
          // line and push onto attemptTrace. Centralizing this keeps the
          // CDP/NODE/PAGE branches identical in their tracing.
          const pushTrace = (label, host, result) => {
            const parts = [`${label} ${host}`];
            if (result) {
              if (result.status != null) parts.push(`status=${result.status}`);
              else parts.push('status=?');
              if (result.contentType) parts.push(`ct=${String(result.contentType).slice(0, 30)}`);
              if (typeof result.size === 'number') parts.push(`size=${result.size}`);
              const tmpBytes = result.bytes || (Array.isArray(result.data) ? Buffer.from(result.data) : null);
              if (tmpBytes && tmpBytes.length) {
                // 180ch (was 60) so full S3 <Error><Message>…</Message>
                // bodies are visible — needed to distinguish "Request has
                // expired" from "SignatureDoesNotMatch" from "AccessDenied".
                const sniff = tmpBytes.slice(0, 180).toString('utf8').replace(/\s+/g, ' ').slice(0, 180);
                parts.push(`sniff="${sniff}"`);
              }
              if (result.error) parts.push(`err=${String(result.error).slice(0, 80)}`);
            } else {
              parts.push('NO_RESULT');
            }
            attemptTrace.push(parts.join(' '));
          };
          // Per-URL fetch with CDP-first, NODE/PAGE fallback. CDP wins for
          // virtually everything because it runs at the browser network
          // layer (cookies + no CORS + follows redirects). We only fall
          // back when CDP itself errors at the transport level (cdp-init,
          // net::ERR_*, etc.) — if CDP returns a real HTTP response (even
          // 403/404), that's the truth and we use it.
          for (const u of candidates) {
            let host = '?';
            try { host = new URL(u).hostname; } catch (_) { /* ignore */ }
            const fallbackLabel = isMercellHost(u) ? 'PAGE' : 'NODE';
            const fallbackFetch = async () => {
              if (isMercellHost(u)) {
                // Mercell-internal fallback — page.evaluate keeps cookies
                // but is CORS-blocked for cross-subdomain calls. Kept as
                // a last resort in case CDP is unavailable.
                let r;
                try {
                  r = await page.evaluate(async (url) => {
                    try {
                      const rr = await fetch(url, { credentials: 'include' });
                      const ct = rr.headers.get('content-type') || '';
                      if (!rr.ok) return { ok: false, status: rr.status, contentType: ct };
                      const buf = await rr.arrayBuffer();
                      const arr = Array.from(new Uint8Array(buf));
                      return { ok: true, status: rr.status, contentType: ct, data: arr, size: arr.length };
                    } catch (e) {
                      return { ok: false, error: String(e) };
                    }
                  }, u);
                } catch (e) {
                  return { ok: false, error: String(e && e.message || e) };
                }
                if (r && r.ok && Array.isArray(r.data)) {
                  r = { ...r, bytes: Buffer.from(r.data) };
                }
                return r;
              }
              // Non-Mercell fallback — Node fetch (no cookies, no CORS).
              return fetchNode(u);
            };

            // Attempt 1: CDP
            let result;
            try {
              result = await fetchViaCDP(u);
            } catch (e) {
              result = { ok: false, error: String(e && e.message || e) };
            }
            pushTrace('CDP', host, result);

            // Did CDP return a real HTTP response? If yes, trust it. If
            // no (transport-level failure with no status), fall back.
            const cdpReachedServer = result && (result.ok || (result.status != null && result.status > 0));
            if (!cdpReachedServer) {
              try {
                result = await fallbackFetch();
              } catch (e) {
                result = { ok: false, error: String(e && e.message || e) };
              }
              pushTrace(fallbackLabel, host, result);
            }

            if (result && result.ok && (result.size || 0) > 100) {
              const tmpBytes = result.bytes || Buffer.from(result.data || []);
              lastStatus = result.status;
              lastContentType = result.contentType;
              lastFormat = detectFormat(tmpBytes);
              if (magicMatchesExt(tmpBytes, f.ext)) {
                bytes = tmpBytes;
                okUrl = u;
                break;
              }
            } else if (result && !result.ok) {
              if (result.status != null) lastStatus = result.status;
              if (!lastContentType && result.contentType) lastContentType = result.contentType;
              if (result.error) lastError = String(result.error).slice(0, 80);
            }
          }

          if (!bytes) {
            const ctTail = lastContentType ? `, ct=${lastContentType.slice(0, 40)}` : '';
            const fmtTail = lastFormat ? `, got=${lastFormat}` : '';
            const statusTail = (lastStatus != null) ? `, last=${lastStatus}` : '';
            const errTail = lastError ? `, err=${lastError}` : '';
            const refLen = f.ref ? String(f.ref).length : 0;
            const refTail = f.ref
              ? `, ref=${String(f.ref).slice(0, 40)}…(len=${refLen})`
              : ', ref=NONE';
            console.log(`    ⚠️ could not fetch ${f.ext.toUpperCase()} "${f.name}" (id=${f.id}${refTail}${statusTail}${ctTail}${fmtTail}${errTail})`);
            // Dump per-attempt trace so we can see WHICH URLs were tried
            // and what each returned — critical when whole batches fail.
            // Bumped from 8 to 14 because each URL now contributes up to
            // 2 entries (CDP + fallback), and we want full coverage of
            // the typical 8-candidate search.
            for (const t of attemptTrace.slice(0, 14)) {
              console.log(`      · ${t}`);
            }
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

      // Merge public notice text on top of any Mercell-internal doc text.
      // Public notices go FIRST so the AI sees verbatim qualification /
      // award-criteria language from TED/FTS before any contract-specific
      // attachments. This block runs even when collectedFiles was empty —
      // many tenders have ONLY a public-notice reference, no attachments.
      if (publicNoticeTexts.length) {
        const publicCombined = publicNoticeTexts.join('\n\n');
        const existing = details.pdfText || '';
        const merged = existing
          ? `${publicCombined}\n\n${existing}`
          : publicCombined;
        details.pdfText = merged.slice(0, MAX_TOTAL_DOC_CHARS);
      }

      // STRUCTURED HINTS pre-extraction — scan the FINAL combined doc
      // text (TED public notice + PLACSP PCAP + any source-side files)
      // for known qualification-section anchors and prepend a labeled
      // [STRUCTURED HINTS] block at the very top. Claude's system
      // prompt instructs it to treat this block as the PRIMARY source
      // for `qualificationRequirements` / `requirementsForSupplier` /
      // `offerWeighingCriteria` — without this, those fields stayed
      // empty on TED-only tenders (tenderned, marches-publics, evergabe
      // .de) where the cues are buried inside 30k chars of metadata.
      // Keeping the original text intact afterward so Claude can still
      // verify / cross-reference if needed.
      if (details.pdfText && details.pdfText.length > 500) {
        try {
          const hints = extractQualificationHints(details.pdfText);
          if (hints) {
            const headerBlock = `[STRUCTURED HINTS — qualification anchors found in source docs]\n${hints}\n[/STRUCTURED HINTS]\n\n`;
            // Cap result at MAX_TOTAL_DOC_CHARS — hints are usually
            // ≤6000 chars and the original text is already capped, so
            // worst-case we trim ~6000 chars from the tail of the
            // flat text. That tail is typically navigation / footer
            // boilerplate in TED notices, so the trade is favourable.
            const merged = (headerBlock + details.pdfText).slice(0, MAX_TOTAL_DOC_CHARS);
            details.pdfText = merged;
            console.log(`    🎯 hints extracted: ${hints.length}ch prepended (${details.pdfText.length}ch total)`);
          } else {
            // ZERO hits diagnostic — only fires for tenders where pdfText
            // is substantial (>5KB). Scan for near-miss stems so we can
            // see what vocabulary the source DOES use and extend anchors
            // in a future iteration. Useful for TED-only tenders where
            // qualifications come back empty — tells us if the text just
            // doesn't have selection criteria, or if it does but uses
            // terms our regex doesn't know.
            if (details.pdfText.length > 5000) {
              const diag = hintExtractorDiagnostic(details.pdfText);
              if (diag) {
                console.log(`    🔍 hint extractor: 0 hits across ${details.pdfText.length}ch — ${diag}`);
              } else {
                console.log(`    🔍 hint extractor: 0 hits across ${details.pdfText.length}ch — no qualification stems present at all`);
              }
            }
          }
        } catch (e) {
          console.log(`    ⚠️ hint extraction failed: ${(e.message || '').slice(0, 80)}`);
        }
      }
    } catch (e) {
      console.log(`    ⚠️ document extraction error: ${e.message}`);
    } finally {
      // Detach the per-tender CDP session so orphaned sessions don't
      // accumulate on the page target — leaving them attached over many
      // tenders correlates with subsequent page.goto()s rendering blank
      // (`WARN: no h1/content`) and the response sniffer capturing 0
      // APIs. Detach is best-effort; ignore errors.
      try { await detachCdp(); } catch (_) { /* ignore */ }
    }

    // --- ŠALTINIO PUSLAPIS -------------------------------------------
    if (details.sourceUrl) {
      console.log(`    → source: ${details.sourceUrl.slice(0, 80)}`);
      const t0 = Date.now();
      let src = await fetchSourcePageDetails(browser, details.sourceUrl);
      const elapsed = Date.now() - t0;
      console.log(`    source done in ${elapsed}ms (host: ${src?.sourceHost || 'n/a'}, err: ${src?.error || 'none'}${src?.skipped ? ', skipped: ' + src.skipped : ''}${src?.placspDocsFound ? `, placsp=${src.placspDocsFound}` : ''})`);

      // DEAD-SITE FALLBACK — Spanish regional portals.
      //
      // 2026-05-12 ES run: 2/9 tenders hit DNS death at
      //   sirecftdpriexp.chap.junta-andalucia.es (Junta de Andalucía SiRec)
      // and got skipped: 'dead-site'. The same tenders are typically ALSO
      // published on the federal aggregator (contrataciondelestado.es /
      // PLACSP). The TED notice we already fetched into details.pdfText
      // usually includes that federal URL. Scan for it and retry once via
      // the dedicated PLACSP handler — turns a useless dead-site skip
      // into a full Pliego/Anuncio extraction (~10k-20k ch each).
      //
      // Generalised: any 'dead-site' skip + Spanish-looking host triggers
      // the scan. Cheap to attempt — single regex + one extra
      // fetchSourcePageDetails call only if a PLACSP URL is actually found.
      if (src?.skipped === 'dead-site' && details.pdfText) {
        const placspMatch = details.pdfText.match(
          /https?:\/\/(?:www\.)?contrataciondelestado\.es\/wps\/[^\s"'<>)]+/i
        );
        if (placspMatch) {
          const altUrl = placspMatch[0].replace(/[.,;:!?]+$/, '');
          console.log(`    🔁 dead-site fallback: trying PLACSP federal URL ${altUrl.slice(0, 100)}`);
          try {
            const t1 = Date.now();
            const src2 = await fetchSourcePageDetails(browser, altUrl);
            const elapsed2 = Date.now() - t1;
            console.log(`    🔁 fallback done in ${elapsed2}ms (host: ${src2?.sourceHost || 'n/a'}, err: ${src2?.error || 'none'}${src2?.skipped ? ', skipped: ' + src2.skipped : ''}${src2?.placspDocsFound ? `, placsp=${src2.placspDocsFound}` : ''})`);
            if (src2 && !src2.skipped && !src2.error) {
              console.log(`    ✓ PLACSP fallback succeeded — replacing dead-site result`);
              src = src2;
              details.sourceFallbackFrom = details.sourceUrl;
              details.sourceFallbackTo = altUrl;
            } else {
              console.log(`    ✗ PLACSP fallback also failed — keeping original dead-site skip`);
            }
          } catch (e) {
            console.log(`    ✗ PLACSP fallback threw: ${(e.message || '').slice(0, 80)}`);
          }
        } else {
          console.log(`    ℹ️  dead-site (${src.sourceHost}) — no PLACSP federal URL in TED text, skipping`);
        }
      }

      // PLACSP-specific diagnostic so we can see why 0 priority docs
      // were found on contrataciondelestado.es pages even when the
      // detail page rendered. Shows total anchors, text-pattern hits,
      // url-pattern hits, plus a sample of first 6 anchor texts.
      if (src?.placspStats) {
        const ps = src.placspStats;
        const sample = (ps.sampleTexts || []).map(t => `"${t}"`).join(', ');
        console.log(`    🇪🇸 PLACSP stats: anchors=${ps.totalAnchors}, textMatches=${ps.textMatches}, urlMatches=${ps.urlMatches}; sample=[${sample}]`);
      }

      // MARCHES-PUBLICS DASHBOARD FALLBACK
      //
      // 2026-05-16 FR test run: when the browser already has a session
      // cookie from an earlier tender, marches-publics root URL
      // (https://www.marches-publics.gouv.fr/) returns the dashboard
      // page — "Bienvenue ... Mon compte Déconnexion ... Mon panier
      // Consultations en cours". This is NOT a login form (so
      // loginGated=false) and NOT useful content (all source fields
      // null, no sourceFilesText), so the deep-link resolver that
      // lives in the post-login branch never fires.
      //
      // Fix: when source fetch returned success-but-empty AND the
      // host is marches-publics AND we have a reference number, trigger
      // resolveMarchesPublicsDeepLink directly. The resolver itself
      // already handles the "Recherche avancée" link click for dashboard
      // landings, so it should work from this entry point too.
      //
      // Same pattern as PLACSP federal fallback above.
      const hostIsMarchesPublics = src?.sourceHost &&
        /(^|\.)marches-publics\.gouv\.fr$/i.test(src.sourceHost);
      const sourceLooksEmpty = src && !src.error && !src.skipped && !src.loginGated &&
        !src.sourceFilesText &&
        !src.maxBudget && !src.requirementsForSupplier &&
        !src.qualificationRequirements && !src.offerWeighingCriteria &&
        !src.scopeOfAgreement;
      if (hostIsMarchesPublics && sourceLooksEmpty && details.referenceNumber) {
        console.log(`    🇫🇷 marches-publics: anonymous fetch returned dashboard (empty fields) — trying deep-link resolver`);
        try {
          const deepLink = await resolveMarchesPublicsDeepLink(
            browser, details.referenceNumber, src.sourceHost
          );
          if (deepLink) {
            console.log(`    🔁 marches-publics: refetching on deep-link URL`);
            const t1 = Date.now();
            const src2 = await fetchSourcePageDetails(browser, deepLink);
            const elapsed2 = Date.now() - t1;
            console.log(`    🔁 marches-publics deep-link refetch done in ${elapsed2}ms (host: ${src2?.sourceHost || 'n/a'}, err: ${src2?.error || 'none'}${src2?.skipped ? ', skipped: ' + src2.skipped : ''})`);
            if (src2 && !src2.skipped && !src2.error) {
              const before = src.sourceFilesText?.length || 0;
              const after = src2.sourceFilesText?.length || 0;
              console.log(`    ✓ marches-publics deep-link: source content ${before}ch → ${after}ch`);
              src = src2;
              details.sourceFallbackFrom = details.sourceUrl;
              details.sourceFallbackTo = deepLink;
            } else {
              console.log(`    ✗ marches-publics deep-link refetch failed — keeping original empty result`);
            }
          } else {
            console.log(`    ℹ️  marches-publics: deep-link resolver returned null (search form / Recherche avancée flow didn't find the tender)`);
          }
        } catch (e) {
          console.log(`    ✗ marches-publics deep-link path threw: ${(e.message || '').slice(0, 80)}`);
        }
      }

      // FORCE-LOGIN coercion — if host is in ALWAYS_LOGIN_HOSTS and we
      // haven't yet authenticated, upgrade the result to loginGated so
      // the next branch tries the credentials we have. We trigger on
      // EITHER of two signals:
      //   1) Thin shell (bodyLen < 600) — typical of SPA portals like
      //      e-avrop, tarjouspalvelu (Cloudia front-end).
      //   2) No "logged-in marker" in the body — covers portals like
      //      kommersannons.se that render a full header/footer (1000+
      //      chars) even for anonymous users, so the thin-shell check
      //      misses them. We look for "Logout" / "Mon compte" / "Min
      //      profil" / etc. — words only a logged-in user would see.
      //      Without those markers we conclude we're still anonymous
      //      and force login. Real-world: kommersannons.se Roslagsvatten
      //      had bodyLen ≈ 1000 (header/footer text) so the thin-shell
      //      check failed; this dual trigger now catches it.
      if (src && !src.error && !src.skipped && !src.loginGated) {
        const bodyLen = src.bodyTextPreview?.length || 0;
        const looksThinShell = bodyLen < 600;
        const preview = src.bodyTextPreview || '';
        const LOGGED_IN_MARKER = /\b(?:log\s*out|log\s*off|logout|logga\s*ut|logg\s*ut|cerrar\s*sesi[oó]n|d[eé]connexion|abmelden|uitloggen|kirjaudu\s*ulos|wyloguj|sign\s*out|min(?:a)?\s*(?:profil|sidor|side)|mein\s*konto|mon\s*compte|my\s*account|my\s*pages|mitt\s*konto|moja\s*strona)\b/i;
        const hasLoggedInMarker = LOGGED_IN_MARKER.test(preview);
        // 2026-05-16 — substantial-content guard.
        //
        // If a portal-specific handler (tendsign Flow A, e-avrop, tarjouspalvelu,
        // kommersannons, etc.) has already fetched a meaningful blob of docs
        // into src.sourceFilesText, the source handler did its job — DO NOT
        // force a login that might (a) clobber the existing content and (b)
        // fail anyway on a blocked/limited account.
        //
        // Real-world (2026-05-16 SE test run, tender 91596 Digitala läromedel):
        // tendsign Flow A extracted 6 priority PDFs (Krav på anbudsgivaren,
        // Administrativa krav, Generella krav, ...) — 93718ch into sourceFiles
        // Text. Without this guard, the ALWAYS_LOGIN_HOSTS coercion fired
        // and forced a re-login (which failed with "account blocked"); the
        // failed-login branch never copied the 93718ch back into
        // details.pdfText, so the AI only saw 154ch of Mercell metadata.
        // Symptom: scope filled but no qualifications.
        //
        // Mirror of the dtvp.de fix in Task #8 (same overwrite pattern).
        const hasSubstantialSourceContent =
          src.sourceFilesText && src.sourceFilesText.length > 1000;
        if (hostRequiresLogin(src.sourceHost) && hasSubstantialSourceContent) {
          console.log(
            `    ✓ host ${src.sourceHost} normally forces login, but source handler ` +
            `already extracted ${src.sourceFilesText.length}ch — skipping forced login ` +
            `to preserve the content`
          );
        } else if (hostRequiresLogin(src.sourceHost) && (looksThinShell || !hasLoggedInMarker)) {
          const trigger = looksThinShell ? 'thin-shell' : 'no-logged-in-marker';
          console.log(`    🔐 host ${src.sourceHost} in ALWAYS_LOGIN_HOSTS (trigger=${trigger}, bodyLen=${bodyLen}) — forcing login`);
          src.loginGated = true;
          src.matchedMarkers = src.matchedMarkers || 0;
          src.hasPasswordField = false;
          src.bodyLength = src.bodyLength || bodyLen;
        }
      }

      if (src?.skipped) {
        // Mercell-internis permalink'as — nefetchinam, tik paliekam žymę.
        details.sourceHost = src.sourceHost || null;
        details.sourceSkipped = src.skipped;
      } else if (src?.loginGated) {
        // Login-gated portal'as (UK MyTenders, Jaggaer, Bravo, DTVP, ...)
        // — realaus turinio nepaseiksim be autentifikacijos. Pirma bandom
        // prisijungti su PORTAL_CREDS_JSON paslaptyje saugomais
        // credentials'ais; jei pavyksta, persifetchinam šaltinio puslapį
        // ir traukiame qualification laukus iš autentikuoto DOM'o.
        console.log(
          `    source login-gated (host: ${src.sourceHost}, markers: ${src.matchedMarkers}, ` +
          `bodyLen: ${src.bodyLength}, passwordField: ${src.hasPasswordField})`
        );
        details.sourceHost = src.sourceHost || null;
        const creds = getPortalCreds(src.sourceHost || details.sourceUrl);
        let postLoginSrc = null;
        if (creds && creds.password) {
          console.log(`    🔑 portal creds found for ${src.sourceHost}`);
          console.log(`    🔐 logging in to ${src.sourceHost} ...`);
          const ok = await attemptPortalLogin(
            browser, details.sourceUrl, creds, src.sourceHost
          );
          if (ok) {
            // marches-publics deep-link resolution — Mercell almost
            // always gives us the root URL ("/" or "?page=Entreprise
            // .EntrepriseAdvancedSearch&AllCons") for this portal, so
            // even when logged in we land on the user dashboard, not
            // the tender page. Use the fileReferenceNumber to search
            // the now-authenticated portal and find the real tender
            // URL. Falls through to the default refetch if anything
            // fails. Real-world: this is the difference between 4%
            // and ~40% marches-publics qualification rate.
            let refetchUrl = details.sourceUrl;
            if (/(^|\.)marches-publics\.gouv\.fr$/i.test(src.sourceHost || '')
                && details.referenceNumber) {
              const deepLink = await resolveMarchesPublicsDeepLink(
                browser, details.referenceNumber, src.sourceHost
              );
              if (deepLink) {
                refetchUrl = deepLink;
                console.log(`    ↪️  marches-publics: using deep-link for post-login fetch instead of root URL`);
              }
            }
            const t1 = Date.now();
            postLoginSrc = await fetchSourcePageDetails(browser, refetchUrl);
            console.log(
              `    🔁 post-login source fetch: ${Date.now() - t1}ms ` +
              `(gated=${!!postLoginSrc?.loginGated}, err=${postLoginSrc?.error || 'none'})`
            );

            // Post-login FALSE-POSITIVE override — even after a successful
            // login, the loginGated detector can fire again on pages that
            // still render a "log in / register" link in their header
            // (typical of TendSign, Cloudia, etc. — once you're logged in
            // they keep the login menu visible). When we see a clear
            // "logged-in marker" in the body, override gated=false so the
            // pipeline trusts the post-login state.
            if (postLoginSrc && postLoginSrc.loginGated) {
              const loggedInRe = /\b(?:log\s*out|logout|logga\s*ut|cerrar\s*sesi[oó]n|logg\s*ut|abmelden|d[eé]connexion|uitloggen|kirjaudu\s*ulos|wyloguj|sign\s*out|min(?:a)?\s*(?:profil|sidor)|mein\s*konto|mon\s*compte|my\s*account|mitt\s*konto)\b/i;
              const preview = postLoginSrc.bodyTextPreview || '';
              if (loggedInRe.test(preview)) {
                console.log(`    ✅ post-login still flagged as gated, but logged-in markers present — overriding to non-gated`);
                postLoginSrc.loginGated = false;
                postLoginSrc.loginOverride = 'logged-in markers detected';
              } else {
                // Secondary heuristic: post-login body grew significantly
                // → likely real content rendered, not the login form.
                const preLen = src.bodyLength || src.bodyTextPreview?.length || 0;
                const postLen = postLoginSrc.bodyLength || preview.length || 0;
                if (preLen > 0 && postLen > preLen * 3 && postLen > 1500) {
                  console.log(`    ✅ post-login body grew ${preLen}→${postLen}ch (3×+ expansion) — overriding gated to non-gated`);
                  postLoginSrc.loginGated = false;
                  postLoginSrc.loginOverride = `body expanded ${preLen}→${postLen}ch`;
                }
              }
            }
          }
        } else {
          console.log(`    ℹ️  no portal creds configured for ${src.sourceHost}`);
        }
        if (postLoginSrc && !postLoginSrc.loginGated && !postLoginSrc.error) {
          // Reuse the same per-field extraction the success branch does.
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
            const v = postLoginSrc[key];
            srcFieldSummary[key] = v
              ? `${String(v).length}ch: ${String(v).slice(0, 60).replace(/\s+/g, ' ')}`
              : null;
            if (v) details[key] = v;
          }
          console.log(`    source fields (post-login):`, JSON.stringify(srcFieldSummary));
          if (postLoginSrc.bodyTextPreview) {
            console.log(
              `    source body preview (first 600ch): ` +
              postLoginSrc.bodyTextPreview.slice(0, 600).replace(/\s+/g, ' ')
            );
          }
          if (!details.referenceNumber && postLoginSrc.referenceNumberSource) {
            details.referenceNumber = postLoginSrc.referenceNumberSource;
          }
          if (postLoginSrc.sourceFilesText && postLoginSrc.sourceFilesText.length) {
            const HARD_CAP = 200000;
            const existing = details.pdfText || '';
            const sep = existing ? '\n\n' : '';
            const combined = (existing + sep + postLoginSrc.sourceFilesText).slice(0, HARD_CAP);
            details.pdfText = combined;
            console.log(
              `    → merged ${postLoginSrc.sourceFilesText.length}ch of source-page docs into pdfText ` +
              `(total now ${combined.length}ch)`
            );
          }
          details.sourceLoggedIn = true;
        } else {
          details.sourceSkipped = 'login-gated';
        }
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

        // Append parsed source-page document text (e.g. simap.ch
        // attachments revealed via "Interesse bekunden") into the same
        // pdfText pool the AI extractor reads. Cap total to 200K so we
        // stay inside Claude Haiku 4.5's 200K context with margin for
        // title/description/system prompt.
        if (src.sourceFilesText && src.sourceFilesText.length) {
          const HARD_CAP = 200000;
          const existing = details.pdfText || '';
          const sep = existing ? '\n\n' : '';
          const combined = (existing + sep + src.sourceFilesText).slice(0, HARD_CAP);
          details.pdfText = combined;
          console.log(`    → merged ${src.sourceFilesText.length}ch of source-page docs into pdfText (total now ${combined.length}ch)`);
        }
        if (src.simapInterestClicked) {
          details.simapInterestClicked = true;
        }
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

// --- RETRANSLATE_STALE BACKFILL ----------------------------------------
// One-shot mode: when env var RETRANSLATE_STALE=1, scan the sheet for rows
// whose TITLE (col D) or SCOPE (col M) look like non-English strings that
// snuck through during a prior run when AI was failing (credit balance
// exhausted, transient 5xx, etc.). Re-run translateToEnglish on just those
// two columns and patch the cells in place via spreadsheets.values.batchUpdate
// — does NOT touch other columns (E-L hold organisation/budget/requirements
// /qualifications/criteria, which would be unsafe to clobber blindly without
// re-fetching the source notice).
//
// On any non-retryable AI error (credits exhausted again, 401/403),
// the pass aborts immediately so we don't loop pointlessly.
async function runRetranslateStale(sheets, SHEET_ID, TAB_NAME) {
  console.log('=== RETRANSLATE_STALE START ===');
  if (!AI_ENABLED) {
    console.log('⚠️ AI disabled — cannot translate. Set ANTHROPIC_API_KEY and re-run.');
    return;
  }
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${TAB_NAME}!A1:Q`,
  });
  const rows = resp.data.values || [];
  if (rows.length === 0) {
    console.log('Sheet is empty — nothing to backfill.');
    return;
  }
  const hasHeader = rows[0] && /DATE OF WHEN ADDED/i.test(rows[0][0] || '');
  const dataStart = hasHeader ? 1 : 0;
  console.log(`Read ${rows.length} rows (header: ${hasHeader}, data rows: ${rows.length - dataStart})`);

  // Same heuristic family as translateToEnglish: flags rows whose visible
  // text contains either non-English diacritics or non-English stopwords,
  // OR contains any non-ASCII byte at all (catches the case where the
  // string is a single non-English noun phrase with no stopword and no
  // diacritic — those would slip past otherwise).
  function looksNonEnglish(s) {
    if (!s) return false;
    const trimmed = String(s).trim();
    if (!trimmed) return false;
    const hasNonAscii = /[^\x00-\x7F]/.test(trimmed);
    const hasNonEnglishDiacritic = /[äöüßñçéèêáíóúîôûàèìòùâêîôûãõÿøœæåÄÖÜÑÉÈÊÁÍÓÚÎÔÛÃÕŸØŒÆÅąčęėįšųūžĄČĘĖĮŠŲŪŽćłńóśźżĆŁŃÓŚŹŻďěňřťůýĎĚŇŘŤŮÝĺŕĹŔőűŐŰ]/.test(trimmed);
    const hasNonEnglishStopword = /\b(?:och|und|der|die|den|das|dem|für|mit|auf|bei|nach|ist|sind|wir|sie|ihr|het|van|een|voor|naar|niet|wel|als|aan|maar|ook|waar|dan|alleen|geen|meer|kan|el|la|los|las|para|del|por|que|con|una|uno|les|pour|sur|avec|sans|dans|sous|dei|delle|della|degli|alla|allo|zur|zum|med|till|fra|men|att|som|inte|eller|ir|su|dėl|kad|yra|kaip|arba|taip|šis|tas|tos|kas|kuris|todėl|prie|po|nuo|iki|w|na|dla|z|ze|nie|jest|się|że|do|oraz|który|przez|przy|jako|lub|jeśli|a|je|ve|by|se|nebo|pokud|však|neboť|vo|zo|sa|alebo|preto|ja|on|ei|et|ka|oma|või|kui|aga|és|az|egy|hogy|vagy|van|nem|csak|már|u|li|nije|ali|ima|kao|samo)\b/i.test(trimmed);
    return hasNonAscii || hasNonEnglishDiacritic || hasNonEnglishStopword;
  }

  const updates = []; // pending batchUpdate payload: [{ range, values }]
  let scanned = 0, candidates = 0, translated = 0;
  let aborted = false;

  async function flushUpdates(label) {
    if (!updates.length) return;
    try {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: { valueInputOption: 'RAW', data: updates.splice(0) },
      });
      console.log(`  💾 flushed ${label} (${translated} cells so far)`);
    } catch (e) {
      console.log(`  ⚠️ batchUpdate failed (${label}): ${e.message}`);
    }
  }

  for (let i = dataStart; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    scanned++;
    const sheetRow = i + 1; // Sheets API rows are 1-indexed
    const title = (r[3] || '').toString();   // col D — TENDER NAME
    const scope = (r[12] || '').toString();  // col M — SCOPE OF AGREEMENT

    const titleStale = looksNonEnglish(title);
    const scopeStale = looksNonEnglish(scope);
    if (!titleStale && !scopeStale) continue;
    candidates++;

    // Reset per-row failure flag — _markAiFailure() will re-set it if a
    // non-retryable error fires.
    _lastAiNonRetryableError = null;

    if (titleStale) {
      const titleEn = await translateToEnglish(title, {
        hint: 'Public tender title',
        skipHeuristic: true,
      });
      if (titleEn && titleEn.trim() !== title.trim()) {
        updates.push({ range: `${TAB_NAME}!D${sheetRow}`, values: [[titleEn]] });
        translated++;
        console.log(`  [${sheetRow}] D: "${title.slice(0, 50)}" → "${titleEn.slice(0, 50)}"`);
      } else {
        console.log(`  [${sheetRow}] D: no change (echoed/empty)`);
      }
    }

    if (_lastAiNonRetryableError) {
      console.log(`⛔ AI non-retryable error (${_lastAiNonRetryableError}) — aborting backfill.`);
      aborted = true;
      break;
    }

    if (scopeStale) {
      const scopeEn = await translateToEnglish(scope, { hint: 'Public tender scope of agreement' });
      if (scopeEn && scopeEn.trim() !== scope.trim()) {
        updates.push({ range: `${TAB_NAME}!M${sheetRow}`, values: [[scopeEn]] });
        translated++;
        console.log(`  [${sheetRow}] M: scope translated (${scope.length}ch → ${scopeEn.length}ch)`);
      } else {
        console.log(`  [${sheetRow}] M: no change (echoed/empty)`);
      }
    }

    if (_lastAiNonRetryableError) {
      console.log(`⛔ AI non-retryable error (${_lastAiNonRetryableError}) — aborting backfill.`);
      aborted = true;
      break;
    }

    // Periodic flush so partial progress survives a crash.
    if (updates.length >= 50) {
      await flushUpdates('batch');
    }

    await new Promise(res => setTimeout(res, 500));
  }

  // Final flush.
  await flushUpdates('final');

  console.log('=== RETRANSLATE_STALE DONE ===');
  console.log(`Scanned: ${scanned}, candidates: ${candidates}, cells translated: ${translated}, aborted: ${aborted}`);
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

  // --- RETRANSLATE_STALE EARLY BRANCH ---------------------------------
  // Backfill-only mode: skip Mercell scraping entirely. Read the sheet,
  // re-translate stale TITLE/SCOPE cells in place, exit. Doesn't touch
  // requirements/qualifications/criteria — those need source text we
  // don't have at backfill time. Trigger with: RETRANSLATE_STALE=1.
  if (process.env.RETRANSLATE_STALE === '1' || process.env.RETRANSLATE_STALE === 'true') {
    console.log('=== RETRANSLATE_STALE MODE — backfill only, no scraping ===');
    if (!AI_ENABLED) {
      console.log('⚠️ ANTHROPIC_API_KEY missing — cannot translate. Aborting.');
      return;
    }
    if (!process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY env var is missing');
    }
    if (!process.env.GOOGLE_SHEET_ID) {
      throw new Error('GOOGLE_SHEET_ID env var is missing');
    }
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
    await runRetranslateStale(sheets, SHEET_ID, TAB_NAME);
    return;
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
    // 2026-05-16 FATAL fix: raw page.click() failed here with
    // "Node is either not clickable or not an Element" — element was
    // in DOM (waitForSelector succeeded) but Puppeteer's clickable-
    // point check rejected it because the React re-render hadn't
    // finished animating it in. clickRobust adds scroll-into-view +
    // DOM-click fallback that bypasses the visibility heuristic.
    if (!await clickRobust(page, 'button[data-testid="more-filters-toggle-button"]', { timeout: 15000 })) {
      throw new Error('clickRobust failed: more-filters-toggle-button (1st)');
    }

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
    if (!await clickRobust(page, 'button[data-testid="more-filters-toggle-button"]', { timeout: 15000 })) {
      throw new Error('clickRobust failed: more-filters-toggle-button (2nd)');
    }
    const locClicked = await clickSpanContainsText(page, 'Location');
    if (!locClicked) {
      // Fallback — try clicking the location-dropdown div directly.
      // Some Mercell UI variants render Location label as part of a
      // div[data-testid="location-dropdown"] rather than a clickable span.
      console.log('    ↪️  Location span click failed — trying location-dropdown div directly');
      await clickRobust(page, 'div[data-testid="location-dropdown"]', { timeout: 5000 }).catch(() => false);
    }
    try {
      await page.waitForSelector('span.p-treenode-label', { timeout: 15000 });
    } catch (e) {
      // Diagnostic dump so we know what DOM state we're in when the
      // treenode never appears. Common causes: Location dropdown didn't
      // open, Mercell UI restructured, network is slow.
      const diag = await page.evaluate(() => {
        const drop = document.querySelector('div[data-testid="location-dropdown"]');
        const spans = Array.from(document.querySelectorAll('span'))
          .map((s) => (s.textContent || '').trim())
          .filter((t) => t && t.length < 40)
          .slice(0, 30);
        const ariaExpanded = drop?.getAttribute('aria-expanded');
        return {
          url: location.href,
          dropdownFound: !!drop,
          ariaExpanded,
          dropdownClasses: drop?.className || '',
          treenodeCount: document.querySelectorAll('span.p-treenode-label').length,
          sampleSpans: spans,
        };
      }).catch(() => null);
      console.log(`    ✗ p-treenode-label wait failed — diag: ${JSON.stringify(diag)}`);
      throw e;
    }

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
    // When COUNTRY_FILTER is active, sparse matches are expected — we
    // bump the empty-pages tolerance so the loop keeps scanning until
    // it finds enough matching tenders or hits MAX_PAGES.
    const MAX_EMPTY_PAGES_IN_ROW = COUNTRY_FILTER_ACTIVE ? 25 : 2;

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
      let filteredOnThisPage = 0;
      for (const t of pageTenders) {
        const id = extractTenderId(t.href);
        if (!id) continue;
        if (seenIds.has(id)) {
          dupesOnThisPage++;
          continue;
        }
        // COUNTRY_FILTER — skip tenders whose country doesn't match.
        // We DON'T mark them as seen, in case a later run lifts the
        // filter and wants to process them. We DO count them in
        // filteredOnThisPage so the page-emptiness heuristic still
        // triggers correctly when no matches exist.
        if (COUNTRY_FILTER_ACTIVE) {
          const cLower = String(t.country || '').trim().toLowerCase();
          if (!cLower || !COUNTRY_FILTER.has(cLower)) {
            filteredOnThisPage++;
            continue;
          }
        }
        seenIds.add(id);
        const url = getCleanTenderUrl(id);
        allTenders.push({ ...t, tenderId: id, url });
        newOnThisPage++;
        if (allTenders.length >= MAX_TENDERS) break;
      }
      console.log(`Page ${pageNum}: +${newOnThisPage} new, ${dupesOnThisPage} dupes${COUNTRY_FILTER_ACTIVE ? `, ${filteredOnThisPage} country-filtered` : ''} (total: ${allTenders.length})`);

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
      let titleOut = d.titleEn || cleanDescription(d.title || t.title || '');
      let scopeOut = d.scopeOfAgreementEn || cleanDescription(d.scopeOfAgreement || '');

      // Surface ambiguous-procurement reviews in the sheet so the
      // sales reviewer can spot them at a glance. We prefix the title
      // with "[REVIEW]" and inject the AI's reason into the scope cell
      // so they don't have to re-read the source notice.
      if (d.rejectCategory === 'ambiguous_procurement_check_manually' && d.rejectReason) {
        titleOut = `[REVIEW] ${titleOut}`;
        scopeOut = `[NEEDS HUMAN REVIEW: ${d.rejectReason}] ${scopeOut}`;
      }
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
    let contentFilteredCount = 0;
    const contentFilterCategories = {};

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
      // Reset the per-tender AI failure flag — _markAiFailure() will set it
      // if any AI call hits a non-retryable error (HTTP 400 invalid_request,
      // 401/403, "credit balance too low"). Checked below before row-write
      // to DEFER the tender (skip pendingRows.push) so the next run retries.
      _lastAiNonRetryableError = null;
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

        // Jei Mercell JSON'e maxBudget yra suspect'iškai mažas (< 1000 EUR) —
        // beveik neįmanomas IT kontraktui — nuvaloma ir leidžiame AI jį
        // užpildyti iš realaus teksto. Taip pat — jei duration yra datų
        // range tipo "01/07/2026 - 28/10/2030" — laikom tuščiu.
        //
        // BUG-FIX (2026-05-12): naive parseFloat broke on Spanish/EU
        // thousand-separator format "313.240,00 Eur" — it returned 313.24
        // and tagged legitimate €313K budgets as "suspicious". Now uses
        // parseEurBudget() which handles EU vs US format heuristic and
        // returns the real EUR amount after FX conversion.
        const suspectCheck = parseEurBudget(dd.maxBudget);
        if (dd.maxBudget && suspectCheck.known && suspectCheck.amount > 0 && suspectCheck.amount < 1000) {
          console.log(`    ⚠️ discarding suspicious maxBudget: "${dd.maxBudget}" (≈€${suspectCheck.amount.toFixed(2)})`);
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
        // Diagnostic: how much text are we feeding the AI? Empty pdfText
        // is the #1 reason requirementsForSupplier / qualificationRequirements
        // come back blank — the AI literally has nothing to extract from.
        const pdfLen = (dd.pdfText || '').length;
        const snipLen = (dd.fullTextSnippet || '').length;
        const descLen = rawScope.length;
        console.log(`    📏 AI inputs: title=${rawTitle.length}ch, desc=${descLen}ch, snippet=${snipLen}ch, pdfText=${pdfLen}ch (combined=${combinedText.length}ch)`);
        if (needsExtract && combinedText) {
          if (pdfLen === 0) {
            console.log(`    ⚠️ no pdfText — AI extract will likely return empty requirements/qualifications`);
          }
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
          // Carry reject decision through (used by the content filter below)
          if (ai.rejectReason) { dd.rejectReason = ai.rejectReason; }
          if (ai.rejectCategory) { dd.rejectCategory = ai.rejectCategory; }
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

        // --- POST-AI CONTENT FILTER --------------------------------
        // Reject tenders whose scope/requirements indicate poor fit:
        // license partnerships, branded product supply, on-site work,
        // pure cybersecurity, helpdesk, network infra, etc. The AI
        // prompt populates dd.rejectReason / dd.rejectCategory based
        // on the rules. Ambiguous procurement cases are NOT rejected
        // by default — they pass through with rejectReason set to
        // "ambiguous_procurement_check_manually" so a human can review
        // them in the sheet.
        //
        // Escape hatch: set CONTENT_FILTER_DISABLED=1 to force-include
        // every tender (useful when comparing what the filter would
        // strip vs. raw output).
        const CONTENT_FILTER_DISABLED = process.env.CONTENT_FILTER_DISABLED === '1';
        const isAmbiguous = (dd.rejectCategory || '') === 'ambiguous_procurement_check_manually';
        if (!CONTENT_FILTER_DISABLED && dd.rejectReason && !isAmbiguous) {
          contentFilteredCount++;
          const catKey = dd.rejectCategory || 'uncategorized';
          contentFilterCategories[catKey] = (contentFilterCategories[catKey] || 0) + 1;
          const cat = dd.rejectCategory ? `[${dd.rejectCategory}] ` : '';
          console.log(`    ⏭️  skipping (post-AI): content filter — ${cat}${dd.rejectReason.slice(0, 200)}`);
          toFetch[i].details = dd;
          await new Promise(r => setTimeout(r, 200));
          continue;
        } else if (isAmbiguous) {
          // Surface ambiguous cases in the log so the user sees them
          // come through for manual review.
          console.log(`    ⚠️  ambiguous procurement (sent to sheet for manual review): ${dd.rejectReason.slice(0, 200)}`);
        }

        // 2) Translate title (always — short, heuristika klysta trumpiems).
        //    Jei tekstas jau anglų, Claude grąžins jį beveik identišką.
        if (rawTitle) {
          const titleEn = await translateToEnglish(rawTitle, {
            hint: 'Public tender title',
            skipHeuristic: true,
          });
          if (titleEn) dd.titleEn = titleEn;
          if (titleEn && titleEn.trim() === rawTitle.trim() && /[^\x00-\x7F]/.test(rawTitle)) {
            console.log(`    ⚠️ title translation echoed source (likely AI failure): "${rawTitle.slice(0, 60)}"`);
          }
        }

        // 3) Translate scopeOfAgreement if not already English
        //    (if AI extract above produced English scope, skip; otherwise translate)
        const scopeToTranslate = dd.scopeOfAgreement || rawScope;
        if (scopeToTranslate) {
          const scopeEn = await translateToEnglish(scopeToTranslate, { hint: 'Public tender scope of agreement' });
          if (scopeEn) dd.scopeOfAgreementEn = scopeEn;
          if (scopeEn && scopeEn.trim() === scopeToTranslate.trim() && /[^\x00-\x7F]/.test(scopeToTranslate)) {
            console.log(`    ℹ️ scope translation skipped/echoed (heuristic flagged as English or AI echoed)`);
          }
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

      // Defer-on-AI-failure: if any AI call hit a non-retryable error
      // (credit balance, 400/401/403), DO NOT write this row — the AI fields
      // (title translation, scope, requirements) would be blank/native-language
      // and once the tenderId is in the sheet it won't be retried.
      if (_lastAiNonRetryableError) {
        console.log(`    ⏭️  deferring row — AI failure (will retry next run): ${_lastAiNonRetryableError}`);
        await new Promise(r => setTimeout(r, 200));
        continue;
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
    console.log(`Content-filtered (poor fit):  ${contentFilteredCount}`);
    if (contentFilteredCount > 0) {
      const breakdown = Object.entries(contentFilterCategories)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
      console.log(`  Content filter breakdown: ${breakdown}`);
    }

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
