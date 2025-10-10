import { chromium, devices } from 'playwright';
import { loginLinkedIn } from '../utils/login.js';
import { scrapeProfile } from '../utils/scrapeProfile.js';
import { saveToLeadDetails } from '../utils/supabase.js';
import { setupStealthContext, preparePage, humanizePage, waitApproximatelyOneMinute } from '../utils/stealth.js';
import { saveLeadsJson } from '../utils/saveJson.js';

function nowTs() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

async function withRetry(fn, { retries = Number(process.env.MAX_RETRIES || 2), baseDelay = Number(process.env.RETRY_BASE_DELAY || 600) } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try { return await fn(); }
    catch (e) {
      const msg = e?.message || '';
      const transient = /fetch failed|ECONNRESET|ETIMEDOUT|network/i.test(msg);
      if (attempt === retries || !transient) throw e;
      const backoff = baseDelay * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
      // eslint-disable-next-line no-console
      console.warn(`Retry ${attempt + 1}/${retries} after ${backoff}ms: ${msg}`);
      await new Promise(r => setTimeout(r, backoff));
    }
  }
}

export async function runLinkedInScraper({
  email,
  password,
  urls,
  headless = String(process.env.HEADLESS || 'true') === 'true',
  slowMo = Number(process.env.SLOW_MO || 75),
  pace = { minMs: 60000, maxMs: 85000 },
  saveToSupabase = true,
  writeJson = true,
  outputJson = process.env.OUTPUT_JSON || null,
  verbose = true,
  minutePacing = true
} = {}) {
  if (!email || !password) throw new Error('email and password required');
  if (!Array.isArray(urls) || !urls.length) throw new Error('urls must be a non-empty array');

  const launchOpts = {
    headless,
    slowMo,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage'
    ]
  };

  const browser = await chromium.launch(launchOpts);
  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    userAgent: devices['Desktop Chrome'].userAgent,
  });

  await setupStealthContext(context);
  const page = await context.newPage();
  await preparePage(page);

  const failures = [];
  const successes = [];

  if (verbose) console.log(`[${nowTs()}] Logging into LinkedIn`);
  await loginLinkedIn(page, email, password);
  if (verbose) console.log(`[${nowTs()}] Login success`);

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const start = Date.now();
    if (verbose) console.log(`\n[${nowTs()}] Processing (${i + 1}/${urls.length}): ${url}`);
    try {
      await humanizePage(page);
      const lead = await scrapeProfile(page, url);
      if (!lead) throw new Error('Empty lead data');

      if (saveToSupabase) {
        await withRetry(() => saveToLeadDetails(lead));
      }

      successes.push(lead);
      if (verbose) console.log(`[${nowTs()}] Saved lead_id=${lead.lead_id}`);
    } catch (e) {
      if (verbose) console.error(`[${nowTs()}] Failed ${url}:`, e.message);
      failures.push({ url, error: e.message, stack: e.stack });
    }

    if (minutePacing && i < urls.length - 1) {
      await waitApproximatelyOneMinute(page, { minMs: pace.minMs, maxMs: pace.maxMs });
      if (verbose) {
        console.log(`[${nowTs()}] Profile duration ${(Date.now() - start) / 1000 | 0}s (paced)`);
      }
    }
  }

  let jsonPath = null;
  if (writeJson && successes.length) {
    jsonPath = saveLeadsJson(successes, outputJson);
    if (verbose) console.log(`[${nowTs()}] Wrote leads JSON ${jsonPath}`);
  }

  if (failures.length && writeJson) {
    const failFile = saveLeadsJson(failures, outputJson ? outputJson.replace(/\.json$/, `-failures-${nowTs()}.json`) : null)
      .replace(/leads-/,'failures-');
    if (verbose) console.warn(`[${nowTs()}] Wrote failures JSON ${failFile}`);
  }

  await browser.close();

  return { successes, failures, jsonPath };
}

export default runLinkedInScraper;