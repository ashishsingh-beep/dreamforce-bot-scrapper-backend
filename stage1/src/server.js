import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { runScrape } from './stage1.js';
import { fetchNextPendingRequest, fetchAllPendingRequests, fetchPendingRequestsCount, fetchActiveAccounts, pickRandomAccount, markAccountErrored, markRequestFulfilled, updateAccountCookies, incrementLoginAttempts } from './utils/supabase.js';

const app = express();
app.use(cors()); // open CORS per requirement
app.use(express.json({ limit: '1mb' }));

let running = false; // simple concurrency gate

function validatePayload(body) {
  const errors = [];
  if (!body) return ['Missing JSON body'];
  const { emailMode, email, password, accountStatus, accountEmail, keyword, searchUrl, durationSec, userId, tag } = body;
  if (!userId) errors.push('userId is required');
  if (!tag) body.tag = 'not_defined';
  if (durationSec !== undefined && (isNaN(durationSec) || durationSec < 0)) errors.push('durationSec must be >= 0');
  if (emailMode === 'manual') {
    if (!email) errors.push('email required for manual mode');
    if (!password) errors.push('password required for manual mode');
  } else if (emailMode === 'stored') {
    if (!accountStatus) errors.push('accountStatus required for stored mode');
    if (!accountEmail) errors.push('accountEmail required for stored mode');
    // password expected to be provided (frontend fetched) but we don't further validate
  } else {
    errors.push('emailMode must be manual or stored');
  }
  if (keyword && searchUrl) errors.push('Provide only one of keyword or searchUrl');
  if (!keyword && !searchUrl) errors.push('One of keyword or searchUrl required');
  return errors;
}

app.post('/scrape', async (req, res) => {
  if (running) return res.status(409).json({ success: false, message: 'Another scrape is in progress' });
  const errors = validatePayload(req.body);
  if (errors.length) return res.status(400).json({ success: false, errors });
  const {
    emailMode,
    email,
    password,
    accountEmail,
    keyword,
    searchUrl,
    durationSec = 0,
    userId,
    tag = 'not_defined',
    headless
  } = req.body;

  const finalEmail = emailMode === 'stored' ? accountEmail : email;
  const finalPassword = password;

  running = true;
  let result;
  try {
    result = await runScrape({
      email: finalEmail,
      password: finalPassword,
      keywords: keyword || '',
      searchUrl: searchUrl || '',
      durationSec: Number(durationSec) || 0,
      tag,
      userId,
      headless: typeof headless === 'boolean' ? headless : false,
      keepOpen: false,
      saveJsonFile: true,
    });
  } catch (e) {
    result = { success: false, error: e.message };
  } finally {
    running = false;
  }
  const status = result.success ? 200 : 500;
  res.status(status).json(result);
});

// ----------------------
// Internal scheduler (optional)
// Controlled via env:
//   AUTO_SCRAPE_ENABLED=true to turn on
//   AUTO_SCRAPE_INTERVAL_MS=600 interval between attempts
// Behavior: every interval attempt a scrape if not running; if no pending request, waits for next interval.
// ----------------------
const autoEnabled = true;
const intervalMs = 6000; // poll every 6 seconds and drain pending requests
if (autoEnabled) {
  console.log(`[auto] Scheduler enabled. Interval=${intervalMs}ms (drains all pending requests)`);
  setInterval(async () => {
    if (running) return; // skip if an execution is already running
    // Log queue depth on each poll
    try {
      const pendingCount = await fetchPendingRequestsCount();
      console.log(`[auto] Pending requests in queue: ${pendingCount}`);
    } catch (e) {
      console.warn('[auto] Failed to count pending requests:', e.message);
    }
    let batch = [];
    try {
      batch = await fetchAllPendingRequests(50);
    } catch (e) {
      console.warn('[auto] fetchAllPendingRequests failed:', e.message);
      return;
    }
    if (!batch.length) return; // nothing pending
    for (const requestRow of batch) {
      if (running) break; // do not overlap
      let accounts = [];
      try { accounts = await fetchActiveAccounts(); } catch (e) {
        console.warn('[auto] fetchActiveAccounts failed:', e.message);
        continue;
      }
      if (!accounts.length) { console.warn('[auto] No active accounts available'); continue; }
      const keywords = (requestRow.keywords || '').trim();
      const searchUrl = (requestRow.search_url || '').trim();
      if (!keywords && !searchUrl) { console.warn(`[auto] Request ${requestRow.request_id} has no keywords or search_url; skipping`); continue; }
      const durationSec = typeof requestRow.load_time === 'number' ? Math.max(0, requestRow.load_time) : 0;
      running = true;
      let result;
      try {
        console.log(`[auto] Running request ${requestRow.request_id}`);
        let lastErr = null;
        for (let attempt = 0; attempt < accounts.length; attempt++) {
          const account = pickRandomAccount(accounts);
          accounts = accounts.filter(a => a !== account);
          try {
            result = await runScrape({
              email: account.email_id,
              password: account.password,
              cookies: account.cookies || [],
              keywords: searchUrl ? '' : keywords,
              searchUrl: searchUrl || '',
              durationSec,
              tag: requestRow.tag,
              userId: requestRow.request_by || null,
              headless: false,
              keepOpen: false,
              saveJsonFile: true
            });
            try {
              const add = result?.method === 'manual' ? 2 : 1;
              await incrementLoginAttempts(account.email_id, add);
            } catch {}
            if (result?.success) {
              if (Array.isArray(result.refreshedCookies)) {
                try { await updateAccountCookies(account.email_id, result.refreshedCookies); } catch {}
              }
              break;
            }
            lastErr = new Error(result?.error || 'Unknown failure');
          } catch (e) {
            lastErr = e;
            try { await markAccountErrored(account.email_id); } catch {}
          }
        }
        if (!result?.success) throw (lastErr || new Error('All accounts failed'));
      } catch (e) {
        console.warn('[auto] scrape failed:', e.message);
      } finally {
        running = false;
      }
      if (result && result.success) {
        try { await markRequestFulfilled(requestRow.request_id, { success: true, runId: result.runId, totalLeads: result.totalLeads }); }
        catch (e) { console.warn('[auto] markRequestFulfilled failed:', e.message); }
      }
    }
  }, intervalMs);
}

const port = process.env.PORT || 4001;
app.get('/health', (_req, res) => res.json({ ok: true, running }));

// Only start server if this file is the entrypoint
if (process.argv[1] === new URL(import.meta.url).pathname) {
  app.listen(port, () => console.log(`[server] Stage1 scrape API listening on :${port}`));
}

export function isStage1Running() { return running; }
export default app;
