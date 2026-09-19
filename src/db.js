import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const FILE = resolve(process.cwd(), 'data/crown.db');
mkdirSync(dirname(FILE), { recursive: true });

export const db = new Database(FILE);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS config (
  id       INTEGER PRIMARY KEY CHECK (id = 1),
  json     TEXT NOT NULL,
  updated  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  platform     TEXT NOT NULL,               -- 'facebook' | 'instagram'
  psid         TEXT NOT NULL,               -- page-scoped user id
  name         TEXT,
  bot_enabled  INTEGER NOT NULL DEFAULT 1,
  flagged      INTEGER NOT NULL DEFAULT 0,
  flag_reason  TEXT,
  last_msg_at  TEXT,
  created_at   TEXT NOT NULL,
  UNIQUE(platform, psid)
);

CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id     INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  direction   TEXT NOT NULL,                -- 'in' | 'out'
  text        TEXT NOT NULL,
  model       TEXT,
  mid         TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conv_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_mid ON messages(mid) WHERE mid IS NOT NULL;

CREATE TABLE IF NOT EXISTS drafts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id     INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,                -- 'order' | 'reservation'
  details     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS seen (
  mid   TEXT PRIMARY KEY,
  at    INTEGER NOT NULL
);
`);

const now = () => new Date().toISOString();

/* ───────── config ───────── */
export const DEFAULT_CONFIG = {
  cafe: {
    name: 'Crown Coffee',
    phone: '01806-576024',
    area: 'Sector 13, Uttara, Dhaka',
    address: '6 Shah Makhdum Avenue, Assure Ayan Tower, Sector 13, Uttara, Dhaka',
    open: '11:00', close: '23:00', offDay: '', holidayNote: '',
    wifi: '', parking: '', seating: '', payments: '', service: '', apps: '', notes: ''
  },
  menu: [
    { id: 'c1', name: 'Hot Coffee', items: [] },
    { id: 'c2', name: 'Cold Coffee', items: [] },
    { id: 'c3', name: 'Tea & Other Drinks', items: [] },
    { id: 'c4', name: 'Food', items: [] },
    { id: 'c5', name: 'Desserts', items: [] }
  ],
  faqs: [],
  persona: {
    tone: 'Polite and professional, warm but not chatty',
    length: 'Short — 1 to 3 sentences',
    language: 'Reply in the exact same language and script the customer used. If they write Bangla, reply in Bangla. If they write Banglish (Bangla words in English letters), reply in Banglish the same way — do not convert it to Bangla script. If they write English, reply in English. Never mix scripts in one reply and never correct how the customer writes.',
    greeting: 'Assalamu Alaikum! Welcome to Crown Coffee.',
    emoji: false,
    disclose: false
  },
  scope: { answer: true, reserve: 'draft', order: 'draft', complaint: 'ack' },
  guards: [
    'Never state a price that is not in the menu below. If an item is not listed, say you will check and a team member will confirm.',
    'Never invent menu items, ingredients, or nutritional information.',
    'Never confirm an order or reservation as final — only say it has been requested.',
    'Never promise a delivery time or a discount.',
    'Never give medical or allergy advice. Pass allergy questions to a human.',
    'If you do not know something, say so plainly and offer to have a team member follow up.'
  ],
  esc: ['refund', 'complaint', 'manager', 'allergy', 'allergic', 'sick', 'lawyer', 'press',
        'ফেরত', 'অভিযোগ', 'ম্যানেজার'],
  runtime: { enabled: true, offHours: 'reply', fallbackText: 'Thanks for your message! Our team will reply shortly.' }
};

export function getConfig() {
  const row = db.prepare('SELECT json FROM config WHERE id = 1').get();
  if (!row) {
    saveConfig(DEFAULT_CONFIG);
    return structuredClone(DEFAULT_CONFIG);
  }
  try { return { ...structuredClone(DEFAULT_CONFIG), ...JSON.parse(row.json) }; }
  catch { return structuredClone(DEFAULT_CONFIG); }
}

export function saveConfig(cfg) {
  db.prepare(`INSERT INTO config (id, json, updated) VALUES (1, ?, ?)
              ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated = excluded.updated`)
    .run(JSON.stringify(cfg), now());
}

/* ───────── dedupe ───────── */
export function alreadySeen(mid) {
  if (!mid) return false;
  const hit = db.prepare('SELECT 1 FROM seen WHERE mid = ?').get(mid);
  if (hit) return true;
  db.prepare('INSERT INTO seen (mid, at) VALUES (?, ?)').run(mid, Date.now());
  db.prepare('DELETE FROM seen WHERE at < ?').run(Date.now() - 7 * 864e5);
  return false;
}

/* ───────── conversations ───────── */
export function upsertConversation(platform, psid, name) {
  db.prepare(`INSERT INTO conversations (platform, psid, name, last_msg_at, created_at)
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(platform, psid) DO UPDATE SET
                last_msg_at = excluded.last_msg_at,
                name = COALESCE(excluded.name, conversations.name)`)
    .run(platform, psid, name || null, now(), now());
  return db.prepare('SELECT * FROM conversations WHERE platform = ? AND psid = ?').get(platform, psid);
}

export const listConversations = () => db.prepare(`
  SELECT c.*, (SELECT text FROM messages m WHERE m.conv_id = c.id ORDER BY m.id DESC LIMIT 1) AS preview
  FROM conversations c ORDER BY c.flagged DESC, c.last_msg_at DESC LIMIT 200`).all();

export const getConversation = id =>
  db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);

export const getMessages = (convId, limit = 60) =>
  db.prepare('SELECT * FROM messages WHERE conv_id = ? ORDER BY id DESC LIMIT ?')
    .all(convId, limit).reverse();

export function addMessage(convId, direction, text, model = null, mid = null) {
  db.prepare('INSERT OR IGNORE INTO messages (conv_id, direction, text, model, mid, created_at) VALUES (?,?,?,?,?,?)')
    .run(convId, direction, text, model, mid, now());
  db.prepare('UPDATE conversations SET last_msg_at = ? WHERE id = ?').run(now(), convId);
}

export const setBotEnabled = (id, on) =>
  db.prepare('UPDATE conversations SET bot_enabled = ? WHERE id = ?').run(on ? 1 : 0, id);

export const setFlag = (id, on, reason = null) =>
  db.prepare('UPDATE conversations SET flagged = ?, flag_reason = ? WHERE id = ?').run(on ? 1 : 0, reason, id);

export const addDraft = (convId, kind, details) =>
  db.prepare('INSERT INTO drafts (conv_id, kind, details, created_at) VALUES (?,?,?,?)')
    .run(convId, kind, details, now());

export const listDrafts = () => db.prepare(`
  SELECT d.*, c.name, c.platform FROM drafts d JOIN conversations c ON c.id = d.conv_id
  WHERE d.status = 'pending' ORDER BY d.id DESC`).all();

export function stats() {
  const q = s => db.prepare(s).get().n;
  return {
    conversations: q('SELECT COUNT(*) n FROM conversations'),
    messagesIn:    q("SELECT COUNT(*) n FROM messages WHERE direction = 'in'"),
    messagesOut:   q("SELECT COUNT(*) n FROM messages WHERE direction = 'out'"),
    flagged:       q('SELECT COUNT(*) n FROM conversations WHERE flagged = 1'),
    today:         q("SELECT COUNT(*) n FROM messages WHERE date(created_at, '+6 hours') = date('now', '+6 hours')")
  };
}
