// Common stealth tweaks to reduce automation detection heuristics
export async function setupStealthContext(context) {
  // Optional: use a custom User-Agent at context creation time (recommended)
  // const context = await browser.newContext({
  //   userAgent: process.env.USER_AGENT || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  // });

  // Optional: If you want to try a community stealth plugin:
  // (uncomment after installing: npm i playwright-extra playwright-extra-plugin-stealth)
  // import { chromium as chromiumExtra } from 'playwright-extra';
  // import stealth from 'playwright-extra-plugin-stealth';
  // chromiumExtra.use(stealth());
  // const browser = await chromiumExtra.launch(/* ... */);

  await context.addInitScript((uaFromEnv) => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });

    // languages
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en']
    });

    // plugins length
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3]
    });

    // chrome runtime existence
    window.chrome = window.chrome || { runtime: {} };

    // permissions query override for notifications
    const originalQuery = window.navigator.permissions && window.navigator.permissions.query;
    if (originalQuery) {
      window.navigator.permissions.query = (parameters) => (
        parameters && parameters.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : originalQuery(parameters)
      );
    }

    // WebGL vendor/renderer spoof
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(parameter) {
      if (parameter === 37445) return 'Intel Inc.'; // UNMASKED_VENDOR_WEBGL
      if (parameter === 37446) return 'Intel Iris OpenGL Engine'; // UNMASKED_RENDERER_WEBGL
      return getParameter.apply(this, [parameter]);
    };

    // hairline fix
    Object.defineProperty(window, 'devicePixelRatio', { get: () => 2 });

    // Optional: override navigator.userAgent via init script if env provided
    if (uaFromEnv) {
      Object.defineProperty(navigator, 'userAgent', { get: () => uaFromEnv });
      Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' });
    }
  }, process.env.USER_AGENT || null);
}

export async function preparePage(page) {
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'DNT': '1'
  });

  // Optional: runtime UA override (prefer context-level userAgent instead)
  // if (process.env.USER_AGENT) {
  //   await page.addInitScript((ua) => {
  //     Object.defineProperty(navigator, 'userAgent', { get: () => ua });
  //   }, process.env.USER_AGENT);
  // }
}

// Small random scroll session
async function randomScrollSession(page, {
  totalSteps = 6 + Math.floor(Math.random() * 6),
  maxDelta = 350,
  pauseMin = 150,
  pauseMax = 500
} = {}) {
  for (let i = 0; i < totalSteps; i += 1) {
    const delta = (Math.random() > 0.5 ? 1 : -1) * (50 + Math.floor(Math.random() * maxDelta));
    await page.evaluate((d) => window.scrollBy(0, d), delta);
    const pause = pauseMin + Math.floor(Math.random() * (pauseMax - pauseMin));
    await page.waitForTimeout(pause);
  }
}

export async function humanizePage(page) {
  // Random small movements and idle waits to look human-ish
  const wiggles = 4 + Math.floor(Math.random() * 4);
  for (let i = 0; i < wiggles; i += 1) {
    const x = 100 + Math.floor(Math.random() * 800);
    const y = 120 + Math.floor(Math.random() * 600);
    await page.mouse.move(x, y, { steps: 6 + Math.floor(Math.random() * 8) });
    await page.waitForTimeout(120 + Math.floor(Math.random() * 320));
    if (Math.random() < 0.6) {
      await randomScrollSession(page);
    }
  }
}

// Wait roughly one minute with human-like micro-activity between profiles
export async function waitApproximatelyOneMinute(page, {
  minMs = 60000, // 60s
  maxMs = 80000  // up to ~80s
} = {}) {
  const target = minMs + Math.floor(Math.random() * (maxMs - minMs));
  const start = Date.now();
  while (Date.now() - start < target) {
    // occasional micro scroll or mouse move
    if (Math.random() < 0.4) {
      await randomScrollSession(page, { totalSteps: 2 + Math.floor(Math.random() * 3), maxDelta: 180, pauseMin: 100, pauseMax: 260 });
    } else {
      const x = 50 + Math.floor(Math.random() * 900);
      const y = 80 + Math.floor(Math.random() * 700);
      await page.mouse.move(x, y, { steps: 3 + Math.floor(Math.random() * 5) });
      await page.waitForTimeout(180 + Math.floor(Math.random() * 400));
    }
    // a slightly longer pause occasionally
    if (Math.random() < 0.2) {
      await page.waitForTimeout(800 + Math.floor(Math.random() * 1200));
    }
  }
}
