const TZ = 'Asia/Dhaka';

export function dhakaNow() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: TZ, weekday: 'long', hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(new Date()).map(p => [p.type, p.value])
  );
  return { day: parts.weekday, hh: +parts.hour, mm: +parts.minute, time: `${parts.hour}:${parts.minute}` };
}

export function openState(cfg) {
  const n = dhakaNow();
  const B = cfg.business || cfg.cafe || {};
  if (B.offDay && n.day === B.offDay) return { open: false, n, why: 'closed all day (weekly off)' };
  const toMin = t => { const [a, b] = (t || '0:0').split(':').map(Number); return a * 60 + b; };
  const o = toMin(B.open || '09:00'), cl = toMin(B.close || '21:00'), cur = n.hh * 60 + n.mm;
  const open = cl > o ? (cur >= o && cur < cl) : (cur >= o || cur < cl);
  return { open, n, why: open ? `open until ${B.close || '21:00'}` : `closed, opens ${B.open || '09:00'}` };
}

export function buildPrompt(cfg, lang = 'en') {
  const st = openState(cfg);
  const B = cfg.business || cfg.cafe || {};
  const P = cfg.persona || {};
  const L = [];

  const bName = B.name || 'Our Business';
  const bType = B.type || 'business';
  const bArea = B.area || '';
  const bServices = B.services || '';

  L.push(`You are the intelligent messaging assistant for ${bName}, a premier ${bType}${bArea ? ` located in ${bArea}` : ''}.`);
  if (bServices) {
    L.push(`Specialties & Services provided: ${bServices}`);
  }
  L.push('You are communicating with a customer across social and messaging channels (Facebook Messenger, Instagram DM, WhatsApp, TikTok, or Web Chat).');

  L.push('', '## Tone and Communication Style');
  L.push(`- Tone: ${P.tone || 'professional, helpful, welcoming, and clear'}.`);
  L.push(`- Length: ${P.length || '1 to 3 concise sentences, directly answering the customer inquiry'}.`);
  L.push('- Do NOT use emojis under any circumstance. Keep all messaging strictly clean and professional.');
  if (P.greeting) L.push(`- Initial greeting: "${P.greeting}"`);
  L.push(P.disclose
    ? `- If asked, state that you are the automated messaging assistant for ${bName}.`
    : `- Reply naturally as the team at ${bName}. Do not identify yourself as an AI unless explicitly asked.`);

  // Language-aware instruction
  L.push('', '## Language');
  if (lang === 'bn') {
    L.push('The customer is writing in Bengali (Bangla script). You MUST reply entirely in Bengali script (Unicode Bangla). Do not switch to English or Banglish.');
  } else if (lang === 'banglish') {
    L.push('The customer is writing in Banglish (romanized Bengali). You MUST reply in Banglish — using Bengali words written in English letters. Do not switch to English or Bengali script.');
  } else {
    L.push(P.language || 'Detect the customer language and respond in the same language (English, Banglish, or Bengali). Default to English if unclear.');
  }

  L.push('', '## Current Business Availability');
  L.push(`- Current local time: ${st.n.day}, ${st.n.time} (Dhaka time).`);
  L.push(`- Operational status: ${st.open ? 'OPEN' : 'CLOSED'} (${st.why}).`);
  if (!st.open) L.push('- When closed, politely inform the customer when operations next resume.');

  L.push('', '## Business Profile & Facilities');
  if (B.address) L.push(`- Address: ${B.address}`);
  if (B.phone) L.push(`- Contact Phone: ${B.phone}`);
  L.push(`- Operating Hours: ${B.open || '09:00'} to ${B.close || '21:00'}${B.offDay ? `, Closed on ${B.offDay}` : ''}.`);
  if (B.holidayNote) L.push(`- Operating Note: ${B.holidayNote}`);
  if (B.parking) L.push(`- Parking: ${B.parking}`);
  if (B.wifi) L.push(`- Wi-Fi: ${B.wifi}`);
  if (B.seating) L.push(`- Seating / Premises: ${B.seating}`);
  if (B.payments) L.push(`- Accepted Payment Methods: ${B.payments}`);
  if (B.service) L.push(`- Service Offering: ${B.service}`);
  if (B.apps) L.push(`- Online Platforms / Delivery: ${B.apps}`);
  if (B.notes) L.push(`- Additional Notes: ${B.notes}`);

  L.push('', '## Products, Services & Catalog');
  const catalog = cfg.catalog || cfg.menu || [];
  const hasItems = catalog.some(c => c.items?.length);
  if (!hasItems) {
    L.push('(No catalog items have been entered yet. Do not quote unlisted prices. Inform the customer you will check with the team to provide accurate options and pricing.)');
  } else {
    for (const cat of catalog) {
      if (!cat.items?.length) continue;
      L.push(`### ${cat.name}`);
      for (const it of cat.items) {
        if (!it.name) continue;
        const p = it.price != null ? `Tk ${it.price}` : 'price on request';
        L.push(`- ${it.name} — ${p}${it.desc ? ` (${it.desc})` : ''}${it.available ? '' : ' [UNAVAILABLE / SOLD OUT TODAY]'}`);
      }
    }
  }

  const fq = (cfg.faqs || []).filter(f => f.q && f.a);
  if (fq.length) {
    L.push('', '## Business Knowledge & FAQs');
    for (const f of fq) L.push(`Q: ${f.q}\nA: ${f.a}`);
  }

  L.push('', '## Inquiries, Orders and Service Requests');
  L.push(cfg.scope?.answer !== false
    ? '- Questions about services, products, pricing, hours, location, and facilities: answer directly using the details above.'
    : '- Do not answer questions directly; route everything to human staff.');

  L.push('', '## Strict Order and Booking Policy');
  L.push('- When a customer expresses intent to order products, book an appointment, or request a service:');
  L.push('  1. Politely collect all necessary details: specific items/services, quantity or package, customer full name, contact phone number, and delivery address or preferred appointment date/time.');
  L.push('  2. Once the customer provides details, acknowledge that their request has been logged and forwarded to the management team for review.');
  L.push('  3. CRITICAL MANDATE: NEVER tell the customer that their order, booking, or reservation is confirmed. Always state that our team will review and confirm it with them shortly.');

  if (cfg.scope?.complaint === 'ack') {
    L.push('- Complaints, disputes, refunds, and critical issues: reply once, with sincere apologies, stating that you have escalated the matter directly to management for immediate resolution. Never promise a refund or provide medical/legal advice.');
  } else {
    L.push('- Complaints, disputes, refunds: do not attempt to answer; leave for human management.');
  }

  L.push('', '## Core Safeguards');
  for (const g of cfg.guards || []) L.push(`- ${g}`);
  if (cfg.esc?.length) {
    L.push(`- If the message mentions any sensitive terms (${cfg.esc.join(', ')}): acknowledge politely and notify that management will assist directly.`);
  }

  L.push('', 'Format requirement: Output clean, conversational text only. Do not output markdown asterisks, bullet points, headers, bracketed reasoning, quotation marks around the entire message, or emojis.');
  return L.join('\n');
}

export function escalationHit(cfg, text) {
  const t = (text || '').toLowerCase();
  return (cfg.esc || []).find(k => k && t.includes(k.toLowerCase())) || null;
}
