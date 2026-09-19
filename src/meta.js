import crypto from 'node:crypto';
import { getConfig } from './db.js';

const GRAPH_VERSION = process.env.GRAPH_VERSION || 'v21.0';

function cleanToken(tok) {
  if (!tok || typeof tok !== 'string') return '';
  return tok.trim().replace(/^Bearer\s+/i, '').replace(/^["']|["']$/g, '').trim();
}

/** Get channel config with database override and .env fallback */
export function getChannelConfig(platform) {
  const cfg = getConfig();
  const ch = cfg.channels?.[platform] || {};
  
  if (platform === 'facebook') {
    return {
      enabled: ch.enabled ?? true,
      pageToken: cleanToken(ch.pageToken || process.env.FB_PAGE_TOKEN || ''),
      pageId: (ch.pageId || process.env.FB_PAGE_ID || '').trim(),
      appSecret: (ch.appSecret || process.env.META_APP_SECRET || '').trim(),
      verifyToken: (ch.verifyToken || process.env.META_VERIFY_TOKEN || 'botcrowncoffee').trim()
    };
  }
  
  if (platform === 'instagram') {
    return {
      enabled: ch.enabled ?? !!(process.env.IG_TOKEN || process.env.IG_USER_ID),
      token: cleanToken(ch.token || process.env.IG_TOKEN || ''),
      userId: (ch.userId || process.env.IG_USER_ID || '').trim(),
      graphHost: (ch.graphHost || process.env.IG_GRAPH_HOST || 'https://graph.facebook.com').replace(/\/$/, '')
    };
  }
  
  if (platform === 'whatsapp') {
    return {
      enabled: ch.enabled ?? !!(process.env.WA_TOKEN || process.env.WA_PHONE_NUMBER_ID),
      phoneNumberId: (ch.phoneNumberId || process.env.WA_PHONE_NUMBER_ID || '').trim(),
      wabaId: (ch.wabaId || process.env.WA_BUSINESS_ACCOUNT_ID || '').trim(),
      token: cleanToken(ch.token || process.env.WA_TOKEN || process.env.FB_PAGE_TOKEN || ''),
      verifyToken: (ch.verifyToken || process.env.WA_VERIFY_TOKEN || process.env.META_VERIFY_TOKEN || 'botcrowncoffee').trim()
    };
  }
  
  return ch;
}

/** Constant-time check of Meta's X-Hub-Signature-256 header. */
export function verifySignature(rawBody, header) {
  const { appSecret } = getChannelConfig('facebook');
  if (!appSecret || !rawBody) return false;
  if (!header?.startsWith('sha256=')) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const a = Buffer.from(header), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** True when the sender is our own page/account (echo of our own send). */
export function isSelf(platform, senderId) {
  if (platform === 'facebook') {
    const fb = getChannelConfig('facebook');
    return fb.pageId ? senderId === fb.pageId : false;
  }
  if (platform === 'instagram') {
    const ig = getChannelConfig('instagram');
    return ig.userId ? senderId === ig.userId : false;
  }
  if (platform === 'whatsapp') {
    const wa = getChannelConfig('whatsapp');
    return wa.phoneNumberId ? senderId === wa.phoneNumberId : false;
  }
  return false;
}

export async function sendMessage(platform, recipientId, text) {
  if (platform === 'whatsapp') {
    return sendWhatsAppMessage(recipientId, text);
  }

  const isFb = platform === 'facebook';
  const conf = getChannelConfig(platform);
  const host = isFb ? 'https://graph.facebook.com' : (conf.graphHost || 'https://graph.facebook.com');
  const token = isFb ? conf.pageToken : conf.token;

  if (!token) throw new Error(`No access token configured for ${platform}. Check Channels settings or .env file.`);

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
export async function sendWhatsAppMessage(toPhoneNumber, text) {
  const conf = getChannelConfig('whatsapp');
  if (!conf.phoneNumberId) throw new Error('WhatsApp Phone Number ID is not configured.');
  if (!conf.token) throw new Error('WhatsApp Access Token is not configured.');

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${conf.phoneNumberId}/messages`;
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
      'Authorization': `Bearer ${conf.token}`,
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
export async function fetchProfileName(platform, senderId, eventDetails = null) {
  try {
    if (platform === 'whatsapp') {
      return eventDetails?.contactName || null;
    }

    const isFb = platform === 'facebook';
    const conf = getChannelConfig(platform);
    const host = isFb ? 'https://graph.facebook.com' : (conf.graphHost || 'https://graph.facebook.com');
    const token = isFb ? conf.pageToken : conf.token;
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
 * Normalise a webhook body into a flat list of inbound text messages.
 * Handles `object: "page"` (Facebook), `object: "instagram"`, and `object: "whatsapp_business_account"`.
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
        const contacts = val.contacts || [];
        const contactMap = new Map();
        for (const c of contacts) {
          if (c.wa_id) contactMap.set(c.wa_id, c.profile?.name);
        }

        for (const msg of val.messages || []) {
          if (msg.type !== 'text' || !msg.text?.body) continue;
          out.push({
            platform: 'whatsapp',
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
    for (const ev of entry.messaging || []) {
      if (!ev.message || ev.message.is_echo) continue; // skip our own sends
      const text = ev.message.text;
      if (!text) continue; // skip stickers/attachments
      out.push({
        platform,
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
  const conf = customConfig || getChannelConfig(platform);

  if (platform === 'facebook') {
    const token = cleanToken(conf.pageToken);
    if (!token) return { ok: false, error: 'Facebook Page Token is missing.' };
    try {
      const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/me?fields=id,name,link&access_token=${encodeURIComponent(token)}`);
      const data = await res.json();
      if (res.ok && data.id) {
        return { ok: true, info: `Connected to Page: "${data.name}" (ID: ${data.id})` };
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
        return { ok: true, info: `Connected as Instagram Account: @${data.username || data.name || data.id}` };
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
        return { ok: true, info: `Connected to WhatsApp Number: ${data.display_phone_number || phoneId} (${data.verified_name || 'Verified'})` };
      }
      return { ok: false, error: data.error?.message || `API error ${res.status}` };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  return { ok: false, error: 'Unknown platform' };
}
