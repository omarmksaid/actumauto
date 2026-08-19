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

A per-dealership catalog: name, description, category, typical duration. Edited in
**Settings → Services we offer**. The agent may describe **only** what is in this table.

Queried by the `lookup_services` tool, which matches on **word stems** so natural speech reaches
formal catalog entries — "brakes" and "my brakes are squeaking" both find *Brake pad replacement*.
Nothing matches ⇒ the agent says so and offers a transfer rather than inventing a service.

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
