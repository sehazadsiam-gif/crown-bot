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
  pauseConversationBot, resumeConversationBot, isConversationBotActive,
  recordUpgradeRequest, listUpgradeRequests, approveUpgradeRequest, rejectUpgradeRequest, dispatchOwnerAlert, getWeeklyDigest,
  listDrafts, stats, db,
  authenticateTenant, authenticateTenantByPasswordOnly, updateTenantCredentials, resetTenantPassword,
  getTenantUser, getSubscription, isSubscriptionActive, updateSubscription,
  listTenantsOverview, createWorkspaceWithTenant, seedWorkspaceIndustry,
  createOrder, listOrders, updateOrderStatus, getOrderStats, isPasswordUnique,
  savePushSubscription, removePushSubscription, listPushSubscriptions,
  logWebhookEvent, listWebhookLogs,
  findWorkspaceByDomain, setWorkspaceCustomDomain,
  exportConversationsCSV, exportOrdersCSV, slugify,
  getAllMetaVerifyTokens,
  getWorkspaceTrainingStatus, recordTrainingTest
} from './db.js';
import { sendTenantCredentialsEmail, sendWeeklyDigestEmail } from './mailer.js';
import { buildPrompt, openState, escalationHit } from './prompt.js';
import { generateReply, parseMenuText, suggestFaqsForBusiness, detectOrderOrInquiry, detectLanguage } from './ai.js';
import {
  verifySignature, isSelf, sendMessage, fetchProfileName, parseWebhook, testMetaConnection,
  getMetaAppId, getMetaAppSecret, createOAuthStateToken, verifyOAuthStateToken, exchangeOAuthCode, subscribePageWebhooks
} from './meta.js';
import { sendTikTokMessage, parseTikTokWebhook, testTikTokConnection, verifyTikTokSignature } from './tiktok.js';
import webpush from 'web-push';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises';

// Configure VAPID for web push (auto-generate keypair if not set in env)
let vapidPublic = process.env.VAPID_PUBLIC_KEY || '';
let vapidPrivate = process.env.VAPID_PRIVATE_KEY || '';
if (!vapidPublic || !vapidPrivate) {
  try {
    const generated = webpush.generateVAPIDKeys();
    vapidPublic = generated.publicKey;
    vapidPrivate = generated.privateKey;
  } catch (e) {
    console.warn('VAPID key generation warning:', e.message);
  }
}
if (vapidPublic && vapidPrivate) {
  try {
    webpush.setVapidDetails(
      process.env.VAPID_EMAIL || 'mailto:admin@ccadmin.online',
      vapidPublic,
      vapidPrivate
    );
  } catch (e) {
    console.warn('VAPID details setup warning:', e.message);
  }
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

function getAuthSession(req) {
  // 1. Prioritize explicit Authorization bearer header (from client localStorage)
  const authHeader = req.headers?.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const s = readToken(authHeader.slice(7).trim());
    if (s) return s;
  }
  // 2. Query param for direct browser file downloads / links
  if (req.query && req.query.token) {
    const s = readToken(String(req.query.token).trim());
    if (s) return s;
  }
  // 3. Fall back to cookie
  if (req.cookies && req.cookies.cc_session) {
    const s = readToken(req.cookies.cc_session);
    if (s) return s;
  }
  return null;
}

function getToken(req) {
  const s = getAuthSession(req);
  return s ? (req.headers?.authorization?.slice(7)?.trim() || req.cookies?.cc_session) : null;
}

async function requireAuth(req, reply) {
  const s = getAuthSession(req);
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
  const s = getAuthSession(req);
  if (!s || (s.role !== 'master_admin' && !(s.role === 'tenant_admin' && s.workspace_id === 1))) {
    return reply.code(403).send({ error: 'forbidden: requires master admin privileges' });
  }
  req.session = s;
}

function getScopedWorkspaceId(req) {
  if (req.session.role === 'master_admin') {
    const qWs = Number(req.query?.workspace_id || req.query?.ws);
    return qWs && qWs > 0 ? qWs : 1;
  }
  return req.session.workspace_id || 1;
}

function resolveWorkspaceFromRequest(req) {
  // 1. Explicit query or body override
  const rawId = req.query?.workspace_id || req.query?.ws || req.query?.workspace || req.query?.tenant ||
                req.body?.workspace_id || req.body?.ws || req.body?.workspace || req.body?.tenant;
  const queryWs = Number(rawId);
  if (queryWs && queryWs > 0) return queryWs;

  // 1b. Slug/string lookup if tenant name or slug passed as string
  if (rawId && typeof rawId === 'string' && isNaN(Number(rawId))) {
    const clean = rawId.trim().toLowerCase();
    try {
      const wsMatch = db.prepare(`
        SELECT id FROM workspaces 
        WHERE LOWER(custom_domain) = ? 
           OR LOWER(REPLACE(REPLACE(name, ' ', ''), '-', '')) = ?
        LIMIT 1
      `).get(clean, clean.replace(/[-_]/g, ''));
      if (wsMatch?.id) return wsMatch.id;
    } catch {}
  }

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

    const cDom = res.workspace.custom_domain || '';
    const dedicatedDomain = cDom ? (cDom.includes('.') ? cDom : `${cDom}.ccadmin.online`) : '';
    const botUrl = dedicatedDomain ? `https://${dedicatedDomain}/` : `https://bot.ccadmin.online/chat?ws=${res.workspace.id}`;
    const loginUrl = `https://bot.ccadmin.online${BASE}/`;

    if (email && email.includes('@')) {
      sendTenantCredentialsEmail({
        to: email,
        businessName: res.workspace.name,
        email: res.credentials.email,
        password: pwd,
        loginUrl,
        botUrl,
        dedicatedDomain
      }).catch(err => req.log.warn({ err }, 'Failed to dispatch signup credentials email'));
    }

    return {
      ok: true,
      role: 'tenant_admin',
      workspace_id: res.workspace.id,
      workspace_name: res.workspace.name,
      email: res.credentials.email,
      token: tok,
      dedicatedDomain,
      botUrl
    };
  } catch (e) {
    req.log.error(e);
    return reply.code(400).send({ error: e.message });
  }
}
app.post('/api/signup', handleSignup);
app.post(`${BASE}/api/signup`, handleSignup);

async function handleSuggestFaqs(req, reply) {
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
}
app.post('/api/ai/suggest-faqs', handleSuggestFaqs);
app.post(`${BASE}/api/ai/suggest-faqs`, handleSuggestFaqs);

async function handleTenantOnboarding(req, reply) {
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
}
app.post('/api/tenant/onboarding', { preHandler: requireAuth }, handleTenantOnboarding);
app.post(`${BASE}/api/tenant/onboarding`, { preHandler: requireAuth }, handleTenantOnboarding);

async function handleSeedIndustry(req, reply) {
  const wsId = getScopedWorkspaceId(req);
  const { businessType, industry, force } = req.body || {};
  const bType = industry || businessType || 'Dentistry';
  const cfg = seedWorkspaceIndustry(wsId, bType, !!force);
  let itemsCount = 0;
  (cfg?.menu || []).forEach(c => { itemsCount += (c.items || []).length; });
  return { ok: true, config: cfg, industry: bType, itemsCount, faqsCount: (cfg?.faqs || []).length };
}
app.post('/api/tenant/seed-industry', { preHandler: requireAuth }, handleSeedIndustry);
app.post(`${BASE}/api/tenant/seed-industry`, { preHandler: requireAuth }, handleSeedIndustry);

/* ───────────────────────── Orders Bucket API ───────────────────────── */
async function handleOrdersList(req) {
  const wsId = getScopedWorkspaceId(req);
  const status = String(req.query?.status || 'all').trim();
  const orders = listOrders(wsId, status);
  const orderStats = getOrderStats(wsId);
  return { ok: true, orders, stats: orderStats };
}
app.get('/api/orders', { preHandler: requireAuth }, handleOrdersList);
app.get(`${BASE}/api/orders`, { preHandler: requireAuth }, handleOrdersList);

async function handleOrdersCreate(req, reply) {
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
}
app.post('/api/orders', { preHandler: requireAuth }, handleOrdersCreate);
app.post(`${BASE}/api/orders`, { preHandler: requireAuth }, handleOrdersCreate);

async function handleOrderConfirm(req, reply) {
  const wsId = getScopedWorkspaceId(req);
  const orderId = Number(req.params.id);
  const notes = req.body?.notes || null;
  try {
    const updated = updateOrderStatus(orderId, wsId, 'confirmed', notes);
    return { ok: true, order: updated };
  } catch (e) {
    return reply.code(400).send({ error: e.message });
  }
}
app.post('/api/orders/:id/confirm', { preHandler: requireAuth }, handleOrderConfirm);
app.post(`${BASE}/api/orders/:id/confirm`, { preHandler: requireAuth }, handleOrderConfirm);

async function handleOrderReject(req, reply) {
  const wsId = getScopedWorkspaceId(req);
  const orderId = Number(req.params.id);
  const notes = req.body?.notes || null;
  try {
    const updated = updateOrderStatus(orderId, wsId, 'rejected', notes);
    return { ok: true, order: updated };
  } catch (e) {
    return reply.code(400).send({ error: e.message });
  }
}
app.post('/api/orders/:id/reject', { preHandler: requireAuth }, handleOrderReject);
app.post(`${BASE}/api/orders/:id/reject`, { preHandler: requireAuth }, handleOrderReject);

async function handleSimulateOrder(req, reply) {
  const wsId = getScopedWorkspaceId(req);
  const cfg = getWorkspaceConfig(wsId);
  const menuItems = (cfg.menu || []).slice(0, 3);
  let orderDesc = '2x Specialty Items & Consultation';
  let totalVal = 'BDT 850';
  if (menuItems.length >= 2) {
    orderDesc = `1x ${menuItems[0].name}, 1x ${menuItems[1].name}`;
    const p1 = parseInt(String(menuItems[0].price || '').replace(/\D/g, '')) || 350;
    const p2 = parseInt(String(menuItems[1].price || '').replace(/\D/g, '')) || 450;
    totalVal = `BDT ${p1 + p2}`;
  } else if (menuItems.length === 1) {
    orderDesc = `2x ${menuItems[0].name}`;
    const p = parseInt(String(menuItems[0].price || '').replace(/\D/g, '')) || 400;
    totalVal = `BDT ${p * 2}`;
  }

  const sampleNames = ['Tanvir Ahmed', 'Farzana Rahman', 'Sadman Sakib', 'Nusrat Jahan', 'Rafiul Islam'];
  const sampleAreas = ['Uttara Sector 4', 'Dhanmondi Road 27', 'Gulshan-2', 'Banani Block C', 'Mirpur DOHS'];
  const randName = sampleNames[Math.floor(Math.random() * sampleNames.length)];
  const randArea = sampleAreas[Math.floor(Math.random() * sampleAreas.length)];
  const randPhone = `017${Math.floor(10000000 + Math.random() * 90000000)}`;

  try {
    const order = createOrder({
      workspace_id: wsId,
      platform: 'web-test',
      customer_name: randName,
      customer_phone: randPhone,
      customer_address: `House ${Math.floor(1 + Math.random() * 40)}, ${randArea}, Dhaka`,
      details: orderDesc,
      estimated_total: totalVal,
      notes: 'Autonomous AI simulation test'
    });
    return { ok: true, order };
  } catch (e) {
    return reply.code(400).send({ error: e.message });
  }
}
app.post('/api/orders/simulate', { preHandler: requireAuth }, handleSimulateOrder);
app.post(`${BASE}/api/orders/simulate`, { preHandler: requireAuth }, handleSimulateOrder);

// CSV Export: Conversations
async function handleExportConversations(req, reply) {
  const wsId = getScopedWorkspaceId(req);
  const filters = { q: req.query?.q || '', platform: req.query?.platform || '', from: req.query?.from || '', to: req.query?.to || '' };
  const csv = exportConversationsCSV(wsId, filters);
  reply.header('Content-Type', 'text/csv; charset=utf-8');
  reply.header('Content-Disposition', 'attachment; filename="conversations.csv"');
  return reply.send(csv);
}
app.get('/api/conversations/export.csv', { preHandler: requireAuth }, handleExportConversations);
app.get(`${BASE}/api/conversations/export.csv`, { preHandler: requireAuth }, handleExportConversations);

// CSV Export: Orders
async function handleExportOrders(req, reply) {
  const wsId = getScopedWorkspaceId(req);
  const csv = exportOrdersCSV(wsId);
  reply.header('Content-Type', 'text/csv; charset=utf-8');
  reply.header('Content-Disposition', 'attachment; filename="orders.csv"');
  return reply.send(csv);
}
app.get('/api/orders/export.csv', { preHandler: requireAuth }, handleExportOrders);
app.get(`${BASE}/api/orders/export.csv`, { preHandler: requireAuth }, handleExportOrders);

// Webhook Logs
async function handleWebhookLogs(req) {
  const wsId = getScopedWorkspaceId(req);
  const limit = Math.min(Number(req.query?.limit || 50), 200);
  return { logs: listWebhookLogs(wsId, limit) };
}
app.get('/api/webhook-logs', { preHandler: requireAuth }, handleWebhookLogs);
app.get(`${BASE}/api/webhook-logs`, { preHandler: requireAuth }, handleWebhookLogs);

// Push Notification Routes
const handleVapidKey = async () => ({ key: vapidPublic || '' });
app.get('/api/push/vapid-public-key', handleVapidKey);
app.get(`${BASE}/api/push/vapid-public-key`, handleVapidKey);

async function handlePushSubscribe(req, reply) {
  const wsId = getScopedWorkspaceId(req);
  try {
    savePushSubscription(wsId, req.body);
    return { ok: true };
  } catch (e) {
    return reply.code(400).send({ error: e.message });
  }
}
app.post('/api/push/subscribe', { preHandler: requireAuth }, handlePushSubscribe);
app.post(`${BASE}/api/push/subscribe`, { preHandler: requireAuth }, handlePushSubscribe);

async function handlePushUnsubscribe(req, reply) {
  const endpoint = req.body?.endpoint;
  if (!endpoint) return reply.code(400).send({ error: 'endpoint required' });
  removePushSubscription(endpoint);
  return { ok: true };
}
app.post('/api/push/unsubscribe', { preHandler: requireAuth }, handlePushUnsubscribe);
app.post(`${BASE}/api/push/unsubscribe`, { preHandler: requireAuth }, handlePushUnsubscribe);

// Custom Domain Routes
async function handleGetCustomDomain(req) {
  const id = Number(req.params.id);
  const ws = db.prepare('SELECT id, name, custom_domain FROM workspaces WHERE id = ?').get(id);
  return { workspace_id: id, custom_domain: ws?.custom_domain || null };
}
app.get('/api/admin/workspaces/:id/custom-domain', { preHandler: requireMasterAdmin }, handleGetCustomDomain);
app.get(`${BASE}/api/admin/workspaces/:id/custom-domain`, { preHandler: requireMasterAdmin }, handleGetCustomDomain);

async function handlePutCustomDomain(req, reply) {
  const id = Number(req.params.id);
  const domain = req.body?.domain || null;
  try {
    return setWorkspaceCustomDomain(id, domain);
  } catch (e) {
    return reply.code(400).send({ error: e.message });
  }
}
app.put('/api/admin/workspaces/:id/custom-domain', { preHandler: requireMasterAdmin }, handlePutCustomDomain);
app.put(`${BASE}/api/admin/workspaces/:id/custom-domain`, { preHandler: requireMasterAdmin }, handlePutCustomDomain);

// On-demand DB Backup
async function handleAdminBackup(req, reply) {
  try {
    const result = await performBackup();
    return { ok: true, ...result };
  } catch (e) {
    return reply.code(500).send({ error: e.message });
  }
}
app.post('/api/admin/backup', { preHandler: requireMasterAdmin }, handleAdminBackup);
app.post(`${BASE}/api/admin/backup`, { preHandler: requireMasterAdmin }, handleAdminBackup);

// List Available Database Backups
async function handleAdminBackupList(req, reply) {
  try {
    const { resolve: res } = await import('node:path');
    const backupDir = res(process.cwd(), 'data/backups');
    await mkdir(backupDir, { recursive: true });
    const files = await readdir(backupDir);
    const backups = [];
    for (const f of files) {
      if (!f.startsWith('crown-') || !f.endsWith('.db')) continue;
      const fp = res(backupDir, f);
      const s = await stat(fp).catch(() => null);
      if (s) {
        backups.push({
          filename: f,
          size: s.size,
          mtime: new Date(s.mtimeMs).toISOString()
        });
      }
    }
    backups.sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
    return { ok: true, backups };
  } catch (e) {
    return reply.code(500).send({ error: e.message });
  }
}
app.get('/api/admin/backup/list', { preHandler: requireMasterAdmin }, handleAdminBackupList);
app.get(`${BASE}/api/admin/backup/list`, { preHandler: requireMasterAdmin }, handleAdminBackupList);

// Direct SQLite DB Backup Download
async function handleAdminBackupDownload(req, reply) {
  try {
    const { resolve: res, basename } = await import('node:path');
    const backupDir = res(process.cwd(), 'data/backups');
    await mkdir(backupDir, { recursive: true });

    let reqFile = req.query?.file ? String(req.query.file).trim() : '';
    if (reqFile) {
      reqFile = basename(reqFile);
      if (!reqFile.startsWith('crown-') || !reqFile.endsWith('.db')) {
        return reply.code(400).send({ error: 'Invalid backup filename.' });
      }
    }

    let targetPath = reqFile ? res(backupDir, reqFile) : null;
    let targetExists = targetPath ? await stat(targetPath).catch(() => null) : null;

    if (!targetExists) {
      // If no file requested or file not found, generate a fresh snapshot
      const fresh = await performBackup();
      targetPath = fresh.file;
      reqFile = fresh.filename;
      targetExists = { size: fresh.size };
    }

    reply.header('Content-Type', 'application/x-sqlite3');
    reply.header('Content-Disposition', `attachment; filename="${reqFile}"`);
    reply.header('Content-Length', targetExists.size);
    return reply.send(createReadStream(targetPath));
  } catch (e) {
    return reply.code(500).send({ error: e.message });
  }
}
app.get('/api/admin/backup/download', { preHandler: requireMasterAdmin }, handleAdminBackupDownload);
app.get(`${BASE}/api/admin/backup/download`, { preHandler: requireMasterAdmin }, handleAdminBackupDownload);

async function handleMe(req) {
  const s = getAuthSession(req);
  if (!s) return { authed: false };
  if (s.role === 'master_admin') {
    return { authed: true, role: 'master_admin', email: s.email || 'masteradmin', is_master: true, agency_email: effectiveAdminEmail };
  }
  const sub = getSubscription(s.workspace_id);
  const tenantUser = getTenantUser(s.workspace_id);
  const ws = db.prepare('SELECT name FROM workspaces WHERE id = ?').get(s.workspace_id);
  const readiness = getWorkspaceTrainingStatus(s.workspace_id);
  return {
    authed: true,
    role: 'tenant_admin',
    workspace_id: s.workspace_id,
    workspace_name: s.workspace_id === 1 ? 'CC' : (ws?.name || 'My Workspace'),
    email: tenantUser?.email || s.email,
    must_change_password: s.workspace_id === 1 ? false : !!tenantUser?.must_change_password,
    subscription: sub,
    trainingStatus: readiness,
    agency_email: effectiveAdminEmail
  };
}

app.get('/api/me', handleMe);
app.get(`${BASE}/api/me`, handleMe);

/* ───────────────────────── Tenant Profile API ───────────────────────── */
const handleTenantProfile = async (req, reply) => {
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
};
app.put(`${BASE}/api/tenant/profile`, { preHandler: requireAuth }, handleTenantProfile);
app.put('/api/tenant/profile', { preHandler: requireAuth }, handleTenantProfile);

/* ───────────────────────── Master Admin Tenant & Subscription API ───────────────────────── */
async function handleListTenants() {
  return { tenants: listTenantsOverview() };
}
app.get('/api/admin/tenants', { preHandler: requireMasterAdmin }, handleListTenants);
app.get(`${BASE}/api/admin/tenants`, { preHandler: requireMasterAdmin }, handleListTenants);

async function handleCreateTenant(req, reply) {
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

    const cDom = res.workspace.custom_domain || '';
    const dedicatedDomain = cDom ? (cDom.includes('.') ? cDom : `${cDom}.ccadmin.online`) : '';
    const botUrl = dedicatedDomain ? `https://${dedicatedDomain}/` : `https://bot.ccadmin.online/chat?ws=${res.workspace.id}`;
    const loginUrl = `https://bot.ccadmin.online${BASE}/`;
    const recipient = String(contact_email || res.credentials.email || '').trim().toLowerCase();

    let emailStatus = null;
    if (recipient && recipient.includes('@')) {
      try {
        emailStatus = await sendTenantCredentialsEmail({
          to: recipient,
          businessName: res.workspace.name,
          email: res.credentials.email,
          password: res.credentials.password,
          loginUrl,
          botUrl,
          dedicatedDomain
        });
      } catch (mailErr) {
        req.log.warn({ mailErr }, 'Failed to dispatch initial credentials email');
        emailStatus = { sent: false, error: mailErr.message };
      }
    }

    return {
      ok: true,
      tenant: res,
      email_dispatched: emailStatus,
      dedicatedDomain,
      botUrl
    };
  } catch (e) {
    return reply.code(400).send({ error: e.message });
  }
}
app.post('/api/admin/tenants', { preHandler: requireMasterAdmin }, handleCreateTenant);
app.post(`${BASE}/api/admin/tenants`, { preHandler: requireMasterAdmin }, handleCreateTenant);

const handleSendCredentials = async (req, reply) => {
  const id = Number(req.params.id);
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id);
  if (!ws) return reply.code(404).send({ error: 'Tenant not found.' });

  const sub = getSubscription(id);
  const user = getTenantUser(id);
  const targetEmail = String(req.body?.recipient || sub?.contact_email || user?.email || '').trim().toLowerCase();

  if (!targetEmail || !targetEmail.includes('@')) {
    return reply.code(400).send({ error: 'No valid recipient email address specified.' });
  }

  const pwd = user?.password_display || (id === 1 ? '1590' : 'Contact admin to reset password');
  const customDomain = ws.custom_domain || '';
  const dedicatedDomain = customDomain ? (customDomain.includes('.') ? customDomain : `${customDomain}.ccadmin.online`) : '';
  const botUrl = dedicatedDomain ? `https://${dedicatedDomain}/` : `https://bot.ccadmin.online/chat?ws=${id}`;
  const loginUrl = `https://bot.ccadmin.online${BASE}/`;

  try {
    const result = await sendTenantCredentialsEmail({
      to: targetEmail,
      businessName: ws.name,
      email: user?.email || targetEmail,
      password: pwd,
      loginUrl,
      botUrl,
      dedicatedDomain
    });

    req.log.info({ tenantId: id, recipient: targetEmail, result }, 'Credentials email dispatched.');
    return {
      ok: true,
      recipient: targetEmail,
      status: result,
      dedicatedDomain,
      botUrl
    };
  } catch (err) {
    req.log.error({ tenantId: id, err }, 'Failed to send credentials email');
    return reply.code(500).send({ error: err.message });
  }
};
app.post(`${BASE}/api/admin/tenants/:id/send-credentials`, { preHandler: requireMasterAdmin }, handleSendCredentials);
app.post('/api/admin/tenants/:id/send-credentials', { preHandler: requireMasterAdmin }, handleSendCredentials);

async function handleUpdateTenantSubscription(req, reply) {
  const id = Number(req.params.id);
  try {
    const sub = updateSubscription(id, req.body || {});
    return { ok: true, subscription: sub };
  } catch (e) {
    return reply.code(400).send({ error: e.message });
  }
}
app.put('/api/admin/tenants/:id/subscription', { preHandler: requireMasterAdmin }, handleUpdateTenantSubscription);
app.put(`${BASE}/api/admin/tenants/:id/subscription`, { preHandler: requireMasterAdmin }, handleUpdateTenantSubscription);

async function handleResetTenantPassword(req, reply) {
  const id = Number(req.params.id);
  const { password } = req.body || {};
  try {
    const res = resetTenantPassword(id, password);
    return { ok: true, ...res };
  } catch (e) {
    return reply.code(400).send({ error: e.message });
  }
}
app.post('/api/admin/tenants/:id/reset-password', { preHandler: requireMasterAdmin }, handleResetTenantPassword);
app.post(`${BASE}/api/admin/tenants/:id/reset-password`, { preHandler: requireMasterAdmin }, handleResetTenantPassword);

async function handleSendRenewalEmail(req, reply) {
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
- bKash: 01771784474 (Personal)
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
}
app.post('/api/admin/tenants/:id/send-renewal-email', { preHandler: requireMasterAdmin }, handleSendRenewalEmail);
app.post(`${BASE}/api/admin/tenants/:id/send-renewal-email`, { preHandler: requireMasterAdmin }, handleSendRenewalEmail);

/* ───────────────────────── Workspace Management API ───────────────────────── */
async function handleListWorkspaces(req) {
  if (req.session.role === 'tenant_admin') {
    return { workspaces: listWorkspaces().filter(w => w.id === req.session.workspace_id) };
  }
  return { workspaces: listWorkspaces() };
}
app.get('/api/workspaces', { preHandler: requireAuth }, handleListWorkspaces);
app.get(`${BASE}/api/workspaces`, { preHandler: requireAuth }, handleListWorkspaces);

async function handleCreateWorkspace(req, reply) {
  const name = String(req.body?.name || '').trim();
  if (!name) return reply.code(400).send({ error: 'Workspace name is required.' });
  const res = createWorkspaceWithTenant(name);
  return { ok: true, workspace: res.workspace, credentials: res.credentials };
}
app.post('/api/workspaces', { preHandler: requireMasterAdmin }, handleCreateWorkspace);
app.post(`${BASE}/api/workspaces`, { preHandler: requireMasterAdmin }, handleCreateWorkspace);

async function handleRenameWorkspace(req, reply) {
  const id = Number(req.params.id);
  const name = String(req.body?.name || '').trim();
  if (!name) return reply.code(400).send({ error: 'Workspace name is required.' });
  try {
    return renameWorkspace(id, name);
  } catch (e) {
    return reply.code(400).send({ error: e.message });
  }
}
app.put('/api/workspaces/:id/rename', { preHandler: requireMasterAdmin }, handleRenameWorkspace);
app.put(`${BASE}/api/workspaces/:id/rename`, { preHandler: requireMasterAdmin }, handleRenameWorkspace);

async function handleDeleteWorkspace(req, reply) {
  const id = Number(req.params.id);
  if (id === 1) return reply.code(400).send({ error: 'Primary workspace cannot be deleted.' });
  try {
    deleteWorkspace(id);
    return { ok: true };
  } catch (e) {
    return reply.code(400).send({ error: e.message });
  }
}
app.delete('/api/workspaces/:id', { preHandler: requireMasterAdmin }, handleDeleteWorkspace);
app.delete(`${BASE}/api/workspaces/:id`, { preHandler: requireMasterAdmin }, handleDeleteWorkspace);

/* ───────────────────────── admin API (Workspace Scoped) ───────────────────────── */
async function handleGetConfig(req) {
  const wsId = getScopedWorkspaceId(req);
  const cfg = getWorkspaceConfig(wsId);
  const sub = getSubscription(wsId);
  const readiness = getWorkspaceTrainingStatus(wsId);
  return { config: cfg, prompt: buildPrompt(cfg), open: openState(cfg), stats: stats(wsId), workspaceId: wsId, subscription: sub, readiness };
}
app.get('/api/config', { preHandler: requireAuth }, handleGetConfig);
app.get(`${BASE}/api/config`, { preHandler: requireAuth }, handleGetConfig);

async function handlePutConfig(req, reply) {
  const wsId = getScopedWorkspaceId(req);
  const cfg = req.body?.config || (req.body && typeof req.body === 'object' && (req.body.business || req.body.cafe || req.body.menu || req.body.bot_enabled !== undefined) ? req.body : null);
  if (!cfg || typeof cfg !== 'object') return reply.code(400).send({ error: 'bad config' });

  // Guard: Do not let tenant turn on live auto-reply before training bot
  if (cfg.bot_enabled === true && req.session.role !== 'master_admin') {
    const readiness = getWorkspaceTrainingStatus(wsId);
    if (!readiness.isReady) {
      cfg.bot_enabled = false;
      saveWorkspaceConfig(wsId, cfg);
      return reply.code(400).send({
        error: 'training_incomplete',
        message: 'Please complete all required bot training steps before activating live auto-reply.',
        readiness
      });
    }
  }

  saveWorkspaceConfig(wsId, cfg);
  const sub = getSubscription(wsId);
  const readiness = getWorkspaceTrainingStatus(wsId);
  return { ok: true, prompt: buildPrompt(cfg), open: openState(cfg), stats: stats(wsId), workspaceId: wsId, subscription: sub, readiness };
}
app.put('/api/config', { preHandler: requireAuth }, handlePutConfig);
app.put(`${BASE}/api/config`, { preHandler: requireAuth }, handlePutConfig);
app.post('/api/config', { preHandler: requireAuth }, handlePutConfig);
app.post(`${BASE}/api/config`, { preHandler: requireAuth }, handlePutConfig);

async function handleTenantReadiness(req) {
  const wsId = getScopedWorkspaceId(req);
  return getWorkspaceTrainingStatus(wsId);
}
app.get('/api/tenant/readiness', { preHandler: requireAuth }, handleTenantReadiness);
app.get(`${BASE}/api/tenant/readiness`, { preHandler: requireAuth }, handleTenantReadiness);

async function handleTenantRecordTest(req) {
  const wsId = getScopedWorkspaceId(req);
  return recordTrainingTest(wsId);
}
app.post('/api/tenant/record-test', { preHandler: requireAuth }, handleTenantRecordTest);
app.post(`${BASE}/api/tenant/record-test`, { preHandler: requireAuth }, handleTenantRecordTest);

async function handleGetStats(req) {
  const wsId = getScopedWorkspaceId(req);
  return { stats: stats(wsId) };
}
app.get('/api/stats', { preHandler: requireAuth }, handleGetStats);
app.get(`${BASE}/api/stats`, { preHandler: requireAuth }, handleGetStats);

async function handleChannelsTest(req, reply) {
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
      const result = await testMetaConnection(platform, config);
      if (result.ok && platform === 'facebook' && result.realPageId) {
        try {
          const wsId = getScopedWorkspaceId(req);
          const curCfg = getWorkspaceConfig(wsId);
          if (curCfg?.channels?.facebook) {
            curCfg.channels.facebook.pageId = String(result.realPageId).trim();
            if (config?.pageToken) curCfg.channels.facebook.pageToken = String(config.pageToken).trim();
            if (config?.appSecret) curCfg.channels.facebook.appSecret = String(config.appSecret).trim();
            saveWorkspaceConfig(wsId, curCfg);
          }
        } catch {}
      }
      return result;
    }
    return reply.code(400).send({ ok: false, error: `Unsupported platform: ${platform}` });
  } catch (e) {
    req.log.error(e);
    return reply.code(500).send({ ok: false, error: e.message });
  }
}
app.post('/api/channels/test', { preHandler: requireAuth }, handleChannelsTest);
app.post(`${BASE}/api/channels/test`, { preHandler: requireAuth }, handleChannelsTest);

function escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderOAuthPopupResult({ success, title, message, pageId, pageName }) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escHtml(title)}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #080D1A;
      color: #FFFFFF;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      padding: 20px;
      box-sizing: border-box;
    }
    .card {
      background: #121E36;
      border: 1px solid rgba(0, 221, 255, 0.28);
      border-radius: 20px;
      padding: 32px 28px;
      max-width: 440px;
      width: 100%;
      text-align: center;
      box-shadow: 0 10px 30px rgba(0,0,0,0.5);
    }
    .status-icon-wrap {
      width: 52px;
      height: 52px;
      border-radius: 50%;
      margin: 0 auto 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: ${success ? 'rgba(0, 221, 255, 0.15)' : 'rgba(255, 29, 88, 0.15)'};
      color: ${success ? '#00DDFF' : '#FF1D58'};
    }
    h2 {
      margin: 0 0 10px 0;
      font-size: 18px;
      color: ${success ? '#00DDFF' : '#FFFFFF'};
      font-weight: 800;
    }
    p {
      margin: 0 0 20px 0;
      font-size: 13.5px;
      color: #DCE8FA;
      line-height: 1.5;
    }
    .page-pill {
      display: inline-block;
      background: #182949;
      border: 1px solid rgba(0, 221, 255, 0.35);
      border-radius: 9999px;
      padding: 5px 14px;
      font-size: 12.5px;
      font-weight: 700;
      color: #00DDFF;
      margin-bottom: 20px;
    }
    button {
      background: #FF1D58;
      color: #FFFFFF;
      border: none;
      font-weight: 800;
      padding: 10px 24px;
      border-radius: 9999px;
      cursor: pointer;
      font-size: 13px;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="status-icon-wrap">
      ${success
        ? '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>'
        : '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'}
    </div>
    <h2>${escHtml(title)}</h2>
    <p>${escHtml(message)}</p>
    ${pageName ? `<div class="page-pill">${escHtml(pageName)}</div>` : ''}
    <div>
      <button onclick="window.close()">Close Window</button>
    </div>
  </div>
  <script>
    try {
      if (window.opener) {
        window.opener.postMessage({
          type: 'FB_OAUTH_RESULT',
          success: ${JSON.stringify(success)},
          pageId: ${JSON.stringify(pageId || '')},
          pageName: ${JSON.stringify(pageName || '')}
        }, '*');
        ${success ? 'setTimeout(() => window.close(), 1600);' : ''}
      }
    } catch (e) {}
  </script>
</body>
</html>`;
}

function renderOAuthPageSelector({ wsId, state, pages }) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Select Facebook Page</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #080D1A;
      color: #FFFFFF;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      padding: 20px;
      box-sizing: border-box;
    }
    .card {
      background: #121E36;
      border: 1px solid rgba(0, 221, 255, 0.28);
      border-radius: 20px;
      padding: 28px 24px;
      max-width: 480px;
      width: 100%;
      box-shadow: 0 10px 30px rgba(0,0,0,0.5);
    }
    h2 {
      margin: 0 0 6px 0;
      font-size: 18px;
      color: #00DDFF;
      font-weight: 800;
    }
    p {
      margin: 0 0 18px 0;
      font-size: 13px;
      color: #DCE8FA;
      line-height: 1.45;
    }
    .pages-list {
      display: flex;
      flex-direction: column;
      gap: 10px;
      max-height: 280px;
      overflow-y: auto;
      margin-bottom: 20px;
    }
    .page-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: #182949;
      border: 1px solid rgba(0, 221, 255, 0.22);
      border-radius: 12px;
      padding: 12px 16px;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .page-item:hover {
      border-color: #00DDFF;
      background: #203762;
    }
    .page-name {
      font-weight: 700;
      font-size: 14px;
      color: #FFFFFF;
    }
    .page-category {
      font-size: 11.5px;
      color: #00DDFF;
      margin-top: 2px;
    }
    .btn-select {
      background: #FF1D58;
      color: #FFFFFF;
      border: none;
      font-weight: 800;
      padding: 6px 14px;
      border-radius: 9999px;
      font-size: 12px;
      cursor: pointer;
    }
    .btn-cancel {
      background: transparent;
      color: #DCE8FA;
      border: 1px solid rgba(0, 221, 255, 0.3);
      padding: 8px 18px;
      border-radius: 9999px;
      font-size: 12px;
      cursor: pointer;
    }
  </style>
</head>
<body>
  <div class="card">
    <h2>Select Your Facebook Page</h2>
    <p>Choose which Facebook Page you want Crown Bot to automatically respond to:</p>
    <div class="pages-list">
      ${pages.map(p => `
        <div class="page-item" onclick="selectPage('${escHtml(p.id)}', '${escHtml(p.accessToken)}', '${escHtml(p.name)}')">
          <div>
            <div class="page-name">${escHtml(p.name)}</div>
            <div class="page-category">${escHtml(p.category || 'Facebook Business Page')}</div>
          </div>
          <button type="button" class="btn-select">Connect</button>
        </div>
      `).join('')}
    </div>
    <div style="text-align:center">
      <button type="button" class="btn-cancel" onclick="window.close()">Cancel</button>
    </div>
  </div>
  <script>
    async function selectPage(pageId, pageToken, pageName) {
      try {
        const res = await fetch('${BASE}/api/oauth/facebook/select-page', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            state: ${JSON.stringify(state)},
            pageId,
            pageToken,
            pageName
          })
        });
        const data = await res.json();
        if (data.ok) {
          if (window.opener) {
            window.opener.postMessage({
              type: 'FB_OAUTH_RESULT',
              success: true,
              pageId,
              pageName
            }, '*');
          }
          window.close();
        } else {
          alert('Could not link page: ' + (data.error || 'Server error'));
        }
      } catch (err) {
        alert('Network error linking page.');
      }
    }
  </script>
</body>
</html>`;
}

async function handleFacebookOAuthStart(req, reply) {
  const wsId = getScopedWorkspaceId(req);
  const appId = getMetaAppId();

  if (!appId) {
    return reply.type('text/html').send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Meta App ID Required</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #080D1A; color: #FFFFFF; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
    .card { background: #121E36; border: 1px solid rgba(0, 221, 255, 0.28); border-radius: 20px; padding: 32px 28px; max-width: 460px; text-align: center; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
    h2 { color: #FFF685; margin: 0 0 12px 0; font-size: 18px; font-weight: 800; }
    p { color: #DCE8FA; line-height: 1.5; font-size: 13.5px; margin: 0 0 16px 0; }
    code { background: #182949; padding: 2px 6px; border-radius: 4px; font-family: monospace; color: #00DDFF; font-size: 12px; }
    button { background: #0049B7; color: #FFFFFF; border: 1px solid rgba(0, 221, 255, 0.4); font-weight: 800; padding: 10px 22px; border-radius: 9999px; cursor: pointer; font-size: 13px; }
  </style>
</head>
<body>
  <div class="card">
    <h2>Meta App ID Not Configured</h2>
    <p>To enable 1-click Facebook connection, please set <code>META_APP_ID</code> in your server environment variables (Coolify / .env).</p>
    <p>In the meantime, you can connect your Facebook Page by entering your Page Token manually in the Connect Channels tab.</p>
    <button onclick="window.close()">Close Window</button>
  </div>
</body>
</html>`);
  }

  const host = req.headers['x-forwarded-host'] || req.headers.host || 'bot.ccadmin.online';
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const redirectUri = `${proto}://${host}${BASE}/api/oauth/facebook/callback`;

  const state = createOAuthStateToken(wsId, req.session?.email || req.session?.username || 'user');

  const metaAuthUrl = 'https://www.facebook.com/v21.0/dialog/oauth?' + new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    state: state,
    scope: 'pages_show_list,pages_messaging,pages_read_engagement,pages_manage_metadata',
    response_type: 'code'
  });

  return reply.redirect(metaAuthUrl);
}

async function handleFacebookOAuthCallback(req, reply) {
  const { code, state, error, error_description } = req.query || {};

  if (error || !code) {
    const errMsg = error_description || error || 'Facebook authorization was cancelled by the user.';
    return reply.type('text/html').send(renderOAuthPopupResult({
      success: false,
      title: 'Connection Cancelled',
      message: errMsg
    }));
  }

  const payload = verifyOAuthStateToken(state);
  if (!payload || !payload.ws) {
    return reply.type('text/html').send(renderOAuthPopupResult({
      success: false,
      title: 'Session Expired',
      message: 'The authorization session has expired or is invalid. Please close this window and try clicking "Connect Facebook Page" again.'
    }));
  }

  const wsId = payload.ws;
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'bot.ccadmin.online';
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const redirectUri = `${proto}://${host}${BASE}/api/oauth/facebook/callback`;

  // Exchange authorization code with Meta Graph API
  const exchangeRes = await exchangeOAuthCode(code, redirectUri);
  if (!exchangeRes.ok) {
    return reply.type('text/html').send(renderOAuthPopupResult({
      success: false,
      title: 'Authorization Error',
      message: exchangeRes.error || 'Failed to exchange authorization code with Meta.'
    }));
  }

  const pages = exchangeRes.pages || [];

  if (pages.length === 0) {
    return reply.type('text/html').send(renderOAuthPopupResult({
      success: false,
      title: 'No Facebook Pages Found',
      message: 'We could not find any Facebook Pages managed by this Facebook account. Please ensure your personal Facebook account is an Admin or Task Manager of your business Page.'
    }));
  }

  if (pages.length === 1) {
    // Exactly 1 page found - automatically link and subscribe!
    const page = pages[0];
    await subscribePageWebhooks(page.id, page.accessToken);

    const cfg = getWorkspaceConfig(wsId);
    if (!cfg.channels) cfg.channels = {};
    if (!cfg.channels.facebook) cfg.channels.facebook = {};
    cfg.channels.facebook.enabled = true;
    cfg.channels.facebook.pageId = page.id;
    cfg.channels.facebook.pageToken = page.accessToken;
    cfg.channels.facebook.pageName = page.name;
    const appSecret = getMetaAppSecret();
    if (appSecret) cfg.channels.facebook.appSecret = appSecret;
    saveWorkspaceConfig(wsId, cfg);

    return reply.type('text/html').send(renderOAuthPopupResult({
      success: true,
      title: 'Connected Successfully!',
      message: `Your Facebook Page "${page.name}" is now connected to Crown Bot. Webhooks have been automatically subscribed.`,
      pageId: page.id,
      pageName: page.name
    }));
  }

  // Multiple pages found - render clean selector inside popup
  return reply.type('text/html').send(renderOAuthPageSelector({
    wsId,
    state,
    pages
  }));
}

async function handleFacebookOAuthSelectPage(req, reply) {
  const { state, pageId, pageToken, pageName } = req.body || {};
  const payload = verifyOAuthStateToken(state);
  if (!payload || !payload.ws) {
    return reply.code(400).send({ ok: false, error: 'invalid_or_expired_state' });
  }

  const wsId = payload.ws;
  if (!pageId || !pageToken) {
    return reply.code(400).send({ ok: false, error: 'missing_page_credentials' });
  }

  await subscribePageWebhooks(pageId, pageToken);

  const cfg = getWorkspaceConfig(wsId);
  if (!cfg.channels) cfg.channels = {};
  if (!cfg.channels.facebook) cfg.channels.facebook = {};
  cfg.channels.facebook.enabled = true;
  cfg.channels.facebook.pageId = pageId;
  cfg.channels.facebook.pageToken = pageToken;
  cfg.channels.facebook.pageName = pageName || pageId;
  const appSecret = getMetaAppSecret();
  if (appSecret) cfg.channels.facebook.appSecret = appSecret;
  saveWorkspaceConfig(wsId, cfg);

  return { ok: true, pageId, pageName };
}

app.get('/api/oauth/facebook/start', { preHandler: requireAuth }, handleFacebookOAuthStart);
app.get(`${BASE}/api/oauth/facebook/start`, { preHandler: requireAuth }, handleFacebookOAuthStart);

app.get('/api/oauth/facebook/callback', handleFacebookOAuthCallback);
app.get(`${BASE}/api/oauth/facebook/callback`, handleFacebookOAuthCallback);

app.post('/api/oauth/facebook/select-page', handleFacebookOAuthSelectPage);
app.post(`${BASE}/api/oauth/facebook/select-page`, handleFacebookOAuthSelectPage);

async function handleImportMenu(req, reply) {
  try {
    const rows = await parseMenuText(String(req.body?.text || '').slice(0, 20000));
    return { ok: true, rows };
  } catch (e) {
    req.log.warn(e);
    return reply.code(502).send({ error: 'Could not parse that menu. Try a simpler paste.' });
  }
}
app.post('/api/import-menu', { preHandler: requireAuth }, handleImportMenu);
app.post(`${BASE}/api/import-menu`, { preHandler: requireAuth }, handleImportMenu);

async function handleTest(req) {
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
  detectOrderOrInquiry(text, history, cfg).then(extracted => {
    if (extracted && extracted.is_order) {
      const isAppt = extracted.kind === 'appointment' || extracted.kind === 'booking';
      createOrder({
        workspace_id: wsId,
        platform: 'web-test',
        kind: isAppt ? 'appointment' : (extracted.kind || 'order'),
        customer_name: extracted.customer_name || 'Test User',
        customer_phone: extracted.customer_phone || '',
        customer_address: extracted.appointment_time
          ? (extracted.customer_address ? `${extracted.customer_address} [Time: ${extracted.appointment_time}]` : `Time: ${extracted.appointment_time}`)
          : (extracted.customer_address || ''),
        details: extracted.details,
        estimated_total: extracted.estimated_total || '',
        notes: `Captured ${extracted.kind || 'order'} from test playground`
      });
    }
  }).catch(() => {});

  return { reply, model, escalated: hit };
}
app.post('/api/test', { preHandler: requireAuth }, handleTest);
app.post(`${BASE}/api/test`, { preHandler: requireAuth }, handleTest);

async function handleConversationsList(req) {
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
}
app.get('/api/conversations', { preHandler: requireAuth }, handleConversationsList);
app.get(`${BASE}/api/conversations`, { preHandler: requireAuth }, handleConversationsList);

async function handleConversationGet(req, reply) {
  const conv = getConversation(req.params.id);
  if (!conv) return reply.code(404).send({ error: 'not found' });
  if (req.session.role === 'tenant_admin' && conv.workspace_id !== req.session.workspace_id) {
    return reply.code(403).send({ error: 'Forbidden' });
  }
  return { conversation: conv, messages: getMessages(req.params.id) };
}
app.get('/api/conversations/:id', { preHandler: requireAuth }, handleConversationGet);
app.get(`${BASE}/api/conversations/:id`, { preHandler: requireAuth }, handleConversationGet);

async function handleConversationBot(req, reply) {
  const conv = getConversation(req.params.id);
  if (!conv) return reply.code(404).send({ error: 'not found' });
  if (req.session.role === 'tenant_admin' && conv.workspace_id !== req.session.workspace_id) {
    return reply.code(403).send({ error: 'Forbidden' });
  }
  setBotEnabled(req.params.id, !!req.body?.enabled);
  return { ok: true };
}
app.post('/api/conversations/:id/bot', { preHandler: requireAuth }, handleConversationBot);
app.post(`${BASE}/api/conversations/:id/bot`, { preHandler: requireAuth }, handleConversationBot);

async function handleConversationFlag(req, reply) {
  const conv = getConversation(req.params.id);
  if (!conv) return reply.code(404).send({ error: 'not found' });
  if (req.session.role === 'tenant_admin' && conv.workspace_id !== req.session.workspace_id) {
    return reply.code(403).send({ error: 'Forbidden' });
  }
  setFlag(req.params.id, !!req.body?.flagged, req.body?.reason || null);
  return { ok: true };
}
app.post('/api/conversations/:id/flag', { preHandler: requireAuth }, handleConversationFlag);
app.post(`${BASE}/api/conversations/:id/flag`, { preHandler: requireAuth }, handleConversationFlag);

async function handleConversationReply(req, reply) {
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
}
app.post('/api/conversations/:id/reply', { preHandler: requireAuth }, handleConversationReply);
app.post(`${BASE}/api/conversations/:id/reply`, { preHandler: requireAuth }, handleConversationReply);

const handleConvPause = async (req, reply) => {
  const conv = getConversation(req.params.id);
  if (!conv) return reply.code(404).send({ error: 'Conversation not found' });
  if (req.session.role === 'tenant_admin' && conv.workspace_id !== req.session.workspace_id) {
    return reply.code(403).send({ error: 'Forbidden' });
  }
  const mins = Math.max(1, Number(req.body?.minutes) || 60);
  const updated = pauseConversationBot(req.params.id, mins);
  return { ok: true, conversation: updated, paused_until: updated.ai_paused_until };
};
app.post(`${BASE}/api/conversations/:id/pause`, { preHandler: requireAuth }, handleConvPause);
app.post('/api/conversations/:id/pause', { preHandler: requireAuth }, handleConvPause);

const handleConvResume = async (req, reply) => {
  const conv = getConversation(req.params.id);
  if (!conv) return reply.code(404).send({ error: 'Conversation not found' });
  if (req.session.role === 'tenant_admin' && conv.workspace_id !== req.session.workspace_id) {
    return reply.code(403).send({ error: 'Forbidden' });
  }
  const updated = resumeConversationBot(req.params.id);
  return { ok: true, conversation: updated };
};
app.post(`${BASE}/api/conversations/:id/resume`, { preHandler: requireAuth }, handleConvResume);
app.post('/api/conversations/:id/resume', { preHandler: requireAuth }, handleConvResume);

const handleUpgradeRequest = async (req, reply) => {
  const wsId = req.session.role === 'master_admin' ? Number(req.body?.workspace_id || req.session.workspace_id) : req.session.workspace_id;
  const { plan_name, plan, monthly_fee, amount, payment_method, sender_number, sender_phone, trx_id, notes } = req.body || {};
  const chosenPlan = plan_name || plan;
  const chosenSender = sender_number || sender_phone;
  const baseAmt = Number(req.body?.base_amount ?? req.body?.monthly_fee ?? req.body?.amount) || 500;
  // Auto-calculate platform fee: 20 Tk per 500 Tk
  const platformFee = Math.ceil(baseAmt / 500) * 20;
  const totalAmount = baseAmt + platformFee;

  if (!chosenPlan || !trx_id || !chosenSender) {
    return reply.code(400).send({ error: 'Please provide plan name, sender phone number, and TrxID.' });
  }

  const rec = recordUpgradeRequest({
    workspaceId: wsId,
    planName: chosenPlan,
    monthlyFee: totalAmount,
    paymentMethod: payment_method || 'bkash',
    senderNumber: chosenSender,
    trxId: trx_id,
    notes: notes || `Base: ৳${baseAmt.toLocaleString()} + Platform Fee: ৳${platformFee} (Total: ৳${totalAmount.toLocaleString()})`
  });

  const updatedSub = getSubscription(wsId);
  return { ok: true, request: rec, subscription: updatedSub };
};
app.post(`${BASE}/api/tenant/subscription/request-upgrade`, { preHandler: requireAuth }, handleUpgradeRequest);
app.post('/api/tenant/subscription/request-upgrade', { preHandler: requireAuth }, handleUpgradeRequest);

/* Master Admin Subscription Request Management */
app.get(`${BASE}/api/admin/subscription-requests`, { preHandler: requireMasterAdmin }, async () => {
  return { requests: listUpgradeRequests() };
});
app.get('/api/admin/subscription-requests', { preHandler: requireMasterAdmin }, async () => {
  return { requests: listUpgradeRequests() };
});

app.post(`${BASE}/api/admin/subscription-requests/:id/approve`, { preHandler: requireMasterAdmin }, async (req, reply) => {
  const id = Number(req.params.id);
  const days = Number(req.body?.days) || 30;
  try {
    const res = approveUpgradeRequest(id, days);
    return { ok: true, ...res };
  } catch (e) {
    return reply.code(400).send({ error: e.message });
  }
});
app.post('/api/admin/subscription-requests/:id/approve', { preHandler: requireMasterAdmin }, async (req, reply) => {
  const id = Number(req.params.id);
  const days = Number(req.body?.days) || 30;
  try {
    const res = approveUpgradeRequest(id, days);
    return { ok: true, ...res };
  } catch (e) {
    return reply.code(400).send({ error: e.message });
  }
});

app.post(`${BASE}/api/admin/subscription-requests/:id/reject`, { preHandler: requireMasterAdmin }, async (req, reply) => {
  const id = Number(req.params.id);
  const { reason } = req.body || {};
  try {
    const reqRow = rejectUpgradeRequest(id, reason);
    return { ok: true, request: reqRow };
  } catch (e) {
    return reply.code(400).send({ error: e.message });
  }
});
app.post('/api/admin/subscription-requests/:id/reject', { preHandler: requireMasterAdmin }, async (req, reply) => {
  const id = Number(req.params.id);
  const { reason } = req.body || {};
  try {
    const reqRow = rejectUpgradeRequest(id, reason);
    return { ok: true, request: reqRow };
  } catch (e) {
    return reply.code(400).send({ error: e.message });
  }
});

const handleTestOwnerAlert = async (req, reply) => {
  const wsId = req.session.role === 'master_admin' ? Number(req.body?.workspace_id || req.session.workspace_id) : req.session.workspace_id;
  const result = await dispatchOwnerAlert(wsId, {
    platform: 'test',
    customer_name: 'Test Patient (Verification)',
    customer_phone: '+880 1700-000000',
    details: 'Test appointment booking verification alert.',
    estimated_total: '1,500'
  });
  return { ok: true, result };
};
app.post(`${BASE}/api/tenant/test-owner-alert`, { preHandler: requireAuth }, handleTestOwnerAlert);
app.post('/api/tenant/test-owner-alert', { preHandler: requireAuth }, handleTestOwnerAlert);

const handleWeeklyDigest = async (req, reply) => {
  const wsId = req.session.role === 'master_admin' ? Number(req.query?.workspace_id || req.session.workspace_id) : req.session.workspace_id;
  const digest = getWeeklyDigest(wsId);
  return { ok: true, digest };
};
app.get(`${BASE}/api/tenant/weekly-digest`, { preHandler: requireAuth }, handleWeeklyDigest);
app.get('/api/tenant/weekly-digest', { preHandler: requireAuth }, handleWeeklyDigest);

const handleWeeklyDigestEmail = async (req, reply) => {
  const wsId = req.session.role === 'master_admin' ? Number(req.body?.workspace_id || req.session.workspace_id) : req.session.workspace_id;
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(wsId);
  const cfg = getWorkspaceConfig(wsId);
  const digest = getWeeklyDigest(wsId);
  const user = getTenantUser(wsId);
  const targetEmail = req.body?.email || cfg?.alerts?.email || ws?.contact_email || user?.email;
  if (!targetEmail || !targetEmail.includes('@')) {
    return reply.code(400).send({ error: 'No valid recipient email address configured.' });
  }
  const res = await sendWeeklyDigestEmail({
    to: targetEmail,
    businessName: ws?.name || cfg?.business?.name || 'Your Business',
    digestData: digest
  });
  return { ok: true, sent: res.sent, error: res.error, simulated: res.simulated };
};
app.post(`${BASE}/api/tenant/weekly-digest/email`, { preHandler: requireAuth }, handleWeeklyDigestEmail);
app.post('/api/tenant/weekly-digest/email', { preHandler: requireAuth }, handleWeeklyDigestEmail);

app.get('/health', async () => ({ ok: true }));
app.get(`${BASE}/health`, async () => ({ ok: true }));

/* ───────────────────────── Public Customer AI Webchat & Subdomain API ───────────────────────── */
app.get('/chat', (req, reply) => reply.sendFile('chat.html'));
app.get(`${BASE}/chat`, (req, reply) => reply.sendFile('chat.html'));

/* Public Legal & Policy Pages for Meta Platform Compliance */
app.get('/privacy', (req, reply) => reply.sendFile('privacy.html'));
app.get(`${BASE}/privacy`, (req, reply) => reply.sendFile('privacy.html'));
app.get('/data-deletion', (req, reply) => reply.sendFile('data-deletion.html'));
app.get(`${BASE}/data-deletion`, (req, reply) => reply.sendFile('data-deletion.html'));
app.get('/terms', (req, reply) => reply.sendFile('terms.html'));
app.get(`${BASE}/terms`, (req, reply) => reply.sendFile('terms.html'));

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

  const sub = getSubscription(wsId);
  const planName = (sub?.plan_name || '').toLowerCase();
  const whiteLabel = planName.includes('pro') || planName.includes('enterprise') || !!cfg?.whiteLabel;

  return {
    ok: true,
    workspace_id: wsId,
    name: bizName,
    greeting,
    open: openInfo,
    whiteLabel,
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
  const rawHistory = Array.isArray(body.history) ? body.history : [];
  const history = rawHistory.map(m => {
    if (m && m.direction) return { direction: m.direction, text: String(m.text || '') };
    if (m && m.role) return { direction: m.role === 'user' ? 'in' : 'out', text: String(m.content || m.text || '') };
    return { direction: 'in', text: String(m || '') };
  }).filter(m => m.text).slice(-12);
  const sessionId = String(body.sessionId || body.session_id || crypto.randomUUID()).slice(0, 64);
  const customerName = String(body.customerName || 'Web Visitor').slice(0, 100);

  if (!message) {
    return reply.code(400).send({ error: 'Message cannot be empty.' });
  }

  const lang = detectLanguage(message);
  const hit = escalationHit(cfg, message);
  const { text: botReply, model } = await generateReply(cfg, history, message, req.log, lang);

  // Record conversation in database for live customer inbox
  let activeConv = null;
  try {
    activeConv = upsertConversation('web', sessionId, customerName, wsId);
    if (activeConv && activeConv.id) {
      addMessage(activeConv.id, 'in', message);
      addMessage(activeConv.id, 'out', botReply);
      if (hit) setFlag(activeConv.id, true);
    }
  } catch (err) {
    req.log.warn({ err }, 'Failed to record public webchat message');
  }

  // If simulator or preview test chat, automatically fulfill owner test verification
  if (sessionId.startsWith('sim_') || customerName.toLowerCase().includes('test')) {
    try { recordTrainingTest(wsId); } catch {}
  }

  // Background order / appointment capture
  detectOrderOrInquiry(message, history, cfg).then(async extracted => {
    if (extracted && extracted.is_order) {
      try {
        const isAppt = extracted.kind === 'appointment' || extracted.kind === 'booking';
        const scheduleOrAddress = extracted.appointment_time
          ? (extracted.customer_address ? `${extracted.customer_address} [Time: ${extracted.appointment_time}]` : `Time: ${extracted.appointment_time}`)
          : (extracted.customer_address || body.customerAddress || '');

        const order = createOrder({
          workspace_id: wsId,
          conv_id: activeConv?.id || null,
          platform: 'web',
          kind: isAppt ? 'appointment' : (extracted.kind || 'order'),
          customer_name: extracted.customer_name || customerName,
          customer_phone: extracted.customer_phone || body.customerPhone || '',
          customer_address: scheduleOrAddress,
          details: extracted.details || message,
          estimated_total: extracted.estimated_total || '',
          notes: isAppt ? 'Web Appointment Booking' : 'Web Order Request'
        });

        // Send Push Notifications to subscribed tenant admins
        const subs = listPushSubscriptions(wsId);
        if (subs && subs.length) {
          const payload = JSON.stringify({
            title: isAppt ? `📅 New Appointment: ${order.customer_name}` : `🔔 New Order: ${order.customer_name}`,
            body: `${order.details}${order.estimated_total ? ' — BDT ' + order.estimated_total : ''}`,
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

async function handleHealthCheck(req) {
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
}
app.get('/api/health', handleHealthCheck);
app.get(`${BASE}/api/health`, handleHealthCheck);

/* ───────────────────────── Meta Webhook (Facebook / Instagram / WhatsApp) ───────────────────────── */
const handleMetaVerification = (req, reply) => {
  const q = req.query;
  const allowedTokens = new Set([
    process.env.META_VERIFY_TOKEN,
    process.env.WA_VERIFY_TOKEN,
    'botcrowncoffee'
  ].filter(Boolean));

  try {
    const allTokens = getAllMetaVerifyTokens();
    for (const t of allTokens) {
      if (t) allowedTokens.add(t);
    }
  } catch {}

  if (q['hub.mode'] === 'subscribe' && allowedTokens.has(q['hub.verify_token'])) {
    return reply.code(200).type('text/plain').send(q['hub.challenge']);
  }
  return reply.code(403).send('forbidden');
};

app.get('/webhook/meta', handleMetaVerification);
app.get('/webhook/whatsapp', handleMetaVerification);

app.post('/webhook/meta', async (req, reply) => {
  if (!verifySignature(req.rawBody, req.headers['x-hub-signature-256'])) {
    req.log.warn('bad meta webhook signature');
    try {
      logWebhookEvent(1, 'meta', 'signature_rejected', 'Invalid HMAC-SHA256 signature in x-hub-signature-256 header', 'error', 'bad signature');
    } catch {}
    return reply.code(401).send('bad signature');
  }

  // Fast acknowledge
  reply.code(200).send('EVENT_RECEIVED');

  const events = parseWebhook(req.body);
  for (const ev of events) {
    let wsId = 1;
    if (ev.recipientAccountId) {
      const acc = findAccountByPlatformAndId(ev.platform, ev.recipientAccountId);
      if (acc?.workspace_id) wsId = acc.workspace_id;
    }
    const preview = JSON.stringify({ platform: ev.platform, text: (ev.text || '').slice(0, 120), recipient: ev.recipientAccountId });
    logWebhookEvent(wsId, ev.platform || 'meta', 'message', preview, 'ok');
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
  if (!isConversationBotActive(conv)) return log.info(`Bot off or paused (human handover active) for conversation ${conv.id}`);

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
  detectOrderOrInquiry(text, history, cfg).then(extracted => {
    if (extracted && extracted.is_order) {
      const isAppt = extracted.kind === 'appointment' || extracted.kind === 'booking';
      const scheduleOrAddress = extracted.appointment_time
        ? (extracted.customer_address ? `${extracted.customer_address} [Time: ${extracted.appointment_time}]` : `Time: ${extracted.appointment_time}`)
        : (extracted.customer_address || '');

      const order = createOrder({
        workspace_id: workspaceId,
        conv_id: conv.id,
        platform,
        kind: isAppt ? 'appointment' : (extracted.kind || 'order'),
        customer_name: extracted.customer_name || name || '',
        customer_phone: extracted.customer_phone || '',
        customer_address: scheduleOrAddress,
        details: extracted.details,
        estimated_total: extracted.estimated_total || '',
        notes: `Automated ${extracted.kind || 'order'} capture from ${platform}`
      });
      log.info(`[orders] Captured incoming ${extracted.kind} for workspace #${workspaceId}`);
      // Broadcast push notification for new order / appointment
      broadcastPush(workspaceId, {
        title: isAppt ? 'New Appointment Request' : 'New Order Received',
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
  const { resolve: res, basename } = await import('node:path');
  const dbPath = res(process.cwd(), 'data/crown.db');
  const backupDir = res(process.cwd(), 'data/backups');
  await mkdir(backupDir, { recursive: true });

  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toTimeString().slice(0, 8).replace(/:/g, '-');
  const filename = `crown-${dateStr}_${timeStr}.db`;
  const dest = res(backupDir, filename);

  // Use SQLite online backup API to ensure WAL journal is safely checkpointed
  try {
    if (db && typeof db.backup === 'function') {
      await db.backup(dest);
    } else {
      await copyFile(dbPath, dest);
    }
  } catch (err) {
    app.log.warn(`[backup] db.backup failed (${err.message}), falling back to copyFile`);
    await copyFile(dbPath, dest);
  }

  // Also maintain a canonical crown-latest.db for 1-click quick recovery
  const latestDest = res(backupDir, 'crown-latest.db');
  try {
    await copyFile(dest, latestDest);
  } catch {}

  const s = await stat(dest);

  // Prune backups older than 7 days (preserving crown-latest.db)
  const files = await readdir(backupDir);
  for (const f of files) {
    if (!f.startsWith('crown-') || !f.endsWith('.db') || f === 'crown-latest.db') continue;
    const fp = res(backupDir, f);
    const fileStat = await stat(fp).catch(() => null);
    if (fileStat && Date.now() - fileStat.mtimeMs > 7 * 86400 * 1000) {
      await rm(fp).catch(() => {});
    }
  }

  return {
    file: dest,
    filename,
    size: s.size,
    timestamp: now.toISOString()
  };
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
