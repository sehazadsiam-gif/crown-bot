import crypto from 'node:crypto';

const {
  META_APP_SECRET, GRAPH_VERSION = 'v21.0',
  FB_PAGE_TOKEN, FB_PAGE_ID,
  IG_TOKEN, IG_USER_ID,
  IG_GRAPH_HOST = 'https://graph.instagram.com'
} = process.env;

/** Constant-time check of Meta's X-Hub-Signature-256 header. */
export function verifySignature(rawBody, header) {
  if (!META_APP_SECRET || !rawBody) return false;
  if (!header?.startsWith('sha256=')) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', META_APP_SECRET).update(rawBody).digest('hex');
  const a = Buffer.from(header), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function cleanToken(tok) {
  if (!tok || typeof tok !== 'string') return '';
  return tok.trim().replace(/^Bearer\s+/i, '').replace(/^["']|["']$/g, '').trim();
}

/** True when the sender is our own page/account (echo of our own send). */
export function isSelf(platform, senderId) {
  return platform === 'facebook' ? senderId === FB_PAGE_ID : senderId === IG_USER_ID;
}

export async function sendMessage(platform, psid, text) {
  const isFb = platform === 'facebook';
  const host = isFb ? 'https://graph.facebook.com' : IG_GRAPH_HOST;
  const rawToken = isFb ? FB_PAGE_TOKEN : IG_TOKEN;
  const token = cleanToken(rawToken);
  if (!token) throw new Error(`no access token configured for ${platform}`);

  const body = { recipient: { id: psid }, message: { text: text.slice(0, 1900) } };
  if (isFb) body.messaging_type = 'RESPONSE';

  const res = await fetch(`${host}/${GRAPH_VERSION}/me/messages?access_token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!res.ok) throw new Error(`${platform} send failed ${res.status}: ${await res.text()}`);
  return res.json();
}

/** Best-effort display name lookup; failure is not fatal. */
export async function fetchProfileName(platform, psid) {
  try {
    const isFb = platform === 'facebook';
    const host = isFb ? 'https://graph.facebook.com' : IG_GRAPH_HOST;
    const rawToken = isFb ? FB_PAGE_TOKEN : IG_TOKEN;
    const token = cleanToken(rawToken);
    if (!token) return null;
    const field = isFb ? 'name' : 'username';
    const res = await fetch(`${host}/${GRAPH_VERSION}/${psid}?fields=${field}&access_token=${encodeURIComponent(token)}`);
    if (!res.ok) return null;
    const d = await res.json();
    return d.name || d.username || null;
  } catch { return null; }
}

/**
 * Normalise a webhook body into a flat list of inbound text messages.
 * Handles both `object: "page"` (Messenger) and `object: "instagram"`.
 */
export function parseWebhook(body) {
  const out = [];
  const platform = body.object === 'instagram' ? 'instagram' : 'facebook';

  for (const entry of body.entry || []) {
    for (const ev of entry.messaging || []) {
      if (!ev.message || ev.message.is_echo) continue;      // skip our own sends
      const text = ev.message.text;
      if (!text) continue;                                   // skip stickers/attachments for now
      out.push({
        platform,
        senderId: ev.sender?.id,
        mid: ev.message.mid,
        text,
        ts: ev.timestamp
      });
    }
  }
  return out;
}
