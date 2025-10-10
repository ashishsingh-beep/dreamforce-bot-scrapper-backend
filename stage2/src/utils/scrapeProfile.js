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

async function getTextByXPath(page, xpath) {
  const el = page.locator(`xpath=${xpath}`);
  try {
    await el.first().waitFor({ state: 'visible', timeout: 8000 });
    const txt = await el.first().innerText();
    return (txt || '').trim();
  } catch {
    return null;
  }
}

async function getAllTextsByXPath(page, xpath) {
  try {
    const els = page.locator(`xpath=${xpath}`);
    const count = await els.count();
    const texts = [];
    for (let i = 0; i < count; i += 1) {
      const t = (await els.nth(i).innerText()).trim();
      if (t) texts.push(t);
    }
    return texts;
  } catch {
    return [];
  }
}

// Extract the LinkedIn "in" handle from a profile URL, else return a random 12-char ID
function extractLeadIdFromUrl(url) {
  try {
    if (url.includes('/in/')) {
      const u = new URL(url);
      const parts = u.pathname.split('/').filter(Boolean);
      const idx = parts.indexOf('in');
      if (idx !== -1) {
        let leadId = parts[idx + 1] || '';
        if (leadId.includes('?')) {
          leadId = leadId.split('?')[0];
        }
        if (leadId) return leadId;
      }
    }
  } catch (_) {
    // ignore and fallback to random
  }
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 12 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
}

export async function scrapeProfile(page, url) {
  const details = {
    lead_id: null,
    name: null,
    title: null,
    location: null,
    profile_url: url,
    bio: null,
    skills: [],
    experience: null,
    company_name: null,
    company_page_url: null,
  };

  // Set lead_id to only the user-id portion of the URL
  details.lead_id = extractLeadIdFromUrl(url);

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  // Allow lazy content to load
  await page.waitForTimeout(1500 + Math.floor(Math.random() * 1000));

  // Gentle scroll to trigger dynamic loads
  for (let y = 0; y <= 1000; y += 250) {
    await page.mouse.wheel(0, 250);
    await page.waitForTimeout(200 + Math.floor(Math.random() * 200));
  }

  details.name = await getTextByXPath(page, XPATHS.name);
  details.bio = await getTextByXPath(page, XPATHS.bio);
  details.skills = await getAllTextsByXPath(page, XPATHS.skills);
  details.experience = await getTextByXPath(page, XPATHS.exp);
  details.title = await getTextByXPath(page, XPATHS.title);
  details.company_name = await getTextByXPath(page, XPATHS.company_name);
  details.location = await getTextByXPath(page, XPATHS.location);

  try {
    const companyLink = page.locator(`xpath=${XPATHS.company_lkd}`).first();
    if (await companyLink.count()) {
      details.company_page_url = await companyLink.getAttribute('href');
    }
  } catch {}

  const hasAny = details.name || details.title || details.location || details.bio || (details.skills && details.skills.length) || details.experience || details.company_name || details.company_page_url;
  return hasAny ? details : null;
}
