export async function loginLinkedIn(page, email, password) {
  if (!email || !password) throw new Error('Missing email or password arguments');

  // Always go to login page and attempt login
  await page.goto('https://www.linkedin.com/login', { waitUntil: 'load' });

  // Human-like small jitter
  const typeLikeHuman = async (locator, text) => {
    for (const ch of text) {
      await locator.type(ch, { delay: 50 + Math.floor(Math.random() * 75) });
    }
  };

  const emailInput = page.locator('input#username');
  const passwordInput = page.locator('input#password');
  const signInButton = page.locator('button[type="submit"]');

  // If already authenticated, login page may redirect; if inputs are present, fill and submit
  if (await emailInput.count()) {
    await emailInput.waitFor({ state: 'visible', timeout: 15000 });
    await typeLikeHuman(emailInput, email);
    await page.waitForTimeout(300 + Math.floor(Math.random() * 400));
    await typeLikeHuman(passwordInput, password);
    await page.waitForTimeout(500 + Math.floor(Math.random() * 500));
    await signInButton.click({ delay: 100 + Math.floor(Math.random() * 200) });
  }

  // Wait until redirected to feed
  await page.waitForURL((url) => url.href.includes('feed'), { timeout: 45000 });
}
