# Crown Coffee Bot — Project Record

Facebook & Instagram auto-reply bot for Crown Coffee, Uttara, Dhaka.
Self-hosted on Contabo VPS via Coolify.

---

## 1. Decisions made

| Question | Decision | Why |
|---|---|---|
| Platforms | Facebook + Instagram only | WhatsApp starts charging for service messages 1 Oct 2026; FB/IG stay free |
| AI model | Gemini Flash primary, Groq fallback, canned text last | Only free option that handles Bangla + Banglish |
| Local model (Ollama) | Rejected | VPS has 7.8 GB RAM with ~4.3 GB used by Supabase; 3–4B models are poor at Bangla |
| Stack | Node + SQLite + Fastify | 20 msgs/day doesn't justify Redis/Postgres/queues |
| Hosting | Coolify (already installed) | Was already running on the box |
| Domain | `bot.ccadmin.online` | Root `ccadmin.online` already claimed by `crowncoffeeinventory` |
| Order/reservation handling | Draft mode — bot collects, human confirms | A confirmed order the kitchen never saw is worse than a 2-min wait |
| Complaints/refunds/allergies | Acknowledge once, then flag for human | AI must never promise refunds or give allergy advice |
| Tone | Polite and professional, warm but not chatty, no emoji | Formal register reads badly in Banglish |
| Language | Mirror the customer exactly | Never convert Banglish to Bangla script |

---

## 2. Architecture

```
Meta webhook (FB/IG)
   ↓ verify HMAC signature (X-Hub-Signature-256)
   ↓ return 200 immediately
   ↓ (async, serialized per sender)
skip echoes + duplicate message IDs
   ↓
store message, look up conversation
   ↓
escalation keyword? → flag thread
   ↓
compile prompt (config + live Dhaka time + menu + FAQs + guardrails)
   ↓
Gemini → on failure Groq → on failure canned line
   ↓
send via Graph API, store reply
```

### Files

```
crown-bot/
├── src/server.js      Fastify: auth, admin API, /webhook/meta
├── src/db.js          SQLite schema + queries
├── src/prompt.js      Config → system prompt compiler
├── src/ai.js          Gemini → Groq → fallback chain
├── src/meta.js        Graph API send + signature verify
├── public/index.html  Admin panel (single file)
├── scripts/hash.js    bcrypt password generator
├── Dockerfile         Multi-stage, node:22-slim
├── docker-compose.yml Declares crown-data volume
└── docs/              Caddyfile + systemd unit (non-Coolify path)
```

### Routes

| Route | Purpose |
|---|---|
| `/` | Redirects to `/chatbotadmin/` |
| `/chatbotadmin/*` | Admin panel + API (session auth) |
| `/webhook/meta` | Meta webhook (GET verify, POST events) |
| `/chatbotadmin/api/health` | Healthcheck, no auth |

---

## 3. Admin panel tabs

| Tab | Function |
|---|---|
| Dashboard | Global kill switch, activity stats, off-hours behaviour |
| Inbox | All threads, flagged first, per-thread bot toggle, manual reply |
| Cafe Info | Address, hours, facilities — the facts the bot may state |
| Menu | Categories, items, prices, **per-item availability toggle** |
| FAQs | Your own answers, override model guesses |
| Persona | Tone, length, emoji, language-mirroring rule |
| Scope & Limits | Autonomy tiers, guardrails, escalation keywords |
| Compiled Prompt | Exactly what the model receives — read this when debugging |
| Playground | Chat with the bot using the real provider, no Meta involved |
| Setup | Health check + webhook URL |

The Menu tab has an **Import from text** box that parses a pasted menu into
structured items via the AI.

---

## 4. Infrastructure state

| Item | Value |
|---|---|
| VPS IP | `169.58.136.137` |
| Host | Contabo, Ubuntu 24.04, 7.8 GB RAM, 4 cores, 100 GB disk |
| Swap | 4 GB added (was 0) |
| Snapshot | `clean-before-coolify` taken |
| Coolify | v4.3.23, already installed, at `http://169.58.136.137:8000` |
| Also running | Supabase stack (~4.3 GB RAM), coolify-proxy owns ports 80/443 |
| Registrar | Hostinger |
| DNS | `ccadmin.online` → A → 169.58.136.137 |
| DNS | `bot.ccadmin.online` → A → 169.58.136.137 |
| Firewall | Contabo firewall `crown-bot`, ports 22/80/443/8000 |
| GitHub repo | `github.com/sehazadsiam-gif/crown-bot` |
| Coolify project | `crown-coffee` / `production` |

### Coolify config

```
Build Pack:               Docker Compose
Base directory:           /
Docker compose location:  /docker-compose.yml     ← NOT .yaml
Branch:                   main
Domain:                   https://bot.ccadmin.online
Health check path:        /chatbotadmin/api/health
Port:                     3000
```

### Environment variables

```dotenv
PUBLIC_URL=https://bot.ccadmin.online
SESSION_SECRET=          # openssl rand -hex 32
ADMIN_EMAIL=
ADMIN_PASSWORD_HASH=     # node scripts/hash.js "password"
GEMINI_API_KEY=          # aistudio.google.com/apikey — NO BILLING
META_VERIFY_TOKEN=       # invent any string, reuse in Meta form

# Fill in later, during Meta setup:
META_APP_SECRET=
FB_PAGE_TOKEN=
FB_PAGE_ID=
IG_TOKEN=
IG_USER_ID=
IG_GRAPH_HOST=https://graph.instagram.com
```

`PORT`, `HOST` and `BASE_PATH` are fixed in the compose file. Never set
`HOST=127.0.0.1` in a container — the proxy can't reach it.

---

## 5. Bugs found and fixed

An IDE agent reviewed the code; these were real and are now fixed and tested.

| # | File | Bug |
|---|---|---|
| 1 | `ai.js` | Gemini requires alternating user/model turns. Two customer messages in a row caused a 400 and silent fallback. Now merges consecutive same-role turns. |
| 2 | `ai.js` | `parseMenuText` crashed with a TypeError when both providers failed. |
| 3 | `meta.js` | Instagram host hardcoded. Now `IG_GRAPH_HOST` env var — depends on login path. |
| 4 | `meta.js` | Instagram rejects `messaging_type`. Now Messenger-only. |
| 5 | `meta.js` | `verifySignature` crashed on an undefined body. Now returns 401. |
| 6 | `server.js` | `decorateReply: false` meant `reply.sendFile` never existed; deep links 404'd. |
| 7 | `server.js` | Added startup guard for `ADMIN_EMAIL`/`ADMIN_PASSWORD_HASH`; hardened login comparison. |
| 8 | `server.js` | Concurrent webhook events raced. Now one promise chain per sender. |
| 9 | `db.js` | `stats()` used UTC, so "today" rolled over at 6am Dhaka. |

Verify they're present:

```bash
grep -c "merged" src/ai.js          # want 5
grep -c "IG_GRAPH_HOST" src/meta.js # want 3
grep -c "enqueue" src/server.js     # want 2
grep -c "decorateReply" src/server.js # want 0
```

---

## 6. Current status

**Done:** snapshot, DNS (both records), firewall, swap, Coolify installed,
repo pushed with fixes, Coolify app configured, **first deploy succeeded**,
`crown-data` volume created.

**Blocked on:** container shows `Restarting`, and
`https://bot.ccadmin.online/chatbotadmin` returns `no available server`.
That means Traefik found the route but the container isn't healthy —
a crash loop.

**Next action:** open Coolify → **Runtime Logs**. Most likely cause is an
empty `ADMIN_EMAIL` or `ADMIN_PASSWORD_HASH` hitting the startup guard.

**Still to do after that:**
1. Enter the menu (Menu tab → Import from text) — *menu still not provided*
2. Test in Playground
3. Connect Facebook (Meta app → Messenger → tokens → webhook)
4. Connect Instagram
5. Meta Business Verification (1–4 weeks — start early)

---

## 7. Meta setup (later)

### Facebook
1. developers.facebook.com → Create App → **Business**
2. Add **Messenger** product
3. Messenger → Settings → connect Page → **Generate Token** → `FB_PAGE_TOKEN`
4. Page numeric ID → `FB_PAGE_ID`
5. Settings → Basic → App Secret → `META_APP_SECRET`
6. Webhooks → Add Callback URL: `https://bot.ccadmin.online/webhook/meta`
   Verify token: your `META_VERIFY_TOKEN`
7. Subscribe to the **`messages`** field, subscribe the Page
8. Redeploy in Coolify

Until App Review, only people with a role on the app receive replies.

### Instagram
Business or Creator account. Same webhook URL, field `messages`,
scope `instagram_business_manage_messages`.

If sends fail with an endpoint error, flip `IG_GRAPH_HOST` to
`https://graph.facebook.com`.

---

## 8. Verification commands

```bash
# DNS
dig +short bot.ccadmin.online          # → 169.58.136.137

# Root redirect
curl -sIL https://bot.ccadmin.online | grep -i location

# Webhook verify — must print exactly: test
curl "https://bot.ccadmin.online/webhook/meta?hub.mode=subscribe&hub.verify_token=YOUR_TOKEN&hub.challenge=test"

# Server
docker ps --format "{{.Names}}" | grep crown
free -h
```

---

## 9. Troubleshooting

| Symptom | Cause |
|---|---|
| `no available server` | Container unhealthy/crash-looping. Check Runtime Logs. |
| `Restarting` status | Usually a missing env var hitting the startup guard. |
| Panel 404s, webhook unreachable | Coolify domain set to a path. Use the root domain; the app routes internally. |
| Menu empty after redeploy | `crown-data` volume missing. Check Storages. |
| Build fails on `better-sqlite3` | Wrong build pack. Use Docker Compose. |
| 401 bad signature | `META_APP_SECRET` wrong or missing. |
| Replies say "team will reply shortly" | Both AI providers failed — usually a bad `GEMINI_API_KEY`. |
| Bot invents prices | Menu is empty. Guardrails block unlisted items by design. |
| Login screen loops locally | `PUBLIC_URL` starts with `https` over plain HTTP → Secure cookie not sent. |

---

## 10. Costs

| Item | Cost |
|---|---|
| Facebook + Instagram messaging | Free |
| Gemini free tier | Free — do **not** enable billing on that project |
| Groq fallback | Free |
| VPS + domain | Already paid |

Gemini's free tier uses prompts to improve Google's products. Fine for menu
questions; worth revisiting if messages ever carry sensitive data.

Free-tier limits vary by model and change often — check AI Studio rather than
trusting a fixed number. ~20 msgs/day is far inside any published limit.

---

## 11. Backups

Everything lives in `/app/data/crown.db` inside the `crown-data` volume.

```bash
docker exec <container> sh -c "cd /app/data && cp crown.db backup.db"
docker cp <container>:/app/data/backup.db ./
```

The Contabo snapshot is a whole-disk rollback, not a data backup — restoring
it reverts everything written since.
