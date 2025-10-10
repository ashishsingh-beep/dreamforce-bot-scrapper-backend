import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import runLinkedInScraper from './lib/scraper.js';

// Resolve project root (one level up from src)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

// Explicit dotenv load so running from any CWD works
const envPath = path.join(projectRoot, '.env');
dotenv.config({ path: envPath });

// Validate required environment variables early with a clear message
const REQUIRED_VARS = ['LINKEDIN_EMAIL', 'LINKEDIN_PASSWORD', 'SUPABASE_URL', 'SUPABASE_ANON_KEY'];
const missing = REQUIRED_VARS.filter(v => !process.env[v] || String(process.env[v]).trim() === '');
if (missing.length) {
  console.error(`Missing required environment variables in ${envPath}: ${missing.join(', ')}`);
  process.exit(1);
}

if (process.env.USER_DATA_DIR) {
  console.warn('[stage2] USER_DATA_DIR is defined but persistent sessions are disabled. Each run uses a fresh ephemeral context.');
}

function readUrlsArgOrDefault() {
  const argPath = process.argv[2];
  const filePath = argPath
    ? path.resolve(process.cwd(), argPath)
    : path.join(__dirname, 'urls.sample.json');
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const urls = JSON.parse(raw);
    if (!Array.isArray(urls)) throw new Error('URLs file must contain an array');
    return urls;
  } catch (e) {
    console.error('Failed to read URLs file', e.message);
    process.exit(1);
  }
}

async function cli() {
  const urls = readUrlsArgOrDefault();
  const email = process.env.LINKEDIN_EMAIL;
  const password = process.env.LINKEDIN_PASSWORD;
  try {
    const { successes, failures, jsonPath } = await runLinkedInScraper({
      email,
      password,
      urls,
      headless: String(process.env.HEADLESS || 'true') === 'true'
    });
    console.log(`Done. Successes=${successes.length} Failures=${failures.length} JSON=${jsonPath || 'n/a'}`);
  } catch (e) {
    console.error('Fatal:', e.message);
    process.exit(1);
  }
}

// if (import.meta.url === `file://${process.argv[1]}`) {
//   cli();
// }

cli();

