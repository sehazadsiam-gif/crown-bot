import { buildPrompt } from './prompt.js';

const {
  GEMINI_API_KEY, GEMINI_MODEL = 'gemini-2.5-flash',
  GROQ_API_KEY, GROQ_MODEL = 'llama-3.3-70b-versatile'
} = process.env;

const TIMEOUT = 25_000;

async function post(url, opts) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); }
  finally { clearTimeout(t); }
}

/* history: [{direction:'in'|'out', text}] oldest first */
async function callGemini(system, history, userText) {
  if (!GEMINI_API_KEY) throw Object.assign(new Error('no gemini key'), { code: 'no_key' });

  const raw = [
    ...history.map(m => ({ role: m.direction === 'in' ? 'user' : 'model', text: m.text })),
    { role: 'user', text: userText }
  ];
  const merged = [];
  for (const turn of raw) {
    const last = merged[merged.length - 1];
    if (last && last.role === turn.role) last.text += '\n' + turn.text;
    else merged.push({ ...turn });
  }
  while (merged.length && merged[0].role !== 'user') merged.shift();
  const contents = merged.map(t => ({ role: t.role, parts: [{ text: t.text }] }));

  const res = await post(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents,
        generationConfig: { temperature: 0.4, maxOutputTokens: 400 },
        safetySettings: []
      })
    }
  );

  if (res.status === 429) throw Object.assign(new Error('gemini rate limited'), { code: 'rate_limited' });
  if (!res.ok) throw Object.assign(new Error(`gemini ${res.status}: ${await res.text()}`), { code: 'upstream' });

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('').trim();
  if (!text) throw Object.assign(new Error('gemini empty'), { code: 'empty' });
  return text;
}

async function callGroq(system, history, userText) {
  if (!GROQ_API_KEY) throw Object.assign(new Error('no groq key'), { code: 'no_key' });

  const messages = [
    { role: 'system', content: system },
    ...history.map(m => ({ role: m.direction === 'in' ? 'user' : 'assistant', content: m.text })),
    { role: 'user', content: userText }
  ];

  const res = await post('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ_API_KEY}` },
    body: JSON.stringify({ model: GROQ_MODEL, messages, temperature: 0.4, max_tokens: 400 })
  });

  if (res.status === 429) throw Object.assign(new Error('groq rate limited'), { code: 'rate_limited' });
  if (!res.ok) throw Object.assign(new Error(`groq ${res.status}`), { code: 'upstream' });

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw Object.assign(new Error('groq empty'), { code: 'empty' });
  return text;
}

/**
 * Try Gemini, fall back to Groq, then to the canned line.
 * Returns { text, model }.
 */
export async function generateReply(cfg, history, userText, log = console) {
  const system = buildPrompt(cfg);

  for (const [name, fn] of [['gemini', callGemini], ['groq', callGroq]]) {
    try {
      const text = await fn(system, history, userText);
      return { text, model: name };
    } catch (e) {
      if (e.code !== 'no_key') log.warn?.(`[ai] ${name} failed: ${e.message}`);
    }
  }

  return { text: cfg.runtime?.fallbackText || 'Thanks for your message! Our team will reply shortly.',
           model: 'fallback' };
}

/** One-shot helper used by the menu importer in the admin panel. */
export async function parseMenuText(raw) {
  const instruction =
    'Parse this cafe menu into structured data. Reply with ONLY a JSON array of objects with keys: ' +
    'category (string), name (string), desc (string, may be empty), price (number in BDT, or null). ' +
    'Keep item names exactly as written. Use the category headings in the text; infer sensible ones if absent. ' +
    'No markdown fences, no commentary.\n\nMENU TEXT:\n' + raw;

  let out;
  try { out = await callGemini('You output only valid JSON.', [], instruction); }
  catch {
    try { out = await callGroq('You output only valid JSON.', [], instruction); }
    catch { throw new Error('no AI provider available to parse the menu'); }
  }
  const m = out?.match(/\[[\s\S]*\]/);
  if (!m) throw new Error('no JSON array in reply');
  return JSON.parse(m[0]);
}
