# Touchpoint Center — Architecture & Build Plan

**AI phone agent for an auto-dealership service department. INBOUND ONLY.**

Service calls coming into the dealership route to the agent. It identifies the caller from their
phone number, answers questions about the services the dealership offers, tells them what's coming
due on their car(s) and recommends it, books a visit, and transfers to a service employee for
anything out of scope — above all "where is my car," which it never attempts to answer.

To know who is calling, the dealership uploads a **CSV of past customers and their vehicles**; the
system also carries **per-model service schedules** so the due engine can enrich a live call with
what that specific car needs next.

Humans get a dashboard of inbound activity, can play back any call with its transcript, look up any
customer, work the handoff queue, and maintain the services catalog and schedules.

## Scope: no outbound

**The system does not place calls, send SMS, or run campaigns.** It was originally built as an
outbound service-reminder platform; that was removed deliberately (see the outbound-removal commit).
Gone with it: the scheduler and touchpoint slotter, the claim→gate→execute→confirm dial protocol,
the reconciler, cadences and follow-up branches, the number-pool pacing/warm-up/health machinery,
quiet hours, and the SMS channel.

Sections below that describe outbound mechanics (§3–§5, §10–§15) are retained as **historical
design record** — they document why the surviving pieces look the way they do, and what the
tradeoffs were, but they no longer describe running code. **§16 is the live design.**

What survives from that era, because inbound depends on it: the CSV import subsystem, the
service-schedule + due engine, `BookingProvider`, the durable webhook inbox, cost tracking, auth
and RLS, and `phone_numbers` — now purely a routing map from a dialed number to a dealership.

Provider stack: Vapi (voice orchestration) · Anthropic (BYO key, Haiku for the live loop) ·
Deepgram STT · Cartesia/Aura-2 TTS · Telnyx numbers · Supabase (Postgres + Auth + Storage) ·
Resend (transactional email, currently unwired).

---

## 1. What changes vs. realtyAI

| realtyAI | Touchpoint Center |
|---|---|
| Leads arrive via Meta/Google webhooks in real time | Customers arrive via **CSV upload** (batch), with column-mapping |
| Router decides staffed-hours → human, else enqueue | **Scheduler** slots calls by service-due date, paced by number pool |
| Channels: WhatsApp, voice, email | Channels: **voice, SMS, email** (WhatsApp removed) |
| One-shot outreach per lead, reply cancels escalation | **Cadence engine**: no-answer retries, SMS/email fallbacks, appt reminders |
| Knowledge docs → RAG for conversation | Same RAG, **plus** structured customer profile + service schedule injected into call |
| "company" = brokerage | "company" = **dealership**; users = service advisors/admins |
| Morning digest of overnight leads | **Funnel dashboard** (slotted / called / booked / not-booked / spam-flagged) |
| — | **Customer Directory**: search by phone/name/VIN, profile, cars, upcoming service, personality |
| — | **myKaarma booking** behind a `BookingProvider` interface (stub first) |
| — | **Number pool** with volume distribution + deliverability/spam metrics |

Reused largely as-is: Supabase auth (ES256 JWKS), RLS `my_company_ids()` pattern, cost tracking,
admin/operator portal, team invites + roles, Vapi voice adapter shape, Voyage embeddings ingest,
Resend email, pg-boss on Supabase Postgres, the demo-data-fallback frontend pattern, design tokens.

---

## 2. Core domain model (new tables)

All tables carry `company_id` (= dealership) + the standard RLS tenant policies from realtyAI's
`0001_init.sql`. Backend workers use service-role and bypass RLS.

### Customers & vehicles
- **`customers`** — required fields: `full_name`, `email`, `phone`. One row per person.
  - `customer_type` (e.g. loyal / lapsed / new / VIP — configurable enum in settings), `tags text[]`,
    `detected_language`, `personality jsonb` (built from past conversations), `notes`,
    `profile jsonb` (extensible bag for future fields), `do_not_contact bool`, `opted_out bool`.
- **`vehicles`** — required: `make`, `model`, `year`, `sold_on` (purchase date), `mileage`.
  - `vin` (nullable, indexed for directory lookup), `trim`, `vehicle_profile jsonb` (extensible).
  - **Mileage tracking (fixes cold-start):** store `mileage_as_of` explicitly (the odometer
    reading date) rather than assuming the CSV export date — dealership exports are often weeks
    old. Store `last_service_on` **and** `mileage_at_last_service` when present. A **`vehicle_mileage`**
    child table (`vehicle_id`, `mileage`, `observed_on`, `source`) accumulates every odometer
    snapshot we see (CSV, service record, in-call mention) so the slope improves over time.
  - `avg_miles_per_day` is **derived, not raw**: if we have two points (e.g. sale + last service,
    or two mileage observations) use the real slope between them; with only one point, **blend**
    the observed rate (`mileage / days_owned`) with a **fleet prior (~30–35 mi/day)**, weighting
    the observed rate by ownership duration (a 4-month-old car leans on the prior; a 3-year-old
    car trusts its own history). Stored as a computed field + recomputed on each new observation.
  - FK `customer_id`. A customer can own several vehicles.
- **Directory search**: a `search_customers()` SQL function + tsvector/GIN over
  `full_name`, `phone`, `email`, and `vehicles.vin` — search by phone / name / VIN returns the
  customer with owned cars, upcoming service, personality, recent conversation summary. Extensible.

### Service schedules (per model, extensible to any make)
- **`service_schedules`** — `make`, `model`, `year_from`, `year_to` (range), `source`, `notes`.
- **`service_intervals`** — FK to schedule: `mileage` (e.g. 5000/10000/...), `months`,
  `service_name`, `operations text[]`, `severity`. "What's due" = min unmet interval given
  current projected mileage/age. Seeded from **researched public Toyota maintenance intervals**
  (accuracy caveat noted in seed), editable in dashboard, extensible to other makes.

### Campaigns, scheduling, cadence
- **`imports`** — one row per CSV upload: filename, storage path, `column_map jsonb`,
  `row_count`, `status` (parsing/mapped/importing/done/failed), `error`, `stats jsonb`.
- **`campaigns`** — a service-reminder run (optionally tied to an import): name, `status`,
  `cadence_id`, targeting (which customers/vehicles), pacing overrides.
- **`touchpoints`** — the unit of outbound work (replaces realtyAI's per-lead outreach jobs).
  A touchpoint is **per customer + service-window**, NOT per vehicle (see dedupe below).
  Columns: `customer_id`, `vehicle_ids uuid[]` (all due vehicles covered by this contact),
  `campaign_id`, `channel` (voice/sms/email), `kind` (initial / no_answer_retry /
  voicemail_followup / reminder), `scheduled_at`, `status`
  (scheduled/**claiming**/in_flight/completed/failed/canceled/spam_blocked), `attempt`, `outcome`
  (answered / **no_answer** / **voicemail_dropped** / **machine_hangup** / booked / declined /
  bad_number / carrier_rejected / **provider_error**), `phone_number_id` (which pool number placed
  it), `cost_usd`, `result jsonb`.
  - **Two-phase claim columns (see §4b):** `claim_id uuid`, `claimed_at timestamptz`,
    `provider_error text`. Unique partial index on `claim_id`; reconciler index on
    `(status, claimed_at) WHERE status IN ('claiming','in_flight')`. The `provider_error` outcome
    means "the provider was down," **not** "the call failed" — it does **not** consume an attempt.
  - **Customer-level dedupe:** a household with two Toyotas both coming due must get **one call**
    that covers **all** due vehicles in a single prompt — not two calls the same week. The
    scheduler coalesces on `singletonKey = customer_id + window_bucket`; the assembled prompt
    lists every due vehicle, and the in-call booking flow can create **multiple appointments**
    (one per vehicle) from that single conversation.
- **Voicemail is its own branch, not a flavor of no-answer.** Vapi AMD (machine detection) drives
  the split, configured per dealership in `cadences`:
  - `on_machine` = `drop_message` (play a short scripted VM + fire an immediate SMS with a booking
    link — the highest-converting pattern) **or** `hangup`. Note hang-ups on machine detection
    **spike spam scores**, so `drop_message` is the default and feeds cleaner number-health signals.
  - `voicemail_counts_as_attempt bool` — whether a drop counts against `max_call_attempts`.
  - A voicemail drop **accelerates** the SMS fallback (VM + immediate booking-link SMS), rather
    than waiting the full `sms_fallback_after_min`.
- **`cadences`** — per-dealership settings (defaults seeded, editable in Settings):
  `no_answer_retry_after_min`, `max_call_attempts`, `sms_fallback_after_min`,
  `email_fallback_after_min`, `reminder_offsets_min int[]` (e.g. [1440, 120] = 24h + 2h before appt),
  `on_machine` (`drop_message`|`hangup`), `voicemail_counts_as_attempt`, `voicemail_sms_immediate`,
  quiet-hours window, per-day pacing. Per-dealership (not per-campaign) as chosen; campaigns can
  override later via nullable columns.

### Calls, transcripts, recordings
- **`calls`** — one per placed voice call: `touchpoint_id`, `vapi_call_id`, `recording_url`,
  `duration_sec`, `outcome`, `cost_usd`, `metadata`. Playback = signed recording URL.
- **`transcripts`** — turn-by-turn rows (role, text, ts, `search` tsvector generated column +
  FTS function, mirroring realtyAI's `0007`). Covers both call transcripts and SMS/email threads
  (channel column) so "play back a call / read the SMS thread" is one model.
- **`messages`** — SMS/email turns (kept for the conversational loop + directory recency).

### Number pool & deliverability
- **`phone_numbers`** — pool of numbers (Telnyx default, §15): `e164`, `provider`, `vapi_phone_id`, `enabled`,
  `daily_cap`, `weight` (volume knob), `sent_today`, `last_reset`, plus health/ramp fields below.
  Scheduler distributes the day's touchpoints across enabled numbers by weight/cap.
- **Health needs a real signal source — a column alone populates nothing.** Carriers don't report
  spam-labeling back to you, so we use both:
  - **Proxy signal (ships first):** per-number **answer-rate decay** — a rolling answer rate
    computed from recent touchpoint outcomes. A sharp drop is the leading indicator of a number
    getting flagged; it lowers the number's effective weight and can auto-quarantine it. Stored as
    `answer_rate_7d`, `health_score`, `quarantined_at`.
  - **External (later, flagged):** Free Caller Registry registration + a reputation-monitoring
    service that polls each number's carrier spam labels; writes `spam_label jsonb`.
- **Warm-up ramp:** 400/day/number is aggressive for **unwarmed** numbers. New pool numbers ramp
  their effective cap over ~2 weeks (e.g. 20 → 50 → 150 → full cap) via `ramp_started_on` +
  a ramp curve; the scheduler uses `min(daily_cap, ramp_cap(today))`. Prevents same-week flagging.
- **Caller identity:** register **SHAKEN/STIR** attestation and set **CNAM** to the dealership's
  name (e.g. "Milpitas Toyota") per number — a labeled call roughly doubles answer rate vs. an
  unlabeled number, and directly improves the health signal above.
- **Deliverability metrics**: touchpoint `status='spam_blocked'` + `outcome` (bad_number,
  carrier_rejected, machine_hangup) + per-number answer-rate decay roll up into the dashboard's
  "canceled due to spam/other issues" and per-number-health tiles.

### Booking (myKaarma, abstracted)
- **`appointments`** — `customer_id`, `vehicle_id`, `provider` ('mykaarma'|'soft'),
  `external_id`, `starts_at`, `preferred_time text` (for soft commits), `service_ops jsonb`,
  `notes`, `status`, `reminder_state`, `shown_at` (see §6b RO loop).
  - `status` includes **`pending_confirmation`** (soft commit awaiting an advisor to place it),
    `confirmed`, `canceled`, `no_show`, **`shown`**.
- **NEVER ship live calls with a stub that pretends to book.** If the AI says "you're booked
  Tuesday at 9" and nothing lands in myKaarma, that is worse than not calling at all. So booking
  is a **mode on `BookingProvider`**, not a fake:
  - **`soft` mode (default until the real adapter exists):** the in-call tool switches the script
    to soft-commit — capture the customer's **preferred time**, promise a **confirmation
    text/call**, and write an `appointments` row as **`status='pending_confirmation'`** for an
    advisor to place manually in myKaarma. The AI never claims a firm booking in this mode.
  - **`live` mode (real myKaarma):** actually reserves the slot and returns a confirmation.
  The system prompt + the in-call tool's response text are gated on the active mode, so the AI's
  wording matches reality.
- **`BookingProvider` interface** (`src/booking/types.ts`): `mode`, `getAvailability(range, ops)`,
  `createAppointment({customer, vehicle, slot, ops, notes})` → returns firm vs. soft result,
  `cancelAppointment(id)`. Ships with **`softBooking`** now; real `myKaarmaBooking` slots in
  behind the same interface once API docs/creds are available — no call-flow changes needed.

### Durability & control tables (HA — see §4b/4c/5b/§8)

An outbound dialer's failure asymmetry is: **failing loud is fine; failing duplicate is
catastrophic.** A retry storm that calls a customer three times in an hour does more brand damage
than a day of downtime. These tables make correctness-under-partial-failure structural, not
retrofitted.

- **`webhook_events`** — the durable inbox for every provider callback. Columns: `id`, `provider`
  ('vapi'|'twilio'|'mykaarma'), `event_type`, `raw_payload jsonb` (**permanent — the replay log**),
  `signature_valid bool`, `received_at`, `processed_at`, `processing_error`, `touchpoint_id`
  (backfilled during processing). Webhook handlers write here and return 200; a pg-boss consumer
  does the real work (§5b). A parsing bug never loses an event.
- **`provider_circuits`** — one row per provider ('vapi'|'twilio_sms'|'resend'|'anthropic'):
  `state` (closed|open|half_open), `failure_count`, `opened_at`, `retry_after`. A tripped circuit
  holds touchpoints in `scheduled` (does **not** consume attempts) rather than marking a day's
  work `failed`.
- **`global_settings`** (single row) — `global_dial_enabled bool`, `max_concurrent_calls int`
  (pilot cap 10–20), `daily_spend_cap_usd`, `monthly_spend_cap_usd` (pilot ~$500). The global
  kill switch + concurrency governor + spend ceilings; the pre-dial gate (§4b) refuses to dial once
  a cap is hit and flips `global_dial_enabled` off. These are the three independent cap layers (§12).
- **`companies.dial_enabled bool NOT NULL DEFAULT true`** — the per-dealership kill switch,
  re-read at dial time (§4b) so "stop everything" takes effect within seconds, including for jobs
  already enqueued.

---

## 3. CSV ingestion + column-mapping (new subsystem)

The pattern (no reusable source existed in the referenced projects — built fresh):
1. **Upload** CSV → Supabase Storage (`imports` bucket); create `imports` row.
2. **Parse headers + sample rows** (papaparse, first ~20 data rows) server-side.
3. **Auto-guess mapping**: fuzzy-match each source header against target fields
   (name/email/phone/make/model/year/sold_on/mileage/vin/...) via normalized token + synonym
   table (e.g. "cell"/"mobile"→phone, "purchase date"/"sale date"→sold_on, "odometer"→mileage).
4. **Confirm UI** (`web/app/(app)/imports/[id]`): shows detected columns, a dropdown per target
   field pre-filled with the guess, a live preview of the first rows mapped, required-field
   validation. User adjusts and confirms → save `column_map`.
5. **Transform + import worker** (`import` pg-boss queue): stream rows, apply mapping, coerce
   types (dates via luxon, mileage→int, phone→E.164), upsert `customers` + `vehicles`
   (dedupe on phone/email/VIN), collect per-row errors into `imports.stats`. Extensible: adding
   a new target field = one entry in the field registry + synonym list.
6. **After import**: compute service-due for each vehicle and (if attached to a campaign) enqueue
   the scheduler to slot initial touchpoints.

---

## 4. Scheduling & call engine (redundancy + no cross-call leakage)

- **Due-date computation**: for each vehicle, project current mileage using the derived
  `avg_miles_per_day` (real slope when two points exist, else observed-blended-with-fleet-prior;
  see §2 vehicles), anchored to `mileage_as_of` rather than "now"; also track age from `sold_on`.
  Find the min unmet `service_interval` (by mileage OR months, whichever comes first); the due date
  is when that service is projected to come due, and `scheduled_at` = due date − the configurable
  **service-due window** (§11). This replaces realtyAI's after-hours routing entirely.
- **Customer-level coalescing:** before creating touchpoints, group a customer's due vehicles into
  one **per-customer, per-window** touchpoint (`vehicle_ids[]`), so a two-Toyota household gets one
  call covering both — not two calls. The `singletonKey = customer_id + window_bucket` enforces
  this even across separate import/campaign runs.
- **pg-boss scheduler cron** (e.g. every 15 min): pulls `touchpoints` where `scheduled_at <= now`
  and `status='scheduled'`, respects **quiet hours** + **per-number daily caps (ramped)** +
  **campaign pacing**, assigns each to a pool number by weight/health, and enqueues a channel job.
  Concurrency cap + retry/backoff so we can pace to ~400/day/number and scale via the pool.
  - **Crash-safe & concurrent-safe:** the slotting query claims batches with **`FOR UPDATE SKIP
    LOCKED`**, so two scheduler instances (Railway runs two during deploys; you'll scale workers)
    can never slot the same touchpoint. The cron also carries a pg-boss `singletonKey`. This is
    the horizontal-scaling story: workers are **stateless competitors over a locked queue** — add
    replicas, no leader election.
- **No cross-call leakage**: each call job builds a **fresh** system prompt from *only that
  customer's* profile + their due vehicle(s) + due service + RAG snippets; Vapi `metadata` carries
  only `touchpointId`; nothing is shared/mutated across concurrent jobs (stateless job payloads,
  per-job Supabase reads). This is the same isolation realtyAI already has, made explicit.
- **Cadence engine**: on call outcome, apply the dealership `cadences` — **voicemail** →
  (drop_message + immediate booking-link SMS) or hangup, per config; **no-answer** → retry call
  after N (up to `max_call_attempts`) → SMS/email fallback → stop; on **booked** → schedule reminder
  touchpoints at `reminder_offsets_min`. Implemented as follow-up `touchpoints` with `startAfter` +
  `singletonKey`.
- **Atomic opt-out (must not leak a same-day SMS after a call opt-out):** when a call/SMS yields
  [OPTOUT], a single transaction sets `customers.opted_out = true` **and cancels every scheduled
  touchpoint for that customer across all channels and all vehicles** (`boss.cancel` by
  `customer_id` singleton family + a DB update to `status='canceled'`). No partial state where one
  channel is stopped but another fires the next day.

---

## 4b. Call dispatch protocol (exactly-once side effects)

Placing a Vapi call (or sending an SMS, or creating a booking) is a **non-idempotent external
side effect**, and pg-boss delivers at-least-once. The dangerous gap: a worker calls Vapi, then
crashes before writing `vapi_call_id` back → on retry the customer is called twice. The dispatch
protocol closes it with **claim → gate → execute → confirm**:

1. **Claim (CAS):**
   ```sql
   UPDATE touchpoints SET status='claiming', claim_id=gen_random_uuid(), claimed_at=now()
   WHERE id=$1 AND status='scheduled' RETURNING claim_id;   -- 0 rows ⇒ someone else owns it, drop the job
   ```
2. **Pre-dial gate — re-checked at THIS moment, not at slot time:**
   - global `global_dial_enabled` **and** dealership `dial_enabled` (kill switch, seconds to effect);
   - provider **circuit closed** (else revert to `scheduled`, `startAfter = retry_after`, attempt untouched);
   - **recipient-local quiet hours** (else revert to `scheduled`, re-slot to tomorrow morning — a
     backed-up queue must never fire a 10pm robocall; TCPA statutory-damages event, not just a bad look);
   - **live-call concurrency semaphore** below `max_concurrent_calls` (pilot 10–20) so a bad
     due-date computation that slots 5,000 touchpoints can't become 5,000 simultaneous calls.
   Any gate failure → revert to `scheduled` with the right `startAfter`, **attempt counter untouched**.
3. **Execute:** call Vapi with `claim_id` in `metadata` (our dedup key — Vapi has no native idempotency).
4. **Confirm:** `UPDATE ... SET status='in_flight', vapi_call_id=$2 WHERE claim_id=$3`.

The **same claim/confirm pattern applies to SMS sends and `BookingProvider.createAppointment`.**

## 4c. Reconciler (new pg-boss cron, ~every 5 min)

This is the actual dedup mechanism — because Vapi won't enforce idempotency keys, **query-before-retry
is mandatory**, not optional.
- Sweeps `claiming` rows older than ~2 min: queries Vapi **list-calls by `metadata.claim_id`**. Call
  exists → backfill `vapi_call_id`, promote to `in_flight`. Doesn't exist → the side effect never
  happened, safely revert to `scheduled`.
- Sweeps `in_flight` rows past max plausible duration (~20 min): pulls the outcome via the Vapi API
  (the **webhook-loss backstop** — polling as safety net, webhooks as fast path).
- Emits a **`reconciler_corrections`** counter → alert if it trends nonzero (a live failure mode).

---

## 5. The call itself (voice)

Reuse realtyAI's Vapi adapter shape. The **system prompt is assembled per call** from:
- Customer profile (who they are, type, personality from past convos, language) — "the agent
  ingests this at the beginning of the call so they know who they are", customizable.
- **All due vehicles** for this customer + **what service is coming up** on each (interval +
  operations) — a two-car household is handled in one conversation.
- Dealership persona/behavior prompt (editable template, guardrails hardcoded like realtyAI).
- RAG snippets from ingested docs (extensible knowledge).
- **Per-call voice selection** (ElevenLabs voice id from dealership/campaign settings) — choose
  different voices, same as realtyAI.
- In-call **book-appointment tool** (Vapi tool → endpoint → `BookingProvider.createAppointment`
  with notes). The tool can be **called multiple times** in one call — one appointment per due
  vehicle. In `soft` mode it captures a preferred time and returns soft-commit wording; in `live`
  mode it reserves a real myKaarma slot. The AI's confirmation language is gated on the mode so it
  never claims a firm booking that didn't happen.
- **Outcome extraction is structured, not post-hoc transcript parsing.** Use Vapi's end-of-call
  **structured analysis** (a defined `analysisPlan`/summary schema) plus the explicit booking
  **function calls** as the source of truth for booked / declined / callback / optout — raw
  transcript classification is noisy. The webhook reads those structured fields; the transcript is
  stored for playback/FTS but not relied on for control decisions.
- The end-of-call webhook is a **thin durable handler** (§5b): it does not process inline. It
  validates, persists the raw payload, and returns 200; a job then stores recording + transcript,
  applies the structured outcome, updates personality, triggers the cadence engine (incl.
  **atomic opt-out**, §4), and runs the **conversation-intelligence extraction** into
  `call_analyses` (§14a) — the same pass that folds in QA/adherence.

## 5b. Webhook handling (durable inbox)

The end-of-call webhook drives everything downstream — transcript, personality, cadence. If it
500s (a parsing bug) or Railway is mid-deploy, Vapi's limited retries exhaust and **a call your
system doesn't know about happened.** Two layers:
- **(a) Fast path — thin handler:** the webhook does exactly three things: **validate signature →
  insert into `webhook_events` (raw payload, permanent) → return 200.** All real processing happens
  in a pg-boss consumer that reads `webhook_events`, stamps `processed_at`, and backfills
  `touchpoint_id`. A bug in transcript parsing therefore **never loses the event** — fix the bug,
  reprocess from the stored raw payloads (the replay log).
- **(b) Backstop — polling:** the reconciler (§4c) already pulls outcomes for `in_flight` calls past
  their max duration via the Vapi API, catching any event that was lost entirely.

Same thin-handler pattern for Twilio status callbacks and myKaarma callbacks.

---

## 6. Dashboard (Next.js, forked)

- **Today / Funnel**: currently slotted, called, of-those-called booked vs. not-booked,
  spam/other-issue cancellations, per-number health — **and, critically, `shown` (closed the
  loop to an actual RO)**. The funnel must not stop at "booked" (see §6b). (Replaces the morning
  digest home.)
- **Customer Directory** (new): search box (phone / name / VIN) → results → customer page:
  type, owned cars, upcoming service, personality (from past convos), recent conversations,
  extensible field panel.
- **Calls / Conversations**: list + `[id]` with **recording playback** + transcript; SMS/email
  threads likewise.
- **Imports**: upload + column-mapping UI + import status/errors.
- **Campaigns**: create/monitor a service-reminder run.
- **Schedules**: view/edit `service_schedules` + intervals (seeded Toyota data).
- **Settings**: cadences (follow-up timings, reminder offsets, quiet hours), number pool
  (add numbers, weights/caps = volume knobs), voices + behavior prompt, customer-type config.
- **Admin/operator portal**: reused from realtyAI (dealerships, usage, spend, billing).
- Same demo-data fallback pattern (works with zero config), same design tokens (re-themed).

### 6b. Appointment-outcome loop (booked → shown RO)

The dealership's success metric — and the whole pitch — is **shown ROs**, not bookings. A
booked appointment that no-shows is worth nothing. So the funnel must close the loop from
`booked` → `shown`. Two mechanisms, either/both:
- **Tagged notes (works even in `soft` mode / before the myKaarma API):** every appointment we
  create writes a **unique tag into the myKaarma appointment notes** (e.g. `TPC:<appointment_id>`).
  A periodic job (or an **RO CSV re-import**, reusing the same import pipeline) pulls past
  appointments/ROs, filters to ones carrying our tag, and back-fills `appointments.status='shown'`
  + `shown_at`. This is the pragmatic path and needs no live integration.
- **API status sync (once `live` myKaarma exists):** poll appointment status and map
  confirmed / no_show / shown back onto our rows.

The dashboard then reports the real conversion chain: **called → booked → shown → attributed RO
revenue**, which is the number the pilot is measured on. `shown` also feeds back into
`customer_type` (a customer who shows is "loyal/active"; a no-show adjusts follow-up cadence).

---

## 7. Auth / tenancy / registration

- Same Supabase Auth + `create_workspace` RPC pattern. Registration: an **admin** signs up a
  dealership, invites **workers** (service advisors) under it via the invites table + roles
  (owner/admin/advisor). `companyId`/`userId` only from `requireAuth`. Webhooks (Twilio status,
  Vapi end-of-call, myKaarma callbacks) authenticate the provider. RLS via `my_company_ids()`.

---

## 8. Security invariants (carried over + new)

1. `companyId`/`userId` only from `requireAuth`; never from bodies. Webhooks auth the provider.
2. Data assistant (if kept) uses a fixed read-only tool menu; no tool accepts company_id.
3. Guardrails in the system prompt (no invented pricing/quotes, [HANDOFF]/[OPTOUT], booking only
   via the tool) hardcoded, wrapping editable templates.
4. New tables get `company_id` + the standard RLS tenant policies.
5. **No cross-call data leakage**: per-job stateless payloads, fresh per-customer prompt assembly.
6. Recordings/transcripts served via short-lived signed URLs, tenant-scoped.

**Correctness-under-partial-failure invariants (the dialer asymmetry):**
7. **Non-idempotent external side effects** (dial, SMS, booking) go through **claim → execute →
   confirm**, with the reconciler as backstop (§4b/4c). Failing loud is fine; failing duplicate is not.
8. **Quiet hours and kill switches are enforced at dial time, not slot time.** A backed-up queue
   must re-validate recipient-local time and the kill switch immediately before dialing.
9. **Provider outages hold touchpoints in `scheduled` and never consume attempts** (circuit
   `provider_error` ≠ `failed`), so an outage can't corrupt the cadence/retry logic.
10. Slotting queries use **`FOR UPDATE SKIP LOCKED`**; all workers are **stateless competitors** —
    the horizontal-scaling story, no leader election.

---

## 9. Deployment

- Two Railway services (API+worker, and web), one **separate new Supabase project** (own DB,
  Auth, Storage buckets `imports` + `knowledge`). `DATABASE_URL` = Supabase pooler for pg-boss.
- Env: Anthropic (BYO key into Vapi, §15), **Telnyx** (SMS + number pool), Vapi + TTS
  (Cartesia/Aura-2 A/B vs. ElevenLabs), Resend, Voyage, Supabase URL/keys, myKaarma (later).
  Migrations `0001..N` stand up the new DB; seed service schedules.
- **pg-boss connection:** `DATABASE_URL` must be the **session-mode pooler (port 5432)**, never
  transaction-mode PgBouncer. pg-boss uses **LISTEN/NOTIFY + long-lived connections** that break
  *silently* in transaction mode — the symptom is jobs mysteriously not picking up.
- Put pg-boss in **its own schema**; set `archive`/`deleteAfter` retention so the job table doesn't
  bloat; monitor job-table/index bloat (a busy pg-boss table degrades as vague "everything is slow").
- **Enable Supabase PITR (point-in-time recovery) day one** — `calls`/`transcripts` are
  contractually sensitive data you cannot regenerate.
- **SIGTERM handling** (Railway restarts kill in-flight jobs): stop claiming new jobs, let in-flight
  HTTP requests to Vapi drain (the call continues server-side at Vapi regardless), then exit. The
  two-phase claim makes even "killed between claim and confirm" recoverable via the reconciler.
- **Migrations as a separate release phase, backward-compatible for one version** (additive columns
  first → code that writes both → cleanup), so a rollback never meets a schema it can't run against.
- **Deferred until multi-dealership (considered, not missed):** multi-region, read replicas,
  failover databases. One Supabase instance is the accepted SPOF for the pilot; the claim/reconcile
  machinery guarantees a safe restart, which is the property that actually matters here.

---

## 10. Build order (vertical slice first)

**Slice 1 (proof): CSV → profile → scheduled call.** Fold in the **structural** HA pieces now —
idempotency is miserable to retrofit.
0. **Day one, parallel to coding:** buy Telnyx numbers + start A2P 10DLC registration (1–4wk lead
   time, §15/§11) so it's approved before the first live campaign.
1. Scaffold repo (fork structure, strip WhatsApp/lead-webhooks), root + web package.json, env.
   Provider defaults per §15: Telnyx telephony, Haiku live-loop model (Sonnet offline), Anthropic
   BYO key into Vapi.
2. Migrations 0001 (core: companies/memberships/customers/vehicles/... + RLS) + auth + supabase libs.
3. CSV upload + parse + fuzzy column-guess + mapping UI + import worker → customers/vehicles.
4. Service schedules table + seeded researched Toyota intervals + due-date computation.
5. Scheduler cron (`FOR UPDATE SKIP LOCKED`) → touchpoints → number-pool assignment → Vapi call
   via the **claim → gate → execute → confirm dispatch protocol** (§4b), incl. **kill-switch flags
   + pre-dial gate**. (claim/confirm columns land in this step.)
6. **Thin durable webhook** → `webhook_events` (§5b) → job: recording + transcript + personality.
7. Funnel dashboard + call playback + Customer Directory search.

**Step 8 — before the first live campaign** (correctness the pilot depends on): reconciler cron
(§4c); circuit-breaker table + pre-dial circuit gate; dial-time quiet-hours revalidation;
`daily_health` view + the five funnel alerts (§12); SIGTERM handling; and the **chaos test — kill
the worker mid-batch in staging, restart, assert zero duplicate dials** (this one test validates
most of the architecture).

**Step 8.5 — before the staff week** (so staff-week calls populate real charts): the
**conversation-intelligence slice** — mechanical metrics (code) + the `call_analyses` extraction job
+ the `daily_call_metrics` materialized view (§14). The **Insights page** (trends) lands ~a week
into the live campaign, once there's enough data for trends to be non-embarrassing.

**Then:** cadence engine (voicemail branch + follow-ups/reminders) · SMS/email adapters (same
claim/confirm) · number-pool warm-up ramp + answer-rate health · Settings (cadences, number pool,
voices) · campaigns · `BookingProvider` **soft mode** + in-call book tool (multi-appointment) ·
**RO/shown loop** (tagged notes + RO re-import) · advisor-queue auto-flags + prompt-regression
replay (§14d) · admin portal · real myKaarma adapter (on docs) · extensible ingest.

**Slice 9 — inbound service line (§16).** Independent of the outbound slices (it consumes calls
rather than placing them), so it can ship in parallel: caller identification → inbound assistant +
tools → services catalog → transfer + handoff queue → inbound stats. Its blocking external
dependency is only that the dealership's service line be pointed at a Vapi number.

---

## 11. Open items to confirm as we build
- Service-due **window**: how far before due to start calling (e.g. 30 days / 500 mi)? — default,
  then per-dealership setting; **tune empirically** from booking-rate-by-days-until-due (§14b).
- Customer-type taxonomy (loyal/lapsed/VIP/new) — start with a configurable default set;
  `shown`/no-show outcomes feed back into it (§6b).
- **Voicemail policy** per dealership: `drop_message` (default) vs. `hangup`; whether a drop counts
  as an attempt; VM + immediate booking-link SMS (default on) — wired in `cadences` (§2).
- **Number warm-up ramp curve** + answer-rate-decay thresholds for auto-quarantine — tune with data.
- **External / provider work (flagged, not code) — START NOW, long lead times:** buy **Telnyx**
  numbers + **A2P 10DLC registration this week** (1–4 weeks, non-transferable between providers —
  gates the first live campaign; §15); SHAKEN/STIR attestation + CNAM = dealership name per pool
  number; Free Caller Registry + reputation monitoring for real spam-label signal.
- Toyota interval data accuracy — researched from public sources, marked for dealer verification.
- **myKaarma:** until the real adapter, booking runs in `soft` mode (pending_confirmation); the
  shown-RO loop runs off tagged notes + RO re-import.
- **Reconciler timeouts** — `claiming` sweep at ~2 min, `in_flight` sweep at ~20 min; tune against
  real Vapi call durations.
- **Pilot concurrency cap** (`max_concurrent_calls`) — start at 10.

---

## 12. Observability & alerts (funnel-shaped, not server-shaped)

CPU graphs won't tell you the system is broken — **the funnel will.** One **`daily_health`
materialized view** + threshold checks gets ~90% of this without standing up Grafana. The five
alerts that matter:
1. **Slotted-today vs. dialed** gap → scheduler or worker stall.
2. **Answer-rate per number** trending down (**alert on a 20% drop over 3 days**) → carrier
   spam-labeling; this is the leading indicator.
3. **Webhook events received vs. calls placed** gap → webhook loss.
4. **Reconciler corrections per hour** — should be ~0; nonzero means a failure mode is active.
5. **Cost per day vs. expected** → runaway-spend tripwire.

**Structured logging with `touchpoint_id` as the correlation key** through every layer — when the
dealership asks "why did Mrs. Chen get called twice," you answer from logs in minutes.

### 12b. Unit economics (the renewal pitch, derived from real data)

`daily_health` **and the weekly digest** carry the numbers that become the real contract, not just
ops hygiene:
- **Cost per shown RO** — the headline. If the pilot shows **~$6 per shown RO against a ~$400
  average RO value**, that ratio *is* the renewal pitch, derived from real data while the caps kept
  the downside at pocket change.
- **Cost per booked appointment** — the interim proxy before enough ROs close the loop (§6b).
- Supporting: cost per answered call, per dialed touchpoint, and the full conversion chain
  dialed → answered → booked → shown with cost attached at each stage.

Computed off `cost_events` (reused from realtyAI) joined to `appointments.status='shown'`, so the
same numbers that bound spend also price the product. The weekly digest pairs these economics with
the three conversation-intelligence numbers a service manager actually reads (booking-rate trend,
top objection, sentiment delta — §14c).

### 12c. Cost caps & bounded exposure (three independent layers)

The spend ceiling is not one guard — it's **three layers that must all fail simultaneously** to run
away, which is exactly why they're independent:
1. **Per-number daily cap** (ramped) — bounds volume at the source (§2 number pool).
2. **Live-call concurrency semaphore** (`max_concurrent_calls`, pilot 10) — a bad due-date
   computation that slots 5,000 touchpoints can't become 5,000 simultaneous calls (§4b gate).
3. **Daily + monthly spend caps** (`global_settings`) — the pre-dial gate refuses to dial and trips
   the global kill switch once hit.

**Bounded exposure:** worst realistic case is the **monthly cap (~$500) + ~$80 fixed ≈ a bounded
~$600/mo**, and the pilot fee can zero even that out. "Going broke" requires all three layers to
fail at once — the reason they're built as three.

## 13. Degradation ladder (written down as product behavior)

- **Vapi down / Anthropic down** → hold voice (touchpoints stay `scheduled`, no attempts consumed);
  **SMS/email cadence steps proceed.**
- **Twilio SMS down** → voice unaffected.
- **Supabase down** → everything stops — which is *fine*, because the claim/reconcile machinery
  guarantees nothing double-fires when it comes back.

**Acceptance test before the first live campaign:** kill the worker mid-batch in staging, restart,
and assert **zero duplicate dials**. That single chaos test validates most of the machinery above.

---

## 14. Conversation intelligence (why calls do/don't convert)

The funnel (§6) tells you *what* happened — called → booked. It can't tell you *why* booking rates
dip: script, voice, offer, list, or timing. Transcript-derived metrics are the only way to attribute
that. This section is the extraction schema → the diagnostic metrics → the aggregation → the
loop-closing behavior.

### 14a. Extraction — one structured pass per completed call

Extend the post-call job (§5) into a **single Claude call emitting a fixed JSON schema**, stored in
a new table **`call_analyses`** (PK `call_id`, `company_id` + standard RLS). Fields, grouped:
- **Conversation mechanics** — `customer_engaged`, `talk_ratio`, `interruption_count`,
  `customer_turn_count`, `silence_or_confusion_events`.
- **Comprehension & identity** — `understood_purpose`, `identity_confusion`, `ai_disclosure_reaction`.
- **Objections & intent** — `objections text[]` (fixed taxonomy), `objection_handled`,
  `interest_level` (hot|warm|cold|hostile), `commitment_type`
  (booked|soft_commit|callback_requested|declined|none).
- **Quality & safety (folds in the QA rubric)** — `script_adherence_score` (0–100),
  `disclosed_recording`, `stated_dealership`, `invented_facts`, `correct_vehicle_referenced`,
  `sentiment_start`, `sentiment_end`, `agent_error_notes`.
- **Language** — `language_detected`, `language_switch_requested`.
- **Bookkeeping** — `analysis_cost_usd`, `taxonomy_version`, `created_at`.

Two disciplines that keep trends trustworthy:
- **Mechanical vs. LLM-judged are separate classes.** Talk ratio, turn/interruption counts,
  seconds-to-hangup, confusion-gap counts come **from the transcript rows + Vapi turn timestamps —
  compute in code**, not the LLM. Only the *judgment* fields go to Claude. Mechanical metrics are
  cheaper **and stable**; LLM-judged metrics drift when the judge prompt changes. Read them knowing
  which class each belongs to.
- **Pin the taxonomy.** Objections/interest come from a **fixed enum** in the extraction prompt
  (`price | too_busy | services_elsewhere | just_serviced | sold_vehicle | doesnt_trust_ai | timing
  | other`) + a free-text field, or you get "too busy" / "busy" / "lack of time" as three
  categories and trends turn to mush. **Version it** (`taxonomy_version`) so charts show when a
  definition changed; review the `other` bucket monthly to grow the enum deliberately.

### 14b. The metrics that actually diagnose (grouped by the question they answer)

- **"Is the conversation working?"** — engagement rate (got past the greeting), **hangup-timing
  distribution** (0–10s = greeting/spam problem, 30–60s = pitch problem, late = closing problem —
  *the single most diagnostic chart for script iteration*), talk ratio + interruptions
  (>70% agent monologue correlates with declines), confusion-events/call (a combined proxy for
  voice quality + latency + script clarity — a rise after a voice/model change is your regression
  signal).
- **"Why aren't they booking?"** — **objection mix over time** (stacked %; each objection maps to a
  different fix *owner*: `services_elsewhere` → list/targeting, `price` → authorize a coupon,
  `doesnt_trust_ai` → disclosure phrasing — this is what makes it actionable), objection→outcome
  conversion (do the objection-handling lines earn their tokens?), and `sold_vehicle`/`just_serviced`
  rates as **per-import data-quality** signals (feeds CSV auto-clean + shows the dealership export
  freshness matters).
- **"Is the agent behaving?"** — adherence **mean + p10** (the tail matters more than the average),
  **invented-facts rate (pinned at zero — any nonzero week is a prompt-regression alarm)**,
  correct-vehicle rate (catches import-mapping bugs surfacing in live calls), **disclosure
  compliance (must be 100% — legal, alert otherwise)**, and **sentiment delta** (even declined calls
  with positive deltas protect the brand; negative-delta calls auto-flag for human listen-back).
- **"What converts?"** — booking rate sliced by time-of-day × day-of-week (feeds answer-rate-weighted
  dialing), attempt number (does attempt 3 ever convert, or is `max_call_attempts=2` free money?),
  **voice ID (A/B with real data)**, language matched vs. not, customer type, vehicle age band, and
  **days-until-due at call time** — which directly tunes the service-due window (§11).

### 14c. Aggregation & trends (no BI stack — three layers)

- **`daily_call_metrics` materialized view** (refresh nightly with `daily_health`): per company ×
  campaign × day — answer/engagement rate, mean/p10 adherence, objection counts by type,
  sentiment-delta mean, booking rate, and **hangup-time histogram as four columns**
  (0–10s / 10–30s / 30–60s / 60s+ — enough for the diagnostic without storing distributions).
- **Dashboard "Insights" page** — 4–6 week trend lines for headline metrics, the objection-mix
  stacked chart, the hangup histogram, and a **"worst calls this week" list** (lowest adherence +
  most negative sentiment delta) linking straight to playback. *Trends say something changed;
  listening to the three worst calls says what* — the highest-value element on the page.
- **Weekly digest additions** — three numbers for the service manager: **booking-rate trend, top
  objection, sentiment delta.** Not fifteen metrics — "customers' #1 pushback this week was price,
  and calls are landing more positively than last week."
- **Segmentation discipline:** every metric slices by campaign, cohort, voice, language, taxonomy
  version. At ~400 answered calls/campaign most weekly slices are n<50 — **show sample sizes on
  every chart, use 4-week rolling windows for anything sliced**, and don't read week-over-week noise
  as signal. (The cohort slice keeps the A/B honest: treatment-side conversation quality is the
  mechanism check on the shown-RO result.)

### 14d. Closing the loop (these metrics drive the system, not just report)

- **Auto-flags into the advisor queue:** adherence < threshold, `invented_facts=true`, hostile
  interest, negative sentiment delta, or disclosure missed → a human reviews the recording. This is
  the production QA sampling strategy: **100% of flagged calls + a random 5% of clean ones**, not
  listen-to-everything.
- **Prompt-change regression protocol:** before any behavior-template edit ships, replay the fixed
  scenario set and **diff the `call_analyses` outputs against the current baseline.** The
  `call_analyses` schema *is* the eval schema — **same rubric offline and online**, so offline evals
  actually predict production numbers.

**Cost:** one analysis pass on a ~2-min transcript is ~a cent with a Haiku-class model (~$5/campaign
at pilot volume), gated by the same daily spend cap (§12c). **Build order:** mechanical metrics +
extraction job + `daily_call_metrics` view land in **one slice before the staff week** (so
staff-week calls populate real charts); the **Insights page arrives ~a week into the live campaign**,
when there's enough data for trends to be non-embarrassing.

---

## 15. Cost-optimized provider defaults

Four provider choices roughly **halve per-minute cost (~$0.25–0.30 → ~$0.12–0.15**; a 1,000-customer
campaign ~$400 → ~$200) with **no functionality lost and no architecture change** — each lives behind
an abstraction the plan already has. *Re-check live pricing before committing; these rates move
quarterly.*

1. **Telephony — Telnyx (voice + SMS), not Twilio.** ~$0.007/min voice (vs. ~$0.014), ~$0.004/SMS
   (vs. ~$0.0083). Vapi supports Telnyx numbers natively; the SMS adapter swaps behind the channel
   provider interface — **so Telnyx is the default number-pool + SMS provider** (the `phone_numbers`
   pool and §5b Twilio-status-callback wording generalize to it). **Do this first:** buy numbers and
   start **10DLC registration through Telnyx this week** — approval is **1–4 weeks and does NOT
   transfer between providers**, so it gates the first live campaign and can't be back-loaded.
2. **Call LLM — Haiku for the live voice loop, not Sonnet.** ~⅓ the token price **and lower latency**
   (a feature in a voice loop). **Keep Sonnet for offline jobs** — `call_analyses` extraction/QA
   scoring (§14a) and personality synthesis — where quality > latency. Per-call model is already a
   per-assistant config field (§5); validate the Haiku switch via the adversarial testing ladder at
   build time (zero runtime risk).
3. **TTS — A/B Cartesia or Deepgram Aura-2 against ElevenLabs.** The single biggest line item drops
   **3–7×**; indistinguishable over 8kHz phone audio, and Cartesia's ~40ms latency *improves*
   conversation feel. Both are native Vapi options — a **per-assistant config change, not an
   integration** — so this rides the existing per-call **voice-selection** field (§5) and the
   **booking-rate-by-voice** metric (§14b) picks the winner during staff week.
4. **Anthropic — BYO key in Vapi.** Skips Vapi's ~5–15% managed LLM markup **and puts call-LLM spend
   under our existing Anthropic spend cap** (§12c) instead of Vapi's invoice. Leave STT/TTS managed
   by Vapi until ~20k min/month.

**Unchanged (deliberately):** Vapi as orchestrator (the ~$0.05/min fee buys the whole pipeline —
STT/LLM/TTS glue, recording, webhooks), **Deepgram STT** (already cheapest), Supabase Pro (PITR
requires it, §9), Railway, Resend, Voyage.

---

## 16. Inbound service line (the agent answers the dealership's calls)

Service calls coming into the dealership route to this agent. It answers questions about the
services we own, identifies the caller from their phone number, tells them what's coming up on
their cars and recommends it, and hands off to a service employee for anything else.

**This inverts three assumptions the outbound design is built on**, which is why it's its own
subsystem rather than a flag on the existing path:

| Outbound (§4–§5) | Inbound (§16) |
|---|---|
| We choose the customer; prompt assembled **before** the call | Caller unknown until connect → **lookup by caller ID at call time** |
| Prompt fixed for the call's duration | Agent **queries mid-call** via tools (their cars, what's due, our services) |
| Goal: book a reminder | Goal: **answer**, recommend due service, **transfer** when out of scope |
| A `touchpoint` exists before the call | **No touchpoint** — a call with no scheduled work behind it |
| Failure mode: duplicate dials | Failure mode: **wrong customer identified**, or a dead-end question |

### 16a. Identification — caller ID only, generic otherwise

Vapi's inbound webhook carries the caller's E.164. We look it up against `customers.phone`
(scoped to the dealership that owns the receiving number, via `phone_numbers`).

- **Exactly one match →** *identified*. The agent gets that customer's profile, vehicles, and due
  service, and may discuss them.
- **Zero matches, or more than one →** *anonymous*. The agent answers **generic questions only**
  (services offered, hours, general guidance) and **never reads any customer-specific data**. It
  offers a transfer for anything needing an account.

Multiple matches deliberately fall to anonymous: a shared household/work number must not cause the
agent to read the wrong person's vehicle history. **Privacy rule (hardcoded guardrail):** no
customer-specific field is ever placed in an anonymous call's prompt or returned by its tools —
the isolation is enforced in the tool layer, not just in prompt wording.

Configurable per dealership as `settings.inbound.identify_mode`:
- **`caller_id_only`** (default, chosen) — as above.
- `verbal_verify` (built later, no schema change) — on a lookup miss, ask name + a second factor
  (plate / VIN last 6) and re-look-up. Deliberately deferred; the setting exists so enabling it is
  config, not a migration.

### 16b. "Where is my car" → transfer to the service line

A caller asking where their car is, or when it will be ready, is asking about a **repair order in
progress — data this system does not have** (no RO/work-in-progress table; `appointments` models
future visits, not current ones). The agent must therefore **never attempt an answer**; it detects
the intent and transfers.

- **Warm transfer** to the dealership's service line (`settings.inbound.transfer_number`), which is
  staffed and expected to pick up.
- **Fallback if the transfer doesn't connect** (no answer / busy / after hours): capture name,
  vehicle, callback number and reason into a `handoff_requests` row for an advisor to work, and
  tell the caller they'll be called back. "Should pick up" is an expectation, not a guarantee — an
  unanswered transfer must not drop the caller.
- Same path for any **out-of-scope** intent: complaints, billing/warranty disputes, anything the
  agent is unsure of, and an explicit request for a human ([HANDOFF]).

### 16c. Services catalog (what we own) — structured, no prices

A **`service_offerings`** table per dealership (`name`, `description`, `category`, `operations[]`,
`typical_duration_min`, `active`), edited in Settings. The agent answers "do you do X" from this
catalog only.

**Prices stay out.** The §8 no-invented-pricing guardrail holds on inbound: the agent describes
what a service is and what's involved, and routes cost questions to an advisor. A quoted price is a
customer-facing commitment the dealership has to honor, so it isn't the agent's to make. (A priced
variant is a column + a guardrail flip later if the dealership wants it.)

This is **not** RAG — a structured table is controllable and can't surface stale contradictory doc
text. Document RAG remains available for outbound (§5) and can layer in later.

### 16d. Recommending due service

On an **identified** call, the agent **answers the caller's question first**, then raises what's
coming due on their vehicle(s) and offers to book. Reuses `computeDue` (§4) unchanged — the same
engine that drives outbound slotting, called live instead of on a cron. Never leads with the
recommendation: this is the caller's agenda, not ours.

Booking on inbound uses the **same `BookingProvider`** and the same mode-gated wording (§2), so in
`soft` mode the agent captures a preferred time and promises confirmation — it never claims a firm
slot it didn't reserve.

### 16e. Mechanics

- **Inbound assistant + tools.** Vapi's `assistant-request` webhook fires on an incoming call; we
  respond **synchronously** with an assistant config whose system prompt is assembled from the
  identified (or anonymous) context. Four tools, all **server-side and tenant-scoped**:
  `lookup_services`, `get_my_vehicles`, `get_due_service`, `book_service`, plus Vapi's native
  `transferCall`. **No tool accepts a `company_id` or `customer_id` from the model** (§8 invariant
  2 extended to inbound) — identity is resolved server-side from the call id and pinned to the
  call. This is the mechanism that makes the anonymous case safe.
- **Inbound calls are first-class rows.** `calls` gains `direction` ('outbound'|'inbound') and
  `from_number`; `touchpoint_id` is already nullable, so an inbound call simply has none. The
  end-of-call webhook (§5b) path is reused as-is — transcripts, recording, cost, and `call_analyses`
  all work unchanged for inbound.
- **`handoff_requests`** — `company_id`, `call_id`, `customer_id` (nullable), `caller_number`,
  `reason` ('where_is_my_car'|'pricing'|'complaint'|'requested_human'|'out_of_scope'|'other'),
  `vehicle_hint`, `notes`, `status` ('open'|'resolved'), surfaced as an advisor queue in the
  dashboard.
- **Dashboard:** inbound calls appear in the existing Calls list (with a direction filter and
  playback) and a new **Handoffs** queue. Settings gains the services catalog + inbound config
  (transfer number, identify mode, greeting).

### 16f. What inbound does NOT touch

Inbound places no outbound calls, so the dispatch protocol (§4b), reconciler (§4c), number-pool
caps/warm-up, quiet hours, and the kill switches are all **irrelevant to it** — it consumes a call
that already exists. The cost caps (§12c) still apply via the shared spend ceiling, and inbound
minutes must be added to the pilot cost model: **inbound volume is not something we pace**, so it's
the one uncapped-by-design cost line and is worth watching in `daily_health`.

### 16g. Open items for inbound

- **Real answer for "where is my car" needs RO data.** Transfer is right for the pilot, but the
  high-value version is a myKaarma RO-status read. Same `BookingProvider`-style abstraction; blocked
  on the same API access.
- **Match rate is the metric that decides whether `caller_id_only` survives.** Log identified vs.
  anonymous per inbound call from day one — if anonymous is a large share, `verbal_verify` becomes
  the pragmatic default (the setting is already there).
- Transfer-failure rate — if the service line frequently doesn't pick up, the fallback queue
  becomes the primary path and needs an SLA.
- After-hours behavior: currently message-capture; a dealership may prefer a different greeting.
