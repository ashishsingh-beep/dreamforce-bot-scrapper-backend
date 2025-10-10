# Stage 1: LinkedIn Login Test

Simple Playwright-based LinkedIn login verification script.

## Setup

1. Install dependencies:
```bash
cd stage1
npm install
```

2. Copy environment template:
```bash
cp .env.example .env
```

3. Edit `.env` with your LinkedIn credentials:
```
LINKEDIN_EMAIL=your_email@example.com
LINKEDIN_PASSWORD=your_password
HEADLESS=false
SLOW_MO=100
```

## Usage

Run the login test:
```bash
npm start
```

Or with visible browser (for debugging):
```bash
npm run test
```

Or directly:
```bash
node src/stage1.js
```

## What it does

- Launches Playwright with stealth configurations
- Navigates to LinkedIn login page
- Enters credentials with human-like typing
- Waits for successful redirect to feed
- Optionally navigates to a posts page via:
	- Direct search results URL (`--searchUrl`)
	- Or keyword search (`--keywords`) + applies Posts filter
- Optionally scrolls for N seconds to load posts
- Counts how many post elements (//li[@class='artdeco-card mb2']) appeared
- Opens each loaded post's reactions list (button `@data-reaction-details`)
- Scrolls the reactions modal until fully loaded (no load-more for 10s)
- Collects unique users (anchor `//a[@rel='noopener noreferrer' and contains(@href,'/in')]`)
- Extracts: `linkedin_url`, `bio` (anchor text), `lead_id` (handle from URL)
- Saves to Supabase `all_leads` (if env configured) and local JSON
- Displays success message and exits (unless KEEP_OPEN=1)

## Environment Variables

- `LINKEDIN_EMAIL` - Your LinkedIn email (required)
- `LINKEDIN_PASSWORD` - Your LinkedIn password (required)  
- `HEADLESS` - Run browser in headless mode (default: false)
- `SLOW_MO` - Milliseconds delay between actions (default: 100)
- `USER_DATA_DIR` - Persistent browser session directory (optional)
- `USER_AGENT` - Custom user agent string (optional)
- `SEARCH_URL` - Direct LinkedIn search results URL (optional)
- `KEYWORDS` - Keywords to type into the top search bar (optional; ignored if SEARCH_URL present)
- `DURATION_SEC` - Seconds to scroll after reaching results (optional; 0 skips scrolling)
- `KEEP_OPEN` - Set to 1 to keep browser open after completion
- `OUTPUT_JSON` - Optional path/name for saved leads JSON
- `SUPABASE_URL` / `SUPABASE_ANON_KEY` (or `SUPABASE_SERVICE_KEY`) - For remote saving

## Reactions Harvesting Logic

1. After scrolling loads posts, each post (`//li[@class='artdeco-card mb2']`) is inspected.
2. If a reactions button (`//button[@data-reaction-details]`) exists, it is clicked.
3. The reactions modal container (`//div[@class='artdeco-modal__content social-details-reactors-modal__content ember-view']`) is scrolled internally.
4. Scrolling stops when the load-more button `(//button[contains(@id,'ember') and contains(@class,'scaffold-finite-scroll__load-button')])[1]` is absent for 10s (or max 2 min safety cap).
5. All user anchors are parsed; duplicates removed by `lead_id`.
6. Data upserted into Supabase `all_leads` (requires schema) and written to JSON (`reactions-leads-*.json`).

## CLI Arguments (override env)

You can pass any of these as flags:

```
node src/stage1.js --searchUrl "https://www.linkedin.com/search/results/content/?keywords=ai%20agents&origin=SWITCH_SEARCH_VERTICAL" --duration 20
```

Or with keywords mode:
```
node src/stage1.js --keywords "gen ai innovation" --duration 15
```

Both provided (searchUrl wins):
```
node src/stage1.js --searchUrl "https://..." --keywords "ignored here" --duration 10
```

Keep window open for inspection:
```
HEADLESS=false KEEP_OPEN=1 node src/stage1.js --keywords "open source security" --duration 25
```

Headless quick run (no UI):
```
HEADLESS=true node src/stage1.js --keywords "edge computing" --duration 10
[Reactions harvesting example]
```
HEADLESS=false node src/stage1.js --keywords "computer vision" --duration 25
```
Will produce logs like:
```
[time] Beginning reactions harvesting across 15 posts (limited to what's loaded).
[time] [Post 1] Opened reactions modal.
[time] [Post 1] Modal fully loaded (no load-more for >10s).
[time] [Post 1] Found 57 user anchor nodes.
...
[time] Total unique leads collected: 312
[time] Saved/Upserted 312 leads to Supabase (table all_leads).
[time] Wrote leads JSON: reactions-leads-2024-...json
```

```

## Success Output

```
[2024-01-01_12-30-45] Starting LinkedIn login test...
[2024-01-01_12-30-46] Attempting login...
[2024-01-01_12-30-52] ✅ LOGIN SUCCESS! Reached LinkedIn feed.
[2024-01-01_12-30-53] Performing keyword search: "gen ai"
[2024-01-01_12-30-55] Applied Posts filter.
[2024-01-01_12-30-55] Starting timed scroll for 15s...
[2024-01-01_12-31-10] Timed scroll complete.
[2024-01-01_12-31-10] ✅ Loaded post elements count: 42
[2024-01-01_12-30-55] 🎉 Process completed successfully!
```

## Troubleshooting

- If login fails, verify credentials in `.env`
- For CAPTCHA issues, try `HEADLESS=false` to see the browser
- Increase `SLOW_MO` value if actions are too fast
- Use `USER_DATA_DIR` to persist login sessions
- No reactions button: Some posts might have zero reactions or dynamic layouts.
- Low count: Increase `--duration` to load more posts.
- Supabase errors: Ensure table `all_leads` exists with columns (lead_id text PK, linkedin_url text, bio text, scrapped boolean default false).