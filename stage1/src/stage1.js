import { randomUUID } from 'crypto';
// Static import (preferred). Some environments (packagers) may tree-shake; we also add a runtime fallback.
import { chromium, devices } from 'playwright';
import { loginLinkedIn, loginLinkedInWithCookies, loginWithCookiesThenCredentials } from './utils/login.js';
import { setupStealthContext, preparePage } from './utils/stealth.js';
import { saveAllLeads } from './utils/supabase.js';
import { saveJson } from './utils/saveJson.js';

export function nowTs() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

export async function runScrape({
  email,
  password,
  cookies = null,
  keywords = '',
  searchUrl = '',
  durationSec = 0,
  tag = 'not_defined',
  userId = null,
  headless = false,
  slowMo = 100,
  userDataDir = null,
  keepOpen = false,
  saveJsonFile = true,
}) {
  if (!cookies && (!email || !password)) throw new Error('Missing credentials: provide cookies or email+password');
  if (!searchUrl && !keywords) console.log('[info] Neither searchUrl nor keywords provided. Will stop after login.');
  if (searchUrl && keywords) console.log('[warn] Both searchUrl and keywords supplied. Using searchUrl and ignoring keywords.');

  console.log(`[${nowTs()}] Starting LinkedIn scrape (headless=${headless}).`);
  // Defensive fallback in case chromium is somehow undefined (e.g., dynamic module loading edge case)
  let chromiumRef = chromium;
  let devicesRef = devices;
  if (!chromiumRef) {
    console.warn('[runScrape] chromium import undefined, attempting dynamic import of playwright...');
    try {
      const pw = await import('playwright');
      chromiumRef = pw.chromium;
      devicesRef = pw.devices;
    } catch (e) {
      throw new Error(`Failed to load playwright dynamically: ${e.message}`);
    }
  }
  if (!chromiumRef) {
    throw new Error('chromium is not available after dynamic import attempt');
  }
  const launchOpts = {
    headless,
    slowMo,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage'
    ]
  };

  let browser; let context; let launchMode = userDataDir ? 'persistent' : 'ephemeral';
  const launchStart = Date.now();
  try {
    if (userDataDir) {
      context = await chromiumRef.launchPersistentContext(userDataDir, {
        ...launchOpts,
        viewport: { width: 1366, height: 768 },
        userAgent: devicesRef['Desktop Chrome'].userAgent,
      });
    } else {
      browser = await chromiumRef.launch(launchOpts);
      context = await browser.newContext({
        viewport: { width: 1366, height: 768 },
        userAgent: devicesRef['Desktop Chrome'].userAgent,
      });
    }
    console.log(`[${nowTs()}] Browser/context launched in ${Date.now() - launchStart}ms (mode=${launchMode}).`);
  } catch (launchErr) {
    console.error(`[${nowTs()}] Failed launching Playwright: ${launchErr.message}`);
    throw launchErr;
  }

  await setupStealthContext(context);
  const page = await context.newPage();

  const summary = { runId: randomUUID(), startedAt: new Date().toISOString(), totalLeads: 0, inserted: 0, tag, userId };

  try {
    console.log(`[${nowTs()}] Attempting login...`);
    let refreshedCookies = null;
    const hybrid = await loginWithCookiesThenCredentials({ context, page, cookies, email, password });
    if (!hybrid?.success) {
      throw new Error(hybrid?.error || 'Login failed');
    }
    if (Array.isArray(hybrid.refreshedCookies)) {
      refreshedCookies = hybrid.refreshedCookies;
    }
    summary.method = hybrid.method || 'unknown';
    summary.attempts = typeof hybrid.attempts === 'number' ? hybrid.attempts : 1;
    console.log(`[${nowTs()}] ✅ LOGIN SUCCESS via ${summary.method} (attempts=${summary.attempts})`);
    if (refreshedCookies) summary.refreshedCookies = refreshedCookies;

    if (searchUrl || keywords) {
      if (searchUrl) {
        console.log(`[${nowTs()}] Navigating to searchUrl...`);
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded' });
      } else if (keywords) {
        // New logic: directly navigate to content search results URL instead of typing into the global search bar.
        const directUrl = `https://www.linkedin.com/search/results/content/?keywords=${keywords}`;
        console.log(`[${nowTs()}] Direct navigation to content search for keywords: "${keywords}" -> ${directUrl}`);
        await page.goto(directUrl, { waitUntil: 'domcontentloaded' });
        // small wait to allow posts to hydrate
        await page.waitForTimeout(2500 + Math.random()*1500);
      }

      let postCount = 0;
      if (durationSec > 0) {
        console.log(`[${nowTs()}] Scrolling for ${durationSec}s...`);
        const endTime = Date.now() + durationSec * 1000;
        let lastHeight = 0;
        while (Date.now() < endTime) {
          await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.8));
          await page.waitForTimeout(600 + Math.random()*700);
          if (Math.random() < 0.18) {
            await page.evaluate(() => window.scrollBy(0, -Math.floor(window.innerHeight * 0.3)));
            await page.waitForTimeout(400 + Math.random()*500);
          }
          const newHeight = await page.evaluate(() => document.body.scrollHeight);
          if (newHeight === lastHeight) await page.waitForTimeout(1200 + Math.random()*800);
          lastHeight = newHeight;
        }
        console.log(`[${nowTs()}] Scroll phase complete.`);
        postCount = await page.locator('xpath=//li[@class="artdeco-card mb2"]').count();
      } else {
        console.log(`[${nowTs()}] Duration 0; skipping scroll.`);
      }

      if (postCount === 0) postCount = await page.locator('xpath=//li[@class="artdeco-card mb2"]').count();
      console.log(`[${nowTs()}] Harvesting reactions across ${postCount} posts.`);
      const posts = await page.locator('xpath=//li[@class="artdeco-card mb2"]').elementHandles();
      const allLeadsMap = new Map();

      for (let idx = 0; idx < posts.length; idx++) {
        const postHandle = posts[idx];
        try {
          const reactionsButton = await postHandle.$("xpath=.//button[@data-reaction-details]");
          if (!reactionsButton) { continue; }
            await reactionsButton.click({ delay: 120 + Math.random()*150 });
          const modalSelector = 'xpath=//div[@class="artdeco-modal__content social-details-reactors-modal__content ember-view"]';
          const modal = page.locator(modalSelector);
          await modal.waitFor({ state: 'visible', timeout: 15000 });
          const loadMoreXPath = "xpath=(//button[contains(@id,'ember') and contains(@class,'scaffold-finite-scroll__load-button')])[1]";
          const startScroll = Date.now();
          let lastSeenLoadMore = Date.now();
          while (true) {
            const loadMoreVisible = await page.locator(loadMoreXPath).isVisible().catch(() => false);
            if (loadMoreVisible) lastSeenLoadMore = Date.now();
            await page.evaluate((sel) => {
              const el = document.evaluate(sel.replace('xpath=',''), document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
              if (el) el.scrollBy(0, el.clientHeight * 0.8);
            }, modalSelector);
            await page.waitForTimeout(600 + Math.random()*500);
            if (!loadMoreVisible && Date.now() - lastSeenLoadMore > 10000) break;
            if (Date.now() - startScroll > 60000) break;
          }
          const anchors = await modal.locator('xpath=.//a[@rel="noopener noreferrer" and contains(@href, "/in")]').elementHandles();
          for (const a of anchors) {
            try {
              const url = await a.getAttribute('href');
              if (!url) continue;
              const fullUrl = url.startsWith('http') ? url : `https://www.linkedin.com${url}`;
              const match = fullUrl.match(/linkedin\.com\/in\/([^/?#]+)/i);
              if (!match) continue;
              const lead_id = match[1];
              const bio = await a.evaluate(el => {
                const raw = (el.innerText || el.textContent || '').trim();
                return raw.split(/\n+/).map(s => s.replace(/\s+/g,' ').trim()).filter(Boolean).join(' | ');
              });
              if (!allLeadsMap.has(lead_id)) allLeadsMap.set(lead_id, { lead_id, linkedin_url: fullUrl, bio });
            } catch {}
          }
          const dismissBtn = page.locator("xpath=(//button[@aria-label='Dismiss'])[1]");
          if (await dismissBtn.isVisible().catch(()=>false)) {
            await dismissBtn.click({ delay: 80 + Math.random()*140 });
            await page.locator(modalSelector).waitFor({ state: 'detached', timeout: 10000 }).catch(()=>{});
          } else {
            await page.keyboard.press('Escape').catch(()=>{});
          }
          await page.waitForTimeout(250 + Math.random()*250);
        } catch (e) {
          console.warn(`[${nowTs()}] Post ${idx+1} reactions modal issue: ${e.message}`);
          await page.keyboard.press('Escape').catch(()=>{});
        }
      }

      const collectedLeads = Array.from(allLeadsMap.values());
      summary.totalLeads = collectedLeads.length;
      console.log(`[${nowTs()}] Total unique leads collected: ${summary.totalLeads}`);
      if (collectedLeads.length && process.env.SUPABASE_URL && (process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_KEY)) {
        try {
          const saveRes = await saveAllLeads(collectedLeads, userId, tag);
          summary.inserted = saveRes.inserted;
          console.log(`[${nowTs()}] Upserted ${saveRes.inserted} leads.`);
        } catch (e) {
          summary.saveError = e.message;
          console.error(`[${nowTs()}] Save failed: ${e.message}`);
        }
      }
      if (collectedLeads.length && saveJsonFile) {
        try {
          summary.outputFile = saveJson(collectedLeads, process.env.OUTPUT_JSON || null, 'reactions-leads');
        } catch (e) {
          console.error(`[${nowTs()}] JSON write failed: ${e.message}`);
        }
      }
    }
    summary.success = true;
  } catch (err) {
    summary.success = false;
    summary.error = err.message;
  } finally {
    summary.endedAt = new Date().toISOString();
    if (!keepOpen) {
      if (browser) await browser.close(); else if (context) await context.close();
    }
  }
  return summary;
}

async function cliMain() {
  const argv = process.argv.slice(2);
  const argMap = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.replace(/^--/, '');
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { argMap[key] = next; i++; } else { argMap[key] = true; }
    }
  }
  const result = await runScrape({
    email: process.env.LINKEDIN_EMAIL,
    password: process.env.LINKEDIN_PASSWORD,
    keywords: argMap.keywords || process.env.KEYWORDS || '',
    searchUrl: argMap.searchUrl || process.env.SEARCH_URL || '',
    durationSec: Number(argMap.duration || process.env.DURATION_SEC || 0),
    tag: process.env.DEFAULT_TAG || 'not_defined',
    userId: process.env.DEFAULT_USER_ID || null,
    headless: true,
  });
  if (!result.success) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cliMain().catch(e => { console.error(e); process.exit(1); });
}