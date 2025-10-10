import { fileURLToPath } from 'url';
import path from 'path';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { chromium, devices } from 'playwright';
import { loginLinkedIn } from './utils/login.js';
import { scrapeProfile } from './utils/scrapeProfile.js';
import { saveToLeadDetails } from './utils/supabase.js';
import { setupStealthContext, preparePage, humanizePage, waitApproximatelyOneMinute } from './utils/stealth.js';
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

async function runSession({ email, password, urls, options }) {
  const launchOpts = {
    headless: options.headless,
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
  await loginLinkedIn(page, email, password);

  let success = 0; let failure = 0;
  for (let i=0;i<urls.length;i++) {
    const url = urls[i];
    try {
      await humanizePage(page);
      const lead = await scrapeProfile(page, url);
      if (!lead) throw new Error('Empty lead data');
      await saveToLeadDetails(lead);
      await markLeadScrapped(url);
      success += 1;
    } catch (e) {
      failure += 1;
    }
    process.send?.({ type: 'progress', success, failure, current: i+1, total: urls.length });
    if (options.minutePacing && i < urls.length - 1) {
      await waitApproximatelyOneMinute(page, { minMs: 60000, maxMs: 85000 });
    }
  }
  await browser.close();
  return { success, failure };
}

process.on('message', async (msg) => {
  if (msg?.type === 'start-session') {
    const { email, password, urls, options } = msg.payload;
    try {
      const { success, failure } = await runSession({ email, password, urls, options });
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
