import fs from 'fs';
import path from 'path';

export function saveJson(data, filePath = null, prefix = 'leads') {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const out = filePath || path.join(process.cwd(), `${prefix}-${ts}.json`);
  fs.writeFileSync(out, JSON.stringify(data, null, 2), 'utf-8');
  return out;
}
