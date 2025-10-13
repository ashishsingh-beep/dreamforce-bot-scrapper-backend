import { fileURLToPath } from 'url';
import path from 'path';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { chromium, devices } from 'playwright';
import { loginWithCookiesThenCredentials } from './utils/login.js';
import { scrapeProfile } from './utils/scrapeProfile.js';
import { saveToLeadDetails, fetchActiveAccountsWithCookies, markAccountErrored, updateAccountCookies } from './utils/supabase.js';
import { setupStealthContext, preparePage, humanizePage } from './utils/stealth.js';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');
const envPath = path.join(rootDir, '.env');
dotenv.config({ path: envPath });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('[worker] Missing SUPABASE credentials');
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

async function markLeadScrapped(linkedinUrl) {
  if (!linkedinUrl) return;
  // We assume lead_id not required for marking; using linkedin_url unique constraint assumption
  const { error } = await supabase
    .from('all_leads')
    .update({ scrapped: true })
    .eq('linkedin_url', linkedinUrl);
  if (error) {
    // eslint-disable-next-line no-console
    console.warn('[worker] Failed to mark scrapped', linkedinUrl, error.message);
  }
}

async function runSession({ urls, options }) {
  const launchOpts = {
    headless: options.headless,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage'
    ]
  };
  const browser = await chromium.launch(launchOpts);
  let success = 0; let failure = 0;

  // Helpers
  const isLoggedOut = async (page) => {
    try {
      const url = page.url();
      if (/linkedin\.com\/(uas\/)?login|checkpoint/i.test(url)) return true;
      const hasLoginInputs = await page.locator('xpath=//input[@id="username"] | //input[@id="password"]').count();
      return hasLoginInputs > 0;
    } catch { return true; }
  };

  const acquireSession = async () => {
    // Load/refresh active accounts
    let accounts = await fetchActiveAccountsWithCookies();
    if (!accounts.length) return null;
    // Shuffle tries across available accounts
    while (accounts.length) {
      const idx = Math.floor(Math.random() * accounts.length);
      const account = accounts.splice(idx, 1)[0];
      let context, page;
      try {
        context = await browser.newContext({
          viewport: { width: 1366, height: 768 },
          userAgent: devices['Desktop Chrome'].userAgent,
        });
        await setupStealthContext(context);
        page = await context.newPage();
        await preparePage(page);

        const hybrid = await loginWithCookiesThenCredentials({
          context,
          page,
          cookies: account.cookies,
          email: account.email_id,
          password: account.password,
        });
        // increment login attempts (1 for cookie, +1 if manual used)
        try {
          const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY);
          const add = hybrid?.method === 'manual' ? 2 : 1;
          await supa.rpc('increment_login_attempts', { p_email: account.email_id, p_by: add });
        } catch {}

        if (!hybrid?.success) throw new Error('Login failed (not on feed)');

        if (hybrid?.refreshedCookies && Array.isArray(hybrid.refreshedCookies)) {
          try { await updateAccountCookies(account.email_id, hybrid.refreshedCookies); } catch {}
        }
        await humanizePage(page);
        return { context, page, account };
      } catch (e) {
        // Mark account as error only when we can't reach feed after login attempt
        try { await markAccountErrored(account.email_id); } catch {}
        if (page) await page.close().catch(()=>{});
        if (context) await context.close().catch(()=>{});
        // continue to next account
      }
    }
    return null;
  };

  let session = null;
  let i = 0;
  const retryCount = new Map();
  while (i < urls.length) {
    // Acquire or re-acquire session if needed
    if (!session) {
      session = await acquireSession();
      if (!session) break; // no accounts available
    }
    const { page, context, account } = session;
    const url = urls[i];
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      // If we got logged out before/after navigation, drop session and retry same URL with a new account
      if (await isLoggedOut(page)) {
        // Close session, do not mark account error for forced logout mid-run
        await context.close().catch(()=>{});
        session = null;
        continue; // retry same i with a new session
      }
      const lead = await scrapeProfile(page, url);
      if (!lead) throw new Error('Empty lead data');
      await saveToLeadDetails(lead);
      await markLeadScrapped(url);
      success += 1;
      i += 1; // move to next URL on success
      process.send?.({ type: 'progress', success, failure, current: i, total: urls.length });
      if (options.minutePacing && i < urls.length) {
        await new Promise(r => setTimeout(r, 10000));
      }
    } catch (e) {
      // Count retries for this URL to avoid infinite loops
      const n = (retryCount.get(url) || 0) + 1;
      retryCount.set(url, n);
      if (n >= 3) {
        failure += 1;
        i += 1; // give up on this URL after 3 attempts
      }
      // If session likely broke, drop it and reacquire
      await session.context.close().catch(()=>{});
      session = null;
      process.send?.({ type: 'progress', success, failure, current: i, total: urls.length });
    }
  }

  if (session?.context) await session.context.close().catch(()=>{});
  await browser.close();
  return { success, failure };
}

process.on('message', async (msg) => {
  if (msg?.type === 'start-session') {
    const { urls, options } = msg.payload;
    try {
      const { success, failure } = await runSession({ urls, options });
      process.send?.({ type: 'done', success, failure });
      process.exit(0);
    } catch (e) {
      process.send?.({ type: 'error', error: e.message });
      process.exit(1);
    }
  }
});

// Safety: if parent dies, exit
if (!process.send) {
  // not an IPC fork context
  process.exit(0);
}
