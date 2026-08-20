# ActumAuto — Setup & Configuration

Everything you need to take the current code from "typechecks locally" to "answers a real call."
Ordered by dependency. See `PLAN.md` for the why behind each choice.

> **This system is INBOUND ONLY** — it answers the dealership's service line. It does not place
> calls or send SMS, so there is **no A2P 10DLC registration to wait on**.

---

## 0. Prerequisites
- Node 20+, npm.
- A GitHub repo (for Railway deploy).
- Accounts you'll create below: Supabase (Pro), Telnyx, Vapi, Anthropic, a TTS provider
  (Cartesia or Deepgram). myKaarma is **not** needed yet (booking runs in `soft` mode until you
  have it). Resend is optional — transactional email exists but nothing calls it yet.

---

## 1. Supabase project (the separate database)
1. Create a **new** Supabase project (its own, separate from any other product).
2. **Upgrade to Pro** and enable **PITR (Point-in-Time Recovery)** — `calls`/`transcripts` are
   unregenerable (PLAN.md §9).
3. **Run the migrations** in order, then the seed, in the SQL Editor (or `psql`):
   - `supabase/migrations/0001_init.sql`
   - ~~`0002_dispatch_rpcs.sql`~~ — **skip it.** Outbound-only RPCs; nothing calls them now.
     (Harmless if you run it; the numbering is kept so existing databases aren't disturbed.)
   - `supabase/migrations/0003_invite_expiry.sql`  (team invites need `invites.expires_at`)
   - `supabase/migrations/0004_inbound.sql`  (caller identification, services catalog, handoffs)
   - `supabase/seed.example.sql`  (buckets, `global_settings`, `create_workspace` RPC, Toyota schedule)

   There is **no migration tracking table and no CLI runner** — paste each file into the Supabase
   SQL Editor in this order, once. They are not idempotent: re-running `0001` on a populated
   database will error on objects that already exist. Verified end to end on a clean Postgres.
4. Grab these from **Project Settings**:
   - **Project URL** → `SUPABASE_URL` and (web) `NEXT_PUBLIC_SUPABASE_URL`
   - **service_role key** (Data API) → `SUPABASE_SERVICE_ROLE_KEY` (server only, never the browser)
   - **anon key** → (web) `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - **JWT secret** (Auth settings) → `SUPABASE_JWT_SECRET`
   - **Connection string → Session pooler (port 5432)** → `DATABASE_URL`
     - ⚠️ **Session mode, port 5432 — NOT transaction mode (6543).** pg-boss uses LISTEN/NOTIFY +
       long-lived connections that break *silently* in transaction mode (symptom: jobs never run).

### Create your first dealership
Sign up a user in Supabase Auth, then in the SQL editor run `select create_workspace('Milpitas Toyota','America/Los_Angeles');` **while authenticated as that user** (or insert `companies` + `memberships` by hand — see the commented block at the bottom of `seed.example.sql`).

---

## 2. Anthropic (the reasoning + BYO key)
1. Create an API key → `ANTHROPIC_API_KEY`.
2. Defaults are set for you (PLAN.md §15): `LLM_MODEL_CALL=claude-haiku-4-5-20251001` (live voice
   loop — cheap + low latency), `LLM_MODEL_OFFLINE=claude-sonnet-4-6` (analysis/QA/personality).
   The key is passed **into Vapi as a BYO key** so LLM spend skips Vapi's markup and lands on your
   own Anthropic bill under your spend caps.

---

## 3. Vapi (voice orchestrator)
1. Create a Vapi account → **API key** → `VAPI_API_KEY`.
2. Set a **server/webhook secret** → `VAPI_WEBHOOK_SECRET` (any strong random string). The webhook
   handler rejects anything without it.
3. After you deploy the API (step 8), Vapi's per-call `server.url` is set automatically by the code
   to `${APP_URL}/webhooks/vapi` with this secret — you don't configure it in the Vapi dashboard.
4. Import your Telnyx number(s) into Vapi (dashboard or API) so each gets a **Vapi phone-number id**;
   store that id on the `phone_numbers.vapi_phone_id` row for the number.

### Inbound service line (PLAN.md §16)

To route the dealership's incoming service calls to the agent:

1. In Vapi, open the phone number that should receive inbound calls and set its **inbound
   assistant** to a **Server URL** (dynamic assistant) of `${APP_URL}/inbound/assistant`, with the
   same `VAPI_WEBHOOK_SECRET`. On each incoming call Vapi asks that endpoint who's calling, and we
   answer synchronously with an assistant built for that specific caller.

   ⚠️ **The secret must go in `server.headers`, not `server.secret`.** Vapi's API accepts a
   `server.secret` field, returns 200, and then silently drops it — the number ends up with a URL
   and no credential, every call 401s, and the caller hears "unauthorized" before it hangs up.
   Nothing reaches your API logs, because the request never gets dispatched. Set it via the API as:

   ```bash
   curl -X PATCH "https://api.vapi.ai/phone-number/<PHONE_ID>" \
     -H "Authorization: Bearer $VAPI_API_KEY" -H "Content-Type: application/json" \
     -d '{"server":{"url":"'"$APP_URL"'/inbound/assistant",
          "headers":{"x-vapi-secret":"'"$VAPI_WEBHOOK_SECRET"'"}}}'
   ```

   Verify it stuck — a GET on the same endpoint should show `headers`, not an empty `server`.
2. The number **must exist in `phone_numbers` with its `e164`** — that's how we resolve which
   dealership was dialed. An unrecognized destination returns 404 and the agent won't answer.
3. In the dashboard → **Settings → Inbound service line**, set the **transfer number** (the staffed
   service line). Without it the agent takes a message instead of transferring.
4. In **Settings → Services we offer**, add the services the dealership performs. The agent answers
   "do you do X?" from this list *only* — with an empty catalog it transfers every service question.
5. Point the carrier/main service line at the Vapi number (forward or publish it) once you've tested.

Caller identification is **caller-ID-only**: a caller whose number isn't on file — or whose number
matches more than one customer — is treated as anonymous and is never read account or vehicle
details. Watch the identified-vs-anonymous rate on the **Handoffs** page; a low rate is the signal
to revisit that setting.

---

## 4. TTS — Cartesia or Deepgram Aura-2 (A/B vs ElevenLabs)
1. Create a Cartesia (or Deepgram) account; both are **native Vapi providers** — no separate
   integration, just config.
2. Set `DEFAULT_TTS_PROVIDER` (`cartesia` | `deepgram` | `11labs`) and `DEFAULT_VOICE_ID` to a voice
   from that provider. (Per-dealership overrides live in `companies.settings.voice`.)
3. Plan to A/B against ElevenLabs during staff week; `booking-rate-by-voice` picks the winner (§14b).

---

## 5. Telnyx (the phone number callers dial)

1. Create a Telnyx account → **API key** → `TELNYX_API_KEY`.
2. **Buy the phone number** that will receive service calls.
3. Optionally set **CNAM** to the dealership's name and register **SHAKEN/STIR** — these help
   outgoing identity; for a purely inbound line they're cosmetic.
4. Import the number into Vapi (step 3) to get its `vapi_phone_id`.
5. Add the number in the dashboard (**Settings → Numbers that route to the agent**), or insert into
   `phone_numbers` (`e164`, `provider='telnyx'`, `vapi_phone_id`, `enabled=true`). **The `e164` must
   match what Vapi reports as the dialed number** — that mapping is how we know which dealership was
   called.

> No A2P 10DLC registration is required: we don't send SMS.

---

## 6. Resend (optional — transactional email)
- **Resend**: API key → `RESEND_API_KEY`, a verified sender → `EMAIL_FROM`.
- Optional today: `src/notify/email.ts` is ready but nothing calls it yet. Skip unless you're
  wiring booking confirmations.

---

## 7. Local run
```bash
# Backend (API + worker)
cp .env.example .env      # fill in values from steps 1–5
npm install
npm run dev               # http://localhost:3000  (GET /health → {"ok":true})

# Dashboard
cd web
cp .env.local.example .env.local   # (create it — see the web env table below)
npm install
npm run dev               # http://localhost:3001
```
### Frontend against the deployed backend

To work on the dashboard without running the API locally:

```bash
./scripts/use-backend.sh deployed   # or: local
cd web && npm run dev               # restart — NEXT_PUBLIC_* are build-time
```

`deployed` points at Railway, so only `npm run dev` in `web/` is needed — no API, no tunnel, and
you're reading the same data customers see. Switch to `local` when changing backend code too.

With **no** `NEXT_PUBLIC_SUPABASE_URL` set, the dashboard runs in **demo mode** (seeded data, zero
config) — useful for UI work. Set the web env vars to hit the real backend.

**Web env (`web/.env.local`):**
| var | value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key |
| `NEXT_PUBLIC_API_URL` | the backend origin (e.g. `http://localhost:3000`, or the Railway API URL) |

---

## 8. Railway deploy (two services, one repo)

Both services deploy from the same repo; they differ only in root directory. Railway reads
`railway.json` (API) and `web/railway.json` (dashboard) for build and start commands.

**Push to GitHub first** — Railway deploys from a repo:
```bash
git remote add origin https://github.com/<you>/actumauto.git
git push -u origin main
```

### Service 1 — API + worker

- **Root directory:** `/` (leave blank)
- Build and start come from `railway.json`; health check is `/health`.
- **Variables** — copy from your `.env`, with one change:

| var | value |
|---|---|
| `APP_URL` | **this service's Railway domain** (set after the domain exists, then redeploy) |
| `WEB_URL` | Service 2's domain |
| `DATABASE_URL` | Supabase **session pooler, port 5432** (not 6543) |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET` | as local |
| `ANTHROPIC_API_KEY`, `VAPI_API_KEY`, `VAPI_WEBHOOK_SECRET` | as local |
| `DEFAULT_TTS_PROVIDER`, `DEFAULT_VOICE_ID` | optional |

`APP_URL` is a chicken-and-egg: deploy once, generate the domain under Settings → Networking,
set `APP_URL` to it, redeploy.

### Service 2 — dashboard

- **Root directory:** `web`
- **Variables:**

| var | value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase publishable key |
| `NEXT_PUBLIC_API_URL` | **Service 1's domain** |

These are inlined at BUILD time, so changing one requires a redeploy, not just a restart.

### Point Vapi at the deployment

The phone number still points at your laptop's tunnel. After the API is live:

```bash
APP_URL=https://your-api.up.railway.app npx tsx scripts/set-webhook-url.ts
```

Then verify:
```bash
curl https://your-api.up.railway.app/health          # {"ok":true}
APP_URL=https://your-api.up.railway.app npm run preflight
```

**Run this after any deploy that changes the API domain.** If you skip it, the number keeps
pointing at the old URL and every call fails silently — the request never reaches you, so nothing
appears in your logs.

Once deployed you can stop the local tunnel and API; the dashboard runs at Service 2's URL.

---

## 9. Before you point the real service line at it

- [ ] A `phone_numbers` row whose `e164` matches the number Vapi reports as dialed, with a valid
      `vapi_phone_id`. **Without this the agent returns 404 and won't answer.**
- [ ] **Transfer number set** (Settings → Inbound service line). Without it the agent can only take
      a message — and "where is my car" is the most common reason people call.
- [ ] **Services catalog populated.** An empty catalog means every service question gets transferred.
- [ ] A service schedule matching your customers' vehicles (the seed covers gas Toyota) — this is
      what the agent reads to say what's due.
- [ ] A CSV imported, so callers are actually recognized. Spot-check that phone numbers landed in a
      consistent format; identification matches on the last 10 digits.
- [ ] `global_settings` spend caps set for a pilot.
- [ ] **Place a test call yourself** from a number that IS in the database, and one that isn't.
      Confirm: the known caller is greeted by name and hears a correct due-service recommendation;
      the unknown caller gets general answers only and is never told about anyone's vehicle.
- [ ] **Test the transfer**, including the case where nobody picks up — confirm a `handoff_requests`
      row appears with `transferred=false` so the caller is recoverable.

---

## 10. What's built vs. still to come

**INBOUND ONLY.** The system answers the dealership's service line. It does not place calls, send
SMS, or run campaigns — that machinery was removed (scheduler, dial protocol, reconciler, cadences,
number-pool pacing, SMS channel).

**Built:** inbound caller identification from caller ID (anonymous on a miss *or* an ambiguous
shared number) · inbound assistant + in-call tools (services lookup, their vehicles, what's due,
booking) · transfer to the service line with a message-taking fallback · services catalog ·
handoff queue · service schedules + due engine (repeating intervals, refuses to guess without
data) · CSV import of past customers + vehicles · durable Vapi webhook → recording/transcript/cost ·
Today dashboard · call playback · customer directory · auth + team invites · soft booking.

**Not yet wired:** real "where is my car" answers (needs myKaarma repair-order status; the agent
always transfers today) · `verbal_verify` caller identification (the setting exists, the in-call
flow doesn't) · real myKaarma booking adapter · transactional email (`src/notify/email.ts` is
ready but nothing calls it) · conversation-intelligence / `call_analyses` · RO/shown re-import.

**Never validated against live providers.** Everything above typechecks and the data layer has been
exercised against a real Postgres, but no Vapi call has ever been placed or received, and there is
no automated test suite. See "Validation status" below.

## 11. Validation status (read this before trusting anything)

| Area | State |
|---|---|
| Migrations `0001`–`0004` | **Verified** — apply cleanly to a real Postgres |
| Caller identification | **Verified** — exact / formatted / 10-digit / shared-number / blocked / cross-tenant cases |
| Due engine | **Verified** — repeating intervals, major-service tie-break, partial and missing data |
| Services catalog, directory search | **Verified** against seeded data |
| TypeScript (API + web) | **Clean**; web builds |
| Vapi inbound handshake, in-call tools, transfer | **Never run** — no provider has been contacted |
| CSV import end to end | **Never run** against a real file |
| Automated tests | **None exist** |
