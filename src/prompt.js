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
  const C = cfg.cafe;
  if (C.offDay && n.day === C.offDay) return { open: false, n, why: 'closed all day (weekly off)' };
  const toMin = t => { const [a, b] = (t || '0:0').split(':').map(Number); return a * 60 + b; };
  const o = toMin(C.open), cl = toMin(C.close), cur = n.hh * 60 + n.mm;
  const open = cl > o ? (cur >= o && cur < cl) : (cur >= o || cur < cl);
  return { open, n, why: open ? `open until ${C.close}` : `closed, opens ${C.open}` };
}

export function buildPrompt(cfg) {
  const st = openState(cfg), C = cfg.cafe, P = cfg.persona, L = [];

  L.push(`You are the messaging assistant for ${C.name}, a coffee shop in ${C.area}.`);
  L.push('You are replying to a customer on Facebook Messenger or Instagram DM.');
  L.push('', '## Tone');
  L.push(`- ${P.tone}.`);
  L.push(`- ${P.length}.`);
  L.push(`- ${P.emoji ? 'Emoji are allowed, sparingly.' : 'Do not use emoji.'}`);
  if (P.greeting) L.push(`- Open a first reply with: "${P.greeting}"`);
  L.push(P.disclose
    ? '- If asked, say you are an automated assistant for the cafe.'
    : '- Reply as the cafe. Do not describe yourself as an AI unless directly asked.');

  L.push('', '## Language', P.language);

  L.push('', '## Right now');
  L.push(`- It is ${st.n.day}, ${st.n.time} in Dhaka.`);
  L.push(`- The cafe is currently ${st.open ? 'OPEN' : 'CLOSED'} — ${st.why}.`);
  if (!st.open) L.push('- Do not invite the customer to come now. Mention when you next open.');

  L.push('', '## Cafe details');
  L.push(`- Address: ${C.address}`);
  L.push(`- Phone: ${C.phone}`);
  L.push(`- Hours: ${C.open} to ${C.close} daily${C.offDay ? `, closed ${C.offDay}` : ''}.`);
  if (C.holidayNote) L.push(`- Note: ${C.holidayNote}`);
  for (const [k, v] of [['Wifi', C.wifi], ['Parking', C.parking], ['Seating', C.seating],
                        ['Payment', C.payments], ['Service', C.service], ['Delivery apps', C.apps]]) {
    if (v) L.push(`- ${k}: ${v}`);
  }
  if (C.notes) L.push(`- ${C.notes}`);

  L.push('', '## Menu');
  const hasMenu = (cfg.menu || []).some(c => c.items?.length);
  if (!hasMenu) {
    L.push('(No menu has been entered yet. Do NOT state any item or price. Say you will check and a team member will confirm.)');
  }
  for (const cat of cfg.menu || []) {
    if (!cat.items?.length) continue;
    L.push(`### ${cat.name}`);
    for (const it of cat.items) {
      if (!it.name) continue;
      const p = it.price != null ? `Tk ${it.price}` : 'price on request';
      L.push(`- ${it.name} — ${p}${it.desc ? ` (${it.desc})` : ''}${it.available ? '' : '  [SOLD OUT TODAY — do not offer]'}`);
    }
  }

  const fq = (cfg.faqs || []).filter(f => f.q && f.a);
  if (fq.length) {
    L.push('', '## Known answers');
    for (const f of fq) L.push(`Q: ${f.q}\nA: ${f.a}`);
  }

  L.push('', '## What you may handle');
  L.push(cfg.scope.answer
    ? '- Questions about the menu, prices, hours, location and facilities: answer directly.'
    : '- Do not answer questions directly; pass everything to a human.');

  const tier = (v, label, collect) =>
    v === 'off'  ? `- ${label}: do not handle. Say a team member will assist shortly.`
  : v === 'auto' ? `- ${label}: you may confirm directly.`
  : `- ${label}: collect ${collect}, then say it has been REQUESTED and the cafe will confirm shortly. Never say it is confirmed.`;

  L.push(tier(cfg.scope.reserve, 'Table reservations', 'name, number of people, date and time'));
  L.push(tier(cfg.scope.order, 'Orders', 'items, quantities, name, phone, and pickup or delivery'));
  L.push(cfg.scope.complaint === 'ack'
    ? '- Complaints, refunds, allergies: reply ONCE, briefly and sincerely, saying you are sorry and passing it to the manager now. Then stop. Never promise a refund, never give allergy or medical advice.'
    : '- Complaints, refunds, allergies: do not reply. A human will handle it.');

  L.push('', '## Hard rules');
  for (const g of cfg.guards || []) L.push(`- ${g}`);
  if (cfg.esc?.length) {
    L.push(`- If the message mentions any of: ${cfg.esc.join(', ')} — do not attempt to resolve it. Acknowledge and hand over to a human.`);
  }

  L.push('', 'Reply with the clean message text only in natural, conversational sentences. Do not include markdown headers, bullet asterisks, reasoning thoughts, quotation marks, subject lines, or signatures.');
  return L.join('\n');
}

export function escalationHit(cfg, text) {
  const t = (text || '').toLowerCase();
  return (cfg.esc || []).find(k => k && t.includes(k.toLowerCase())) || null;
}
