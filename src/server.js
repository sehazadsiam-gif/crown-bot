import 'dotenv/config';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fstatic from '@fastify/static';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  getConfig, saveConfig, alreadySeen, upsertConversation, listConversations,
  getConversation, getMessages, addMessage, setBotEnabled, setFlag,
  listDrafts, stats, db
} from './db.js';
import { buildPrompt, openState, escalationHit } from './prompt.js';
import { generateReply, parseMenuText } from './ai.js';
import { verifySignature, isSelf, sendMessage, fetchProfileName, parseWebhook, testMetaConnection } from './meta.js';
import { sendTikTokMessage, parseTikTokWebhook, testTikTokConnection, verifyTikTokSignature } from './tiktok.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = (process.env.BASE_PATH || '/chatbotadmin').replace(/\/$/, '');
const {
  PORT = 3000, HOST = '0.0.0.0',
  SESSION_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_PASSWORD_HASH
} = process.env;

if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
  console.error('SESSION_SECRET missing or too short. Run: openssl rand -hex 32');
  process.exit(1);
}

const activePassword = ADMIN_PASSWORD || ADMIN_PASSWORD_HASH;
if (!ADMIN_EMAIL || !activePassword) {
  console.error('ADMIN_EMAIL and ADMIN_PASSWORD (or ADMIN_PASSWORD_HASH) are both required.');
  process.exit(1);
}

async function verifyPassword(inputPassword, plainPassword, hashedPassword) {
  const input = String(inputPassword || '');
  if (plainPassword && input === plainPassword) return true;
  if (hashedPassword) {
    if (hashedPassword.startsWith('$2')) {
      try {
        return await bcrypt.compare(input, hashedPassword);
      } catch {
        return false;
      }
    }
    return input === hashedPassword;
  }
  return false;
}

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL || 'info' },
  trustProxy: true,
  bodyLimit: 2_000_000
});

await app.register(cookie, { secret: SESSION_SECRET });
await app.register(fstatic, { root: join(__dirname, '..', 'public'), prefix: `${BASE}/` });

/* Capture raw body for webhook HMAC signature verification */
app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
  req.rawBody = body;
  try { done(null, JSON.parse(body.toString('utf8') || '{}')); }
  catch (e) { e.statusCode = 400; done(e); }
});

/* ───────────────────────── auth ───────────────────────── */
const SESSION_TTL = 7 * 864e5;

function makeToken() {
  const payload = JSON.stringify({ u: ADMIN_EMAIL, exp: Date.now() + SESSION_TTL });
  const b = Buffer.from(payload).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(b).digest('base64url');
  return `${b}.${sig}`;
}

function readToken(tok) {
  if (!tok || !tok.includes('.')) return null;
  const [b, sig] = tok.split('.');
  const good = crypto.createHmac('sha256', SESSION_SECRET).update(b).digest('base64url');
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  try {
    const p = JSON.parse(Buffer.from(b, 'base64url').toString());
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
}

const requireAuth = async (req, reply) => {
  if (!readToken(req.cookies.cc_session)) return reply.code(401).send({ error: 'unauthorized' });
};

/* In-memory login throttle */
const attempts = new Map();
function throttled(ip) {
  const a = attempts.get(ip);
  if (!a) return false;
  if (Date.now() - a.at > 15 * 60_000) { attempts.delete(ip); return false; }
  return a.n >= 8;
}
function noteFail(ip) {
  const a = attempts.get(ip) || { n: 0, at: Date.now() };
  a.n++; a.at = Date.now(); attempts.set(ip, a);
}

app.post(`${BASE}/api/login`, async (req, reply) => {
  const ip = req.ip;
  if (throttled(ip)) return reply.code(429).send({ error: 'Too many attempts. Wait 15 minutes.' });

  const { email, password } = req.body || {};
  const supplied = typeof email === 'string' ? email.trim().toLowerCase() : '';
  const expected = ADMIN_EMAIL.trim().toLowerCase();
  const passwordOk = await verifyPassword(password, ADMIN_PASSWORD, ADMIN_PASSWORD_HASH);
  const ok = supplied !== '' && supplied === expected && passwordOk;

  if (!ok) { noteFail(ip); return reply.code(401).send({ error: 'Wrong email or password.' }); }

  attempts.delete(ip);
  reply.setCookie('cc_session', makeToken(), {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: false,
    maxAge: SESSION_TTL / 1000
  });
  return { ok: true };
});

app.post(`${BASE}/api/logout`, async (req, reply) => {
  reply.clearCookie('cc_session', { path: '/' });
  return { ok: true };
});


app.get(`${BASE}/api/me`, async req => ({ authed: !!readToken(req.cookies.cc_session) }));

/* ───────────────────────── admin API ───────────────────────── */
app.get(`${BASE}/api/config`, { preHandler: requireAuth }, async () => {
  const cfg = getConfig();
  return { config: cfg, prompt: buildPrompt(cfg), open: openState(cfg), stats: stats() };
});

app.put(`${BASE}/api/config`, { preHandler: requireAuth }, async (req, reply) => {
  const cfg = req.body?.config;
  if (!cfg || typeof cfg !== 'object') return reply.code(400).send({ error: 'bad config' });
  saveConfig(cfg);
  return { ok: true, prompt: buildPrompt(cfg), open: openState(cfg), stats: stats() };
});

app.post(`${BASE}/api/channels/test`, { preHandler: requireAuth }, async (req, reply) => {
  const { platform, config } = req.body || {};
  if (!platform) return reply.code(400).send({ error: 'Platform is required.' });

  try {
    if (platform === 'tiktok') {
      return await testTikTokConnection(config);
    } else if (['facebook', 'instagram', 'whatsapp'].includes(platform)) {
      return await testMetaConnection(platform, config);
    }
    return reply.code(400).send({ ok: false, error: `Unsupported platform: ${platform}` });
  } catch (e) {
    req.log.error(e);
    return reply.code(500).send({ ok: false, error: e.message });
  }
});

app.post(`${BASE}/api/import-menu`, { preHandler: requireAuth }, async (req, reply) => {
  try {
    const rows = await parseMenuText(String(req.body?.text || '').slice(0, 20000));
    return { ok: true, rows };
  } catch (e) {
    req.log.warn(e);
    return reply.code(502).send({ error: 'Could not parse that menu. Try a simpler paste.' });
  }
});

app.post(`${BASE}/api/test`, { preHandler: requireAuth }, async req => {
  const cfg = getConfig();
  const history = (req.body?.history || []).slice(-12);
  const text = String(req.body?.text || '');
  const hit = escalationHit(cfg, text);
  const { text: reply, model } = await generateReply(cfg, history, text, req.log);
  return { reply, model, escalated: hit };
});

app.get(`${BASE}/api/conversations`, { preHandler: requireAuth }, async () =>
  ({ conversations: listConversations(), drafts: listDrafts() }));

app.get(`${BASE}/api/conversations/:id`, { preHandler: requireAuth }, async req =>
  ({ conversation: getConversation(req.params.id), messages: getMessages(req.params.id) }));

app.post(`${BASE}/api/conversations/:id/bot`, { preHandler: requireAuth }, async req => {
  setBotEnabled(req.params.id, !!req.body?.enabled);
  return { ok: true };
});

app.post(`${BASE}/api/conversations/:id/flag`, { preHandler: requireAuth }, async req => {
  setFlag(req.params.id, !!req.body?.flagged, req.body?.reason || null);
  return { ok: true };
});

app.post(`${BASE}/api/conversations/:id/reply`, { preHandler: requireAuth }, async (req, reply) => {
  const conv = getConversation(req.params.id);
  if (!conv) return reply.code(404).send({ error: 'not found' });
  const text = String(req.body?.text || '').trim();
  if (!text) return reply.code(400).send({ error: 'empty' });
  try {
    if (conv.platform === 'tiktok') {
      await sendTikTokMessage(conv.psid, text);
    } else {
      await sendMessage(conv.platform, conv.psid, text);
    }
    addMessage(conv.id, 'out', text, 'human');
    setFlag(conv.id, false);
    return { ok: true };
  } catch (e) {
    req.log.error(e);
    return reply.code(502).send({ error: e.message });
  }
});

app.get(`${BASE}/api/health`, async () => {
  const cfg = getConfig();
  const publicUrl = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
  return {
    ok: true,
    open: openState(cfg),
    providers: { gemini: !!process.env.GEMINI_API_KEY, groq: !!process.env.GROQ_API_KEY },
    channels: {
      facebook: {
        enabled: cfg.channels?.facebook?.enabled ?? true,
        configured: !!(cfg.channels?.facebook?.pageToken || process.env.FB_PAGE_TOKEN),
        webhookUrl: `${publicUrl}/webhook/meta`
      },
      instagram: {
        enabled: cfg.channels?.instagram?.enabled ?? false,
        configured: !!(cfg.channels?.instagram?.token || process.env.IG_TOKEN),
        webhookUrl: `${publicUrl}/webhook/meta`
      },
      whatsapp: {
        enabled: cfg.channels?.whatsapp?.enabled ?? false,
        configured: !!((cfg.channels?.whatsapp?.token || process.env.WA_TOKEN || process.env.FB_PAGE_TOKEN) && (cfg.channels?.whatsapp?.phoneNumberId || process.env.WA_PHONE_NUMBER_ID)),
        webhookUrl: `${publicUrl}/webhook/meta`
      },
      tiktok: {
        enabled: cfg.channels?.tiktok?.enabled ?? false,
        configured: !!(cfg.channels?.tiktok?.token || process.env.TIKTOK_ACCESS_TOKEN),
        webhookUrl: `${publicUrl}/webhook/tiktok`
      }
    },
    stats: stats()
  };
});

/* ───────────────────────── Meta Webhook (Facebook / Instagram / WhatsApp) ───────────────────────── */
const handleMetaVerification = (req, reply) => {
  const q = req.query;
  const cfg = getConfig();
  const allowedTokens = [
    process.env.META_VERIFY_TOKEN,
    process.env.WA_VERIFY_TOKEN,
    cfg.channels?.facebook?.verifyToken,
    cfg.channels?.whatsapp?.verifyToken,
    'botcrowncoffee'
  ].filter(Boolean);

  if (q['hub.mode'] === 'subscribe' && allowedTokens.includes(q['hub.verify_token'])) {
    return reply.code(200).type('text/plain').send(q['hub.challenge']);
  }
  return reply.code(403).send('forbidden');
};

app.get('/webhook/meta', handleMetaVerification);
app.get('/webhook/whatsapp', handleMetaVerification);

app.post('/webhook/meta', async (req, reply) => {
  if (!verifySignature(req.rawBody, req.headers['x-hub-signature-256'])) {
    req.log.warn('bad meta webhook signature');
    return reply.code(401).send('bad signature');
  }

  // Fast acknowledge
  reply.code(200).send('EVENT_RECEIVED');

  const events = parseWebhook(req.body);
  for (const ev of events) enqueue(ev, req.log);
});

app.post('/webhook/whatsapp', async (req, reply) => {
  reply.code(200).send('EVENT_RECEIVED');
  const events = parseWebhook(req.body);
  for (const ev of events) enqueue(ev, req.log);
});

/* ───────────────────────── TikTok Webhook ───────────────────────── */
app.get('/webhook/tiktok', async (req, reply) => {
  const q = req.query;
  if (q['challenge']) return reply.code(200).type('text/plain').send(q['challenge']);
  if (q['hub.challenge']) return reply.code(200).type('text/plain').send(q['hub.challenge']);
  return reply.code(200).send('OK');
});

app.post('/webhook/tiktok', async (req, reply) => {
  if (!verifyTikTokSignature(req.rawBody, req.headers['x-tiktok-signature'], req.headers['x-tiktok-timestamp'])) {
    req.log.warn('bad tiktok webhook signature');
  }
  reply.code(200).send({ status: 'ok' });
  const events = parseTikTokWebhook(req.body);
  for (const ev of events) enqueue(ev, req.log);
});

/* ───────────────────────── Queue & Message Pipeline ───────────────────────── */
const chains = new Map();
function enqueue(ev, log) {
  const key = `${ev.platform}:${ev.senderId}`;
  const prev = chains.get(key) || Promise.resolve();
  const next = prev
    .then(() => handleEvent(ev, log))
    .catch(e => log.error(e))
    .finally(() => { if (chains.get(key) === next) chains.delete(key); });
  chains.set(key, next);
}

async function handleEvent(ev, log) {
  const { platform, senderId, mid, text, contactName } = ev;
  if (!senderId || isSelf(platform, senderId)) return;
  if (alreadySeen(mid)) return;

  const cfg = getConfig();
  const ch = cfg.channels?.[platform];
  if (ch && ch.enabled === false) return log.info(`Channel ${platform} is disabled in config.`);

  const name = contactName || await fetchProfileName(platform, senderId, ev);
  const conv = upsertConversation(platform, senderId, name);
  addMessage(conv.id, 'in', text, null, mid);

  if (!cfg.runtime?.enabled) return log.info('bot globally disabled');
  if (!conv.bot_enabled) return log.info(`bot off for conversation ${conv.id}`);

  const hit = escalationHit(cfg, text);
  if (hit) {
    setFlag(conv.id, true, `keyword: ${hit}`);
    if (cfg.scope.complaint !== 'ack') return; // silent flag
  }

  const st = openState(cfg);
  if (!st.open && cfg.runtime?.offHours === 'silent') {
    return log.info('closed, off-hours set to silent');
  }

  const history = getMessages(conv.id, 12).slice(0, -1);
  const { text: replyText, model } = await generateReply(cfg, history, text, log);

  try {
    if (platform === 'tiktok') {
      await sendTikTokMessage(senderId, replyText);
    } else {
      await sendMessage(platform, senderId, replyText);
    }
    addMessage(conv.id, 'out', replyText, model);
    if (hit) setFlag(conv.id, true, `keyword: ${hit} (acknowledged, needs you)`);
  } catch (e) {
    log.error(`send failed (${platform}): ${e.message}`);
    setFlag(conv.id, true, 'send failed');
  }
}

/* ───────────────────────── pages ───────────────────────── */
app.get('/', (req, reply) => reply.redirect(`${BASE}/`));
app.get(BASE, (req, reply) => reply.redirect(`${BASE}/`));
app.setNotFoundHandler((req, reply) => {
  if (req.url.startsWith(BASE)) return reply.sendFile?.('index.html')
    ?? reply.code(404).send('not found');
  reply.code(404).send('not found');
});

app.listen({ port: +PORT, host: HOST })
  .then(() => app.log.info(`admin  → ${process.env.PUBLIC_URL || ''}${BASE}/`))
  .catch(e => { app.log.error(e); process.exit(1); });

process.on('SIGTERM', () => { db.close(); app.close(() => process.exit(0)); });
