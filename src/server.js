import 'dotenv/config';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fstatic from '@fastify/static';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  listWorkspaces, createWorkspace, deleteWorkspace, renameWorkspace,
  getWorkspaceConfig, saveWorkspaceConfig, findAccountByPlatformAndId, listWorkspaceChannels,
  getConfig, saveConfig, alreadySeen, upsertConversation, listConversations,
  getConversation, getMessages, addMessage, setBotEnabled, setFlag,
  listDrafts, stats, db,
  authenticateTenant, authenticateTenantByPasswordOnly, updateTenantCredentials, resetTenantPassword,
  getTenantUser, getSubscription, isSubscriptionActive, updateSubscription,
  listTenantsOverview, createWorkspaceWithTenant,
  createOrder, listOrders, updateOrderStatus, getOrderStats, isPasswordUnique,
  savePushSubscription, removePushSubscription, listPushSubscriptions,
  logWebhookEvent, listWebhookLogs,
  findWorkspaceByDomain, setWorkspaceCustomDomain,
  exportConversationsCSV, exportOrdersCSV
} from './db.js';
import { buildPrompt, openState, escalationHit } from './prompt.js';
import { generateReply, parseMenuText, suggestFaqsForBusiness, detectOrderOrInquiry, detectLanguage } from './ai.js';
import { verifySignature, isSelf, sendMessage, fetchProfileName, parseWebhook, testMetaConnection } from './meta.js';
import { sendTikTokMessage, parseTikTokWebhook, testTikTokConnection, verifyTikTokSignature } from './tiktok.js';
import webpush from 'web-push';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises';

// Configure VAPID for web push
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_EMAIL || 'mailto:admin@ccadmin.online',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

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

// Enforce HTTPS behind reverse proxy (resolves "Not Secure" warning)
app.addHook('onRequest', async (req, reply) => {
  const proto = req.headers['x-forwarded-proto'];
  if (proto && proto === 'http' && req.hostname !== 'localhost' && !req.hostname.startsWith('127.0.0.1')) {
    const host = req.headers.host || req.hostname;
    return reply.redirect(`https://${host}${req.url}`, 301);
  }
});

// Security & PWA headers
app.addHook('onSend', async (req, reply) => {
  reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'SAMEORIGIN');
});

/* Capture raw body for webhook HMAC signature verification */
app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
  req.rawBody = body;
  try {
    const str = body.toString('utf8');
    done(null, str ? JSON.parse(str) : {});
  } catch (err) {
    err.statusCode = 400;
    done(err, undefined);
  }
});

/* ───────────────────────── auth helpers ───────────────────────── */
const SESSION_TTL = 7 * 86400 * 1000;

function makeToken(payload) {
  const exp = Date.now() + SESSION_TTL;
  const data = Buffer.from(JSON.stringify({ ...payload, exp })).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function readToken(tok) {
  if (!tok || typeof tok !== 'string') return null;
  const [data, sig] = tok.split('.');
  if (!data || !sig) return null;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch { return null; }
}

function getToken(req) {
  if (req.cookies && req.cookies.cc_session) return req.cookies.cc_session;
  const authHeader = req.headers?.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  return null;
}

async function requireAuth(req, reply) {
  const s = readToken(getToken(req));
  if (!s) return reply.code(401).send({ error: 'unauthorized' });
  // Enforce subscription expiry for tenant admins (workspace #1 is always exempt)
  if (s.role === 'tenant_admin' && s.workspace_id && s.workspace_id !== 1) {
    if (!isSubscriptionActive(s.workspace_id)) {
      return reply.code(402).send({
        error: 'subscription_expired',
        message: 'Your subscription has expired. Please contact admin@ccadmin.online to renew.'
      });
    }
  }
  req.session = s;
}

async function requireMasterAdmin(req, reply) {
  const s = readToken(getToken(req));
  if (!s || s.role !== 'master_admin') {
    return reply.code(403).send({ error: 'forbidden: requires master admin privileges' });
  }
  req.session = s;
}

function getScopedWorkspaceId(req) {
  if (req.session.role === 'master_admin') {
    const qWs = Number(req.query?.ws);
    return qWs && qWs > 0 ? qWs : 1;
  }
  return req.session.workspace_id || 1;
}

/* ───────────────────────── rate limiting ───────────────────────── */
const attempts = new Map();
const MAX_FAILS = 15;
const LOCKOUT = 5 * 60 * 1000;

// General-purpose per-IP rate limiter: { key -> { count, resetAt } }
const rateBuckets = new Map();
function rateLimit(ip, key, maxCalls, windowMs) {
  const k = `${ip}:${key}`;
  const now2 = Date.now();
  let rec = rateBuckets.get(k);
  if (!rec || now2 > rec.resetAt) {
    rec = { count: 0, resetAt: now2 + windowMs };
    rateBuckets.set(k, rec);
  }
  rec.count++;
  return rec.count <= maxCalls;
}
// Clean up stale buckets every 10 minutes
setInterval(() => {
  const now2 = Date.now();
  for (const [k, r] of rateBuckets) if (now2 > r.resetAt) rateBuckets.delete(k);
}, 10 * 60 * 1000);

function checkRate(ip) {
  const rec = attempts.get(ip);
  if (!rec) return true;
  if (Date.now() - rec.first > LOCKOUT) { attempts.delete(ip); return true; }
  return rec.count < MAX_FAILS;
}

function noteFail(ip) {
  const now = Date.now();
  const rec = attempts.get(ip) || { count: 0, first: now };
  rec.count++;
  attempts.set(ip, rec);
}

app.post(`${BASE}/api/login`, async (req, reply) => {
  const ip = req.ip;
  if (!checkRate(ip)) {
    return reply.code(429).send({ error: 'Too many failed attempts. Try again in 5 minutes.' });
  }

  const { email, password } = req.body || {};
  const supplied = (email || '').trim().toLowerCase();
  const suppliedPass = (password || '').trim();

  if (!suppliedPass) {
    noteFail(ip);
    return reply.code(400).send({ error: 'Password is required.' });
  }

  // 1. Check Master Admin Credentials (Password: ccadmin6789)
  const isMasterPass = (suppliedPass === 'ccadmin6789') || await verifyPassword(suppliedPass, ADMIN_PASSWORD, ADMIN_PASSWORD_HASH);
  const expectedAdmin = (ADMIN_EMAIL || '').trim().toLowerCase();
  const isMasterEmail = !supplied || supplied === expectedAdmin;

  if (isMasterPass && isMasterEmail) {
    attempts.delete(ip);
    const tok = makeToken({ role: 'master_admin', email: ADMIN_EMAIL || 'admin@crowncoffee.com' });
    reply.setCookie('cc_session', tok, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      maxAge: SESSION_TTL / 1000
    });
    return { ok: true, role: 'master_admin', email: ADMIN_EMAIL || 'admin@crowncoffee.com', token: tok };
  }

  // 2. Check Crown Coffee Tenant 1 (Dedicated Password: 1590)
  if (suppliedPass === '1590') {
    attempts.delete(ip);
    const tok = makeToken({
      role: 'tenant_admin',
      workspace_id: 1,
      user_id: 1,
      email: 'tenant@crowncoffee.local',
      must_change_password: 0
    });
    reply.setCookie('cc_session', tok, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      maxAge: SESSION_TTL / 1000
    });
    return {
      ok: true,
      role: 'tenant_admin',
      workspace_id: 1,
      workspace_name: 'Crown Coffee',
      email: 'tenant@crowncoffee.local',
      must_change_password: 0,
      token: tok
    };
  }

  // 3. Check Other Tenant Credentials (email + password OR password-only)
  const tenant = (supplied ? authenticateTenant(supplied, suppliedPass) : null)
    || authenticateTenantByPasswordOnly(suppliedPass);

  if (tenant) {
    attempts.delete(ip);
    const tok = makeToken({
      role: 'tenant_admin',
      workspace_id: tenant.workspace_id,
      user_id: tenant.id,
      email: tenant.email,
      must_change_password: tenant.must_change_password
    });
    reply.setCookie('cc_session', tok, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      maxAge: SESSION_TTL / 1000
    });
    return {
      ok: true,
      role: 'tenant_admin',
      workspace_id: tenant.workspace_id,
      workspace_name: tenant.workspace_name,
      email: tenant.email,
      must_change_password: tenant.must_change_password,
      token: tok
    };
  }

  noteFail(ip);
  return reply.code(401).send({ error: 'Wrong password or credentials.' });
});

app.post(`${BASE}/api/logout`, async (req, reply) => {
  reply.clearCookie('cc_session', { path: '/' });
  return { ok: true };
});

app.post(`${BASE}/api/signup`, async (req, reply) => {
  const ip = req.ip;
  if (!rateLimit(ip, 'signup', 5, 10 * 60 * 1000)) {
    return reply.code(429).send({ error: 'Too many signup attempts. Try again in 10 minutes.' });
  }
  const { businessName, businessType, services, contactEmail, password } = req.body || {};
  const name = String(businessName || '').trim();
  const pwd = String(password || '').trim();
  const bType = String(businessType || 'General Business').trim();
  const bServices = String(services || '').trim();
  const email = String(contactEmail || '').trim().toLowerCase();

  if (!name || name.length < 2) {
    return reply.code(400).send({ error: 'Business name must be at least 2 characters.' });
  }
  if (!pwd || pwd.length < 4) {
    return reply.code(400).send({ error: 'Password must be at least 4 characters.' });
  }

  if (!isPasswordUnique(pwd)) {
    return reply.code(400).send({ error: 'This password is already reserved or in use by another tenant. Please choose a unique password.' });
  }

  try {
    const res = createWorkspaceWithTenant(name, 500, email, pwd, bType, bServices);
    const tok = makeToken({
      role: 'tenant_admin',
      workspace_id: res.workspace.id,
      user_id: res.workspace.id,
      email: res.credentials.email,
      must_change_password: 0
    });
    reply.setCookie('cc_session', tok, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      maxAge: SESSION_TTL / 1000
    });

    return {
      ok: true,
      role: 'tenant_admin',
      workspace_id: res.workspace.id,
      workspace_name: res.workspace.name,
      email: res.credentials.email,
      token: tok
    };
  } catch (e) {
    req.log.error(e);
    return reply.code(400).send({ error: e.message });
  }
});

app.post(`${BASE}/api/ai/suggest-faqs`, async (req, reply) => {
  const ip = req.ip;
  if (!rateLimit(ip, 'suggest-faqs', 10, 60 * 1000)) {
    return reply.code(429).send({ error: 'Rate limit: max 10 FAQ suggestions per minute.' });
  }
  const { businessType, businessName, services, location } = req.body || {};
  try {
    const faqs = await suggestFaqsForBusiness({ businessType, businessName, services, location });
    return { ok: true, faqs };
  } catch (e) {
    req.log.warn(e);
    return reply.code(500).send({ ok: false, error: 'Could not generate FAQs.' });
  }
});

app.post(`${BASE}/api/tenant/onboarding`, { preHandler: requireAuth }, async (req, reply) => {
  const wsId = getScopedWorkspaceId(req);
  const { businessName, businessType, services, faqs, open, close, phone, address, parking, payments } = req.body || {};
  try {
    const cfg = getWorkspaceConfig(wsId);
    if (businessName) {
      db.prepare('UPDATE workspaces SET name = ? WHERE id = ?').run(String(businessName).trim(), wsId);
    }
    const b = cfg.business || cfg.cafe || {};
    if (businessName) b.name = String(businessName).trim();
    if (businessType) b.type = String(businessType).trim();
    if (services) b.services = String(services).trim();
    if (open) b.open = String(open).trim();
    if (close) b.close = String(close).trim();
    if (phone) b.phone = String(phone).trim();
    if (address) b.address = String(address).trim();
    if (parking) b.parking = String(parking).trim();
    if (payments) b.payments = String(payments).trim();

    cfg.business = { ...b };
    cfg.cafe = { ...b }; // backward compatibility

    if (Array.isArray(faqs) && faqs.length) {
      cfg.faqs = faqs.map(f => ({
        q: String(f.q || '').trim(),
        a: String(f.a || '').trim()
      })).filter(f => f.q && f.a);
    }

    saveWorkspaceConfig(wsId, cfg);
    return { ok: true, config: cfg };
  } catch (e) {
    req.log.error(e);
    return reply.code(400).send({ error: e.message });
  }
});

/* ───────────────────────── Orders Bucket API ───────────────────────── */
app.get(`${BASE}/api/orders`, { preHandler: requireAuth }, async req => {
  const wsId = getScopedWorkspaceId(req);
  const status = String(req.query?.status || 'all').trim();
  const orders = listOrders(wsId, status);
  const orderStats = getOrderStats(wsId);
  return { ok: true, orders, stats: orderStats };
});

app.post(`${BASE}/api/orders`, { preHandler: requireAuth }, async (req, reply) => {
  const wsId = getScopedWorkspaceId(req);
  const { details, customer_name, customer_phone, customer_address, estimated_total, platform, notes } = req.body || {};
  if (!details || !String(details).trim()) {
    return reply.code(400).send({ error: 'Order details or service request is required.' });
  }
  try {
    const order = createOrder({
      workspace_id: wsId,
      platform: platform || 'manual',
      customer_name,
      customer_phone,
      customer_address,
      details,
      estimated_total,
      notes
    });
    return { ok: true, order };
  } catch (e) {
    return reply.code(400).send({ error: e.message });
  }
});

app.post(`${BASE}/api/orders/:id/confirm`, { preHandler: requireAuth }, async (req, reply) => {
  const wsId = getScopedWorkspaceId(req);
  const orderId = Number(req.params.id);
  const notes = req.body?.notes || null;
  try {
    const updated = updateOrderStatus(orderId, wsId, 'confirmed', notes);
    return { ok: true, order: updated };
  } catch (e) {
    return reply.code(400).send({ error: e.message });
  }
});

app.post(`${BASE}/api/orders/:id/reject`, { preHandler: requireAuth }, async (req, reply) => {
  const wsId = getScopedWorkspaceId(req);
  const orderId = Number(req.params.id);
  const notes = req.body?.notes || null;
  try {
    const updated = updateOrderStatus(orderId, wsId, 'rejected', notes);
    return { ok: true, order: updated };
  } catch (e) {
    return reply.code(400).send({ error: e.message });
  }
});

// CSV Export: Conversations
app.get(`${BASE}/api/conversations/export.csv`, { preHandler: requireAuth }, async (req, reply) => {
  const wsId = getScopedWorkspaceId(req);
  const filters = { q: req.query?.q || '', platform: req.query?.platform || '', from: req.query?.from || '', to: req.query?.to || '' };
  const csv = exportConversationsCSV(wsId, filters);
  reply.header('Content-Type', 'text/csv; charset=utf-8');
  reply.header('Content-Disposition', 'attachment; filename="conversations.csv"');
  return reply.send(csv);
});

// CSV Export: Orders
app.get(`${BASE}/api/orders/export.csv`, { preHandler: requireAuth }, async (req, reply) => {
  const wsId = getScopedWorkspaceId(req);
  const csv = exportOrdersCSV(wsId);
  reply.header('Content-Type', 'text/csv; charset=utf-8');
  reply.header('Content-Disposition', 'attachment; filename="orders.csv"');
  return reply.send(csv);
});

// Webhook Logs
app.get(`${BASE}/api/webhook-logs`, { preHandler: requireAuth }, async (req) => {
  const wsId = getScopedWorkspaceId(req);
  const limit = Math.min(Number(req.query?.limit || 50), 200);
  return { logs: listWebhookLogs(wsId, limit) };
});

// Push Notification Routes
app.get(`${BASE}/api/push/vapid-public-key`, async () => ({
  key: process.env.VAPID_PUBLIC_KEY || ''
}));

app.post(`${BASE}/api/push/subscribe`, { preHandler: requireAuth }, async (req, reply) => {
  const wsId = getScopedWorkspaceId(req);
  try {
    savePushSubscription(wsId, req.body);
    return { ok: true };
  } catch (e) {
    return reply.code(400).send({ error: e.message });
  }
});

app.post(`${BASE}/api/push/unsubscribe`, { preHandler: requireAuth }, async (req, reply) => {
  const endpoint = req.body?.endpoint;
  if (!endpoint) return reply.code(400).send({ error: 'endpoint required' });
  removePushSubscription(endpoint);
  return { ok: true };
});

// Custom Domain Routes
app.get(`${BASE}/api/admin/workspaces/:id/custom-domain`, { preHandler: requireMasterAdmin }, async (req) => {
  const id = Number(req.params.id);
  const ws = db.prepare('SELECT id, name, custom_domain FROM workspaces WHERE id = ?').get(id);
  return { workspace_id: id, custom_domain: ws?.custom_domain || null };
});

app.put(`${BASE}/api/admin/workspaces/:id/custom-domain`, { preHandler: requireMasterAdmin }, async (req, reply) => {
  const id = Number(req.params.id);
  const domain = req.body?.domain || null;
  try {
    return setWorkspaceCustomDomain(id, domain);
  } catch (e) {
    return reply.code(400).send({ error: e.message });
  }
});

// On-demand DB Backup
app.post(`${BASE}/api/admin/backup`, { preHandler: requireMasterAdmin }, async (req, reply) => {
  try {
    const result = await performBackup();
    return { ok: true, ...result };
  } catch (e) {
    return reply.code(500).send({ error: e.message });
  }
});

app.get(`${BASE}/api/me`, async req => {
  const s = readToken(getToken(req));
  if (!s) return { authed: false };
  if (s.role === 'master_admin') {
    return { authed: true, role: 'master_admin', email: s.email };
  }
  const sub = getSubscription(s.workspace_id);
  const tenantUser = getTenantUser(s.workspace_id);
  const ws = db.prepare('SELECT name FROM workspaces WHERE id = ?').get(s.workspace_id);
  return {
    authed: true,
    role: 'tenant_admin',
    workspace_id: s.workspace_id,
    workspace_name: ws?.name || (s.workspace_id === 1 ? 'Crown Coffee' : 'My Workspace'),
    email: tenantUser?.email || s.email,
    must_change_password: s.workspace_id === 1 ? false : !!tenantUser?.must_change_password,
    subscription: sub
  };
});

/* ───────────────────────── Tenant Profile API ───────────────────────── */
app.put(`${BASE}/api/tenant/profile`, { preHandler: requireAuth }, async (req, reply) => {
  if (req.session.role !== 'tenant_admin') {
    return reply.code(400).send({ error: 'Only tenants can update profile here.' });
  }
  const { email, password } = req.body || {};
  try {
    const res = updateTenantCredentials(req.session.user_id, email, password);
    const tok = makeToken({
      ...req.session,
      email: res.email,
      must_change_password: 0
    });
    reply.setCookie('cc_session', tok, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      maxAge: SESSION_TTL / 1000
    });
    return { ok: true, email: res.email };
  } catch (e) {
    return reply.code(400).send({ error: e.message });
  }
});

/* ───────────────────────── Master Admin Tenant & Subscription API ───────────────────────── */
app.get(`${BASE}/api/admin/tenants`, { preHandler: requireMasterAdmin }, async () => {
  return { tenants: listTenantsOverview() };
});

app.post(`${BASE}/api/admin/tenants`, { preHandler: requireMasterAdmin }, async (req, reply) => {
  const { name, monthly_fee, contact_email } = req.body || {};
  if (!name || !String(name).trim()) return reply.code(400).send({ error: 'Tenant business name is required.' });
  try {
    const res = createWorkspaceWithTenant(String(name).trim(), monthly_fee, contact_email);
    return { ok: true, tenant: res };
  } catch (e) {
    return reply.code(400).send({ error: e.message });
  }
});

app.put(`${BASE}/api/admin/tenants/:id/subscription`, { preHandler: requireMasterAdmin }, async (req, reply) => {
  const id = Number(req.params.id);
  try {
    const sub = updateSubscription(id, req.body || {});
    return { ok: true, subscription: sub };
  } catch (e) {
    return reply.code(400).send({ error: e.message });
  }
});

app.post(`${BASE}/api/admin/tenants/:id/reset-password`, { preHandler: requireMasterAdmin }, async (req, reply) => {
  const id = Number(req.params.id);
  const { password } = req.body || {};
  try {
    const res = resetTenantPassword(id, password);
    return { ok: true, ...res };
  } catch (e) {
    return reply.code(400).send({ error: e.message });
  }
});

app.post(`${BASE}/api/admin/tenants/:id/send-renewal-email`, { preHandler: requireMasterAdmin }, async (req, reply) => {
  const id = Number(req.params.id);
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id);
  if (!ws) return reply.code(404).send({ error: 'Tenant not found.' });
  const sub = getSubscription(id);
  const user = getTenantUser(id);
  const recipient = req.body?.recipient || sub.contact_email || user?.email || `admin@${slugify(ws.name)}.com`;
  const amount = Number(req.body?.amount || sub.monthly_fee || 500);
  const dueDate = req.body?.due_date || (sub.active_until ? new Date(sub.active_until).toLocaleDateString() : 'Immediate');

  const emailSubject = `[Invoice] Crown Operations - Monthly Chatbot Platform Renewal for ${ws.name}`;
  const emailBody = `Dear ${ws.name} Team,

This is a notification that your monthly subscription for the Crown Operations AI Chatbot Platform is due for renewal.

Invoice Details:
- Business Name: ${ws.name}
- Service: Multi-Channel AI Chatbot Platform (Facebook, Instagram, WhatsApp, TikTok)
- Renewal Fee: BDT ${amount.toLocaleString()}
- Due Date: ${dueDate}
- Platform URL: https://bot.ccadmin.online/chatbotadmin/

Payment Information:
- bKash / Nagad Merchant: 01806-576024
- Bank Transfer / Card: Available on request

Upon confirmation, your service will remain active for the next billing cycle.

Best regards,
Crown Operations Admin`;

  req.log.info({ tenantId: id, recipient, emailSubject }, 'Renewal invoice notification prepared.');
  return {
    ok: true,
    recipient,
    subject: emailSubject,
    body: emailBody,
    dispatched_at: new Date().toISOString()
  };
});

/* ───────────────────────── Workspace Management API ───────────────────────── */
app.get(`${BASE}/api/workspaces`, { preHandler: requireAuth }, async (req) => {
  if (req.session.role === 'tenant_admin') {
    return { workspaces: listWorkspaces().filter(w => w.id === req.session.workspace_id) };
  }
  return { workspaces: listWorkspaces() };
});

app.post(`${BASE}/api/workspaces`, { preHandler: requireMasterAdmin }, async (req, reply) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return reply.code(400).send({ error: 'Workspace name is required.' });
  const res = createWorkspaceWithTenant(name);
  return { ok: true, workspace: res.workspace, credentials: res.credentials };
});

app.put(`${BASE}/api/workspaces/:id/rename`, { preHandler: requireMasterAdmin }, async (req, reply) => {
  const id = Number(req.params.id);
  const name = String(req.body?.name || '').trim();
  if (!name) return reply.code(400).send({ error: 'Workspace name is required.' });
  try {
    return renameWorkspace(id, name);
  } catch (e) {
    return reply.code(400).send({ error: e.message });
  }
});

app.delete(`${BASE}/api/workspaces/:id`, { preHandler: requireMasterAdmin }, async (req, reply) => {
  const id = Number(req.params.id);
  if (id === 1) return reply.code(400).send({ error: 'Primary workspace cannot be deleted.' });
  try {
    deleteWorkspace(id);
    return { ok: true };
  } catch (e) {
    return reply.code(400).send({ error: e.message });
  }
});

/* ───────────────────────── admin API (Workspace Scoped) ───────────────────────── */
app.get(`${BASE}/api/config`, { preHandler: requireAuth }, async (req) => {
  const wsId = getScopedWorkspaceId(req);
  const cfg = getWorkspaceConfig(wsId);
  const sub = getSubscription(wsId);
  return { config: cfg, prompt: buildPrompt(cfg), open: openState(cfg), stats: stats(wsId), workspaceId: wsId, subscription: sub };
});

app.put(`${BASE}/api/config`, { preHandler: requireAuth }, async (req, reply) => {
  const wsId = getScopedWorkspaceId(req);
  const cfg = req.body?.config;
  if (!cfg || typeof cfg !== 'object') return reply.code(400).send({ error: 'bad config' });
  saveWorkspaceConfig(wsId, cfg);
  const sub = getSubscription(wsId);
  return { ok: true, prompt: buildPrompt(cfg), open: openState(cfg), stats: stats(wsId), workspaceId: wsId, subscription: sub };
});

app.get(`${BASE}/api/stats`, { preHandler: requireAuth }, async (req) => {
  const wsId = getScopedWorkspaceId(req);
  return { stats: stats(wsId) };
});

app.post(`${BASE}/api/channels/test`, { preHandler: requireAuth }, async (req, reply) => {
  const ip = req.ip;
  if (!rateLimit(ip, 'channels-test', 10, 60 * 1000)) {
    return reply.code(429).send({ error: 'Rate limit: max 10 connection tests per minute.' });
  }
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
  const ip = req.ip;
  if (!rateLimit(ip, 'test-playground', 30, 60 * 1000)) {
    return req.log.warn('Rate limited test playground') || { reply: 'Slow down — you are sending too many test messages.', model: null, escalated: false };
  }
  const wsId = getScopedWorkspaceId(req);
  const cfg = getWorkspaceConfig(wsId);
  const history = (req.body?.history || []).slice(-12);
  const text = String(req.body?.text || '');
  const lang = detectLanguage(text);
  const hit = escalationHit(cfg, text);
  const { text: reply, model } = await generateReply(cfg, history, text, req.log, lang);

  // Background order capture
  detectOrderOrInquiry(text, history).then(extracted => {
    if (extracted && extracted.is_order) {
      createOrder({
        workspace_id: wsId,
        platform: 'web-test',
        customer_name: extracted.customer_name || 'Test User',
        customer_phone: extracted.customer_phone || '',
        customer_address: extracted.customer_address || '',
        details: extracted.details,
        estimated_total: extracted.estimated_total || '',
        notes: 'Captured order from test playground'
      });
    }
  }).catch(() => {});

  return { reply, model, escalated: hit };
});

app.get(`${BASE}/api/conversations`, { preHandler: requireAuth }, async (req) => {
  const wsId = getScopedWorkspaceId(req);
  const filters = {
    q: req.query?.q || '',
    platform: req.query?.platform || '',
    from: req.query?.from || '',
    to: req.query?.to || '',
    page: req.query?.page || 1,
    limit: req.query?.limit || 200
  };
  return { conversations: listConversations(wsId, filters), drafts: listDrafts(wsId) };
});

app.get(`${BASE}/api/conversations/:id`, { preHandler: requireAuth }, async (req, reply) => {
  const conv = getConversation(req.params.id);
  if (!conv) return reply.code(404).send({ error: 'not found' });
  if (req.session.role === 'tenant_admin' && conv.workspace_id !== req.session.workspace_id) {
    return reply.code(403).send({ error: 'Forbidden' });
  }
  return { conversation: conv, messages: getMessages(req.params.id) };
});

app.post(`${BASE}/api/conversations/:id/bot`, { preHandler: requireAuth }, async (req, reply) => {
  const conv = getConversation(req.params.id);
  if (!conv) return reply.code(404).send({ error: 'not found' });
  if (req.session.role === 'tenant_admin' && conv.workspace_id !== req.session.workspace_id) {
    return reply.code(403).send({ error: 'Forbidden' });
  }
  setBotEnabled(req.params.id, !!req.body?.enabled);
  return { ok: true };
});

app.post(`${BASE}/api/conversations/:id/flag`, { preHandler: requireAuth }, async (req, reply) => {
  const conv = getConversation(req.params.id);
  if (!conv) return reply.code(404).send({ error: 'not found' });
  if (req.session.role === 'tenant_admin' && conv.workspace_id !== req.session.workspace_id) {
    return reply.code(403).send({ error: 'Forbidden' });
  }
  setFlag(req.params.id, !!req.body?.flagged, req.body?.reason || null);
  return { ok: true };
});

app.post(`${BASE}/api/conversations/:id/reply`, { preHandler: requireAuth }, async (req, reply) => {
  const conv = getConversation(req.params.id);
  if (!conv) return reply.code(404).send({ error: 'not found' });
  if (req.session.role === 'tenant_admin' && conv.workspace_id !== req.session.workspace_id) {
    return reply.code(403).send({ error: 'Forbidden' });
  }
  const text = String(req.body?.text || '').trim();
  if (!text) return reply.code(400).send({ error: 'empty' });
  try {
    const wsId = conv.workspace_id || 1;
    if (conv.platform === 'tiktok') {
      await sendTikTokMessage(conv.psid, text, null, wsId);
    } else {
      await sendMessage(conv.platform, conv.psid, text, null, wsId);
    }
    addMessage(conv.id, 'out', text, 'human');
    setFlag(conv.id, false);
    return { ok: true };
  } catch (e) {
    req.log.error(e);
    return reply.code(502).send({ error: e.message });
  }
});

app.get('/health', async () => ({ ok: true }));
app.get(`${BASE}/health`, async () => ({ ok: true }));

app.get(`${BASE}/api/health`, async (req) => {
  const wsId = Number(req.query?.workspace_id) || 1;
  const cfg = getWorkspaceConfig(wsId);
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
    stats: stats(wsId)
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
  for (const ev of events) {
    const preview = JSON.stringify({ platform: ev.platform, text: (ev.text || '').slice(0, 120) });
    logWebhookEvent(1, ev.platform || 'meta', 'message', preview, 'ok');
    enqueue(ev, req.log);
  }
});

app.post('/webhook/whatsapp', async (req, reply) => {
  reply.code(200).send('EVENT_RECEIVED');
  const events = parseWebhook(req.body);
  for (const ev of events) {
    const preview = JSON.stringify({ platform: ev.platform, text: (ev.text || '').slice(0, 120) });
    logWebhookEvent(1, 'whatsapp', 'message', preview, 'ok');
    enqueue(ev, req.log);
  }
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
  for (const ev of events) {
    const preview = JSON.stringify({ platform: 'tiktok', text: (ev.text || '').slice(0, 120) });
    logWebhookEvent(1, 'tiktok', 'message', preview, 'ok');
    enqueue(ev, req.log);
  }
});

/* ───────────────────────── Push Broadcast ───────────────────────── */
async function broadcastPush(workspaceId, payload) {
  if (!process.env.VAPID_PUBLIC_KEY) return;
  const subs = listPushSubscriptions(workspaceId);
  const pushPayload = JSON.stringify(payload);
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        pushPayload
      );
    } catch (e) {
      // Remove expired/invalid subscriptions
      if (e.statusCode === 404 || e.statusCode === 410) {
        removePushSubscription(sub.endpoint);
      }
    }
  }
}

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
  const { platform, senderId, mid, text, contactName, recipientAccountId } = ev;
  if (!senderId) return;

  // Resolve target workspace & channel account
  let channelAcc = null;
  let workspaceId = 1;
  if (recipientAccountId) {
    channelAcc = findAccountByPlatformAndId(platform, recipientAccountId);
    if (channelAcc) {
      workspaceId = channelAcc.workspace_id;
    }
  }

  if (isSelf(platform, senderId, channelAcc, workspaceId)) return;
  if (alreadySeen(mid)) return;

  const cfg = getWorkspaceConfig(workspaceId);
  const ch = cfg.channels?.[platform];
  if (ch && ch.enabled === false) return log.info(`Channel ${platform} is disabled in workspace #${workspaceId}`);

  const name = contactName || await fetchProfileName(platform, senderId, ev, channelAcc, workspaceId);
  const conv = upsertConversation(platform, senderId, name, workspaceId);
  addMessage(conv.id, 'in', text, null, mid);

  if (!isSubscriptionActive(workspaceId)) return log.info(`Subscription inactive/expired for workspace #${workspaceId}. Bot auto-reply paused.`);
  if (!cfg.runtime?.enabled) return log.info(`Bot globally disabled for workspace #${workspaceId}`);
  if (!conv.bot_enabled) return log.info(`Bot off for conversation ${conv.id}`);

  const hit = escalationHit(cfg, text);
  if (hit) {
    setFlag(conv.id, true, `keyword: ${hit}`);
    if (cfg.scope.complaint !== 'ack') return; // silent flag
  }

  const st = openState(cfg);
  if (!st.open && cfg.runtime?.offHours === 'silent') {
    return log.info(`Closed, off-hours set to silent for workspace #${workspaceId}`);
  }

  const history = getMessages(conv.id, 12).slice(0, -1);
  const lang = detectLanguage(text);
  const { text: replyText, model } = await generateReply(cfg, history, text, log, lang);

  // Background order capture
  detectOrderOrInquiry(text, history).then(extracted => {
    if (extracted && extracted.is_order) {
      const order = createOrder({
        workspace_id: workspaceId,
        conv_id: conv.id,
        platform,
        customer_name: extracted.customer_name || name || '',
        customer_phone: extracted.customer_phone || '',
        customer_address: extracted.customer_address || '',
        details: extracted.details,
        estimated_total: extracted.estimated_total || '',
        notes: `Automated order capture from ${platform}`
      });
      log.info(`[orders] Captured incoming ${extracted.kind} for workspace #${workspaceId}`);
      // Broadcast push notification for new order
      broadcastPush(workspaceId, {
        title: 'New Order Received',
        body: `From ${name || platform}: ${String(extracted.details || '').slice(0, 80)}`,
        tag: `order-${order.id}`,
        url: `${process.env.PUBLIC_URL || ''}${BASE}/`
      }).catch(() => {});
    }
  }).catch(e => log.warn(`[orders] Capture failed: ${e.message}`));

  try {
    if (platform === 'tiktok') {
      await sendTikTokMessage(senderId, replyText, channelAcc, workspaceId);
    } else {
      await sendMessage(platform, senderId, replyText, channelAcc, workspaceId);
    }
    addMessage(conv.id, 'out', replyText, model);
    if (hit) setFlag(conv.id, true, `keyword: ${hit} (acknowledged, needs you)`);
  } catch (e) {
    log.error(`send failed (${platform}): ${e.message}`);
    setFlag(conv.id, true, 'send failed');
  }
}

/* ───────────────────────── Backup Utility ───────────────────────── */
async function performBackup() {
  const { resolve: res } = await import('node:path');
  const dbPath = res(process.cwd(), 'data/crown.db');
  const backupDir = res(process.cwd(), 'data/backups');
  await mkdir(backupDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const dest = res(backupDir, `crown-${date}.db`);
  await copyFile(dbPath, dest);
  // Prune backups older than 7 days
  const files = await readdir(backupDir);
  for (const f of files) {
    if (!f.startsWith('crown-') || !f.endsWith('.db')) continue;
    const fp = res(backupDir, f);
    const s = await stat(fp).catch(() => null);
    if (s && Date.now() - s.mtimeMs > 7 * 86400 * 1000) await rm(fp).catch(() => {});
  }
  return { file: dest, timestamp: new Date().toISOString() };
}

/* ───────────────────────── pages & assets ───────────────────────── */
app.get('/favicon.ico', (req, reply) => reply.sendFile('favicon.svg'));
app.get('/favicon.svg', (req, reply) => reply.sendFile('favicon.svg'));
app.get(`${BASE}/favicon.ico`, (req, reply) => reply.sendFile('favicon.svg'));
app.get(`${BASE}/favicon.svg`, (req, reply) => reply.sendFile('favicon.svg'));

// Service Worker with unrestricted scope header
app.get('/sw.js', (req, reply) => {
  reply.header('Service-Worker-Allowed', '/');
  reply.header('Content-Type', 'application/javascript; charset=utf-8');
  return reply.sendFile('sw.js');
});
app.get(`${BASE}/sw.js`, (req, reply) => {
  reply.header('Service-Worker-Allowed', '/');
  reply.header('Content-Type', 'application/javascript; charset=utf-8');
  return reply.sendFile('sw.js');
});

// PWA Manifests
app.get('/manifest.webmanifest', (req, reply) => {
  reply.header('Content-Type', 'application/manifest+json; charset=utf-8');
  return reply.sendFile('manifest.webmanifest');
});
app.get('/manifest.json', (req, reply) => {
  reply.header('Content-Type', 'application/manifest+json; charset=utf-8');
  return reply.sendFile('manifest.webmanifest');
});
app.get(`${BASE}/manifest.webmanifest`, (req, reply) => {
  reply.header('Content-Type', 'application/manifest+json; charset=utf-8');
  return reply.sendFile('manifest.webmanifest');
});
app.get(`${BASE}/manifest.json`, (req, reply) => {
  reply.header('Content-Type', 'application/manifest+json; charset=utf-8');
  return reply.sendFile('manifest.webmanifest');
});

// PWA & Touch Icons
app.get('/apple-touch-icon.png', (req, reply) => reply.sendFile('apple-touch-icon.png'));
app.get(`${BASE}/apple-touch-icon.png`, (req, reply) => reply.sendFile('apple-touch-icon.png'));
app.get('/icon-192.png', (req, reply) => reply.sendFile('icon-192.png'));
app.get(`${BASE}/icon-192.png`, (req, reply) => reply.sendFile('icon-192.png'));
app.get('/icon-512.png', (req, reply) => reply.sendFile('icon-512.png'));
app.get(`${BASE}/icon-512.png`, (req, reply) => reply.sendFile('icon-512.png'));
app.get('/icon-maskable-192.png', (req, reply) => reply.sendFile('icon-maskable-192.png'));
app.get(`${BASE}/icon-maskable-192.png`, (req, reply) => reply.sendFile('icon-maskable-192.png'));
app.get('/icon-maskable-512.png', (req, reply) => reply.sendFile('icon-maskable-512.png'));
app.get(`${BASE}/icon-maskable-512.png`, (req, reply) => reply.sendFile('icon-maskable-512.png'));
app.get('/', (req, reply) => reply.redirect(`${BASE}/`));
app.get(BASE, (req, reply) => reply.redirect(`${BASE}/`));
app.setNotFoundHandler((req, reply) => {
  if (req.url.startsWith(BASE)) return reply.sendFile?.('index.html')
    ?? reply.code(404).send('not found');
  reply.code(404).send('not found');
});

app.listen({ port: +PORT, host: HOST })
  .then(() => {
    app.log.info(`admin  -> ${process.env.PUBLIC_URL || ''}${BASE}/`);
    // Schedule daily DB backup at startup and every 24 hours
    performBackup().catch(e => app.log.warn(`[backup] Initial backup failed: ${e.message}`));
    setInterval(() => {
      performBackup().catch(e => app.log.warn(`[backup] Scheduled backup failed: ${e.message}`));
    }, 24 * 60 * 60 * 1000);
  })
  .catch(e => { app.log.error(e); process.exit(1); });

export { app };

process.on('SIGTERM', () => { db.close(); app.close(() => process.exit(0)); });
