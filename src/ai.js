import 'dotenv/config';
import { buildPrompt } from './prompt.js';
import { getIndustryPresets } from './db.js';

const getEnv = () => ({
  geminiKey: process.env.GEMINI_API_KEY,
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.5-flash',
  groqKey: process.env.GROQ_API_KEY,
  groqModel: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile'
});

const TIMEOUT = 25_000;

async function post(url, opts) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); }
  finally { clearTimeout(t); }
}

/* history: [{direction:'in'|'out', text}] oldest first */
async function callGemini(system, history, userText) {
  const { geminiKey, geminiModel } = getEnv();
  if (!geminiKey) throw Object.assign(new Error('no gemini key'), { code: 'no_key' });

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

  const modelsToTry = Array.from(new Set([geminiModel, 'gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']));

  let lastError;
  for (const model of modelsToTry) {
    try {
      const res = await post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey },
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

      if (!res.ok) {
        const errText = await res.text();
        lastError = new Error(`gemini model ${model} failed (${res.status}): ${errText}`);
        continue;
      }

      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('').trim();
      if (!text) {
        lastError = new Error(`gemini model ${model} returned empty output`);
        continue;
      }
      return text;
    } catch (e) {
      lastError = e;
    }
  }

  throw lastError || new Error('All gemini models failed');
}

async function callGroq(system, history, userText) {
  const { groqKey, groqModel } = getEnv();
  if (!groqKey) throw Object.assign(new Error('no groq key'), { code: 'no_key' });

  const messages = [
    { role: 'system', content: system },
    ...history.map(m => ({ role: m.direction === 'in' ? 'user' : 'assistant', content: m.text })),
    { role: 'user', content: userText }
  ];

  const res = await post('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${groqKey}` },
    body: JSON.stringify({ model: groqModel, messages, temperature: 0.4, max_tokens: 400 })
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
/**
 * Detect the primary language of a customer message.
 * Returns: 'bn' (Bengali script), 'banglish' (romanized Bengali), or 'en' (English/default)
 */
export function detectLanguage(text) {
  if (!text || typeof text !== 'string') return 'en';
  // Bengali Unicode range U+0980-U+09FF
  const bengaliChars = (text.match(/[\u0980-\u09FF]/g) || []).length;
  const totalChars = text.replace(/\s/g, '').length || 1;
  if (bengaliChars / totalChars > 0.15) return 'bn';

  // Common Banglish words and patterns
  const banglishWords = /\b(ami|tumi|apni|amar|tomar|apnar|ache|nei|hoye|koro|korte|kibhabe|ki|kemon|bolo|bolun|diyeche|lagbe|hobe|nibo|deben|jacchi|jachchi|jabe|ashbo|asho|asha|bhalo|kharap|sundor|dhanybad|shukriya|jee|haa|na|nai|thako|thakun|kothay|koi|achho|achhen|onek|ektu|ekta|koto|kotota|beshi|kom|shundor|mishti|gororm|thanda|khabo|khaibo|order|dicho|dao|pls|plz|plss)\b/i;
  if (banglishWords.test(text)) return 'banglish';

  return 'en';
}

export async function generateReply(cfg, history, userText, log = console, lang = 'en') {
  const system = buildPrompt(cfg, lang);

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
  const { geminiKey, geminiModel, groqKey } = getEnv();

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

  if (geminiKey) {
    const modelsToTry = Array.from(new Set([geminiModel, 'gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite']));
    for (const model of modelsToTry) {
      try {
        const res = await post(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey },
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

  if (!out && groqKey) {
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

/**
 * AI FAQ Generator:
 * Given a business type, name, services, and location, automatically generates
 * high-value, realistic FAQs for instant bot training.
 */
export async function suggestFaqsForBusiness({ businessType, businessName, services, location }) {
  const bType = businessType || 'General Business';
  const bName = businessName || 'Our Business';
  const preset = getIndustryPresets(bName, bType, services);
  const bServices = services || preset.serviceDesc || 'General products and services';
  const bLoc = location || 'Dhaka, Bangladesh';

  const prompt = `You are a world-class senior operations and customer experience consultant specializing in ${bType}.
A client has registered a new business on our multi-channel conversational AI operations hub.

Business Name: ${bName}
Profession / Industry: ${bType}
Services Provided: ${bServices}
Location / Area: ${bLoc}

Generate 6 realistic, highly useful, authoritative, and professional Frequently Asked Questions (FAQs) and detailed official answers tailored specifically to this profession (${bType}).

Ensure you address real questions customers or patients actually ask for this exact profession, such as:
1. Core services, clinical/technical procedures, packages, and scope of work for ${bType}.
2. How to book an appointment, reserve a slot, schedule a consultation, or place an order.
3. Pricing, fee estimates, consultations charges, and accepted payment methods (Cash, Cards, bKash, Nagad).
4. Operating hours, location address, and service availability.
5. Turnaround time, delivery timeframe, or cancellation and rescheduling policy.
6. Emergency procedures, urgent inquiries, warranties, hygiene/safety standards, or custom requests.

Output ONLY a valid JSON array of objects with the exact keys "q" (question string) and "a" (answer string).
DO NOT use emojis anywhere in the questions or answers.
Make answers natural, professional, trustworthy, and directly informative.`;

  let out = null;
  const { geminiKey, geminiModel, groqKey } = getEnv();

  if (geminiKey) {
    const modelsToTry = Array.from(new Set([geminiModel, 'gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite']));
    for (const model of modelsToTry) {
      try {
        const res = await post(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey },
            body: JSON.stringify({
              contents: [{ role: 'user', parts: [{ text: prompt }] }],
              generationConfig: {
                temperature: 0.2,
                maxOutputTokens: 2048,
                responseMimeType: 'application/json'
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

  if (!out && groqKey) {
    try {
      out = await callGroq('You output only valid JSON.', [], prompt);
    } catch {}
  }

  if (!out) {
    return preset.faqs && preset.faqs.length ? preset.faqs : [
      { q: `What services does ${bName} offer?`, a: `We specialize in ${bServices}. Contact us anytime to learn more about our packages.` },
      { q: `How can I place an order or book an appointment?`, a: `You can send us a message here with your requested items/services, name, and contact details. Our team will review and confirm with you shortly.` },
      { q: `What are your accepted payment methods?`, a: `We accept Cash, Cards (Visa, Mastercard), bKash, and Nagad.` },
      { q: `Where are you located and what are your hours?`, a: `We are located in ${bLoc}. We operate during standard business hours. Feel free to message us anytime.` },
      { q: `Can I get a custom quote for specific requirements?`, a: `Yes, please share your specific requirements and contact number, and our team will get in touch with a customized quote.` },
      { q: `What is your cancellation or rescheduling policy?`, a: `Please inform us at least 2 to 4 hours in advance so we can accommodate your schedule smoothly.` }
    ];
  }

  let cleaned = out.trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    const parsed = JSON.parse(cleaned);
    const arr = Array.isArray(parsed) ? parsed : (parsed.faqs || parsed.questions || Object.values(parsed).find(v => Array.isArray(v)));
    if (Array.isArray(arr) && arr.length) {
      return arr.map(item => ({
        q: String(item.q || item.question || '').trim(),
        a: String(item.a || item.answer || '').trim()
      })).filter(item => item.q && item.a);
    }
  } catch {}

  return preset.faqs && preset.faqs.length ? preset.faqs : [
    { q: `What services does ${bName} offer?`, a: `We specialize in ${bServices}. Contact us to learn more.` },
    { q: `How can I place an order or book an appointment?`, a: `Send us a message with your request, name, and contact info, and our team will confirm shortly.` },
    { q: `What payment methods do you accept?`, a: `We accept Cash, Cards, bKash, and Nagad.` },
    { q: `What are your operating hours?`, a: `We operate during regular business hours throughout the week.` }
  ];
}

/**
 * Detects if a customer message is an order, service booking, or reservation inquiry.
 */
export async function detectOrderOrInquiry(text, history = []) {
  if (!text || text.trim().length < 3) return null;
  const userText = String(text).trim();
  const lower = userText.toLowerCase();

  const orderKeywords = [
    'order', 'buy', 'purchase', 'want', 'need', 'book', 'booking', 'appointment', 'reserve', 'reservation',
    'takeaway', 'parcel', 'deliver', 'delivery', 'send me', 'please send', 'how much for', 'price for',
    'অর্ডার', 'বুকিং', 'কিনতে চাই', 'নিতে চাই', 'পাঠান'
  ];
  const hasKeyword = orderKeywords.some(k => lower.includes(k));
  if (!hasKeyword) return null;

  const prompt = `Analyze this customer message in a business messaging channel.
Customer message: "${userText}"
Recent history: ${JSON.stringify(history.slice(-4))}

Determine if the customer is requesting to place an order, book an appointment/reservation, or initiate a serious service request.
If YES, extract:
- is_order: true
- kind: "order" (for purchasing goods/food), "booking" (for services/appointments/reservations), or "inquiry" (detailed request for quotation)
- details: Clear summary of items or services requested, including quantities or specifics if mentioned.
- customer_name: Full name if provided, or empty string.
- customer_phone: Phone number if provided, or empty string.
- customer_address: Address or delivery location if provided, or empty string.
- estimated_total: Price or total estimate if obvious, or empty string.

If NO (it is just a general question, casual greeting, or simple FAQ inquiry):
- is_order: false

Output ONLY a valid JSON object. No emojis, no markdown wrappers.`;

  try {
    const { geminiKey, geminiModel } = getEnv();
    if (!geminiKey) {
      if (hasKeyword && (lower.includes('order') || lower.includes('book') || lower.includes('want'))) {
        return {
          is_order: true,
          kind: lower.includes('book') ? 'booking' : 'order',
          details: userText,
          customer_name: '',
          customer_phone: '',
          customer_address: '',
          estimated_total: ''
        };
      }
      return null;
    }

    const res = await post(
      `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel || 'gemini-3.5-flash'}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 512,
            responseMimeType: 'application/json'
          }
        })
      }
    );

    if (res.ok) {
      const data = await res.json();
      const rawText = data?.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('').trim();
      if (rawText) {
        const parsed = JSON.parse(rawText);
        if (parsed.is_order) {
          return {
            is_order: true,
            kind: parsed.kind || 'order',
            details: parsed.details || userText,
            customer_name: parsed.customer_name || '',
            customer_phone: parsed.customer_phone || '',
            customer_address: parsed.customer_address || '',
            estimated_total: parsed.estimated_total || ''
          };
        }
      }
    }
  } catch {}

  return null;
}
