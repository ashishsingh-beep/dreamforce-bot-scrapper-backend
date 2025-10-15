import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// stage2/src/utils -> stage2/logs
const logsDir = path.join(__dirname, '..', 'logs');
const logFile = path.join(logsDir, 'stage2.log');

function ensureDir() {
  try {
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
  } catch {}
}

function nowIST() {
  try {
    return new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
  } catch {
    return new Date().toISOString();
  }
}

export function logStage2Lead({ lead_id, name }) {
  try {
    ensureDir();
    const payload = {
      lead_id: lead_id || null,
      name: name || null,
      time_ist: nowIST(),
      iso: new Date().toISOString()
    };
    fs.appendFileSync(logFile, JSON.stringify(payload) + '\n');
  } catch {}
}
