import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import path from 'path';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { fork } from 'child_process';
import { v4 as uuidv4 } from 'uuid';

// Resolve root & load env
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');
const envPath = path.join(rootDir, '.env');
dotenv.config({ path: envPath });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_ANON_KEY in .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// In-memory job registry
const jobs = new Map();
// Global single-worker gate.
let activeWorker = false;

// Shape helper (single-account version)
function createSingleJob(accountEmail, count, mode='single') {
  return {
    jobId: uuidv4(),
    status: 'pending',
    createdAt: new Date().toISOString(),
    completedAt: null,
    accounts: [{ idx:0, email: accountEmail, mode, assigned: count, success:0, failure:0, state:'pending' }],
    total: { assigned: count, success:0, failure:0 },
    errors: []
  };
}

app.get('/stage2/health', (req,res)=>res.json({ ok: true, time: new Date().toISOString() }));

// Fetch leads by filters helper
async function fetchCandidateLeads({ dateFrom, dateTo, tags }) {
  if (!dateFrom || !dateTo) throw new Error('dateFrom/dateTo required');
  const fromUtc = new Date(`${dateFrom}T00:00:00Z`).toISOString();
  const toUtc = new Date(`${dateTo}T23:59:59Z`).toISOString();
  let query = supabase
    .from('all_leads')
    .select('*')
    .eq('scrapped', false)
    .gte('created_at', fromUtc)
    .lte('created_at', toUtc);
  if (tags && tags.length) query = query.in('tag', tags);
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

// Distribute leads evenly
function distribute(leads, accounts) {
  if (!leads.length) return accounts.map(a => ({ ...a, urls: [] }));
  const n = accounts.length;
  const base = Math.floor(leads.length / n);
  const rem = leads.length % n;
  const result = [];
  let idx = 0;
  for (let i=0;i<n;i++) {
    const take = base + (i < rem ? 1 : 0);
    result.push({ ...accounts[i], urls: leads.slice(idx, idx + take) });
    idx += take;
  }
  return result.filter(r => r.urls.length); // drop zero assignments
}

// Multi endpoint simplified: uses only the first provided account after validation, ignores others.
app.post('/stage2/scrape-multi', async (req,res) => {
  try {
    const { mode, accounts: acctPayload, dateFrom, dateTo, tags } = req.body || {};
    if (!mode || !['manual','stored'].includes(mode)) return res.status(400).json({ error: 'mode must be manual|stored' });
    if (!Array.isArray(acctPayload) || !acctPayload.length) return res.status(400).json({ error: 'accounts array required' });
    if (activeWorker) return res.status(409).json({ error: 'Another scrape is in progress' });

    // Validate accounts & fetch passwords if stored mode
    // Only consider the first account
    const first = acctPayload[0];
    let account;
    if (mode === 'manual') {
      if (!first.email || !first.password) return res.status(400).json({ error: 'manual email/password required' });
      account = { email: first.email, password: first.password };
    } else {
      if (!first.email) return res.status(400).json({ error: 'stored email required' });
      const { data, error } = await supabase
        .from('accounts')
        .select('password')
        .eq('email_id', first.email)
        .single();
      if (error || !data) return res.status(400).json({ error: `password lookup failed for ${first.email}` });
      account = { email: first.email, password: data.password };
    }

    // Load candidate leads
    const leads = await fetchCandidateLeads({ dateFrom, dateTo, tags });
    if (!leads.length) return res.status(400).json({ error: 'No leads match filters (scrapped=false enforced)' });

    // Shuffle leads for fair distribution (optional)
    for (let i=leads.length-1;i>0;i--) { const j=Math.floor(Math.random()*(i+1)); [leads[i],leads[j]]=[leads[j],leads[i]]; }

  const leadList = leads.map(l=>({ lead_id: l.lead_id, linkedin_url: l.linkedin_url })).filter(l=>l.linkedin_url).slice(0,40);
  const job = createSingleJob(account.email, leadList.length, 'multi-single');
      jobs.set(job.jobId, job);
      job.status = 'running';
      job.accounts[0].state = 'running';
      activeWorker = true;
      const workerPath = path.join(__dirname, 'worker-stage2.js');
      const child = fork(workerPath, [], { stdio: ['inherit','inherit','inherit','ipc'] });
      child.send({ type: 'start-session', payload: {
        leads: leadList,
        options: { headless: false, writeJson: false, minutePacing: true, verbose: true },
        jobId: job.jobId,
        accountIndex: 0
      }});
      child.on('message', (msg) => {
        if (msg?.type === 'progress') {
          job.accounts[0].success = msg.success;
          job.accounts[0].failure = msg.failure;
          job.total.success = msg.success;
          job.total.failure = msg.failure;
        } else if (msg?.type === 'done') {
          job.accounts[0].success = msg.success;
          job.accounts[0].failure = msg.failure;
          job.accounts[0].state = 'done';
        } else if (msg?.type === 'error') {
          job.accounts[0].state = 'error';
          job.accounts[0].failure += 1;
          job.errors.push({ email: account.email, error: msg.error });
        }
      });
      child.on('exit', (code) => {
        if (job.accounts[0].state === 'running') job.accounts[0].state = code === 0 ? 'done':'error';
        job.status = job.accounts[0].state === 'error' ? 'error' : 'completed';
        job.completedAt = new Date().toISOString();
        activeWorker = false;
      });
  res.json({ jobId: job.jobId, accounts: 1, totalAssigned: job.total.assigned, mode: 'single', capped: leadList.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// New simpler batch endpoint: client already fetched + distributed urls.
app.post('/stage2/scrape-batch', async (req,res) => {
  try {
    const { jobs: jobList, options } = req.body || {};
    if (!Array.isArray(jobList) || !jobList.length) return res.status(400).json({ error: 'jobs array required' });
    if (activeWorker) return res.status(409).json({ error: 'Another scrape is in progress' });
    const first = jobList[0];
    if (!first?.email || !first?.password) return res.status(400).json({ error: 'email/password required for first job' });
    if (!Array.isArray(first.urls) || !first.urls.length) return res.status(400).json({ error: 'urls required' });
    const uniq = Array.from(new Set(first.urls.filter(Boolean)));
    if (!uniq.length) return res.status(400).json({ error: 'No valid urls' });
    const { data: mapped, error: mapErr } = await supabase
      .from('all_leads')
      .select('lead_id, linkedin_url')
      .in('linkedin_url', uniq)
      .eq('scrapped', false);
    if (mapErr) return res.status(500).json({ error: mapErr.message });
    const leadList = (mapped || []).map(l => ({ lead_id: l.lead_id, linkedin_url: l.linkedin_url })).slice(0,40);
    if (!leadList.length) return res.status(400).json({ error: 'No pending leads for provided urls' });
    const job = createSingleJob(first.email, leadList.length, 'batch-single');
    jobs.set(job.jobId, job);
    job.status = 'running';
    job.accounts[0].state = 'running';
    activeWorker = true;
    const workerPath = path.join(__dirname, 'worker-stage2.js');
    const child = fork(workerPath, [], { stdio: ['inherit','inherit','inherit','ipc'] });
    child.send({ type: 'start-session', payload: {
      leads: leadList,
      options: {
        headless: false,
        writeJson: false,
        minutePacing: options?.minutePacing === false ? false : true,
        verbose: false
      },
      jobId: job.jobId,
      accountIndex: 0
    }});
    child.on('message', (msg) => {
      if (msg?.type === 'progress') {
        job.accounts[0].success = msg.success;
        job.accounts[0].failure = msg.failure;
        job.total.success = msg.success;
        job.total.failure = msg.failure;
      } else if (msg?.type === 'done') {
        job.accounts[0].success = msg.success;
        job.accounts[0].failure = msg.failure;
        job.accounts[0].state = 'done';
      } else if (msg?.type === 'error') {
        job.accounts[0].state = 'error';
        job.errors.push({ email: first.email, error: msg.error });
      }
    });
    child.on('exit', (code) => {
      if (job.accounts[0].state === 'running') job.accounts[0].state = code === 0 ? 'done':'error';
      job.status = job.accounts[0].state === 'error' ? 'error' : 'completed';
      job.completedAt = new Date().toISOString();
      activeWorker = false;
    });
  res.json({ jobId: job.jobId, accounts: 1, totalAssigned: job.total.assigned, mode: 'single', capped: leadList.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/stage2/jobs/:jobId', (req,res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });
  res.json(job);
});

// Synchronous random runner: pick N random pending leads (scrapped=false)
app.post('/stage2/run-random', async (req, res) => {
  try {
    const { limit } = req.body || {};
    if (activeWorker) return res.status(409).json({ error: 'Another scrape is in progress' });
    const take = Math.min(Math.max(Number(limit)||10, 1), 50);
    // Fetch a pool of pending leads and randomize client-side
    const { data: pending, error } = await supabase
      .from('all_leads')
      .select('lead_id, linkedin_url')
      .eq('scrapped', false)
      .limit(200);
    if (error) return res.status(500).json({ error: error.message });
    if (!pending || !pending.length) return res.status(404).json({ error: 'No pending leads' });
    for (let i=pending.length-1;i>0;i--) { const j=Math.floor(Math.random()*(i+1)); [pending[i],pending[j]]=[pending[j],pending[i]]; }
    const leadList = pending.slice(0, take).map(l => ({ lead_id: l.lead_id, linkedin_url: l.linkedin_url })).filter(l=>l.linkedin_url);
    if (!leadList.length) return res.status(400).json({ error: 'No valid linkedin_url among pending leads' });
    const job = createSingleJob('random-active-account', leadList.length, 'random');
    job.status = 'running';
    job.accounts[0].state = 'running';
    jobs.set(job.jobId, job);
    activeWorker = true;
    const workerPath = path.join(__dirname, 'worker-stage2.js');
    const child = fork(workerPath, [], { stdio: ['inherit','inherit','inherit','ipc'] });
    child.send({ type: 'start-session', payload: {
      leads: leadList,
      options: { headless: false, writeJson: false, minutePacing: true, verbose: false },
      jobId: job.jobId,
      accountIndex: 0
    }});
    child.on('message', (msg) => {
      if (msg?.type === 'progress') {
        job.accounts[0].success = msg.success;
        job.accounts[0].failure = msg.failure;
        job.total.success = msg.success;
        job.total.failure = msg.failure;
      } else if (msg?.type === 'done') {
        job.accounts[0].success = msg.success;
        job.accounts[0].failure = msg.failure;
        job.accounts[0].state = 'done';
      } else if (msg?.type === 'error') {
        job.accounts[0].state = 'error';
        job.accounts[0].failure += 1;
        job.errors.push({ email: 'random-active-account', error: msg.error });
      }
    });
    child.on('exit', (code) => {
      if (job.accounts[0].state === 'running') job.accounts[0].state = code === 0 ? 'done':'error';
      job.status = job.accounts[0].state === 'error' ? 'error' : 'completed';
      job.completedAt = new Date().toISOString();
      activeWorker = false;
    });
    res.json({ jobId: job.jobId, totalAssigned: job.total.assigned, mode: 'random' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ------------------------
// INTERNAL ALWAYS-ON SCHEDULER (600ms) FOR AUTO STAGE2 SCRAPE
// WARNING: 600ms is extremely aggressive for LinkedIn profile scraping and may result in rapid account throttling.
// This loop continuously:
//   1. Skips if there is already a running 'auto' job (status running and auto flag true)
//   2. Attempts to find earliest pending lead (scrapped=false)
//   3. Resolves newest active/temp account for that lead's user
//   4. Launches a single-worker job (same as /stage2/auto-scrape)
// To adjust behavior, edit code directly. AUTO_SCRAPE_ENABLED is hard-coded true per request.
// ------------------------
const AUTO_SCRAPE_ENABLED = true;
const AUTO_INTERVAL_MS = 6000; // less aggressive
if (AUTO_SCRAPE_ENABLED) {
  console.log(`[stage2:auto] HARD ENABLED scheduler @ ${AUTO_INTERVAL_MS}ms (WARNING: very fast)`);
  setInterval(async () => {
    try {
      // If an auto job currently running, skip.
      for (const j of jobs.values()) {
        if ((j.auto && j.status === 'running') || activeWorker) return; // allow only one active worker globally
      }
      // Probe earliest pending lead
      const { data: leadProbe, error: probeErr } = await supabase
        .from('all_leads')
        .select('user_id, linkedin_url')
        .eq('scrapped', false)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();
      if (probeErr || !leadProbe) return; // no pending
      const targetUserId = leadProbe.user_id;
      // Fetch up to 40 leads per burst (cap)
      const { data: leads, error: leadsErr } = await supabase
        .from('all_leads')
        .select('lead_id, linkedin_url')
        .eq('scrapped', false)
        .eq('user_id', targetUserId)
        .order('created_at', { ascending: true })
        .limit(40);
      if (leadsErr || !leads || !leads.length) return;
  const leadList = leads.map(l => ({ lead_id: l.lead_id, linkedin_url: l.linkedin_url })).filter(l=>l.linkedin_url).slice(0,40);
  if (!leadList.length) return;
  const job = createSingleJob('multi-account-cookie', leadList.length, 'auto');
      job.status = 'running';
      job.accounts[0].state = 'running';
      job.auto = true;
      job.userId = targetUserId;
      jobs.set(job.jobId, job);
      const workerPath = path.join(__dirname, 'worker-stage2.js');
      const child = fork(workerPath, [], { stdio: ['inherit','inherit','inherit','ipc'] });
      child.send({ type: 'start-session', payload: {
        leads: leadList,
        options: { headless: false, writeJson: false, minutePacing: true, verbose: false },
        jobId: job.jobId,
        accountIndex: 0
      }});
      child.on('message', (msg) => {
        if (msg?.type === 'progress') {
          job.accounts[0].success = msg.success;
          job.accounts[0].failure = msg.failure;
          job.total.success = msg.success;
          job.total.failure = msg.failure;
        } else if (msg?.type === 'done') {
          job.accounts[0].success = msg.success;
          job.accounts[0].failure = msg.failure;
          job.accounts[0].state = 'done';
          job.total.success = msg.success;
          job.total.failure = msg.failure;
          job.status = msg.failure > 0 ? 'error' : 'completed';
          job.completedAt = new Date().toISOString();
        } else if (msg?.type === 'error') {
          job.accounts[0].state = 'error';
          job.accounts[0].failure += 1;
          job.errors.push({ email: accountRow.email_id, error: msg.error });
          job.status = 'error';
          job.completedAt = new Date().toISOString();
        }
      });
      child.on('exit', (code) => {
        if (job.accounts[0].state === 'running') {
          job.accounts[0].state = code === 0 ? 'done' : 'error';
          job.status = code === 0 ? 'completed' : 'error';
          job.completedAt = new Date().toISOString();
        }
      });
    } catch (e) {
      console.warn('[stage2:auto] scheduler error:', e.message);
    }
  }, AUTO_INTERVAL_MS);
}

// ------------------------
// AUTO SCRAPE (Stage2) - fetch pending (scrapped=false) leads for one user and run a single account session.
// Query params / body (optional): userId (uuid), limit (default 10)
// Logic:
//   1. If userId supplied: scope leads to those whose user_id = userId, else pick any earliest created pending lead and use its user_id.
//   2. Select newest account (status in active|temp) where created_by = user_id.
//   3. Collect up to limit leads (linkedin_url) scrapped=false for that user.
//   4. Spawn worker (start-session) with those URLs.
//   5. Return job summary.
// NOTE: relies on worker to mark scrapped when saving details in saveToLeadDetails.
app.post('/stage2/auto-scrape', async (req,res) => {
  try {
  const { userId, limit } = req.body || {};
    const take = Math.min(Math.max(Number(limit)||10, 1), 50); // cap at 50

    // Step 1: determine target user & leads
    let targetUserId = userId || null;
    if (!targetUserId) {
      const { data: firstLead, error: flErr } = await supabase
        .from('all_leads')
        .select('user_id')
        .eq('scrapped', false)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();
      if (flErr) return res.status(500).json({ error: 'Lead probe failed: ' + flErr.message });
      if (!firstLead) return res.status(404).json({ error: 'No pending leads' });
      targetUserId = firstLead.user_id;
    }

    // Fetch leads for target user
    const { data: leads, error: leadsErr } = await supabase
      .from('all_leads')
      .select('lead_id, linkedin_url')
      .eq('scrapped', false)
      .eq('user_id', targetUserId)
      .order('created_at', { ascending: true })
      .limit(take);
    if (leadsErr) return res.status(500).json({ error: 'Failed fetching leads: ' + leadsErr.message });
    if (!leads || !leads.length) return res.status(404).json({ error: 'No pending leads for user' });

    // Step 2: pick newest matching account
  const leadList = leads.map(l => ({ lead_id: l.lead_id, linkedin_url: l.linkedin_url })).filter(l=>l.linkedin_url);
  if (!leadList.length) return res.status(400).json({ error: 'Leads missing linkedin_url values' });

    // Create synthetic job structure mirroring batch endpoint (single account)
    const job = {
      jobId: uuidv4(),
      status: 'running',
      createdAt: new Date().toISOString(),
      completedAt: null,
  accounts: [ { idx:0, email: 'multi-account-cookie', mode:'auto', assigned: leadList.length, success:0, failure:0, state:'running' } ],
    total: { assigned: leadList.length, success:0, failure:0 },
      errors: [],
      auto: true,
      userId: targetUserId
    };
    jobs.set(job.jobId, job);

    const workerPath = path.join(__dirname, 'worker-stage2.js');
    const child = fork(workerPath, [], { stdio: ['inherit','inherit','inherit','ipc'] });
    child.send({ type: 'start-session', payload: {
      leads: leadList,
      options: { headless: false, writeJson: false, minutePacing: true, verbose: false },
      jobId: job.jobId,
      accountIndex: 0
    }});
    child.on('message', (msg) => {
      if (msg?.type === 'progress') {
        job.accounts[0].success = msg.success;
        job.accounts[0].failure = msg.failure;
        job.total.success = msg.success;
        job.total.failure = msg.failure;
      } else if (msg?.type === 'done') {
        job.accounts[0].success = msg.success;
        job.accounts[0].failure = msg.failure;
        job.accounts[0].state = 'done';
        job.total.success = msg.success;
        job.total.failure = msg.failure;
        job.status = msg.failure > 0 ? 'error' : 'completed';
        job.completedAt = new Date().toISOString();
      } else if (msg?.type === 'error') {
        job.accounts[0].state = 'error';
        job.accounts[0].failure += 1;
        job.errors.push({ email: accountRow.email_id, error: msg.error });
        job.status = 'error';
        job.completedAt = new Date().toISOString();
      }
    });
    child.on('exit', (code) => {
      if (job.accounts[0].state === 'running') {
        job.accounts[0].state = code === 0 ? 'done' : 'error';
        job.status = code === 0 ? 'completed' : 'error';
        job.completedAt = new Date().toISOString();
      }
    });

  return res.json({ jobId: job.jobId, assigned: leadList.length, account: 'multi-account-cookie', userId: targetUserId });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.STAGE2_PORT || 4002;
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  app.listen(PORT, () => console.log(`[stage2] server listening on ${PORT}`));
}

export default app;
