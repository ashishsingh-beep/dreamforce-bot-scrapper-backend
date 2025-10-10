import { createClient } from '@supabase/supabase-js';

let supabase = null;

export function getSupabase() {
  if (supabase) return supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_KEY;
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
 * Select most recently created account for this request
 * Criteria: status in ('active','temp') AND created_by = request.request_by
 * Order by created_at DESC limit 1
 */
export async function selectAccountForRequest(request) {
  if (!request) return null;
  const client = getSupabase();
  const { data, error } = await client
    .from('accounts')
    .select('*')
    .in('status', ['active', 'temp'])
    .eq('created_by', request.request_by)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  return data && data.length ? data[0] : null;
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

