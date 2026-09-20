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
const effectiveSessionSecret = (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32)
  ? process.env.SESSION_SECRET
  : 'crown-session-default-secret-key-32-chars-minimum-auto-generated-fallback-2026';

const effectiveAdminEmail = (process.env.ADMIN_EMAIL || 'admin@crowncoffee.com').trim().toLowerCase();
const effectiveAdminPass = process.env.ADMIN_PASSWORD || 'ccadmin6789';
const effectiveAdminPassHash = process.env.ADMIN_PASSWORD_HASH || '';

const { PORT = 3000, HOST = '0.0.0.0' } = process.env;

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

await app.register(cookie, { secret: effectiveSessionSecret });
await app.register(fstatic, { root: join(__dirname, '..', 'public'), prefix: `${BASE}/` });

if (BASE && BASE !== '/' && BASE !== '') {
  await app.register(fstatic, {
    root: join(__dirname, '..', 'public'),
    prefix: '/',
    decorateReply: false
  });
}


// Enforce HTTPS behind reverse proxy for domain names
app.addHook('onRequest', async (req, reply) => {
  const proto = req.headers['x-forwarded-proto'];
  const host = req.headers.host || req.hostname;
  if (proto && proto === 'http' && host && !/^\d+\.\d+\.\d+\.\d+/.test(host) && !host.startsWith('localhost') && !host.startsWith('127.0.0.1')) {
    return reply.redirect(`https://${host}${req.url}`, 301);
  }
});

// Security & PWA headers
app.addHook('onSend', async (req, reply) => {
  reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'SAMEORIGIN');
  if (req.url.includes('/chatbotadmin') || req.url.endsWith('.html') || req.url === '/' || req.url === '') {
    reply.header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    reply.header('Pragma', 'no-cache');
  }
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
  const sig = crypto.createHmac('sha256', effectiveSessionSecret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function readToken(tok) {
  if (!tok || typeof tok !== 'string') return null;
  const [data, sig] = tok.split('.');
  if (!data || !sig) return null;
  const expected = crypto.createHmac('sha256', effectiveSessionSecret).update(data).digest('base64url');
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

function resolveWorkspaceFromRequest(req) {
  // 1. Explicit query or body override
  const queryWs = Number(req.query?.workspace_id || req.query?.ws || req.body?.workspace_id || req.body?.ws);
  if (queryWs && queryWs > 0) return queryWs;

  // 2. Hostname resolution
  const rawHost = (req.headers.host || req.hostname || '').split(':')[0].toLowerCase();
  if (rawHost) {
    // Check custom domain in database
    const wsByDomain = findWorkspaceByDomain(rawHost);
    if (wsByDomain) return wsByDomain.id;

    // Check special subdomains for flagship workspace 1 (CC)
    if (rawHost === 'bot.ccadmin.online' || rawHost === 'cc.ccadmin.online') {
      return 1;
    }

    // Check generic subdomain: [subdomain].ccadmin.online
    const parts = rawHost.split('.');
    if (parts.length >= 3 && rawHost.endsWith('ccadmin.online')) {
      const sub = parts[0];
      if (sub === 'bot' || sub === 'cc') return 1;

      // Try matching by subdomain as custom_domain (e.g. sub.ccadmin.online or sub)
      const wsBySub = db.prepare(`
        SELECT id FROM workspaces 
        WHERE LOWER(custom_domain) = ? 
           OR LOWER(custom_domain) = ? 
           OR LOWER(REPLACE(REPLACE(name, ' ', ''), '-', '')) = ?
        LIMIT 1
      `).get(rawHost, sub, sub.replace(/[-_]/g, ''));
      if (wsBySub) return wsBySub.id;
    }
  }

  return 1; // Default to workspace 1 (CC)
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

async function handleLogin(req, reply) {
  const ip = req.ip;
  const { email, password } = req.body || {};
  const supplied = (email || '').trim().toLowerCase();
  const suppliedPass = (password || '').trim();

  if (!suppliedPass) {
    return reply.code(400).send({ error: 'Password is required.' });
  }

  // 1. MASTER PLATFORM ADMIN (Username: masteradmin, Password: ccadmin6789)
  const isMasterUsername = supplied === 'masteradmin' || supplied === 'admin' || (effectiveAdminEmail && supplied === effectiveAdminEmail.toLowerCase());
  const isMasterPassword = (suppliedPass === 'ccadmin6789')
    || (effectiveAdminPass !== '1590' && suppliedPass === effectiveAdminPass)
    || await verifyPassword(suppliedPass, effectiveAdminPass, effectiveAdminPassHash);

  if (isMasterPassword && (isMasterUsername || (supplied === '' && suppliedPass === 'ccadmin6789'))) {
    attempts.delete(ip);
    const adminEmail = supplied || 'masteradmin';
    const tok = makeToken({ role: 'master_admin', email: adminEmail, is_master: true });
    reply.setCookie('cc_session', tok, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      maxAge: SESSION_TTL / 1000
    });
    return { ok: true, role: 'master_admin', email: adminEmail, token: tok };
  }

  // 2. Tenant #1: CC (Dedicated Password: 1590)
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
      workspace_name: 'CC',
      email: 'tenant@crowncoffee.local',
      must_change_password: 0,
      token: tok
    };
  }

  // 3. Other Tenant Credentials (email, name, subdomain, or password-only)
  const tenant = authenticateTenant(supplied, suppliedPass);
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
      workspace_name: tenant.workspace_id === 1 ? 'CC' : tenant.workspace_name,
      email: tenant.email,
      must_change_password: tenant.must_change_password,
      token: tok
    };
  }

  noteFail(ip);
  return reply.code(401).send({ error: 'Invalid username or password.' });
}

app.post('/api/login', handleLogin);
app.post(`${BASE}/api/login`, handleLogin);

async function handleLogout(req, reply) {
  reply.clearCookie('cc_session', { path: '/' });
  return { ok: true };
}
app.post('/api/logout', handleLogout);
app.post(`${BASE}/api/logout`, handleLogout);

async function handleSignup(req, reply) {
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
}
app.post('/api/signup', handleSignup);
app.post(`${BASE}/api/signup`, handleSignup);

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

async function handleMe(req) {
  const s = readToken(getToken(req));
  if (!s) return { authed: false };
  if (s.role === 'master_admin') {
    return { authed: true, role: 'master_admin', email: s.email || 'masteradmin', is_master: true };
  }
  const sub = getSubscription(s.workspace_id);
  const tenantUser = getTenantUser(s.workspace_id);
  const ws = db.prepare('SELECT name FROM workspaces WHERE id = ?').get(s.workspace_id);
  return {
    authed: true,
    role: 'tenant_admin',
    workspace_id: s.workspace_id,
    workspace_name: s.workspace_id === 1 ? 'CC' : (ws?.name || 'My Workspace'),
    email: tenantUser?.email || s.email,
    must_change_password: s.workspace_id === 1 ? false : !!tenantUser?.must_change_password,
    subscription: sub
  };
}

app.get('/api/me', handleMe);
app.get(`${BASE}/api/me`, handleMe);

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
  const { name, monthly_fee, contact_email, custom_password, password, business_type, services, subdomain, custom_domain } = req.body || {};
  if (!name || !String(name).trim()) return reply.code(400).send({ error: 'Tenant business name is required.' });
  try {
    const res = createWorkspaceWithTenant(
      String(name).trim(),
      monthly_fee,
      contact_email,
      custom_password || password || null,
      business_type || 'General Business',
      services || '',
      subdomain || custom_domain || ''
    );
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

/* ───────────────────────── Public Customer AI Webchat & Subdomain API ───────────────────────── */
app.get('/chat', (req, reply) => reply.sendFile('chat.html'));
app.get(`${BASE}/chat`, (req, reply) => reply.sendFile('chat.html'));

app.get('/widget.js', (req, reply) => {
  reply.header('Content-Type', 'application/javascript; charset=utf-8');
  return reply.sendFile('widget.js');
});
app.get(`${BASE}/widget.js`, (req, reply) => {
  reply.header('Content-Type', 'application/javascript; charset=utf-8');
  return reply.sendFile('widget.js');
});

async function handleBotInfo(req, reply) {
  const wsId = resolveWorkspaceFromRequest(req);
  const cfg = getWorkspaceConfig(wsId);
  const ws = db.prepare('SELECT id, name, custom_domain FROM workspaces WHERE id = ?').get(wsId);
  const bizName = wsId === 1 ? 'CC' : (ws?.name || cfg.business?.name || cfg.cafe?.name || 'AI Assistant');
  const greeting = cfg.cafe?.greeting || cfg.bot?.greeting || `Hello! Welcome to ${bizName}. How can I assist you today?`;
  const openInfo = openState(cfg);

  return {
    ok: true,
    workspace_id: wsId,
    name: bizName,
    greeting,
    open: openInfo,
    channels: {
      phone: cfg.cafe?.phone || cfg.business?.phone || '',
      address: cfg.cafe?.area || cfg.business?.address || '',
      hours: cfg.cafe?.hours || cfg.business?.hours || ''
    },
    menu: cfg.menu?.categories || [],
    services: cfg.business?.services || [],
    faqs: (cfg.faqs || []).slice(0, 5).map(f => ({ q: f.q, a: f.a }))
  };
}

app.get('/api/public/bot-info', handleBotInfo);
app.get(`${BASE}/api/public/bot-info`, handleBotInfo);

async function handlePublicChat(req, reply) {
  const ip = req.ip;
  if (!rateLimit(ip, 'public-chat', 30, 60 * 1000)) {
    return reply.code(429).send({ error: 'You are sending messages too fast. Please wait a moment.' });
  }

  const wsId = resolveWorkspaceFromRequest(req);
  const cfg = getWorkspaceConfig(wsId);
  const body = req.body || {};
  const message = String(body.message || body.text || '').trim();
  const history = (Array.isArray(body.history) ? body.history : []).slice(-12);
  const sessionId = String(body.sessionId || crypto.randomUUID()).slice(0, 64);
  const customerName = String(body.customerName || 'Web Visitor').slice(0, 100);

  if (!message) {
    return reply.code(400).send({ error: 'Message cannot be empty.' });
  }

  const lang = detectLanguage(message);
  const hit = escalationHit(cfg, message);
  const { text: botReply, model } = await generateReply(cfg, history, message, req.log, lang);

  // Record conversation in database for live customer inbox
  try {
    const conv = upsertConversation('web', sessionId, customerName, wsId);
    if (conv && conv.id) {
      addMessage(conv.id, 'in', message);
      addMessage(conv.id, 'out', botReply);
      if (hit) setFlag(conv.id, true);
    }
  } catch (err) {
    req.log.warn({ err }, 'Failed to record public webchat message');
  }

  // Background order capture
  detectOrderOrInquiry(message, history).then(async extracted => {
    if (extracted && extracted.is_order) {
      try {
        const order = createOrder({
          workspace_id: wsId,
          platform: 'web',
          customer_name: extracted.customer_name || customerName,
          customer_phone: extracted.customer_phone || body.customerPhone || '',
          customer_address: extracted.customer_address || body.customerAddress || '',
          details: extracted.details || message,
          total_price: extracted.total_price || 0,
          currency: 'BDT'
        });

        // Send Push Notifications to subscribed tenant admins
        const subs = listPushSubscriptions(wsId);
        if (subs && subs.length) {
          const payload = JSON.stringify({
            title: `🔔 New Order: ${order.customer_name}`,
            body: `${order.details} — BDT ${order.total_price}`,
            url: `${process.env.PUBLIC_URL || ''}${BASE}/`
          });
          for (const s of subs) {
            webpush.sendNotification(JSON.parse(s.subscription_json), payload).catch(() => {});
          }
        }
      } catch (e) {
        req.log.warn({ err: e }, 'Background order extraction save failed');
      }
    }
  }).catch(() => {});

  return {
    ok: true,
    reply: botReply,
    model,
    escalated: hit,
    sessionId
  };
}

app.post('/api/public/chat', handlePublicChat);
app.post(`${BASE}/api/public/chat`, handlePublicChat);

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
app.get('/', (req, reply) => {
  const host = (req.headers.host || req.hostname || '').split(':')[0].toLowerCase();
  const isBotSubdomain = host && (
    host.startsWith('bot.') ||
    host.startsWith('cc.') ||
    (host.endsWith('ccadmin.online') && host !== 'ccadmin.online') ||
    (host !== 'ccadmin.online' && host !== 'localhost' && host !== '127.0.0.1' && !/^\d+\.\d+\.\d+\.\d+$/.test(host))
  );

  if (isBotSubdomain) {
    return reply.sendFile('chat.html');
  }
  return reply.redirect(`${BASE}/`);
});
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
