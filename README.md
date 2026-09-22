# Crown Coffee — Facebook & Instagram auto-reply bot

Self-hosted. Admin panel at `https://ccadmin.online/chatbotadmin`, Meta webhook at
`https://ccadmin.online/webhook/meta`.

Node + SQLite + Fastify. No Redis, no Postgres, no Docker required. Around 120 MB RAM.

---

## 1. Point the domain at your VPS

In your DNS provider add an **A record**:

```
ccadmin.online   A   <your Contabo IPv4>
```

Check it: `dig +short ccadmin.online`

## 2. Deploy in Coolify

Coolify runs its own proxy and issues the TLS certificate, so there is no Caddy
or systemd setup. (Those files are in `docs/` if you ever move off Coolify.)

1. Push this folder to a Git repo Coolify can read.
2. **New Resource -> Application**.
3. **Build Pack: Docker Compose**, compose file `docker-compose.yml`.

   Compose is the safer choice because the persistent volume is declared in the
   file. With the plain Dockerfile build pack you must remember to add the
   volume by hand in the UI, and forgetting it silently destroys your data on
   the next deploy.

4. **Domain:** `https://ccadmin.online`

   Set the **root domain, not a path.** Do not enter
   `https://ccadmin.online/chatbotadmin`. The app routes internally: `/`
   redirects to the panel, `/chatbotadmin/*` is the panel, and `/webhook/meta`
   is Meta's endpoint. Path-based routing in Coolify would forward only one of
   those and Meta's webhook would break.

5. **Port:** `3000`
6. **Health check path:** `/chatbotadmin/api/health`

## 3. Environment variables

Coolify -> your app -> **Environment Variables**. Add as *runtime* variables:

| Variable | Value |
|---|---|
| `PUBLIC_URL` | `https://ccadmin.online` |
| `SESSION_SECRET` | output of `openssl rand -hex 32` |
| `ADMIN_EMAIL` | your login email |
| `ADMIN_PASSWORD_HASH` | see below |
| `GEMINI_API_KEY` | from <https://aistudio.google.com/apikey> |
| `META_VERIFY_TOKEN` | any random string you invent |
| `META_APP_SECRET` | Meta App Dashboard -> Settings -> Basic |
| `FB_PAGE_TOKEN`, `FB_PAGE_ID` | after step 7 |
| `IG_TOKEN`, `IG_USER_ID` | after step 8 |
| `GROQ_API_KEY` | optional fallback |

Generate the password hash locally (needs Node):

```bash
npm install bcryptjs
node scripts/hash.js "your-password"
```

Keep secrets in Coolify's UI, never committed to the repo.

`PORT`, `HOST` and `BASE_PATH` are already fixed in the compose file. Do not
override `HOST` to `127.0.0.1` — inside a container that makes the app
unreachable from Coolify's proxy.

## 4. Persistent storage — do not skip this

Everything lives in one SQLite file at **`/app/data/crown.db`**: menu, cafe
info, persona, guardrails and every conversation.

The compose file mounts a named volume `crown-data` there. Confirm it appears
under **Storages** in Coolify after the first deploy. If it is missing, add it
before entering any real data:

```
Name:         crown-data
Mount path:   /app/data
```

Without it, a redeploy resets you to an empty menu.

## 5. Deploy and check

Hit **Deploy**. The first build takes a few minutes — `better-sqlite3` compiles
a native module.

Then:

```bash
# should redirect to the panel
curl -sIL https://ccadmin.online | grep -i location

# should print: test
curl "https://ccadmin.online/webhook/meta?hub.mode=subscribe&hub.verify_token=YOUR_TOKEN&hub.challenge=test"
```

Open `https://ccadmin.online/chatbotadmin` and sign in.

## 6. Redeploying safely

Config and conversations live in the volume, not the image, so push and
redeploy keeps everything. Back up before major changes:

```bash
docker exec <container> sh -c "cd /app/data && cp crown.db backup.db"
docker cp <container>:/app/data/backup.db ./
```

## 7. Connect Facebook

There are 3 supported ways to connect a Facebook Page to Crown Bot:

### Option 1: 30-Second Page Invite / "Task Access" (Recommended Alternative for Clients)
Best for non-technical clinic, salon, or store owners who do not want to manage Meta Developer tools:
1. **Tenant Action (30 seconds):**
   - Open Facebook Page → **Settings & Privacy** → **Settings** → **New Pages Experience** → **Page Access**.
   - Under **People with Task Access**, click **Add New**.
   - Enter your agency Facebook account or email (`admin@crowncoffee.com`).
   - Toggle **Messages** access to **ON** and confirm with password.
2. **Master Admin Action:**
   - Your agency Meta App (configured on the server) generates a permanent Page Access Token for the page.
   - In Master Admin → **Tenants Directory** → **Inspect Client Bot** → **Connect Channels**, paste the token and click **Test Facebook Ping**.
   - Crown Bot auto-detects the Page ID, subscribes webhooks, and activates AI replies immediately.

### Option 2: 1-Click Meta Connect (Direct OAuth)
- From the **Connect Channels** tab, the tenant or admin clicks **Connect Facebook Page**.
- Meta launches the standard permissions dialogue to authorize the page.
- Tokens and webhook subscriptions are synchronized automatically.

### Option 3: Manual Meta Developer Console Setup (Advanced / Self-Hosted)
1. <https://developers.facebook.com> → **Create App** → type **Business**.
2. Add the **Messenger** product.
3. Under *Messenger → Settings*, connect your Facebook Page and click
   **Generate Token**. Put it in `.env` as `FB_PAGE_TOKEN`. Put the Page's
   numeric ID in `FB_PAGE_ID`.
4. *Settings → Basic* → copy **App Secret** into `META_APP_SECRET`.
5. Under *Webhooks*, click **Add Callback URL**:
   - Callback URL: `https://ccadmin.online/webhook/meta`
   - Verify Token: the exact `META_VERIFY_TOKEN` string from your `.env`
6. Subscribe to the **`messages`** field, and subscribe your Page.
7. Redeploy or click **Test Facebook Ping** in the dashboard.

Message your Page from a different Facebook account to test.

**Until App Review, only people with a role on your app can get replies.**
Add yourself under *App Roles → Roles* to test.

## 8. Connect Instagram

Your Instagram account must be a **Business** or **Creator** account.

1. Add the **Instagram** product to the same app.
2. Use *Business Login for Instagram* to get an Instagram user access token →
   `IG_TOKEN`, and the account's numeric ID → `IG_USER_ID`.
3. Same webhook URL. Subscribe to the **`messages`** field for Instagram.
4. Redeploy.

## 9. App Review

For anyone outside your app's roles to receive replies you need **Advanced
Access**, which requires Business Verification (real company documents) plus a
screencast of the flow. Start this early — it is the long pole, not the code.

Permissions to request:
- `pages_messaging` (Facebook)
- `instagram_business_manage_messages` (Instagram)
- `pages_manage_metadata`

---

## Using the panel

| Tab | What it does |
|---|---|
| **Dashboard** | Global kill switch, activity counts, off-hours behaviour |
| **Inbox** | All threads. Flagged first. Per-thread bot toggle and manual reply |
| **Cafe Info** | Address, hours, facilities — the facts the bot may state |
| **Menu** | Categories, items, prices. **Availability toggle per item** |
| **FAQs** | Your own answers, which override the model's guesses |
| **Persona** | Tone, length, emoji, language mirroring rule |
| **Scope & Limits** | Autonomy tiers, guardrails, escalation keywords |
| **Compiled Prompt** | Exactly what the model receives. Read this when something goes wrong |
| **Playground** | Chat with your bot using the real provider. Does not touch Meta |
| **Setup** | Health check and the webhook URL to paste into Meta |

The **Import from text** box on the Menu tab sends your pasted menu to the AI
and turns it into structured items. Always check the prices afterwards.

## How a message flows

```
Meta webhook  →  verify HMAC signature  →  reply 200 immediately
                                              ↓ (async)
                    skip echoes and duplicate message IDs
                                              ↓
                    store message, look up conversation
                                              ↓
                    escalation keyword? → flag the thread
                                              ↓
                    compile prompt (config + live Dhaka time + menu)
                                              ↓
                    Gemini → on failure Groq → on failure canned line
                                              ↓
                    send via Graph API, store the reply
```

## Costs

| | |
|---|---|
| Facebook + Instagram messaging | Free |
| Gemini free tier | Free (limits vary by model — check AI Studio; do **not** enable billing on that project) |
| Groq fallback | Free |
| VPS | Already paid |
| Domain | Already paid |

At ~20 messages a day you are far inside even the most conservative published limit.

## Backups

Everything lives in the `crown-data` volume at `/app/data/crown.db`.

```bash
docker exec <container> sh -c "cd /app/data && cp crown.db backup.db"
```

Then `docker cp` it off the VPS. Worth a weekly cron job.

## Troubleshooting

**Webhook verification fails in Meta** — `META_VERIFY_TOKEN` must match exactly.
Test yourself:
```bash
curl "https://ccadmin.online/webhook/meta?hub.mode=subscribe&hub.verify_token=YOUR_TOKEN&hub.challenge=test"
```
Should print `test`.

**Panel 404s / webhook not reached** — the Coolify domain is set to a path.
Set it to the root `https://ccadmin.online` and let the app route internally.

**Menu empty after a redeploy** — the `crown-data` volume is missing. Check
Storages in Coolify.

**Build fails on `better-sqlite3`** — the Dockerfile installs `python3 make g++`
in the build stage. If you switched to the Nixpacks build pack, switch back to
Docker Compose.

**401 bad signature in the logs** — `META_APP_SECRET` is wrong or missing.

**Bot never replies** — check the Dashboard kill switch, then the per-thread
toggle in the Inbox, then the Logs tab in Coolify.

**Replies say "our team will reply shortly"** — both providers failed. Usually a
missing or invalid `GEMINI_API_KEY`.

**Bot invents prices** — your menu is empty or the item is missing. The guardrails
stop it quoting anything not listed; add the item.

## Security notes

- The container is only reachable through Coolify's proxy, which terminates TLS.
- Login is rate-limited to 8 attempts per IP per 15 minutes.
- Session cookies are HMAC-signed, HttpOnly, SameSite=Lax, scoped to `/chatbotadmin`.
- Webhook requests without a valid HMAC signature are rejected.
- Gemini's **free tier uses your prompts to improve Google's products**. Your
  customers' messages go through it. Fine for menu questions; consider the paid
  tier or Groq-only if that ever stops being acceptable.
