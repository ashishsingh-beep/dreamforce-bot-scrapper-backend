import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { runScrape } from './stage1.js';
import { fetchNextPendingRequest, selectAccountForRequest, markRequestFulfilled } from './utils/supabase.js';

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
  const finalPassword = password; // already provided (fetched on frontend per accepted approach)

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

// Auto processing endpoint: fetch one pending request + matching account and run scrape in headful mode.
app.post('/auto-scrape', async (_req, res) => {
  if (running) return res.status(409).json({ success: false, message: 'Another scrape is in progress' });
  let requestRow;
  try {
    requestRow = await fetchNextPendingRequest();
  } catch (e) {
    return res.status(500).json({ success: false, error: 'Failed fetching pending request: ' + e.message });
  }
  if (!requestRow) return res.status(404).json({ success: false, message: 'No pending requests' });

  let account;
  try {
    account = await selectAccountForRequest(requestRow);
  } catch (e) {
    return res.status(500).json({ success: false, error: 'Failed selecting account: ' + e.message });
  }
  if (!account) return res.status(400).json({ success: false, message: 'No suitable account (active/temp) for this request_by' });

  // Build scraper payload
  const keywords = (requestRow.keywords || '').trim();
  if (!keywords) return res.status(400).json({ success: false, message: 'Request has empty keywords' });

  const durationSec = typeof requestRow.load_time === 'number' ? Math.max(0, requestRow.load_time) : 0; // load_time referenced as duration

  running = true;
  let result;
  try {
    result = await runScrape({
      email: account.email_id,
      password: account.password,
      keywords,
      searchUrl: '',
      durationSec,
      tag: requestRow.tag,
      userId: requestRow.request_by || null,
      headless: false, // headfull as requested
      keepOpen: false,
      saveJsonFile: true
    });
  } catch (e) {
    result = { success: false, error: e.message };
  } finally {
    running = false;
  }

  if (result.success) {
    try {
      await markRequestFulfilled(requestRow.request_id, { success: true, runId: result.runId, totalLeads: result.totalLeads });
    } catch (e) {
      // Non-fatal: include warning
      result.markWarning = 'Failed to mark request fulfilled: ' + e.message;
    }
  }
  return res.status(result.success ? 200 : 500).json({
    mode: 'auto',
    request_id: requestRow.request_id,
    account: account.email_id,
    durationSec,
    ...result
  });
});

// ----------------------
// Internal scheduler (optional)
// Controlled via env:
//   AUTO_SCRAPE_ENABLED=true to turn on
//   AUTO_SCRAPE_INTERVAL_MS=600 interval between attempts
// Behavior: every interval attempt a scrape if not running; if no pending request, waits for next interval.
// ----------------------
const autoEnabled = true;
const intervalMs = 6000;
if (autoEnabled) {
  console.log(`[auto] Scheduler enabled. Interval=${intervalMs}ms`);
  setInterval(async () => {
    if (running) return; // skip if active
    let requestRow;
    try {
      requestRow = await fetchNextPendingRequest();
    } catch (e) {
      console.warn('[auto] fetchNextPendingRequest failed:', e.message);
      return;
    }
    if (!requestRow) return; // nothing to do this cycle
    let account;
    try { account = await selectAccountForRequest(requestRow); } catch (e) {
      console.warn('[auto] selectAccountForRequest failed:', e.message); return; }
    if (!account) return; // no valid account
    const keywords = (requestRow.keywords || '').trim();
    if (!keywords) return; // skip empty
    const durationSec = typeof requestRow.load_time === 'number' ? Math.max(0, requestRow.load_time) : 0;
    running = true;
    let result;
    try {
      console.log(`[auto] Running request ${requestRow.request_id} with account ${account.email_id}`);
      result = await runScrape({
        email: account.email_id,
        password: account.password,
        keywords,
        searchUrl: '',
        durationSec,
        tag: requestRow.tag,
        userId: requestRow.request_by || null,
        headless: false,
        keepOpen: false,
        saveJsonFile: true
      });
    } catch (e) {
      console.warn('[auto] scrape failed:', e.message);
    } finally {
      running = false;
    }
    if (result && result.success) {
      try { await markRequestFulfilled(requestRow.request_id, { success: true, runId: result.runId, totalLeads: result.totalLeads }); }
      catch (e) { console.warn('[auto] markRequestFulfilled failed:', e.message); }
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
