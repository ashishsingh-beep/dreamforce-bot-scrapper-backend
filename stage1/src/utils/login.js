// Utility: timestamp for logs
const tstamp = () => new Date().toISOString();

// Credential-based login (legacy/fallback)
export async function loginLinkedIn(page, email, password) {
  console.log(`[stage1:login] ${tstamp()} legacy credential login invoked for ${email}`);
  if (!email || !password) throw new Error('Missing email or password arguments');
  console.log(`[stage1:login] ${tstamp()} navigating to /login`);
  await page.goto('https://www.linkedin.com/login', { waitUntil: 'load' });
  const typeLikeHuman = async (locator, text) => {
    for (const ch of text) {
      await locator.type(ch, { delay: 50 + Math.floor(Math.random() * 75) });
    }
  };
  const emailInput = page.locator('input#username, input[name="session_key"]');
  const passwordInput = page.locator('input#password, input[name="session_password"]');
  const signInButton = page.locator('button[type="submit"], button:has-text("Sign in")');
  const emailCount = await emailInput.count();
  const passCount = await passwordInput.count();
  console.log(`[stage1:login] ${tstamp()} login page loaded url=${page.url()} emailInputs=${emailCount} passInputs=${passCount}`);
  if (emailCount) {
    await emailInput.waitFor({ state: 'visible', timeout: 15000 });
    console.log(`[stage1:login] ${tstamp()} typing email`);
    await typeLikeHuman(emailInput, email);
    await page.waitForTimeout(300 + Math.floor(Math.random() * 400));
    console.log(`[stage1:login] ${tstamp()} typing password`);
    await typeLikeHuman(passwordInput, password);
    await page.waitForTimeout(500 + Math.floor(Math.random() * 500));
    const btnCount = await signInButton.count();
    console.log(`[stage1:login] ${tstamp()} submit button count=${btnCount}`);
    if (btnCount) {
      await signInButton.first().click({ delay: 100 + Math.floor(Math.random() * 200) });
    } else {
      await page.keyboard.press('Enter');
    }
  }
  console.log(`[stage1:login] ${tstamp()} waiting for /feed`);
  await page.waitForURL((url) => url.href.includes('feed'), { timeout: 45000 });
  console.log(`[stage1:login] ${tstamp()} reached /feed`);
}

// Cookie-based login (preferred): inject cookies and validate landing on feed
export async function loginLinkedInWithCookies(context, page, cookiesArray) {
  console.log(`[stage1:login] ${tstamp()} cookie login start, cookies array length=${Array.isArray(cookiesArray) ? cookiesArray.length : 0}`);
  if (!Array.isArray(cookiesArray) || cookiesArray.length === 0) {
    throw new Error('cookiesArray is required for cookie login');
  }
  // Filter to LinkedIn domains only to avoid third-party noise
  const cookies = cookiesArray.filter(c => /linkedin\.com$/i.test(c.domain) || /\.linkedin\.com$/i.test(c.domain) || /www\.linkedin\.com$/i.test(c.domain));
  if (cookies.length === 0) throw new Error('No LinkedIn cookies found');
  // Normalize sameSite values to Playwright accepted strings (None|Lax|Strict)
  const norm = cookies.map(c => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/',
    httpOnly: Boolean(c.httpOnly),
    secure: Boolean(c.secure),
    sameSite: c.sameSite === 'None' || c.sameSite === 'Lax' || c.sameSite === 'Strict' ? c.sameSite : undefined,
    expires: typeof c.expires === 'number' ? c.expires : undefined
  }));
  console.log(`[stage1:login] ${tstamp()} adding ${norm.length} cookies to context`);
  await context.addCookies(norm);
  console.log(`[stage1:login] ${tstamp()} navigating to /feed to validate cookie session`);
  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'load' });
  // If redirected to login, fail
  const url = page.url();
  const hasLoginForm = await page.locator('input#username, input[name="session_key"], input#password, input[name="session_password"]').count();
  console.log(`[stage1:login] ${tstamp()} after cookie nav url=${url} hasLoginInputs=${hasLoginForm}`);
  if (!/linkedin\.com\/feed/i.test(url) || hasLoginForm > 0) {
    throw new Error('Cookie login failed');
  }
}

// Hybrid login: try cookies, if not on feed then fall back to credentials for the same account.
// Returns { success: boolean, refreshedCookies?: array }
export async function loginWithCookiesThenCredentials({ context, page, cookies, email, password }) {
  let attempts = 0;
  // 1) Try cookies first (exactly once)
  if (Array.isArray(cookies) && cookies.length) {
    attempts += 1;
    try {
      console.log(`[stage1:login] ${tstamp()} attempting cookie login`);
      await loginLinkedInWithCookies(context, page, cookies);
      const refreshed = await context.cookies();
      console.log(`[stage1:login] ${tstamp()} cookie login success; refreshedCookies=${refreshed?.length ?? 0}`);
      return { success: true, refreshedCookies: refreshed, attempts, method: 'cookies' };
    } catch (e) {
      console.log(`[stage1:login] ${tstamp()} cookie login failed: ${e?.message}`);
      // fall through to manual
    }
  }

  // 2) Ensure we reach the username/password form.
  console.log(`[stage1:login] ${tstamp()} ensuring credential form`);
  await ensureCredentialForm(page);

  // 3) Manual credential login (exactly once)
  attempts += 1;
  try {
    console.log(`[stage1:login] ${tstamp()} performing manual credential login`);
    await fillCredentialsAndSignIn(page, email, password);
  } catch (e) {
    console.log(`[stage1:login] ${tstamp()} manual login failed: ${e?.message}`);
    return { success: false, attempts, error: e?.message || 'Manual login failed' };
  }
  try {
    const refreshed = await context.cookies();
    console.log(`[stage1:login] ${tstamp()} manual login success; refreshedCookies=${refreshed?.length ?? 0}`);
    return { success: true, refreshedCookies: refreshed, attempts, method: 'manual' };
  } catch {
    console.log(`[stage1:login] ${tstamp()} manual login success; failed to fetch cookies`);
    return { success: true, attempts, method: 'manual' };
  }
}

async function ensureCredentialForm(page) {
  // Force navigation to canonical login and let strict XPath waits handle visibility
  try {
    console.log(`[stage1:login] ${tstamp()} forcing navigation to /login`);
    await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded' });
  } catch (e) {
    console.log(`[stage1:login] ${tstamp()} goto /login error: ${e?.message}`);
  }
  await page.waitForTimeout(400);
}

async function fillCredentialsAndSignIn(page, email, password) {
  console.log(`[stage1:login] ${tstamp()} filling credential form fields with strict XPaths`);
  const typeLikeHuman = async (locator, text) => {
    for (const ch of text) {
      await locator.type(ch, { delay: 45 + Math.floor(Math.random() * 60) });
    }
  };

  // Checkpoint: if the interstitial is shown, click it before proceeding
  try {
    const altLink = page.getByText('Sign in using another account', { exact: true });
    const altCount = await altLink.count();
    console.log(`[stage1:login] ${tstamp()} alt interstitial count=${altCount}`);
    if (altCount) {
      console.log(`[stage1:login] ${tstamp()} clicking 'Sign in using another account'`);
      await altLink.first().click({ timeout: 8000 }).catch(() => {});
      await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(400);
    }
  } catch {}

  const emailInput = page.locator('xpath=//input[@id="username"]');
  const passwordInput = page.locator('xpath=//input[@id="password"]');
  const signInButton = page.locator('xpath=//button[@aria-label="Sign in"]');

  // Waits
  await emailInput.waitFor({ state: 'visible', timeout: 20000 }).catch(() => { throw new Error('Login email field not visible'); });
  await passwordInput.waitFor({ state: 'visible', timeout: 20000 }).catch(() => { throw new Error('Login password field not visible'); });
  await signInButton.waitFor({ state: 'visible', timeout: 20000 }).catch(() => { throw new Error('Login Sign in button not visible'); });

  console.log(`[stage1:login] ${tstamp()} typing email`);
  await emailInput.fill('');
  await typeLikeHuman(emailInput, email);
  await page.waitForTimeout(200 + Math.random() * 200);

  console.log(`[stage1:login] ${tstamp()} typing password`);
  await passwordInput.fill('');
  await typeLikeHuman(passwordInput, password);
  await page.waitForTimeout(250 + Math.random() * 250);

  console.log(`[stage1:login] ${tstamp()} clicking Sign in`);
  await signInButton.click({ delay: 100 });

  console.log(`[stage1:login] ${tstamp()} waiting for /feed after submit`);
  await page.waitForURL(url => /linkedin\.com\/feed/i.test(url.href), { timeout: 45000 });
  console.log(`[stage1:login] ${tstamp()} reached /feed after submit`);
}