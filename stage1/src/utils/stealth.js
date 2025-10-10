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