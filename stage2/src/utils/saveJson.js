import fs from 'fs';
import path from 'path';

export function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

export function saveLeadsJson(leads, outPath) {
  const target = outPath || defaultOutputPath();
  ensureDir(path.dirname(target));
  const payload = JSON.stringify({ count: leads.length, leads }, null, 2);
  fs.writeFileSync(target, payload, 'utf-8');
  return target;
}

export function defaultOutputPath() {
  const base = process.env.OUTPUT_JSON || path.join(process.cwd(), 'data', `leads-${ts()}.json`);
  return path.isAbsolute(base) ? base : path.resolve(base);
}

function ts() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}
