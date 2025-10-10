import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { chromium, devices } from 'playwright';
import { setupStealthContext } from '../utils/stealth.js';
import { loginLinkedIn } from '../utils/login.js';

// Ensure env loads regardless of CWD
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.join(__dirname, '..', '..', '.env');
dotenv.config({ path: envPath });
if (!process.env.LINKEDIN_EMAIL || !process.env.LINKEDIN_PASSWORD) {
  console.error(`Missing LINKEDIN_EMAIL or LINKEDIN_PASSWORD in ${envPath}`);
  process.exit(1);
}

const XPATHS = {
  name: "//h1[contains(@class, 't-24')]",
  bio: '//*[@id="profile-content"]/div/div[2]/div/div/main/section[1]/div[2]/div[2]/div[1]/div[2]',
  skills: "//section[descendant::div[@id='skills']]/div[3]/ul/li//a[contains(@href, 'SKILL')]",
  exp: "(//section[.//*[@id='experience']]//ul[1]/li)[1]",
  about: "//section[descendant::div[@id='about']]/div[3]",
  company_lkd: "//section[.//*[@id='experience']]//ul[1]//a[@data-field='experience_company_logo']",
  title: "(((//section[.//div[@id='experience']]//li)[1]//a)[2]/div)[1]",
  company_name: "(//section[.//*[@id='experience']]//ul[1]//a[@data-field='experience_company_logo'])[2]/span[1]/span[@aria-hidden='true']",
  location: "//div[*/a[contains(@href,'contact-info')]]/span[1]",
};

async function run() {
  const browser = await chromium.launch({ headless: false, slowMo: 50 });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    userAgent: devices['Desktop Chrome'].userAgent,
  });
  await setupStealthContext(context);
  const page = await context.newPage();

  await loginLinkedIn(page, process.env.LINKEDIN_EMAIL, process.env.LINKEDIN_PASSWORD);

  const profile = process.argv[2];
  if (!profile) throw new Error('Pass profile URL as arg');
  await page.goto(profile);

  for (const [key, xp] of Object.entries(XPATHS)) {
    try {
      const el = page.locator(`xpath=${xp}`).first();
      await el.waitFor({ state: 'visible', timeout: 5000 });
      const text = await el.innerText();
      console.log(key, '=>', text.slice(0, 120).replace(/\s+/g, ' '));
    } catch (e) {
      console.log(key, '=> not found');
    }
  }

  await context.close();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
