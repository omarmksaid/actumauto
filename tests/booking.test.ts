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
