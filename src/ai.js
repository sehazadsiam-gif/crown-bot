import { buildPrompt } from './prompt.js';

const {
  GEMINI_API_KEY, GEMINI_MODEL = 'gemini-3.5-flash',
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

  const modelsToTry = Array.from(new Set([GEMINI_MODEL, 'gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']));

  let lastError;
  for (const model of modelsToTry) {
    try {
      const res = await post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: system }] },
            contents,
            generationConfig: {
              temperature: 0.3,
              maxOutputTokens: 1000,
              thinkingConfig: { thinkingBudget: 0 }
            },
            safetySettings: []
          })
        }
      );

      if (res.status === 429) throw Object.assign(new Error('gemini rate limited'), { code: 'rate_limited' });
      if (!res.ok) {
        const errText = await res.text();
        if (res.status === 404) {
          lastError = new Error(`gemini model ${model} not found`);
          continue;
        }
        throw Object.assign(new Error(`gemini ${res.status}: ${errText}`), { code: 'upstream' });
      }

      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('').trim();
      if (!text) throw Object.assign(new Error('gemini empty'), { code: 'empty' });
      return text;
    } catch (e) {
      lastError = e;
      if (e.code === 'rate_limited') throw e;
    }
  }

  throw lastError || new Error('All gemini models failed');
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
  if (!raw || !raw.trim()) throw new Error('Menu text is empty');

  const instruction =
    'Parse this cafe menu into a JSON array of objects. ' +
    'Each object MUST have keys: ' +
    '"category" (string, e.g. "Hot Coffee", "Cold Coffee", "Food", "Dessert"), ' +
    '"name" (string, the item name), ' +
    '"desc" (string, description or ingredients if mentioned, otherwise empty string ""), ' +
    '"price" (number in BDT/Tk, or null if unlisted). ' +
    'Keep item names and categories organized as in the text. ' +
    'Output ONLY a valid JSON array.\n\nMENU TEXT:\n' + raw;

  let out = null;

  if (GEMINI_API_KEY) {
    const modelsToTry = Array.from(new Set([GEMINI_MODEL, 'gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite']));
    for (const model of modelsToTry) {
      try {
        const res = await post(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
            body: JSON.stringify({
              contents: [{ role: 'user', parts: [{ text: instruction }] }],
              generationConfig: {
                temperature: 0.1,
                maxOutputTokens: 8192,
                responseMimeType: 'application/json',
                thinkingConfig: { thinkingBudget: 0 }
              }
            })
          }
        );
        if (res.ok) {
          const data = await res.json();
          out = data?.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('').trim();
          if (out) break;
        }
      } catch {}
    }
  }

  if (!out && GROQ_API_KEY) {
    try {
      out = await callGroq('You output only valid JSON.', [], instruction);
    } catch {}
  }

  if (!out) {
    try { out = await callGemini('You output only valid JSON.', [], instruction); }
    catch { throw new Error('No AI provider available to parse the menu.'); }
  }

  let cleaned = out.trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/\[[\s\S]*\]/);
    if (m) {
      try { parsed = JSON.parse(m[0]); } catch {}
    }
    if (!parsed) {
      const objMatch = cleaned.match(/\{[\s\S]*\}/);
      if (objMatch) {
        try {
          const obj = JSON.parse(objMatch[0]);
          parsed = obj.menu || obj.items || obj.rows || Object.values(obj).find(v => Array.isArray(v));
        } catch {}
      }
    }
  }

  if (!Array.isArray(parsed) && parsed && typeof parsed === 'object') {
    parsed = parsed.items || parsed.menu || parsed.rows || Object.values(parsed).find(v => Array.isArray(v));
  }

  if (!Array.isArray(parsed) || !parsed.length) {
    throw new Error('Could not extract menu items from text. Please paste the text clearly.');
  }

  return parsed.map(item => ({
    category: String(item.category || 'General').trim(),
    name: String(item.name || '').trim(),
    desc: String(item.desc || '').trim(),
    price: (item.price != null && !isNaN(+item.price)) ? +item.price : null
  })).filter(item => item.name.length > 0);
}
