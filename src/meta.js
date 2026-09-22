import crypto from 'node:crypto';
import { getWorkspaceConfig, getAllMetaAppSecrets } from './db.js';

const GRAPH_VERSION = process.env.GRAPH_VERSION || 'v21.0';

function cleanToken(tok) {
  if (!tok || typeof tok !== 'string') return '';
  return tok.trim().replace(/^Bearer\s+/i, '').replace(/^["']|["']$/g, '').trim();
}

/** Get channel config for a specific workspace with database override and .env fallback */
export function getChannelConfig(platform, workspaceId = 1) {
  const cfg = getWorkspaceConfig(workspaceId);
  const ch = cfg.channels?.[platform] || {};
  
  if (platform === 'facebook') {
    return {
      enabled: ch.enabled ?? true,
      pageToken: cleanToken(ch.pageToken || (workspaceId === 1 ? process.env.FB_PAGE_TOKEN : '') || ''),
      pageId: (ch.pageId || (workspaceId === 1 ? process.env.FB_PAGE_ID : '') || '').trim(),
      appSecret: (ch.appSecret || (workspaceId === 1 ? process.env.META_APP_SECRET : '') || '').trim(),
      verifyToken: (ch.verifyToken || (workspaceId === 1 ? process.env.META_VERIFY_TOKEN : '') || 'botcrowncoffee').trim()
    };
  }
  
  if (platform === 'instagram') {
    return {
      enabled: ch.enabled ?? true,
      token: cleanToken(ch.token || (workspaceId === 1 ? process.env.IG_TOKEN : '') || ''),
      userId: (ch.userId || (workspaceId === 1 ? process.env.IG_USER_ID : '') || '').trim(),
      appSecret: (ch.appSecret || (workspaceId === 1 ? process.env.META_APP_SECRET : '') || '').trim(),
      graphHost: (ch.graphHost || 'https://graph.facebook.com').trim()
    };
  }
  
  if (platform === 'whatsapp') {
    return {
      enabled: ch.enabled ?? true,
      phoneNumberId: (ch.phoneNumberId || (workspaceId === 1 ? process.env.WA_PHONE_NUMBER_ID : '') || '').trim(),
      wabaId: (ch.wabaId || (workspaceId === 1 ? process.env.WA_WABA_ID : '') || '').trim(),
      token: cleanToken(ch.token || (workspaceId === 1 ? (process.env.WA_TOKEN || process.env.FB_PAGE_TOKEN) : '') || ''),
      verifyToken: (ch.verifyToken || (workspaceId === 1 ? (process.env.WA_VERIFY_TOKEN || process.env.META_VERIFY_TOKEN) : '') || 'botcrowncoffee').trim()
    };
  }
  
  return ch;
}

/** Constant-time check of Meta's X-Hub-Signature-256 header across all configured tenant secrets. */
export function verifySignature(rawBody, header, customSecret = null) {
  if (!rawBody) return true;
  if (!header?.startsWith('sha256=')) return false;

  const candidateSecrets = new Set();
  if (customSecret && String(customSecret).trim()) candidateSecrets.add(String(customSecret).trim());
  if (process.env.META_APP_SECRET && process.env.META_APP_SECRET.trim()) candidateSecrets.add(process.env.META_APP_SECRET.trim());

  try {
    const allSecrets = getAllMetaAppSecrets();
    for (const s of allSecrets) {
      if (s && String(s).trim()) candidateSecrets.add(String(s).trim());
    }
  } catch {}

  // If absolutely no secrets are configured in any workspace or .env, allow
  if (candidateSecrets.size === 0) return true;

  for (const secret of candidateSecrets) {
    try {
      const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
      const a = Buffer.from(header);
      const b = Buffer.from(expected);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
        return true;
      }
    } catch {}
  }
  return false;
}

/** True when the sender is our own page/account (echo of our own send). */
export function isSelf(platform, senderId, channelAccount = null, workspaceId = 1) {
  if (!senderId) return false;
  if (channelAccount?.account_id && String(senderId) === String(channelAccount.account_id)) {
    return true;
  }
  if (platform === 'facebook') {
    const fb = getChannelConfig('facebook', workspaceId);
    return fb.pageId ? String(senderId) === String(fb.pageId) : false;
  }
  if (platform === 'instagram') {
    const ig = getChannelConfig('instagram', workspaceId);
    return ig.userId ? String(senderId) === String(ig.userId) : false;
  }
  if (platform === 'whatsapp') {
    const wa = getChannelConfig('whatsapp', workspaceId);
    return wa.phoneNumberId ? String(senderId) === String(wa.phoneNumberId) : false;
  }
  return false;
}

export async function sendMessage(platform, recipientId, text, channelAccount = null, workspaceId = 1) {
  if (platform === 'whatsapp') {
    return sendWhatsAppMessage(recipientId, text, channelAccount, workspaceId);
  }

  const isFb = platform === 'facebook';
  const conf = getChannelConfig(platform, workspaceId);
  const host = isFb ? 'https://graph.facebook.com' : (conf.graphHost || 'https://graph.facebook.com');
  const token = channelAccount?.token || (isFb ? conf.pageToken : conf.token);

  if (!token) throw new Error(`No access token configured for ${platform} in workspace #${workspaceId}. Check Channels settings.`);

  const body = {
    recipient: { id: recipientId },
    message: { text: text.slice(0, 1900) }
  };
  if (isFb) body.messaging_type = 'RESPONSE';

  const res = await fetch(`${host}/${GRAPH_VERSION}/me/messages?access_token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`${platform} send failed (${res.status}): ${errText}`);
  }
  return res.json();
}

/** WhatsApp Cloud API Send Message */
export async function sendWhatsAppMessage(toPhoneNumber, text, channelAccount = null, workspaceId = 1) {
  const conf = getChannelConfig('whatsapp', workspaceId);
  const phoneNumberId = channelAccount?.account_id || conf.phoneNumberId;
  const token = channelAccount?.token || conf.token;

  if (!phoneNumberId) throw new Error(`WhatsApp Phone Number ID is not configured in workspace #${workspaceId}.`);
  if (!token) throw new Error(`WhatsApp Access Token is not configured in workspace #${workspaceId}.`);

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;
  const body = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: toPhoneNumber,
    type: 'text',
    text: {
      preview_url: false,
      body: text.slice(0, 4000)
    }
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`WhatsApp send failed (${res.status}): ${errText}`);
  }
  return res.json();
}

/** Best-effort display name lookup; failure is not fatal. */
export async function fetchProfileName(platform, senderId, eventDetails = null, channelAccount = null, workspaceId = 1) {
  try {
    if (platform === 'whatsapp') {
      return eventDetails?.contactName || null;
    }

    const isFb = platform === 'facebook';
    const conf = getChannelConfig(platform, workspaceId);
    const host = isFb ? 'https://graph.facebook.com' : (conf.graphHost || 'https://graph.facebook.com');
    const token = channelAccount?.token || (isFb ? conf.pageToken : conf.token);
    if (!token) return null;

    const field = isFb ? 'name' : 'username';
    const res = await fetch(`${host}/${GRAPH_VERSION}/${senderId}?fields=${field}&access_token=${encodeURIComponent(token)}`);
    if (!res.ok) return null;
    const d = await res.json();
    return d.name || d.username || null;
  } catch {
    return null;
  }
}

/**
 * Normalise a webhook body into a flat list of inbound text messages with recipient routing.
 */
export function parseWebhook(body) {
  const out = [];
  if (!body) return out;

  // WhatsApp Cloud API
  if (body.object === 'whatsapp_business_account') {
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== 'messages') continue;
        const val = change.value || {};
        const recipientAccountId = val.metadata?.phone_number_id || entry.id;
        const contacts = val.contacts || [];
        const contactMap = new Map();
        for (const c of contacts) {
          if (c.wa_id) contactMap.set(c.wa_id, c.profile?.name);
        }

        for (const msg of val.messages || []) {
          if (msg.type !== 'text' || !msg.text?.body) continue;
          out.push({
            platform: 'whatsapp',
            recipientAccountId,
            senderId: msg.from,
            mid: msg.id,
            text: msg.text.body,
            contactName: contactMap.get(msg.from) || null,
            ts: msg.timestamp ? (+msg.timestamp * 1000) : Date.now()
          });
        }
      }
    }
    return out;
  }

  // Messenger and Instagram
  const platform = body.object === 'instagram' ? 'instagram' : 'facebook';

  for (const entry of body.entry || []) {
    const entryId = entry.id;
    for (const ev of entry.messaging || []) {
      if (!ev.message || ev.message.is_echo) continue;
      const text = ev.message.text;
      if (!text) continue;
      out.push({
        platform,
        recipientAccountId: ev.recipient?.id || entryId,
        senderId: ev.sender?.id,
        mid: ev.message.mid,
        text,
        ts: ev.timestamp || Date.now()
      });
    }
  }
  return out;
}

/**
 * Test credentials against Meta API for Facebook, Instagram, or WhatsApp.
 */
export async function testMetaConnection(platform, customConfig = null) {
  const conf = customConfig || getChannelConfig(platform, 1);

  if (platform === 'facebook') {
    const token = cleanToken(conf.pageToken || conf.token);
    if (!token) return { ok: false, error: 'Facebook Page Token is missing.' };
    try {
      const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/me?fields=id,name,link&access_token=${encodeURIComponent(token)}`);
      const data = await res.json();
      if (res.ok && data.id) {
        // Automatically subscribe this Facebook Page to Webhook events
        let subNote = '';
        let subscribed = false;
        try {
          const subRes = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${data.id}/subscribed_apps?subscribed_fields=messages,messaging_postbacks,message_reads,message_echoes&access_token=${encodeURIComponent(token)}`, {
            method: 'POST'
          });
          const subJson = await subRes.json();
          if (subJson.success) {
            subNote = ' · Webhook Subscribed ✅';
            subscribed = true;
          } else if (subJson.error) {
            subNote = ` · Webhook Warning: ${subJson.error.message}`;
          }
        } catch (subErr) {
          subNote = ` · Webhook auto-subscribe: ${subErr.message}`;
        }

        return {
          ok: true,
          id: data.id,
          name: data.name,
          info: `Connected to Page: "${data.name}" (ID: ${data.id})${subNote}`,
          realPageId: data.id,
          pageName: data.name,
          subscribed
        };
      }
      return { ok: false, error: data.error?.message || `API error ${res.status}` };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  if (platform === 'instagram') {
    const token = cleanToken(conf.token);
    const host = (conf.graphHost || 'https://graph.facebook.com').replace(/\/$/, '');
    if (!token) return { ok: false, error: 'Instagram Access Token is missing.' };
    try {
      const res = await fetch(`${host}/${GRAPH_VERSION}/me?fields=id,username,name&access_token=${encodeURIComponent(token)}`);
      const data = await res.json();
      if (res.ok && data.id) {
        return { ok: true, id: data.id, name: data.username || data.name, info: `Connected as Instagram Account: @${data.username || data.name || data.id}` };
      }
      return { ok: false, error: data.error?.message || `API error ${res.status}` };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  if (platform === 'whatsapp') {
    const token = cleanToken(conf.token);
    const phoneId = (conf.phoneNumberId || '').trim();
    if (!token) return { ok: false, error: 'WhatsApp Access Token is missing.' };
    if (!phoneId) return { ok: false, error: 'WhatsApp Phone Number ID is missing.' };
    try {
      const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneId}?fields=display_phone_number,verified_name,quality_rating&access_token=${encodeURIComponent(token)}`);
      const data = await res.json();
      if (res.ok && (data.display_phone_number || data.id)) {
        return { ok: true, id: phoneId, name: data.verified_name || data.display_phone_number, info: `Connected to WhatsApp Number: ${data.display_phone_number || phoneId} (${data.verified_name || 'Verified'})` };
      }
      return { ok: false, error: data.error?.message || `API error ${res.status}` };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  return { ok: false, error: 'Unknown platform' };
}

export function getMetaAppId() {
  return (process.env.META_APP_ID || process.env.FB_APP_ID || '').trim();
}

export function getMetaAppSecret() {
  return (process.env.META_APP_SECRET || '').trim();
}

const DEFAULT_SECRET = process.env.SESSION_SECRET || 'crown-coffee-default-session-secret-32-chars-min!!';

/** Create a cryptographically signed state token for Meta OAuth flow */
export function createOAuthStateToken(workspaceId, userId = '', secret = DEFAULT_SECRET) {
  const payload = {
    ws: Number(workspaceId) || 1,
    u: String(userId || ''),
    exp: Date.now() + 15 * 60 * 1000 // 15 minutes validity
  };
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

/** Verify a state token returned from Meta OAuth callback */
export function verifyOAuthStateToken(stateToken, secret = DEFAULT_SECRET) {
  if (!stateToken || typeof stateToken !== 'string') return null;
  const parts = stateToken.split('.');
  if (parts.length !== 2) return null;
  const [data, sig] = parts;
  const expected = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;

  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Exchange Meta OAuth authorization code for permanent Page Access Tokens */
export async function exchangeOAuthCode(code, redirectUri, customAppId = null, customAppSecret = null) {
  const appId = (customAppId || getMetaAppId()).trim();
  const appSecret = (customAppSecret || getMetaAppSecret()).trim();

  if (!appId) {
    return { ok: false, error: 'META_APP_ID is not configured on the server. Please add META_APP_ID to your environment variables.' };
  }
  if (!appSecret) {
    return { ok: false, error: 'META_APP_SECRET is not configured on the server. Please add META_APP_SECRET to your environment variables.' };
  }

  try {
    // 1. Exchange authorization code for short-lived user access token
    const tokenUrl = `https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token?` + new URLSearchParams({
      client_id: appId,
      client_secret: appSecret,
      redirect_uri: redirectUri,
      code: code
    });

    const tokenRes = await fetch(tokenUrl);
    const tokenData = await tokenRes.json();

    if (!tokenRes.ok || !tokenData.access_token) {
      return { ok: false, error: tokenData.error?.message || 'Failed to exchange authorization code for access token.' };
    }

    const shortUserToken = tokenData.access_token;

    // 2. Exchange short-lived token for long-lived user token (60-day validity)
    let userToken = shortUserToken;
    try {
      const longTokenUrl = `https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token?` + new URLSearchParams({
        grant_type: 'fb_exchange_token',
        client_id: appId,
        client_secret: appSecret,
        fb_exchange_token: shortUserToken
      });
      const longRes = await fetch(longTokenUrl);
      const longData = await longRes.json();
      if (longRes.ok && longData.access_token) {
        userToken = longData.access_token;
      }
    } catch (longErr) {
      console.warn('Long-lived token exchange warning:', longErr.message);
    }

    // 3. Retrieve Facebook Pages managed by this user
    // Note: When queried using a long-lived user token, page access tokens are permanent!
    const accountsUrl = `https://graph.facebook.com/${GRAPH_VERSION}/me/accounts?` + new URLSearchParams({
      fields: 'id,name,access_token,category,link,tasks',
      access_token: userToken
    });

    const accountsRes = await fetch(accountsUrl);
    const accountsData = await accountsRes.json();

    if (!accountsRes.ok) {
      return { ok: false, error: accountsData.error?.message || 'Failed to fetch Facebook Pages for this account.' };
    }

    const pages = (accountsData.data || []).map(p => ({
      id: p.id,
      name: p.name,
      accessToken: p.access_token,
      category: p.category,
      link: p.link,
      tasks: p.tasks || []
    }));

    return {
      ok: true,
      userToken,
      pages
    };
  } catch (err) {
    return { ok: false, error: err.message || 'Meta OAuth network error.' };
  }
}

/** Subscribe a Facebook Page to webhook events (messages, postbacks, reads) */
export async function subscribePageWebhooks(pageId, pageAccessToken) {
  const token = cleanToken(pageAccessToken);
  if (!pageId || !token) return { ok: false, error: 'Missing pageId or pageAccessToken' };

  try {
    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/subscribed_apps?` + new URLSearchParams({
      subscribed_fields: 'messages,messaging_postbacks,message_reads,message_echoes',
      access_token: token
    });

    const res = await fetch(url, { method: 'POST' });
    const data = await res.json();

    if (res.ok && data.success) {
      return { ok: true, success: true };
    }
    return { ok: false, error: data.error?.message || 'Failed to subscribe page to webhooks.' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
