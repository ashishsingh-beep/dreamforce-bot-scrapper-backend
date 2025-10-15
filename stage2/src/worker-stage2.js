import { fileURLToPath } from 'url';
import path from 'path';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { chromium, devices } from 'playwright';
import { loginWithCookiesThenCredentials } from './utils/login.js';
import { scrapeProfile } from './utils/scrapeProfile.js';
import { saveToLeadDetails, fetchRandomActiveAccount, markAccountErrored, updateAccountCookies } from './utils/supabase.js';
import { setupStealthContext, preparePage, humanizePage } from './utils/stealth.js';
import { logStage2Lead } from './utils/logger.js';
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

// removed URL-based scrapped marking; now handled by saveToLeadDetails via lead_id

async function runSession({ leads, options }) {
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
    // Pick any random active account (with or without cookies)
    let tried = 0;
    const maxTries = 5;
    while (tried < maxTries) {
      const account = await fetchRandomActiveAccount();
      if (!account) return null;
      tried++;
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
          cookies: account.cookies || [],
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
  while (i < leads.length) {
    // Acquire or re-acquire session if needed
    if (!session) {
      session = await acquireSession();
      if (!session) break; // no accounts available
    }
    const { page, context, account } = session;
    const { lead_id, linkedin_url } = leads[i] || {};
    try {
      if (!linkedin_url) throw new Error('Missing linkedin_url');
      await page.goto(linkedin_url, { waitUntil: 'domcontentloaded' });
      // If we got logged out before/after navigation, drop session and retry same URL with a new account
      if (await isLoggedOut(page)) {
        // Close session, do not mark account error for forced logout mid-run
        await context.close().catch(()=>{});
        session = null;
        continue; // retry same i with a new session
      }
      const lead = await scrapeProfile(page, linkedin_url);
      if (!lead) throw new Error('Empty lead data');
      // attach lead_id from all_leads to ensure uniform IDs
      lead.lead_id = lead_id || lead.lead_id || null;
      // save and mark scrapped by lead_id internally
      await saveToLeadDetails(lead);
      // stage2 log
      try { logStage2Lead({ lead_id: lead.lead_id, name: lead.name }); } catch {}
      success += 1;
      i += 1; // move to next lead on success
      process.send?.({ type: 'progress', success, failure, current: i, total: leads.length });
      if (options.minutePacing && i < leads.length) {
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
      process.send?.({ type: 'progress', success, failure, current: i, total: leads.length });
    }
  }

  if (session?.context) await session.context.close().catch(()=>{});
  await browser.close();
  return { success, failure };
}

process.on('message', async (msg) => {
  if (msg?.type === 'start-session') {
    const { leads, options } = msg.payload;
    try {
      const { success, failure } = await runSession({ leads, options });
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
