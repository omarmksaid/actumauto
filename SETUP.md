# Touchpoint Center — Setup & Configuration

Everything you need to take the current code from "typechecks locally" to "places a real call."
Ordered by dependency + lead time. See `PLAN.md` for the why behind each choice.

> **Start the one item with a clock today:** Telnyx A2P 10DLC registration (step 5) takes
> **1–4 weeks and does not transfer between providers.** Nothing else has a lead time.

---

## 0. Prerequisites
- Node 20+, npm.
- A GitHub repo (for Railway deploy).
- Accounts you'll create below: Supabase (Pro), Telnyx, Vapi, Anthropic, a TTS provider
  (Cartesia or Deepgram), Resend, Voyage. myKaarma is **not** needed yet (booking runs in
  `soft` mode until you have it).

---

## 1. Supabase project (the separate database)
1. Create a **new** Supabase project (its own, separate from any other product).
2. **Upgrade to Pro** and enable **PITR (Point-in-Time Recovery)** — `calls`/`transcripts` are
   unregenerable (PLAN.md §9).
3. **Run the migrations** in order, then the seed, in the SQL Editor (or `psql`):
   - `supabase/migrations/0001_init.sql`
   - `supabase/migrations/0002_dispatch_rpcs.sql`
   - `supabase/seed.example.sql`  (buckets, `create_workspace` RPC, global Toyota schedule)
4. Grab these from **Project Settings**:
   - **Project URL** → `SUPABASE_URL` and (web) `NEXT_PUBLIC_SUPABASE_URL`
   - **service_role key** (Data API) → `SUPABASE_SERVICE_ROLE_KEY` (server only, never the browser)
   - **anon key** → (web) `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - **JWT secret** (Auth settings) → `SUPABASE_JWT_SECRET`
   - **Connection string → Session pooler (port 5432)** → `DATABASE_URL`
     - ⚠️ **Session mode, port 5432 — NOT transaction mode (6543).** pg-boss uses LISTEN/NOTIFY +
       long-lived connections that break *silently* in transaction mode (symptom: jobs never run).

### Create your first dealership
Sign up a user in Supabase Auth, then in the SQL editor run `select create_workspace('Milpitas Toyota','America/Los_Angeles');` **while authenticated as that user** (or insert `companies` + `memberships` + a `cadences` row by hand — see the commented block at the bottom of `seed.example.sql`).

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

---

## 4. TTS — Cartesia or Deepgram Aura-2 (A/B vs ElevenLabs)
1. Create a Cartesia (or Deepgram) account; both are **native Vapi providers** — no separate
   integration, just config.
2. Set `DEFAULT_TTS_PROVIDER` (`cartesia` | `deepgram` | `11labs`) and `DEFAULT_VOICE_ID` to a voice
   from that provider. (Per-dealership overrides live in `companies.settings.voice`.)
3. Plan to A/B against ElevenLabs during staff week; `booking-rate-by-voice` picks the winner (§14b).

---

## 5. Telnyx (telephony — voice numbers + SMS) — **START THE 10DLC NOW**
1. Create a Telnyx account → **API key** → `TELNYX_API_KEY`.
2. Create a **Messaging Profile** → `TELNYX_MESSAGING_PROFILE_ID` (for SMS, used in a later slice).
3. **Buy one or more phone numbers.**
4. **Submit A2P 10DLC brand + campaign registration immediately** — 1–4 week approval, blocks SMS at
   volume, non-transferable. Do this before anything else time-wise.
5. Also queue up (not blocking, but improves answer rate at volume): **SHAKEN/STIR attestation** and
   **CNAM = the dealership's name** (e.g. "Milpitas Toyota") per number; Free Caller Registry.
6. Add each number to the DB `phone_numbers` table for the dealership (`e164`, `provider='telnyx'`,
   `vapi_phone_id`, `enabled=true`, `daily_cap`, `weight`, `ramp_started_on=today`).

---

## 6. Resend + Voyage (email + embeddings)
- **Resend**: API key → `RESEND_API_KEY`, a verified sender → `EMAIL_FROM`. (Email fallback slice.)
- **Voyage**: API key → `VOYAGE_API_KEY`. (RAG ingest slice.)

---

## 7. Local run
```bash
# Backend (API + worker)
cp .env.example .env      # fill in values from steps 1–6
npm install
npm run dev               # http://localhost:3000  (GET /health → {"ok":true})

# Dashboard
cd web
cp .env.local.example .env.local   # (create it — see the web env table below)
npm install
npm run dev               # http://localhost:3001
```
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
**Service 1 — API + worker** (repo root):
- Build: `npm install && npm run build` · Start: `npm start` · Health check: `/health`
- Variables: everything from `.env`. Set `APP_URL` to this service's generated domain **after** you
  generate it, then redeploy (the Vapi webhook URL is built from it).
- `DATABASE_URL` = the **session-mode** Supabase pooler (port 5432).

**Service 2 — dashboard** (root directory `web`):
- Build: `npm install && npm run build` · Start: `npm start`
- Variables: the three `NEXT_PUBLIC_*` web vars (API URL = Service 1's domain).

**Scaling:** the code is already safe to run as multiple replicas — the scheduler claims work with
`FOR UPDATE SKIP LOCKED` and every side effect is idempotent via the claim/reconcile machinery
(PLAN.md §8). No leader election needed.

---

## 9. Pre-first-live-campaign checklist (PLAN.md §10 Step 8)
Before pointing this at real customers:
- [ ] 10DLC approved (step 5).
- [ ] At least one `phone_numbers` row with a valid `vapi_phone_id`, `ramp_started_on` set.
- [ ] `global_settings` caps sane for a pilot: `max_concurrent_calls=10`, daily/monthly spend caps.
- [ ] A `cadences` row for the dealership (quiet hours in the dealership timezone).
- [ ] A service schedule that matches your customers' vehicles (the seed covers gas Toyota).
- [ ] **Chaos test:** in staging, kill the worker mid-batch, restart, confirm **zero duplicate
      dials** (this validates the claim/reconcile core).
- [ ] Kill switch verified: flip `global_settings.global_dial_enabled=false` and confirm dialing
      stops within a dispatch cycle.

---

## 10. What's built vs. still to come
**Built (Slices 1–2):** CSV import + column-mapping · service-due engine · scheduler + customer-level
coalescing · claim→gate→execute→confirm voice dispatch · thin durable webhook + event processor ·
reconciler · cadence engine (voicemail/no-answer/booked/opt-out) · soft booking.

**Not yet wired:** SMS/email channel *senders* (rows are created by the cadence engine; the actual
Telnyx/Resend send handlers are the next slice) · funnel dashboard + call playback + Customer
Directory UI · Insights/conversation-intelligence (`call_analyses`) · number warm-up ramp +
answer-rate health job · real myKaarma adapter · RO/shown re-import loop.
