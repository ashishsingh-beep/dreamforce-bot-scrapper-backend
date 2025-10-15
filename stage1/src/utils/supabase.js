import { createClient } from '@supabase/supabase-js';
import { logStage1Lead } from './logger.js';

let supabase = null;

export function getSupabase() {
  if (supabase) return supabase;
  const url = process.env.SUPABASE_URL;
  // Prefer service key for writes like updating accounts.status
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_ANON_KEY/SUPABASE_SERVICE_KEY in env');
  }
  supabase = createClient(url, key, { auth: { persistSession: false } });
  return supabase;
}

export async function saveAllLeads(leads, userId = null, tag = null) {
  if (!Array.isArray(leads) || !leads.length) return { inserted: 0 };
  const client = getSupabase();
  // Expect table all_leads with columns: lead_id, linkedin_url, bio, scrapped, user_id, tag
  const effectiveUserId = userId || '1ff7317c-f2e0-44b2-a2d5-766a57a176a0';
  const payload = leads.map(l => ({
    lead_id: l.lead_id,
    linkedin_url: l.linkedin_url,
    bio: l.bio,
    scrapped: false,
    user_id: userId || effectiveUserId,
    tag: tag || 'auto'
  }));

  const { data, error } = await client
    .from('all_leads')
    .upsert(payload, { onConflict: 'lead_id' })
    .select('lead_id');
  if (error) throw error;
  try {
    for (const row of data) {
      if (row?.lead_id) logStage1Lead(row.lead_id);
    }
  } catch {}
  return { inserted: data.length };
}

// --- New helper functions for auto-scrape flow ---

/**
 * Fetch the oldest pending request (is_fulfilled = false).
 * Assumes table: requests(request_id, keywords, is_fulfilled, created_at, request_by, request_by_name, load_time?)
 */
export async function fetchNextPendingRequest() {
  const client = getSupabase();
  const { data, error } = await client
    .from('requests')
    .select('*')
    .eq('is_fulfilled', false)
    .order('created_at', { ascending: true })
    .limit(1);
  if (error) throw error;
  return data && data.length ? data[0] : null;
}

/**
 * Fetch a batch of pending requests to process sequentially.
 */
export async function fetchAllPendingRequests(limit = 50) {
  const client = getSupabase();
  const { data, error } = await client
    .from('requests')
    .select('*')
    .eq('is_fulfilled', false)
    .order('created_at', { ascending: true })
    .limit(Math.max(1, Math.min(500, limit)));
  if (error) throw error;
  return data || [];
}

/**
 * Count all pending requests (is_fulfilled=false) without fetching rows.
 */
export async function fetchPendingRequestsCount() {
  const client = getSupabase();
  const { count, error } = await client
    .from('requests')
    .select('request_id', { count: 'exact', head: true })
    .eq('is_fulfilled', false);
  if (error) throw error;
  return count || 0;
}

// Fetch all active accounts with cookies available
export async function fetchActiveAccounts() {
  const client = getSupabase();
  const { data, error } = await client
    .from('accounts')
    .select('email_id, password, cookies, status, created_at')
    .eq('status', 'active');
  if (error) throw error;
  return data || [];
}

export function pickRandomAccount(accounts) {
  if (!accounts || !accounts.length) return null;
  const idx = Math.floor(Math.random() * accounts.length);
  return accounts[idx];
}

export async function markAccountErrored(emailId) {
  if (!emailId) return;
  const client = getSupabase();
  const { error } = await client
    .from('accounts')
    .update({ status: 'error' })
    .eq('email_id', emailId);
  if (error) throw error;
}

export async function updateAccountCookies(emailId, cookiesArray) {
  if (!emailId || !Array.isArray(cookiesArray)) return;
  const client = getSupabase();
  const { error } = await client
    .from('accounts')
    .update({ cookies: cookiesArray })
    .eq('email_id', emailId);
  if (error) throw error;
}

export async function incrementLoginAttempts(emailId, count = 1) {
  if (!emailId || !Number.isFinite(count) || count <= 0) return;
  const client = getSupabase();
  const { error } = await client
    .rpc('increment_login_attempts', { p_email: emailId, p_by: count });
  if (error) {
    // Fallback if RPC not present: do a naive update using expression if supported
    try {
      const { error: updErr } = await client
        .from('accounts')
        .update({ num_login_attempts: undefined })
        .eq('email_id', emailId);
      if (updErr) throw updErr;
    } catch {}
  }
}

export async function markRequestFulfilled(requestId, { success, errorMessage, runId, totalLeads } = {}) {
  if (!requestId) return;
  const client = getSupabase();
  // Basic update: set is_fulfilled true only if success. If failure, leave false for retry.
  if (!success) return; // intentionally skip marking so it can be retried
  await client
    .from('requests')
    .update({ is_fulfilled: true })
    .eq('request_id', requestId);
  // NOTE: If later we add columns like last_error or run_id we can update them here.
  // errorMessage, runId, totalLeads currently unused.
}

