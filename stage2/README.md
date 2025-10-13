# Stage 2: Per‑Lead Cookie Scraper

Stage2 polls `all_leads` for `scrapped=false`, and for each profile URL it picks a random eligible account from `accounts` where `status='active'`, logs in using that account’s cookies in a fresh browser context, visits the profile, scrapes, saves to `lead_details`, and marks the lead as scrapped. If the cookie login fails, that account is set to `status='error'` and the scraper retries with another active account. Each lead uses a different account. Pacing between profiles is 10 seconds.

## What changed
- Uses `accounts.cookies` (jsonb Playwright cookies) for login; credentials are not typed.
- Removes any `user_id` coupling; any active account can scrape any lead.
- A fresh Playwright context is used per lead for isolation.
- 10s pacing between profiles.

## Environment
Create `stage2/.env` with:

```
SUPABASE_URL=...
SUPABASE_SERVICE_KEY=...     # service role key preferred (updates accounts.status)
# Optional fallback
SUPABASE_ANON_KEY=...

# Browser
HEADLESS=false                # headful per requirement
```

## Start the backend

```
cd stage2
npm install
node src/server.js
```

The server exposes:
- `POST /stage2/auto-scrape` — collects earliest pending leads, spawns the worker to process them with per‑lead cookie rotation.
- `POST /stage2/scrape-batch` — start a job with an explicit list of URLs (server passes only URLs to the worker; worker rotates accounts).
- `GET /stage2/jobs/:jobId` — check job progress.
- Internal scheduler — attempts a run every ~6s when idle.

## Data flow
1. Query `all_leads` where `scrapped=false` to get a batch of URLs.
2. Worker loads the set of `accounts` where `status='active'` and `cookies` is non-empty.
3. For each URL:
   - Pick a random account (each lead uses a different account).
   - Create a new context, inject cookies, validate access to `https://www.linkedin.com/feed/`.
   - Visit the profile and scrape via `scrapeProfile`.
   - `saveToLeadDetails(lead)` persists into `lead_details` and marks `all_leads.scrapped=true`.
   - If login fails → `accounts.status='error'` and retry with the next active account. Stop the whole run if no active accounts remain.

## Supabase tables
- `accounts`: email_id (PK/unique), cookies (jsonb), status (text), created_at (timestamptz)
- `all_leads`: created_at, lead_id, linkedin_url, bio, scrapped (bool), tag, user_id (unused for account selection)
- `lead_details`: any schema you use for profile details

## Notes
- Respect LinkedIn’s Terms of Service. Use at your own risk.
- Cookie freshness is critical; if many accounts flip to `error` quickly, refresh cookies in `accounts.cookies`.
