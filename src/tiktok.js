import crypto from 'node:crypto';
import { getConfig } from './db.js';

function cleanToken(tok) {
  if (!tok || typeof tok !== 'string') return '';
  return tok.trim().replace(/^Bearer\s+/i, '').replace(/^["']|["']$/g, '').trim();
}

export function getTikTokConfig() {
  const cfg = getConfig();
  const ch = cfg.channels?.tiktok || {};
  return {
    enabled: ch.enabled ?? !!(process.env.TIKTOK_ACCESS_TOKEN || process.env.TIKTOK_CLIENT_KEY),
    clientKey: ch.clientKey || process.env.TIKTOK_CLIENT_KEY || '',
    clientSecret: ch.clientSecret || process.env.TIKTOK_CLIENT_SECRET || '',
    token: cleanToken(ch.token || process.env.TIKTOK_ACCESS_TOKEN || '')
  };
}

/**
 * Verify TikTok Webhook Signature if secret is configured.
 */
export function verifyTikTokSignature(rawBody, signatureHeader, timestampHeader) {
  const { clientSecret } = getTikTokConfig();
  if (!clientSecret || !rawBody) return true; // allow if no secret set for testing
  if (!signatureHeader) return false;

  try {
    const payload = (timestampHeader || '') + rawBody.toString('utf8');
    const expected = crypto.createHmac('sha256', clientSecret).update(payload).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expected));
  } catch {
    return false;
  }
}

/**
 * Send a direct message to a user on TikTok Business Messaging.
 */
export async function sendTikTokMessage(toUserId, text) {
  const { token } = getTikTokConfig();
  if (!token) throw new Error('TikTok access token is not configured.');

  const url = 'https://open.tiktokapis.com/v2/im/message/send/';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      recipient: { open_id: toUserId },
      message: {
        type: 'text',
        text: text.slice(0, 1000)
      }
    })
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || (data.code && data.code !== 0)) {
    throw new Error(`TikTok send failed (${res.status}): ${data.message || JSON.stringify(data)}`);
  }
  return data;
}

/**
 * Normalise TikTok inbound webhook events into standard message objects.
 */
export function parseTikTokWebhook(body) {
  const out = [];
  if (!body) return out;

  // Handles common TikTok webhook payloads
  if (body.event === 'im.message' && body.data) {
    const d = body.data;
    if (d.message?.type === 'text' && d.message?.text) {
      out.push({
        platform: 'tiktok',
        senderId: d.sender?.open_id || d.sender_id,
        mid: d.message_id || `tt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        text: d.message.text,
        ts: d.create_time || Date.now()
      });
    }
  } else if (Array.isArray(body.entry)) {
    for (const entry of body.entry) {
      for (const ev of entry.messaging || []) {
        if (ev.message?.text && !ev.message.is_echo) {
          out.push({
            platform: 'tiktok',
            senderId: ev.sender?.id || ev.sender?.open_id,
            mid: ev.message.mid || ev.message.id,
            text: ev.message.text,
            ts: ev.timestamp || Date.now()
          });
        }
      }
    }
  }
  return out;
}

/**
 * Test TikTok credentials against TikTok API.
 */
export async function testTikTokConnection(customConfig = null) {
  const conf = customConfig || getTikTokConfig();
  const token = cleanToken(conf.token);
  if (!token) return { ok: false, error: 'TikTok Access Token is missing.' };

  try {
    const res = await fetch('https://open.tiktokapis.com/v2/user/info/?fields=open_id,union_id,avatar_url,display_name', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && (!data.code || data.code === 0)) {
      return { ok: true, info: data.data?.user?.display_name ? `Connected as ${data.data.user.display_name}` : 'Token verified successfully.' };
    }
    return { ok: false, error: data.message || `API returned status ${res.status}` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
