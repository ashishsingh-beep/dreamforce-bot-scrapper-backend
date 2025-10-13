// Legacy credential login (fallback only) - Stage2 will use cookies path
export async function loginLinkedIn(page, email, password) {
  if (!email || !password) throw new Error('Missing email or password arguments');
  await page.goto('https://www.linkedin.com/login', { waitUntil: 'load' });
  const typeLikeHuman = async (locator, text) => {
    for (const ch of text) {
      await locator.type(ch, { delay: 50 + Math.floor(Math.random() * 75) });
    }
  };
  const emailInput = page.locator('input#username');
  const passwordInput = page.locator('input#password');
  const signInButton = page.locator('button[type="submit"]');
  if (await emailInput.count()) {
    await emailInput.waitFor({ state: 'visible', timeout: 15000 });
    await typeLikeHuman(emailInput, email);
    await page.waitForTimeout(300 + Math.floor(Math.random() * 400));
    await typeLikeHuman(passwordInput, password);
    await page.waitForTimeout(500 + Math.floor(Math.random() * 500));
    await signInButton.click({ delay: 100 + Math.floor(Math.random() * 200) });
  }
  await page.waitForURL((url) => url.href.includes('feed'), { timeout: 45000 });
}

export async function loginLinkedInWithCookies(context, page, cookiesArray) {
  if (!Array.isArray(cookiesArray) || cookiesArray.length === 0) throw new Error('cookiesArray required');
  const cookies = cookiesArray.filter(c => /linkedin\.com$/i.test(c.domain) || /\.linkedin\.com$/i.test(c.domain) || /www\.linkedin\.com$/i.test(c.domain));
  if (!cookies.length) throw new Error('No LinkedIn cookies present');
  const norm = cookies.map(c => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/',
    httpOnly: !!c.httpOnly,
    secure: !!c.secure,
    sameSite: ['None','Lax','Strict'].includes(c.sameSite) ? c.sameSite : undefined,
    expires: typeof c.expires === 'number' ? c.expires : undefined
  }));
  await context.addCookies(norm);
  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'load' });
  const url = page.url();
  const hasLogin = await page.locator('input#username, input#password').count();
  if (!/linkedin\.com\/feed/i.test(url) || hasLogin > 0) throw new Error('Cookie login failed');
}

export async function loginWithCookiesThenCredentials({ context, page, cookies, email, password }) {
  let attempts = 0;
  if (Array.isArray(cookies) && cookies.length) {
    attempts += 1;
    try {
      await loginLinkedInWithCookies(context, page, cookies);
      const refreshed = await context.cookies();
      return { success: true, refreshedCookies: refreshed, attempts, method: 'cookies' };
    } catch (_) {}
  }
  await ensureCredentialForm(page);
  attempts += 1;
  try { await fillCredentialsAndSignIn(page, email, password); }
  catch (e) { return { success: false, attempts, error: e?.message || 'Manual login failed' }; }
  try { const refreshed = await context.cookies(); return { success: true, refreshedCookies: refreshed, attempts, method: 'manual' }; }
  catch { return { success: true, attempts, method: 'manual' }; }
}

async function ensureCredentialForm(page) {
  const maxTries = 3;
  for (let i=0;i<maxTries;i++) {
    const u = await page.locator('input#username').isVisible().catch(()=>false);
    const p = await page.locator('input#password').isVisible().catch(()=>false);
    if (u && p) return true;
    const alt = page.getByText(/sign in (using|with) another account/i, { exact: false });
    if (await alt.count()) { try { await alt.first().click({ delay: 80 }); } catch {} await page.waitForTimeout(400); }
    try { await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded' }); } catch {}
    await page.waitForTimeout(300);
  }
  return (await page.locator('input#username').count()) > 0 && (await page.locator('input#password').count()) > 0;
}

async function fillCredentialsAndSignIn(page, email, password) {
  const typeLikeHuman = async (locator, text) => {
    for (const ch of text) { await locator.type(ch, { delay: 45 + Math.floor(Math.random() * 60) }); }
  };
  // Checkpoint: interstitial link for switching account
  try {
    const altLink = page.getByText('Sign in using another account', { exact: true });
    if (await altLink.count()) {
      await altLink.first().click({ timeout: 8000 }).catch(() => {});
      await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(400);
    }
  } catch {}
  const emailInput = page.locator('xpath=//input[@id="username"]');
  const passwordInput = page.locator('xpath=//input[@id="password"]');
  const signInButton = page.locator('xpath=//button[@aria-label="Sign in"]');
  await emailInput.waitFor({ state: 'visible', timeout: 20000 }).catch(() => { throw new Error('Login email field not visible'); });
  await passwordInput.waitFor({ state: 'visible', timeout: 20000 }).catch(() => { throw new Error('Login password field not visible'); });
  await signInButton.waitFor({ state: 'visible', timeout: 20000 }).catch(() => { throw new Error('Login Sign in button not visible'); });
  await emailInput.fill('');
  await typeLikeHuman(emailInput, email);
  await page.waitForTimeout(200 + Math.random()*200);
  await passwordInput.fill('');
  await typeLikeHuman(passwordInput, password);
  await page.waitForTimeout(250 + Math.random()*250);
  await signInButton.click({ delay: 100 });
  await page.waitForURL(url => /linkedin\.com\/feed/i.test(url.href), { timeout: 45000 });
}
