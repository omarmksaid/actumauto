# How the agent works

Reference for the inbound service line: what happens on a call, where every piece of information
comes from, and what the agent can and cannot do.

Companion docs: `PLAN.md` (architecture + why), `SETUP.md` (configuration).

---

## The short version

Someone calls the dealership's service number. Vapi answers, asks our API who is calling, and we
reply with an assistant built for that specific caller — their name, their cars, what those cars
are due for, and the dealership's service list. The agent answers questions, recommends due
service, books a visit, and transfers anything it shouldn't handle to a service employee.

**There is no outbound.** The system never places calls or sends SMS.

---

## 1. Call lifecycle

```
Caller dials +1 628-285-1278
        │
        ▼
   Vapi answers, POSTs ──► /inbound/assistant        (once, before the agent speaks)
        │                       │
        │                       ├─ which dealership owns the dialed number?
        │                       ├─ which customer owns the calling number?
        │                       ├─ load their vehicles + compute what's due
        │                       ├─ load the dealership's services catalog
        │                       ├─ write a `calls` row pinning identity to the Vapi call id
        │                       └─ return: greeting + system prompt + tool list
        ▼
   Agent talks. Each tool it invokes ──► /inbound/tools   (many times per call)
        │                                     │
        │                                     └─ re-resolves identity from the call id,
        │                                        never from what the model claims
        ▼
   Call ends. Vapi POSTs ──► /webhooks/vapi
        │                       │
        │                       ├─ verify secret, store raw payload, return 200 immediately
        │                       └─ background job: recording, transcript, cost, opt-out
        ▼
   Dashboard: Today · Calls (playback + transcript) · Handoffs
```

Both `/inbound/*` endpoints authenticate on the `x-vapi-secret` header. Without a match: 401, and
the agent never answers.

---

## 2. How the agent knows who is calling

**Caller ID only.** No verbal verification (that mode is designed but not built).

`identify_inbound_caller(to_number, from_number)` — a Postgres function — does two lookups:

1. **Dialed number → dealership.** Matches `phone_numbers.e164`. No match ⇒ HTTP 404 and the agent
   does not answer. This is why the `e164` must exactly match what Vapi reports.
2. **Calling number → customer.** Compares the **last 10 digits**, ignoring formatting, so
   `+16283587659`, `(628) 358-7659`, and `6283587659` all match the same person.

The result decides everything downstream:

| Matches | Result | What the agent knows |
|---|---|---|
| exactly 1 | **identified** | name, language, vehicles, due service |
| 0 | **anonymous** | nothing about the caller |
| 2 or more | **anonymous** | nothing about the caller |

**Two or more matches is deliberately treated as anonymous.** A shared household or work number
must never cause the agent to read one person's vehicle history to another. Silence is the correct
answer when we are not sure who is on the line.

The name itself is just `customers.full_name`, read after a single-match lookup
(`src/inbound/identify.ts`), and it reaches the agent two ways: in the greeting
(*"hi Omar"*) and in the system prompt (`CALLER: Omar Said (first name: Omar)`).

That row comes from the **CSV import** — the dealership uploads its past customers and vehicles,
which is the only reason an inbound caller is recognizable at all.

---

## 3. Where the agent's knowledge comes from

**There is no RAG.** No embeddings, no vector search, no uploaded documents. Everything the agent
knows comes from structured database rows. Two distinct sources answer two distinct questions:

### "Do you do X?" → `service_offerings`

**Only service NAMES go in the prompt.** Full descriptions and durations were 903 tokens — 38% of
the prompt — re-sent on every turn of every call, which costs both money and time-to-first-token.
Names are enough to know whether we do something; `lookup_services` fetches what a service involves
on demand. Past 40 services even the names are dropped and the agent relies entirely on the tool.


A per-dealership catalog: name, description, category, typical duration. Edited in
**Settings → Services we offer**. The agent may describe **only** what is in this table.

Queried by the `lookup_services` tool, which matches on **word stems** so natural speech reaches
formal catalog entries — "brakes" and "my brakes are squeaking" both find *Brake pad replacement*.
Nothing matches ⇒ the agent says so and offers a transfer rather than inventing a service.

**Adding services in bulk:** edit `scripts/services.json` and run
`npx tsx scripts/import-services.ts`. Only `name` is required; `description`, `category`,
`typical_duration_min`, `operations`, and `active` are optional. It matches on name and updates
rather than duplicating, so re-running after an edit is safe. `--replace` deactivates entries the
file no longer lists (deactivates, never deletes, so past appointments stay intelligible).

**No prices, by design.** There is no price column. A quoted price is a commitment the dealership
must honor, so cost questions are routed to an advisor.

### "What is my car due for?" → `service_schedules` + the due engine

`service_schedules` / `service_intervals` hold maintenance intervals per make/model (seeded with
public Toyota data, marked approximate and editable at **Service Schedules**). A dealership's own
schedule overrides the built-in default.

`computeDue()` matches the caller's vehicle to a schedule and works out the next unmet interval:

- Projects current mileage from the last odometer reading and the derived daily driving rate
- Treats intervals as **repeating** — a car 5,594 miles past its last service is due for its *next*
  oil change, not the 5,000-mile one it already had
- Takes whichever axis comes first, mileage or time
- Prefers the more thorough service when two land within a week (a 30k major service beats a
  concurrent oil change)
- **Returns nothing when there is no odometer and no dates** — the agent then makes no
  recommendation rather than inventing a due date

This runs live during the call, not on a schedule.

---

## 4. The five tools

| Tool | Available to | Does |
|---|---|---|
| `lookup_services` | everyone | Search the dealership's catalog. Never returns prices. |
| `transfer_to_service` | everyone | Hand off to a human. Always writes a handoff row first. |
| `get_my_vehicles` | identified only | The caller's vehicles on file. |
| `get_due_service` | identified only | What each vehicle is due for, and when. |
| `book_service` | identified only | Capture an appointment request. |

**The security rule:** no tool accepts a `company_id` or `customer_id` from the model. Every call
re-resolves identity server-side from the Vapi call id, which was pinned to a `calls` row at
assistant-request time. So:

- an anonymous caller reaches no customer data, whatever the model is persuaded to ask for;
- an identified caller reaches only their own.

The customer-scoped tools are **not offered** on an anonymous call *and* **refuse server-side** if
invoked anyway — belt and braces, because prompt wording alone is not a security boundary.

`vehicle_id` is the single id accepted from the model, and it is validated against the pinned
customer before use.

---

## 5. Use case walkthroughs

### A. Known caller asks about a service

> **"Do you guys do brake work?"**

Identified as Omar Said. Agent calls `lookup_services("brake work")` → *Brake pad replacement*,
describes it, no price. Then, per the recommend-after-resolving rule, mentions the RAV4 is coming
due for an oil and filter change and offers to book.

### B. Known caller asks what is due

> **"Is my car due for anything?"**

`get_due_service` → *2022 Toyota RAV4: oil & filter, tire rotation, multi-point inspection, due
around 2026-12-16 (~33,480 mi)*. Offers to book.

### C. Unknown caller

> **"What's due on my car?"** (number not on file, or shared by two customers)

The agent has no vehicle data in its prompt, was not given the customer tools, and would be refused
if it tried. It explains it cannot look up the account and offers a transfer. **It never mentions a
vehicle.**

### D. "Where is my car?"

Always a transfer, never an answer — **there is no repair-order data in this system.** The agent
detects the intent, writes a `handoff_requests` row, and transfers to the service line.

**If the transfer does not connect,** the row is already written with `transferred=false` and
surfaces in the Handoffs queue as *"Call them back."* A caller is never silently dropped — "the
service line should pick up" is an expectation, not a guarantee.

### E. Pricing, billing, complaints, "let me talk to a person"

All transfer, all logged with a reason. Pricing is a deliberate refusal, not a gap.

### F. Booking

**Hours are enforced twice.** The agent is told the opening hours and instructed to refuse times
outside them; `book_service` also checks server-side and refuses, because a prompt rule is guidance
and a captured out-of-hours request is a promise the dealership has to walk back. Vague phrasing
("sometime next week") still passes through for an advisor to sort out. Hours live in
`companies.business_hours` per weekday, `null` = closed.

**The vehicle is always confirmed aloud** before a booking is captured — even for a customer with
one car on file. Assuming silently is right most of the time and wrong invisibly.


`book_service` captures a preferred time and writes an appointment as `pending_confirmation` for an
advisor to place. In this **`soft` mode** the agent promises a confirmation text and **never claims
a firm slot** — telling someone they are booked when they are not is worse than not answering.
Multiple vehicles ⇒ the agent asks which one.

### G. Opt-out

If the caller asks not to be contacted, the post-call job sets `customers.opted_out`.

---

## 6. What the dashboard shows

- **Today** — call volume, identify rate, anonymous and ambiguous counts, bookings, open handoffs,
  callbacks owed, spend
- **Calls** — every inbound call with recording playback and transcript
- **Handoffs** — the queue, with failed transfers pinned to the top
- **Customer Directory** — search by phone, name, or VIN
- **Imports** — CSV upload with column mapping
- **Service Schedules** — the intervals behind every recommendation
- **Settings** — inbound config, services catalog, numbers, voice

**The identify rate is the number to watch.** If a large share of callers land anonymous, caller-ID
matching is not good enough for this dealership and verbal verification becomes worth building.

---

## 6b. Testing the agent without calling

`scripts/chat.ts` talks to the agent from a terminal using the **same** `/inbound/assistant` and
`/inbound/tools` endpoints Vapi calls — same prompt, same tools, same data. Only speech is missing.

```bash
npx tsx scripts/chat.ts                # as a known caller (first customer on file)
npx tsx scripts/chat.ts --anon         # as an unrecognized caller
npx tsx scripts/chat.ts --from 628-358-7659   # as a specific number (any format)
npx tsx scripts/chat.ts --prompt       # print the system prompt and exit
```

The number is normalized to E.164 before the lookup — the form Vapi actually sends — and the
header states which of the three identification outcomes you're testing (identified / not on file
/ ambiguous). The ambiguous case, where two customers share a number and both are refused, is
otherwise very hard to reproduce on a real phone.

Tool calls are executed for real and printed, so you can see whether the agent **looked something
up** or invented it — the single most useful signal when tuning the prompt. Scripted turns work
too (`printf 'where is my car?\n' | npx tsx scripts/chat.ts`), which makes a prompt change
repeatable to check.

**Database effects:** a simulation writes a `calls` row (identity is pinned to it, which is how
the tools stay tenant-safe) and any `handoff_requests` a transfer produces. Both are deleted when
you exit, so the dashboard keeps reflecting only real calls. A hard kill can strand them —
`npx tsx scripts/chat.ts --cleanup` sweeps any leftovers. Bookings are NOT written: book_service
runs, but its appointment is removed with the call row.

To change how the agent behaves, edit `src/inbound/prompt.ts` — guardrails are hardcoded there,
and the dealership-editable persona sits inside them (Settings → inbound behavior prompt).

---

## 6c. Stopping the agent (kill switch)

```bash
npx tsx scripts/agent-switch.ts off    # AI stops; callers are transferred to a human
npx tsx scripts/agent-switch.ts on     # resume
npx tsx scripts/agent-switch.ts        # show current state
```

**OFF still answers the phone.** The caller hears one line — *"let me get you to our team right
away"* — and is transferred. Only `log_handoff` and `transferCall` are offered; the agent cannot
discuss services, look up an account, or book. Customer data is not even loaded.

That is deliberate. Silence is worse for the caller than a handoff, and an unanswered service line
is a lost customer either way. Takes effect on the **next** call; a call in progress finishes.

A second, harder lever: set `phone_numbers.enabled = false` (Settings → Numbers). That number then
resolves to no dealership, our endpoint returns 404, and the agent does not answer at all — Vapi
falls back to its own handling. Use it to take a number dark entirely.

The hardest stop of all is Vapi: clear the number's Server URL, and nothing reaches us.

---

## 7. Guardrails (hardcoded, not editable)

1. Never invent prices, promotions, or wait times
2. Only describe services the catalog returns
3. Never guess the status of a vehicle in the shop
4. Never claim a firm booking in `soft` mode
5. Anonymous callers get no customer-specific data — enforced in the tool layer
6. Disclose being an assistant and that calls may be recorded

The dealership's editable persona wraps *inside* these; it cannot override them.

---

## 8. Known limits

| Limit | Why | Path forward |
|---|---|---|
| No real "where is my car" | No repair-order data exists | myKaarma RO status API |
| Bookings are soft commits | No booking API access | myKaarma booking adapter |
| No verbal verification | Not built; setting exists | Build the in-call flow |
| No document RAG | Deliberate — a structured catalog is controllable and cannot surface stale text | Add later if arbitrary Q&A is needed |
| No prices | Deliberate | Add a price column + flip the guardrail |
| No automated tests | Not yet written | Due engine and identification are pure and testable |
