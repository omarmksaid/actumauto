# ActumAuto

AI phone agent for an auto-dealership **service center**. Inbound only.

A customer calls the service line. The agent identifies them from their caller ID, answers
questions about the services the dealership offers, tells them what's coming due on their car,
books a visit, and transfers to a service employee for anything out of scope — above all
"where is my car", which it never attempts to answer.

## Docs

| | |
|---|---|
| [`FLOW.md`](FLOW.md) | How the agent works, per use case — the call lifecycle, tools, guardrails |
| [`SETUP.md`](SETUP.md) | Configuration and deployment, start to finish |
| [`PLAN.md`](PLAN.md) | Architecture and the reasoning behind it (§16 is the live design) |

## Layout

```
src/inbound/     caller identification, prompt assembly, Vapi assistant config
src/routes/      API — /inbound/assistant, /inbound/tools, dashboard endpoints
src/scheduling/  service-due engine (what a vehicle needs next)
src/imports/     CSV import of past customers + vehicles
web/             Next.js dashboard (calls, transcripts, handoffs, settings)
supabase/        migrations + seed
scripts/         preflight, agent kill switch, terminal simulator, deploy helpers
```

## Running locally

```bash
npm install && cp .env.example .env    # fill in the 8 required vars
npm run preflight                      # verifies every dependency before a call
npm run dev                            # API + worker on :3000
cd web && npm run dev                  # dashboard on :3001
```

**Talk to the agent without phoning it:**

```bash
npx tsx scripts/chat.ts            # as a known caller
npx tsx scripts/chat.ts --anon     # as an unrecognized caller
```

**Stop the agent:**

```bash
npx tsx scripts/agent-switch.ts off   # callers are handed to a human instead
```

## Stack

Vapi (voice orchestration) · Anthropic Haiku (BYO key) · Deepgram STT · Supabase (Postgres,
Auth, Storage) · pg-boss · Next.js · Railway.
