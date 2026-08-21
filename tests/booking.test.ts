/**
 * Booking failure wording.
 *
 * From a real call: book_service returned "That vehicle isn't on this caller's account", and the
 * agent told the customer "Your RAV4 is scheduled for Saturday at 8:30." Nothing was stored. A
 * failure the model can read as a note is a failure it will paper over, so every failure path
 * must be unmistakable.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildInboundSystemPrompt } from "../src/inbound/prompt";
import type { InboundContext } from "../src/inbound/identify";

const SRC = readFileSync("src/routes/inbound.ts", "utf8");

/**
 * The source of a single function, by brace matching.
 *
 * Slicing to the next `\nasync function` or `\n}` silently truncates: the first stops at a
 * later sibling that may not exist, the second stops at the first column-0 `}` inside the
 * function. Both produce a body that PASSES a "does it contain X" check by accident, or fails
 * it while the real code is fine.
 */
function fnBody(name: string): string {
  const start = SRC.search(new RegExp(`(async )?function ${name}\\b`));
  if (start < 0) return "";
  // Count from the opening paren so an inline parameter type — buildAppointmentNote(a: {...}) —
  // is consumed as part of the signature. Anchoring on the first `{` would instead treat that
  // type literal as the whole body and return before the function's real content.
  let depth = 0, inBody = false;
  for (let i = SRC.indexOf("(", start); i < SRC.length; i++) {
    const ch = SRC[i];
    if (ch === "(" || ch === "{") depth++;
    else if (ch === ")") depth--;
    else if (ch === "}") { depth--; if (inBody && depth === 0) return SRC.slice(start, i + 1); }
    if (!inBody && depth === 0 && ch === ")") {
      const brace = SRC.indexOf("{", i);
      if (brace < 0) return SRC.slice(start);
      inBody = true; i = brace; depth = 1;
    }
  }
  return SRC.slice(start);
}

test("every book_service failure path says FAILED and forbids confirming", () => {
  const body = fnBody("bookService");
  // Grab the WHOLE return expression, not just its first string literal — several failure
  // messages are concatenated across lines ("...booking to. " + "Do NOT say it's booked..."),
  // and stopping at the first closing quote would hide the very clause we're checking for.
  const returns = [...body.matchAll(/return\s+((?:[`"][^`"]*[`"]\s*\+?\s*)+)/g)]
    .map((m) => m[1].replace(/[`"]\s*\+?\s*[`"]/g, "").replace(/[`"]/g, ""))
    .filter((r) => r.length >= 20);
  // A refusal is anything instructing the agent NOT to proceed. Success paths return the
  // provider's confirmation text instead.
  const failures = returns.filter((r) => /Do NOT|FAILED|Ask (the caller|which)/i.test(r));
  assert.ok(failures.length >= 3, `expected several failure paths, found ${failures.length}`);
  for (const f of failures) {
    assert.ok(/FAILED/.test(f), `failure not marked FAILED: "${f.slice(0, 60)}"`);
    assert.ok(/do NOT (say|tell)/i.test(f), `failure doesn't forbid confirming: "${f.slice(0, 60)}"`);
  }
});

test("a hallucinated vehicle id falls back when there's only one car", () => {
  // The model writes "2022_Toyota_RAV4" instead of the UUID. With one vehicle there is no
  // ambiguity, so booking should proceed rather than dead-end.
  assert.ok(/else if \(vehicles\.length === 1\)/.test(SRC),
    "no single-vehicle fallback for an unrecognized id");
});

test("the prompt forbids claiming success the tool didn't return", () => {
  const ctx: InboundContext = {
    companyId: "c", companyName: "T", timezone: "America/Los_Angeles",
    customerId: "cu", customerName: "Omar Said", customerLanguage: null,
    vehicles: [], offerings: [], transferNumber: null, greeting: null, personaTemplate: null,
    identifyMode: "caller_id_only", agentEnabled: true, businessHours: {},
    todayLabel: "Friday, August 21, 2026", inService: null, matchCount: 1,
  };
  const p = buildInboundSystemPrompt(ctx, "soft");
  assert.ok(/NEVER say something is booked/i.test(p), "prompt doesn't forbid false confirmation");
  assert.ok(/FAILED/.test(p), "prompt doesn't explain the FAILED convention");
});

test("booking requires the vehicle to be confirmed out loud", () => {
  const body = fnBody("bookService");
  assert.ok(/vehicle_confirmed/.test(body), "no confirmation gate before booking");
  assert.ok(/haven't confirmed which vehicle/i.test(body),
    "the refusal doesn't tell the agent to ask which car");
});

test("a vehicle not on file is never booked against a different car", () => {
  const body = fnBody("bookService");
  // other_vehicle must be checked BEFORE the single-vehicle fallback, or a Tacoma gets stored
  // as the customer's RAV4 and the advisor never learns which car is arriving.
  assert.ok(body.indexOf("if (otherVehicle)") < body.indexOf("vehicles.length === 1"),
    "the single-vehicle fallback can override an explicitly different vehicle");
  // The advisor-facing wording lives in buildAppointmentNote; what bookService owes us is the
  // signal it renders from — the vehicle it couldn't match must be flagged as off-file, not
  // quietly dropped.
  assert.ok(/vehicleOnFile:\s*!!vehicleId/.test(body),
    "bookService doesn't tell the note whether the vehicle is on file");
  assert.ok(/vehicle:\s*vehicleLabel\s*\?\?\s*otherVehicle/.test(body),
    "an off-file vehicle description never reaches the note");
});

test("the appointment note tells an advisor who, what car, what work, and waiting-vs-drop-off", () => {
  // "(booked on inbound call) AA:uuid" told them none of that. They place this in myKaarma
  // without listening to the recording, so the row has to stand on its own.
  const body = fnBody("buildAppointmentNote");
  assert.ok(body, "no appointment note builder");
  for (const field of ["customerName", "vehicle", "Requested", "When", "WAIT"]) {
    assert.ok(body.includes(field), `note is missing ${field}`);
  }
});

test("a vehicle we don't have on file is flagged in the note", () => {
  const body = fnBody("buildAppointmentNote");
  assert.ok(/NOT ON FILE/.test(body), "advisor isn't told to add an unknown vehicle");
});

test("the prompt tells the model to carry an answered vehicle question into the flag", () => {
  // From a real call: the agent asked "are we talking about your 2022 RAV4?", the caller said
  // yes, then book_service was called WITHOUT vehicle_confirmed. The gate refused, and the
  // caller was asked the identical question a second time. The gate is right; the model just
  // was never told that an earlier answer sets the flag.
  const ctx: InboundContext = {
    companyId: "c", companyName: "T", timezone: "America/Los_Angeles",
    customerId: "cu", customerName: "Omar Said", customerLanguage: null,
    vehicles: [], offerings: [], transferNumber: null, greeting: null, personaTemplate: null,
    identifyMode: "caller_id_only", agentEnabled: true, businessHours: {},
    todayLabel: "Friday, August 21, 2026", inService: null, matchCount: 1,
  };
  const p = buildInboundSystemPrompt(ctx, "soft");
  assert.ok(/vehicle_confirmed: true/.test(p), "the prompt never names the flag");
  assert.ok(/do not ask twice/i.test(p), "nothing prevents re-asking what they already answered");
});

test("the caller's real vehicle ids reach the prompt", () => {
  // Without ids in the vehicle block the model has no reason to call get_my_vehicles, so it
  // invents one ("2022-toyota-rav4"). That only books because of the single-vehicle fallback.
  const ctx: InboundContext = {
    companyId: "c", companyName: "T", timezone: "America/Los_Angeles",
    customerId: "cu", customerName: "Omar Said", customerLanguage: null,
    vehicles: [
      { id: "8f3c1e22-0000-4000-8000-000000000001", make: "Toyota", model: "RAV4", year: 2022, vin: null, mileage: 41000, due: null },
      { id: "8f3c1e22-0000-4000-8000-000000000002", make: "Toyota", model: "Tacoma", year: 2024, vin: null, mileage: 9000, due: null },
    ],
    offerings: [], transferNumber: null, greeting: null, personaTemplate: null,
    identifyMode: "caller_id_only", agentEnabled: true, businessHours: {},
    todayLabel: "Friday, August 21, 2026", inService: null, matchCount: 1,
  };
  const p = buildInboundSystemPrompt(ctx, "soft");
  assert.ok(p.includes("id=8f3c1e22-0000-4000-8000-000000000001"), "RAV4 id missing from prompt");
  assert.ok(p.includes("id=8f3c1e22-0000-4000-8000-000000000002"), "Tacoma id missing from prompt");
  assert.ok(/never invent one/i.test(p), "the model isn't told to use these ids verbatim");
});

test("a second booking at the same time merges instead of creating a duplicate", () => {
  // From a real call: the caller booked an oil change, then agreed to add a tire rotation. Two
  // rows landed at 11:00 AM for the same car, and the calendar showed three 11 AM appointments
  // for one visit. Retrying a failed booking did the same thing.
  const body = fnBody("bookService");
  assert.ok(/MERGE INSTEAD OF DUPLICATING/.test(body), "no merge path in bookService");
  assert.ok(/\.eq\("starts_at", startsAt\.toISOString\(\)\)/.test(body),
    "the existing-appointment lookup isn't keyed on the start time");
  assert.ok(/\.in\("status", \["pending_confirmation", "confirmed", "in_service"\]\)/.test(body),
    "the merge doesn't restrict to live appointments — cancelled visits are history");
  assert.ok(/it's ONE visit, not a second booking/.test(body),
    "the agent isn't told the merge was not a new booking");
});

test("merging unions the service list rather than replacing it", () => {
  // Replacing would silently drop the oil change when the tire rotation was added, and the
  // advisor would never know the car was supposed to get both.
  const body = fnBody("bookService");
  assert.ok(/mergedOps/.test(body), "no merged operation list");
  assert.ok(/seen\.has\(o\.toLowerCase\(\)\)/.test(body),
    "duplicate ops aren't deduplicated case-insensitively");
});

test("start_now moves the appointment to the present and checks it in", () => {
  // Demoing the "we have your car in with us" greeting needs an appointment that is BOTH
  // in_service and dated now. Checking in alone leaves it sitting at its original time, which
  // reads as stale on the calendar even though the agent would greet on it.
  const SRC = readFileSync("src/routes/agent.ts", "utf8");
  const h = SRC.slice(SRC.indexOf('agentRoutes.patch("/appointments/:id"'));
  const block = h.slice(h.indexOf('b.action === "start_now"'), h.indexOf('b.action === "check_in"'));
  assert.ok(/patch\.status = "in_service"/.test(block), "start_now doesn't set in_service");
  assert.ok(/patch\.starts_at = now\.toISOString\(\)/.test(block), "start_now doesn't move the visit to now");
  assert.ok(/patch\.checked_in_at/.test(block), "start_now doesn't stamp the check-in");
});

test("reopen clears the terminal timestamps, not just the status", () => {
  // Leaving completed_at/canceled_at set would leave a row that says "confirmed" while carrying
  // a completion time, and the same appointment couldn't cleanly drive the demo twice.
  const SRC = readFileSync("src/routes/agent.ts", "utf8");
  const h = SRC.slice(SRC.indexOf('b.action === "reopen"'));
  const block = h.slice(0, h.indexOf("}"));
  for (const f of ["checked_in_at", "completed_at", "shown_at", "canceled_at"]) {
    assert.ok(new RegExp(`patch\\.${f} = null`).test(block), `reopen leaves ${f} set`);
  }
});

test("the chat simulator ends the call on transfer, like production does", () => {
  // The simulator returned "Transferred." and kept looping, so the model happily said "I've
  // transferred you to the team" — which looked like an agent bug but was the harness being
  // unfaithful. In production Vapi has already moved the leg; nobody is there to hear it.
  const SRC = readFileSync("scripts/chat.ts", "utf8");
  const block = SRC.slice(SRC.indexOf('tc.name === "transferCall"'));
  const body = block.slice(0, block.indexOf("continue;"));
  assert.ok(/ended = true/.test(body), "transferCall doesn't end the simulated call");
  assert.ok(/no longer on your line/i.test(body),
    "the tool result doesn't tell the model the caller is gone");
});

test("a confirmed transfer resolves its handoff automatically", () => {
  // A handoff row exists so nobody falls through the cracks. Once Vapi confirms the leg moved to
  // a human, the advisor IS the next step and there is nothing to action — leaving it open
  // buries the rows that DO need work (a transfer that rang out, a message taken because no
  // transfer line is configured) and trains people to ignore the queue.
  const SRC = readFileSync("src/calls/events.ts", "utf8");
  assert.ok(/assistant-forwarded-call/.test(SRC),
    "nothing keys off Vapi's forwarded-call outcome");
  const block = SRC.slice(SRC.indexOf('msg.endedReason === "assistant-forwarded-call"'));
  assert.ok(/handoff_requests/.test(block.slice(0, 400)), "the handoff row isn't resolved");
  assert.ok(/\.eq\("status", "open"\)/.test(block.slice(0, 500)),
    "resolving isn't scoped to open rows, so it would stamp already-closed ones");
});

test("handoff.transferred records the attempt, not the outcome", () => {
  // It's set from whether a transfer number is CONFIGURED. A row therefore says "transferred"
  // even if the advisor never picked up — which is exactly why the queue still matters.
  const SRC = readFileSync("src/routes/inbound.ts", "utf8");
  const block = fnBody("logHandoff");
  assert.ok(/Whether we ATTEMPTED a transfer/.test(block),
    "the attempt-vs-outcome distinction isn't documented where it misleads");
  assert.ok(/transferred: !!transferNumber/.test(block),
    "transferred is no longer derived from configuration — update the comment if this changed");
});

test("a successful booking marks the call as booked", () => {
  // "Booked from a call" read zero while eight appointments sat in the table. The outcome was
  // inferred at end-of-call from Vapi's analysis.structuredData.booked, which requires an
  // analysisPlan the assistant never sends — so it was always undefined. book_service knows
  // first-hand that it booked; it shouldn't ask a model to remember.
  const body = fnBody("bookService");
  assert.ok(/markCallBooked\(pinned\.callId\)/.test(body),
    "a successful booking doesn't record the outcome on the call");
  // The merge path is a booking too — the caller added work on this call.
  assert.equal((body.match(/markCallBooked\(pinned\.callId\)/g) ?? []).length, 2,
    "the merge path doesn't mark the call booked");
});

test("end-of-call never downgrades a booked call to answered", () => {
  // deriveOutcome falls back to "answered". Without a guard it would erase the outcome
  // book_service already recorded, putting the metric back at zero.
  const SRC = readFileSync("src/calls/events.ts", "utf8");
  assert.ok(/prior\?\.outcome === "booked" \? "booked" : outcome\.outcome/.test(SRC),
    "the end-of-call update can clobber outcome=booked");
});

test("the appointment funnel counts by when the visit happens, not when it was booked", () => {
  // The funnel filtered appointments on created_at, so "today" counted every row WRITTEN today
  // — including next Monday's booking — while omitting a visit booked last week that is
  // happening right now. Membership has to be the scheduled time.
  const SRC = readFileSync("src/routes/agent.ts", "utf8");
  const fn = SRC.slice(SRC.indexOf('agentRoutes.get("/funnel"'), SRC.indexOf('agentRoutes.get("/calls"'));
  assert.ok(/const when = x\.starts_at \?\? x\.created_at/.test(fn),
    "the funnel doesn't prefer the scheduled time");
  assert.ok(/const until =/.test(fn),
    "the window has no upper bound, so every future booking leaks into every range");
});

test("in-service appointments have their own funnel stage", () => {
  // Pending -> Confirmed -> Shown had no bucket for a car physically in the shop, so checked-in
  // visits vanished from the funnel entirely: neither still-confirmed nor yet-completed.
  const SRC = readFileSync("src/routes/agent.ts", "utf8");
  const fn = SRC.slice(SRC.indexOf('agentRoutes.get("/funnel"'), SRC.indexOf('agentRoutes.get("/calls"'));
  assert.ok(/in_service: a\.filter/.test(fn), "in_service is not counted");
  const UI = readFileSync("web/app/(app)/dashboard/page.tsx", "utf8");
  assert.ok(/label="In service"/.test(UI), "the funnel UI has no in-service stage");
});

test("the chat simulator records a call duration", () => {
  // duration_sec is written by Vapi's end-of-call webhook, which the simulator never sends — so
  // simulated calls had a null duration and were invisible to "Avg call length" and to anything
  // counting answered calls.
  const SRC = readFileSync("scripts/chat.ts", "utf8");
  assert.ok(/async function finalize/.test(SRC), "the simulator never stamps a duration");
  assert.ok(/duration_sec: seconds/.test(SRC), "finalize doesn't write duration_sec");
  assert.ok(/--keep/.test(SRC), "there's no way to keep a simulated call for dashboard testing");
});

test("calls->customers joins name the foreign key explicitly", () => {
  // customers.created_on_call_id points back at calls, so there are TWO relationships between
  // the tables. An unqualified embed fails with "more than one relationship was found" — the
  // Calls page rendered "No calls yet" while 27 calls sat in the table.
  const SRC = readFileSync("src/routes/agent.ts", "utf8");
  const bad = SRC.match(/from\("calls"\)[\s\S]{0,400}?customers\((?!!)/g) ?? [];
  assert.equal(bad.length, 0,
    "an unqualified customers embed on calls will fail at runtime — use customers!calls_customer_id_fkey");
});

test("the calls endpoint surfaces query errors instead of returning an empty list", () => {
  // `const { data } = ...; data ?? []` turned a hard failure into "No calls yet", which is
  // indistinguishable from an empty table — that's what hid the broken join.
  const SRC = readFileSync("src/routes/agent.ts", "utf8");
  const fn = SRC.slice(SRC.indexOf('agentRoutes.get("/calls"'), SRC.indexOf('agentRoutes.get("/calendar"'));
  assert.ok(/const \{ data, error \} = await query/.test(fn), "the calls query ignores its error");
  assert.ok(/if \(error\) return c\.json\(\{ error: error\.message \}, 500\)/.test(fn),
    "a failed calls query still renders as an empty list");
});

test("a caller with no caller ID can't be registered without a callback number", () => {
  // A blocked caller ID meant phone=null on the new customer: the advisor couldn't call to
  // confirm the soft booking, and the caller would be anonymous on every future call. Prompt
  // guidance alone didn't hold — the model registered first and read the rule afterwards — so
  // the tool refuses, like the vehicle-confirmation gate.
  const body = fnBody("registerCustomer");
  assert.ok(/if \(!phone\)/.test(body), "registration proceeds with no reachable number");
  assert.ok(/FAILED — no caller ID for this call and no callback number/.test(body),
    "the refusal doesn't tell the agent what to ask for");
  assert.ok(/pinned\.callerNumber \?\? spoken/.test(body),
    "a spoken number could override a real caller ID");
});

test("a spoken callback number is validated before it's stored", () => {
  // A half-heard number is worse than none: an advisor will call it and reach a stranger.
  const SRC = readFileSync("src/routes/inbound.ts", "utf8");
  const fn = fnBody("normalizePhone");
  assert.ok(fn, "no phone normalizer");
  assert.ok(/d\.length === 10/.test(fn) && /return null/.test(fn),
    "the normalizer accepts implausible numbers");
  assert.ok(/callback_number/.test(readFileSync("src/inbound/assistant.ts", "utf8")),
    "callback_number isn't in the register_customer schema, so the model can't send it");
});

test("every function tool suppresses Vapi's spoken filler", () => {
  // A real call produced "Just a sec." and "Hold on a sec." as separate utterances before one
  // lookup. A prompt rule alone didn't hold, so each tool carries an explicit empty
  // request-start message — the tools return faster than the filler takes to say.
  const SRC = readFileSync("src/inbound/assistant.ts", "utf8");
  assert.ok(/const quiet = \[\{ type: "request-start", content: "" \}\]/.test(SRC),
    "no quiet request-start message defined");
  assert.ok(/\.\.\.HANDOFF_TOOL\(server\), messages: quiet/.test(SRC),
    "log_handoff is built separately and still narrates");
});

test("the kill switch forwards the call without speaking or running a model", () => {
  // With the agent off it used to greet ("let me get you to our team right away"), run an LLM
  // turn, call log_handoff, then transferCall — a spoken line and a model round-trip before the
  // call moved. Switched off, there is nothing for a model to decide.
  const SRC = readFileSync("src/inbound/assistant.ts", "utf8");
  const fn = SRC.slice(SRC.indexOf("export function buildInboundAssistant"));
  assert.ok(/if \(!ctx\.agentEnabled && ctx\.transferNumber\)/.test(fn),
    "the kill switch doesn't short-circuit to a forward");
  assert.ok(/return \{ forwardingPhoneNumber: ctx\.transferNumber \}/.test(fn),
    "it doesn't use Vapi's telephony-level forward");
  // The early return must come BEFORE the assistant is built, or it still costs a model turn.
  assert.ok(fn.indexOf("forwardingPhoneNumber") < fn.indexOf("firstMessage"),
    "the forward happens after the assistant is assembled");
});

test("with no transfer number the kill switch still answers rather than dead-airing", () => {
  // Forwarding needs somewhere to forward TO. With none configured, silence is worse than a
  // spoken handoff, so the old path has to remain reachable.
  const SRC = readFileSync("src/inbound/assistant.ts", "utf8");
  const fn = SRC.slice(SRC.indexOf("export function buildInboundAssistant"));
  assert.ok(/&& ctx\.transferNumber/.test(fn),
    "the forward isn't guarded on a transfer number existing");
});
