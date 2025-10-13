# Scraper Backend (Dreamforce Bot)

This backend has two stages that work together:

- Stage 1 (discover): logs in to LinkedIn, opens a search (via search_url or keywords), scrolls, and collects people who reacted to posts. It writes rows into `all_leads` with `scrapped=false`.
- Stage 2 (enrich): logs in, opens each lead’s profile, extracts details, writes to `lead_details`, and marks the corresponding row in `all_leads` as `scrapped=true`.

A unified server exposes endpoints for both stages from one process.

## How login works

- Only `accounts.status = 'active'` are eligible.
- On each login attempt:
  1. Try cookie login (inject stored cookies, navigate to `/feed`).
  2. If not on feed, go to `/login`, click “Sign in using another account” if shown, then fill credentials using strict XPaths:
     - Email: `//input[@id="username"]`
     - Password: `//input[@id="password"]`
     - Sign in: `//button[@aria-label="Sign in"]`
  3. Login is successful only when the URL contains `/feed`.
- If credential login does not reach `/feed`, mark that account `status='error'`.
- On successful login (cookie or manual), refreshed cookies are saved back to `accounts.cookies` for that `email_id`.
- `num_login_attempts` is incremented (1 for cookie-only, 2 for cookie+manual).
- Stage 2 reuses a logged-in session to scrape multiple profiles until forced logout; then it acquires another random active account. Forced logout mid-run is not marked as error.

## Requirements

- Node.js 18+
- Supabase project (URL + Service Role key)
- Supabase tables (minimum):
  - `accounts(email_id text, password text, cookies jsonb, status text, num_login_attempts int)`
  - `all_leads(lead_id text, linkedin_url text, bio text, scrapped bool, user_id text, tag text)`
  - `lead_details(...)` (fields for profile details)
  - `requests` (Stage 1 auto): `request_id, keywords, search_url, is_fulfilled, created_at, request_by, tag, load_time`
- Optional RPC: `increment_login_attempts(email_id, by)`

## Environment variables

Create `stage2/.env` with:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY` (preferred over anon key)
- `UNIFIED_PORT` (optional, default 4000)

## Step-by-step: run the backend

1. Install deps
   - From repo root:
```bash
npm install
```
   - Then in stage2:
```bash
cd stage2
npm install
```

2. Configure env
   - Create `stage2/.env` with the vars above.

3. Start the unified server (exposes both stages)
```bash
cd stage2
npm run unified
```
You should see logs like:
```
[unified] server listening on 4000
[unified] Stage1: POST /scrape, GET /health
[unified] Stage2: /stage2/health, /stage2/scrape-batch, /stage2/scrape-multi, /stage2/jobs/:jobId
[unified] Aggregate: /unified/health
```

4. Health checks
- Aggregate: `GET /unified/health`
- Stage 1: `GET /health`
- Stage 2: `GET /stage2/health`

## Using the API

- Stage 1 (discover)
  - Manual: `POST /scrape` with `searchUrl` OR `keyword`, `durationSec`, `userId`, `tag`.
  - Auto: insert into `requests` with `is_fulfilled=false`; the scheduler will process the oldest pending.
  - If both `search_url` and `keywords` exist, `search_url` is used.

- Stage 2 (enrich)
  - Provide LinkedIn profile URLs via `POST /stage2/scrape-batch` or `POST /stage2/scrape-multi`.
  - Poll `GET /stage2/jobs/:jobId` to track progress.
  - A single logged-in session is reused to process multiple profiles; if the session breaks, another active account is acquired automatically.

## Troubleshooting

- Credential login fails: the account is set to `status='error'`. Ensure the record is valid and active.
- Cookie login fails: cookies may be stale; a manual login attempt will refresh cookies.
- Supabase errors: verify `SUPABASE_URL` and `SUPABASE_SERVICE_KEY`.
- No active accounts: ensure at least one row has `status='active'`.

## Notes

Use responsibly and comply with LinkedIn’s Terms and applicable laws.
