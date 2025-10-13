# Stage 1: Automated Reactions Harvester (Cookie-based)

Stage1 polls the `requests` table and, when it finds a pending request (`is_fulfilled=false`), it selects a random eligible LinkedIn account from `accounts` where `status='active'`, logs in using that account’s cookies, and runs the reactions-harvest flow on either the provided `search_url` or the `keywords` (search_url takes precedence when both exist). Harvested leads are upserted to `all_leads` and also written to a JSON file (optional).

## What changed
- Cookie-based login using `accounts.cookies` (jsonb array of Playwright cookies). No manual credentials are typed.
- Accounts are selected globally (ignoring `user_id`) with the condition `status='active'`.
- On cookie-login failure the account is marked `status='error'` and Stage1 retries automatically with another active account.
- Supports `requests.search_url` (preferred) and `requests.keywords` as input drivers.
- Runs headful by default so you can supervise.

## Environment
Create `stage1/.env` with:

```
SUPABASE_URL=...              # your Supabase project URL
SUPABASE_SERVICE_KEY=...      # service role key (preferred for status updates)
# Optional fallbacks
SUPABASE_ANON_KEY=...

# Scrape tuning
HEADLESS=false                # Stage1 auto runs headful; keep false
SLOW_MO=100
OUTPUT_JSON=./data
DEFAULT_TAG=not_defined
DEFAULT_USER_ID=optional
```

Note: `LINKEDIN_EMAIL` / `LINKEDIN_PASSWORD` are no longer required for auto-mode; cookie login is used instead. They may still be used by the legacy manual `/scrape` endpoint if you call it directly.

## Start the backend

```
cd stage1
npm install
node src/server.js
```

The server exposes:

- `POST /auto-scrape` — runs one job immediately if a pending request exists.
- Internal scheduler — every 6s attempts a run if idle and a pending request exists.
- `GET /health` — simple status.

## Request processing
1. Probe the earliest `requests` row where `is_fulfilled=false`.
2. Load all accounts where `status='active'` and have non-empty cookies.
3. Try a random account:
	- Inject cookies and open `https://www.linkedin.com/feed/`.
	- If login fails → set account `status='error'` and retry with another account.
4. After login:
	- If `search_url` present → navigate to it.
	- Else if `keywords` present → go to `https://www.linkedin.com/search/results/content/?keywords=...`.
5. Scroll per existing logic and harvest reactions.
6. Upsert to `all_leads` and write JSON.
7. Mark the request as fulfilled on success.

## Troubleshooting
- Ensure `accounts.cookies` contains valid LinkedIn cookies (array) for the selected accounts.
- Make sure your Supabase RLS allows updates to `accounts.status` with the service-key.
- If no active accounts exist or all fail, Stage1 will skip the request until accounts are replenished/fixed.