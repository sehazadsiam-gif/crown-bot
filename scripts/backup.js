/**
 * Standalone DB backup script.
 * Usage: node scripts/backup.js
 * Creates a timestamped copy of data/crown.db in data/backups/ and
 * prunes files older than 7 days.
 */

import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const dbPath = resolve(root, 'data/crown.db');
const backupDir = resolve(root, 'data/backups');

await mkdir(backupDir, { recursive: true });

const date = new Date().toISOString().slice(0, 10);
const dest = resolve(backupDir, `crown-${date}.db`);

await copyFile(dbPath, dest);
console.log(`[backup] Saved: ${dest}`);

// Prune backups older than 7 days
const files = await readdir(backupDir);
for (const f of files) {
  if (!f.startsWith('crown-') || !f.endsWith('.db')) continue;
  const fp = resolve(backupDir, f);
  const s = await stat(fp).catch(() => null);
  if (s && Date.now() - s.mtimeMs > 7 * 86400 * 1000) {
    await rm(fp).catch(() => {});
    console.log(`[backup] Pruned: ${f}`);
  }
}

console.log('[backup] Done.');
