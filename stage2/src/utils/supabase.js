import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;

let supabase = null;
if (supabaseUrl && supabaseKey) {
  supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });
}

export async function saveToLeadDetails(lead) {
  if (!supabase) {
    console.warn('Supabase not configured; skipping save');
    return { skipped: true };
  }
  // Ensure fields per schema
  const row = {
    lead_id: lead.lead_id ?? null,
    name: lead.name ?? null,
    title: lead.title ?? null,
    location: lead.location ?? null,
    profile_url: lead.profile_url ?? null,
    bio: lead.bio ?? null,
    skills: lead.skills ?? [],
    experience: lead.experience ?? null,
    company_name: lead.company_name ?? null,
    company_page_url: lead.company_page_url ?? null,
  };
  let duplicate = false;
  try {
    const { error } = await supabase.from('lead_details').insert(row);
    if (error) throw error;
  } catch (e) {
    // If duplicate key on lead_id, treat as already saved and continue to mark scrapped
    const msg = e?.message || '';
    if (e?.code === '23505' || /duplicate key value/i.test(msg) || /unique constraint/i.test(msg)) {
      duplicate = true;
    } else {
      throw e;
    }
  }

  // Mark scrapped true in all_leads strictly by lead_id (very important)
  if (row.lead_id) {
    try {
      const { error: updErr, data } = await supabase
        .from('all_leads')
        .update({ scrapped: true })
        .eq('lead_id', row.lead_id)
        .select('lead_id');
      if (updErr) {
        console.warn('Failed to update all_leads.scrapped for', row.lead_id, updErr.message);
      } else if (!data || data.length === 0) {
        console.warn('No matching row in all_leads for lead_id=', row.lead_id);
      } else {
        console.log(`Marked all_leads.scrapped=true for lead_id=${row.lead_id}`);
      }
    } catch (e) {
      console.warn('Unexpected error updating all_leads.scrapped', e.message);
    }
  }

  return { inserted: !duplicate, duplicate };
}

export async function fetchOnePendingLead() {
  if (!supabase) throw new Error('Supabase not configured');
  const { data, error } = await supabase
    .from('all_leads')
    .select('lead_id, linkedin_url, created_at')
    .eq('scrapped', false)
    .order('created_at', { ascending: true })
    .limit(1);
  if (error) throw error;
  return data?.[0] || null;
}

export async function fetchRandomActiveAccount() {
  if (!supabase) throw new Error('Supabase not configured');
  const { data, error } = await supabase
    .from('accounts')
    .select('email_id, password, cookies, status')
    .eq('status', 'active');
  if (error) throw error;
  const arr = data || [];
  if (!arr.length) return null;
  const idx = Math.floor(Math.random() * arr.length);
  return arr[idx];
}

export async function markAccountErrored(emailId) {
  if (!supabase) throw new Error('Supabase not configured');
  if (!emailId) return;
  const { error } = await supabase
    .from('accounts')
    .update({ status: 'error' })
    .eq('email_id', emailId);
  if (error) throw error;
}

export async function updateAccountCookies(emailId, cookiesArray) {
  if (!supabase) throw new Error('Supabase not configured');
  if (!emailId || !Array.isArray(cookiesArray)) return;
  const { error } = await supabase
    .from('accounts')
    .update({ cookies: cookiesArray })
    .eq('email_id', emailId);
  if (error) throw error;
}



// Test function to check supabase connection
// (async () => {

//   if (!supabase) {
//     console.warn('Supabase not configured; skipping save');
//     return { skipped: true };
//   }
//   const { error } = await supabase.from('lead_details').insert({lead_id: "abc", user_id: "1ff7317c-f2e0-44b2-a2d5-766a57a176a0"});
//   if (error) throw error;
//   return { inserted: true };

// })()