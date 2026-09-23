/**
 * Standalone DB backup script.
 * Usage: node scripts/backup.js
 * Creates a timestamped snapshot of data/crown.db in data/backups/ and
 * prunes files older than 7 days.
 */

import Database from 'better-sqlite3';
import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const dbPath = resolve(root, 'data/crown.db');
const backupDir = resolve(root, 'data/backups');

await mkdir(backupDir, { recursive: true });

const now = new Date();
const dateStr = now.toISOString().slice(0, 10);
const timeStr = now.toTimeString().slice(0, 8).replace(/:/g, '-');
const filename = `crown-${dateStr}_${timeStr}.db`;
const dest = resolve(backupDir, filename);

try {
  const db = new Database(dbPath);
  await db.backup(dest);
  db.close();
} catch (err) {
  console.warn(`[backup] db.backup fallback to copyFile: ${err.message}`);
  await copyFile(dbPath, dest);
}

// Update crown-latest.db alias
const latestDest = resolve(backupDir, 'crown-latest.db');
try {
  await copyFile(dest, latestDest);
} catch {}

const fileStat = await stat(dest);
console.log(`[backup] Saved: ${dest} (${(fileStat.size / 1024).toFixed(1)} KB)`);

// Prune backups older than 7 days (preserving crown-latest.db)
const files = await readdir(backupDir);
for (const f of files) {
  if (!f.startsWith('crown-') || !f.endsWith('.db') || f === 'crown-latest.db') continue;
  const fp = resolve(backupDir, f);
  const s = await stat(fp).catch(() => null);
  if (s && Date.now() - s.mtimeMs > 7 * 86400 * 1000) {
    await rm(fp).catch(() => {});
    console.log(`[backup] Pruned older backup: ${f}`);
  }
}

console.log('[backup] Backup completed successfully.');
