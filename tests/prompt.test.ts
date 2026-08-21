/**
 * Prompt assembly — the privacy boundary and the guardrails.
 *
 * These are the rules a regression would breach silently: reading one customer's vehicle to
 * another, quoting a price, or claiming a booking that didn't happen. They're asserted on the
 * assembled prompt rather than on live model output, so they run in milliseconds with no API call.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildInboundSystemPrompt, buildInboundGreeting } from "../src/inbound/prompt";
import type { InboundContext } from "../src/inbound/identify";

const KNOWN: InboundContext = {
  companyId: "c1", companyName: "Milpitas Toyota", timezone: "America/Los_Angeles",
  customerId: "cust1", customerName: "Omar Said", customerLanguage: "en",
  vehicles: [{ id: "v1", make: "Toyota", model: "RAV4", year: 2022, vin: null, mileage: 31200,
    due: { service: "Oil & filter", dueOn: "2026-12-16", reason: "mileage", projectedMileage: 33500 } }],
  offerings: [{ name: "Oil & filter change", description: "Full synthetic.", category: "maintenance", typical_duration_min: 45 }],
  transferNumber: "+15551234567", greeting: null, personaTemplate: null,
  identifyMode: "caller_id_only", agentEnabled: true, businessHours: { mon: ["07:00", "18:00"], sun: null },
  todayLabel: "Friday, August 21, 2026", inService: null, matchCount: 1,
};
const ANON: InboundContext = { ...KNOWN, customerId: null, customerName: null, vehicles: [], matchCount: 0 };

test("an anonymous caller's prompt contains NO customer data", () => {
  const p = buildInboundSystemPrompt(ANON, "soft");
  assert.ok(!p.includes("Omar"), "leaked the customer's name");
  assert.ok(!p.includes("RAV4"), "leaked the customer's vehicle");
  assert.ok(/isn't on file|NO record for them/i.test(p), "missing the anonymous privacy rule");
});

test("an identified caller gets their name and vehicle", () => {
  const p = buildInboundSystemPrompt(KNOWN, "soft");
  assert.ok(p.includes("Omar Said"));
  assert.ok(p.includes("RAV4"));
});

test("guardrails are present for both caller types", () => {
  for (const [label, ctx] of [["known", KNOWN], ["anon", ANON]] as const) {
    const p = buildInboundSystemPrompt(ctx, "soft");
    assert.ok(/quote prices/i.test(p), `${label}: missing the pricing guardrail`);
    assert.ok(/repair-order/i.test(p), `${label}: missing the "where is my car" guardrail`);
    assert.ok(/\[OPTOUT\]/.test(p), `${label}: missing the opt-out rule`);
  }
});

test("soft mode never permits claiming a firm booking", () => {
  const p = buildInboundSystemPrompt(KNOWN, "soft");
  assert.ok(/never claim a firm booking/i.test(p));
});

test("the static half is IDENTICAL across callers (prompt caching depends on it)", () => {
  const a = buildInboundSystemPrompt(KNOWN, "soft");
  const b = buildInboundSystemPrompt(ANON, "soft");
  const marker = "── THIS CALL";
  assert.equal(a.slice(0, a.indexOf(marker)), b.slice(0, b.indexOf(marker)),
    "per-call content leaked into the cacheable prefix");
});

test("the kill switch strips the agent down to a handoff", () => {
  const p = buildInboundSystemPrompt({ ...KNOWN, agentEnabled: false }, "soft");
  assert.ok(/log_handoff/.test(p) && /transferCall/.test(p));
  assert.ok(!p.includes("RAV4"), "kill switch still exposed customer data");
});

test("a known number ASKS whether it's that person, never assumes", () => {
  const g = buildInboundGreeting(KNOWN);
  // A phone number identifies a record, not a person — the household may share the line.
  assert.ok(/am I speaking with Omar\?/i.test(g), `greeting asserts identity: "${g}"`);
  assert.ok(!buildInboundGreeting(ANON).includes("Omar"));
});

test("a car in the shop is NOT revealed before identity is confirmed", () => {
  const ctx = { ...KNOWN, inService: { vehicle: "2022 Toyota RAV4", since: null, ops: ["Oil change"] } };
  const g = buildInboundGreeting(ctx);
  assert.ok(!/RAV4/.test(g), `greeting leaked the vehicle to an unconfirmed caller: "${g}"`);
  // The agent still knows, and raises it once they confirm.
  assert.ok(/IN THE SHOP RIGHT NOW/.test(buildInboundSystemPrompt(ctx, "soft")));
});

test("hours and today's date reach the prompt", () => {
  const p = buildInboundSystemPrompt(KNOWN, "soft");
  assert.ok(p.includes("Friday, August 21, 2026"), "agent can't resolve 'tomorrow' without today");
  assert.ok(/Sunday: closed/.test(p), "closed days must be stated, not implied");
});

test("the agent doesn't name the caller's vehicle before knowing what they want", () => {
  // From a real call: "What can I help you with today for your RAV4?" — asked before the caller
  // said anything car-related. With one vehicle on file the model reaches for it as a friendly
  // opener, which tells the caller what their call is about instead of asking.
  const ctx: InboundContext = {
    companyId: "c", companyName: "Milpitas Toyota", timezone: "America/Los_Angeles",
    customerId: "cu", customerName: "Omar Said", customerLanguage: null,
    vehicles: [{ id: "v1", make: "Toyota", model: "RAV4", year: 2022, vin: null, mileage: 41000, due: null }],
    offerings: [], transferNumber: "+14085550111", greeting: null, personaTemplate: null,
    identifyMode: "caller_id_only", agentEnabled: true, businessHours: {},
    todayLabel: "Friday, August 21, 2026", inService: null, matchCount: 1,
  };
  const p = buildInboundSystemPrompt(ctx, "soft");
  assert.ok(/Do NOT bring up their vehicle until you know what they want/i.test(p),
    "nothing stops the agent leading with the car");
  assert.ok(/never narrow it to one of their vehicles/i.test(p),
    "the opening question isn't required to be open-ended");
});

test("a car already in the shop is an explicit exception to that rule", () => {
  // Someone whose car is being serviced is almost certainly calling about it — staying silent
  // there would be unhelpful, so the two rules must not read as contradictory.
  const ctx: InboundContext = {
    companyId: "c", companyName: "Milpitas Toyota", timezone: "America/Los_Angeles",
    customerId: "cu", customerName: "Omar Said", customerLanguage: null,
    vehicles: [{ id: "v1", make: "Toyota", model: "RAV4", year: 2022, vin: null, mileage: 41000, due: null }],
    offerings: [], transferNumber: "+14085550111", greeting: null, personaTemplate: null,
    identifyMode: "caller_id_only", agentEnabled: true, businessHours: {},
    todayLabel: "Friday, August 21, 2026", matchCount: 1,
    inService: { vehicle: "2022 Toyota RAV4", since: null, ops: ["Oil change"] },
  };
  const p = buildInboundSystemPrompt(ctx, "soft");
  assert.ok(/EXCEPTION to waiting before mentioning their vehicle/i.test(p),
    "the in-service case doesn't override the wait-to-mention rule");
});

test("a full name already given is not asked for again", () => {
  // From a real call: the caller opened with "my name is Ahmad Said", and at booking time the
  // agent asked "I have Ahmad — what's your last name?". The rule said "if you don't have it
  // yet", which the model didn't apply to something said several turns earlier.
  const ctx: InboundContext = {
    companyId: "c", companyName: "T", timezone: "America/Los_Angeles",
    customerId: null, customerName: null, customerLanguage: null,
    vehicles: [], offerings: [], transferNumber: null, greeting: null, personaTemplate: null,
    identifyMode: "caller_id_only", agentEnabled: true, businessHours: {},
    todayLabel: "Friday, August 21, 2026", inService: null, matchCount: 0,
  };
  const p = buildInboundSystemPrompt(ctx, "soft");
  assert.ok(/including in the very first thing they said/i.test(p),
    "nothing tells the model a name given earlier still counts");
  assert.ok(/BEFORE check_availability/.test(p),
    "register_customer isn't required before availability, so the caller hits the FAILED path");
});

test("a car in the shop is announced up front, with an invitation to ask", () => {
  // Someone whose car is being serviced is almost certainly calling about it. Waiting for them
  // to explain that back is a bad opening when we already know from the caller ID.
  const ctx: InboundContext = {
    companyId: "c", companyName: "T", timezone: "America/Los_Angeles",
    customerId: "cu", customerName: "Omar Said", customerLanguage: null,
    vehicles: [{ id: "v1", make: "Toyota", model: "RAV4", year: 2022, vin: null, mileage: 41000, due: null }],
    offerings: [], transferNumber: "+14085550111", greeting: null, personaTemplate: null,
    identifyMode: "caller_id_only", agentEnabled: true, businessHours: {},
    todayLabel: "Friday, August 21, 2026", matchCount: 1,
    inService: { vehicle: "2022 Toyota RAV4", since: null, ops: ["Oil change"] },
  };
  const p = buildInboundSystemPrompt(ctx, "soft");
  assert.ok(/LEAD with it/.test(p), "the agent isn't told to raise the in-shop car first");
  assert.ok(/did you have a question about it/i.test(p), "no invitation to ask about the car");
  assert.ok(/log_handoff and transfer/.test(p),
    "status questions about an in-shop car must still transfer");
});

test("venting is not treated as an instant transfer trigger", () => {
  // From a real call: the caller said "your service sucks" and the agent asked "can you tell me
  // what's been going on?" — then transferred in the SAME turn, without waiting. The caller was
  // asked a question and cut off; they may well have been calling to book.
  const ctx: InboundContext = {
    companyId: "c", companyName: "T", timezone: "America/Los_Angeles",
    customerId: null, customerName: null, customerLanguage: null,
    vehicles: [], offerings: [], transferNumber: "+14085550111", greeting: null,
    personaTemplate: null, identifyMode: "caller_id_only", agentEnabled: true, businessHours: {},
    todayLabel: "Friday, August 21, 2026", inService: null, matchCount: 0,
  };
  const p = buildInboundSystemPrompt(ctx, "soft");
  assert.ok(/NOT AUTOMATICALLY A TRANSFER/.test(p),
    "frustration still routes straight to a human");
  assert.ok(/WAIT for the answer/i.test(p),
    "nothing stops the agent asking a question and transferring before it's answered");
  assert.ok(/ask what they need today/i.test(p),
    "the agent isn't told to find out what they actually called about");
});

test("de-escalation never invents an apology, a fix, or a promise", () => {
  // Soft mode can't promise anything, and the agent has no service history — so it must not
  // apologise for something it can't verify or commit anyone to a callback.
  const ctx: InboundContext = {
    companyId: "c", companyName: "T", timezone: "America/Los_Angeles",
    customerId: null, customerName: null, customerLanguage: null,
    vehicles: [], offerings: [], transferNumber: "+14085550111", greeting: null,
    personaTemplate: null, identifyMode: "caller_id_only", agentEnabled: true, businessHours: {},
    todayLabel: "Friday, August 21, 2026", inService: null, matchCount: 0,
  };
  const p = buildInboundSystemPrompt(ctx, "soft");
  assert.ok(/never promise a fix, a callback, a/i.test(p), "the agent may promise a remedy");
  assert.ok(/still upset after you've/i.test(p),
    "no stop condition — the agent could keep de-escalating instead of transferring");
});

test("asking for a person still transfers immediately", () => {
  const ctx: InboundContext = {
    companyId: "c", companyName: "T", timezone: "America/Los_Angeles",
    customerId: null, customerName: null, customerLanguage: null,
    vehicles: [], offerings: [], transferNumber: "+14085550111", greeting: null,
    personaTemplate: null, identifyMode: "caller_id_only", agentEnabled: true, businessHours: {},
    todayLabel: "Friday, August 21, 2026", inService: null, matchCount: 0,
  };
  const p = buildInboundSystemPrompt(ctx, "soft");
  assert.ok(/ask for a person, a manager, or to speak to someone/i.test(p),
    "a direct request for a human is no longer an immediate transfer");
});

test("the agent doesn't claim the transfer succeeded", () => {
  // From a test call the agent said "You're connected now." after transferCall. It cannot know
  // that: the leg is handed to the provider and the advisor may not pick up, may be ringing, or
  // may be at voicemail. Same class of error as saying "you're booked" with nothing reserved.
  const ctx: InboundContext = {
    companyId: "c", companyName: "T", timezone: "America/Los_Angeles",
    customerId: null, customerName: null, customerLanguage: null,
    vehicles: [], offerings: [], transferNumber: "+14085550111", greeting: null,
    personaTemplate: null, identifyMode: "caller_id_only", agentEnabled: true, businessHours: {},
    todayLabel: "Friday, August 21, 2026", inService: null, matchCount: 0,
  };
  const p = buildInboundSystemPrompt(ctx, "soft");
  assert.ok(/ONCE transferCall HAS RUN, YOUR TURN IS OVER/i.test(p),
    "the agent may still narrate after handing off the call");
  assert.ok(/claims you cannot make/i.test(p),
    "nothing explains why asserting the connection is wrong");
  // The pre-transfer check-in gave the model a reason to speak again afterwards; it said
  // "I've already transferred you". Both phrasings have to be ruled out explicitly.
  assert.ok(/never after it/i.test(p),
    "the check-in question isn't pinned to before the transfer");
});

test("a known caller's upcoming appointments reach the prompt with real ids", () => {
  // The agent can only volunteer what it already knows. Left to list_appointments, a caller
  // saying "I need to move my appointment" has to prove one exists before anything happens.
  const ctx: InboundContext = {
    companyId: "c", companyName: "T", timezone: "America/Los_Angeles",
    customerId: "cu", customerName: "Omar Said", customerLanguage: null,
    vehicles: [], offerings: [], transferNumber: null, greeting: null, personaTemplate: null,
    identifyMode: "caller_id_only", agentEnabled: true, businessHours: {},
    todayLabel: "Friday, August 21, 2026", inService: null, matchCount: 1,
    upcoming: [{
      id: "0f50f03d-6a35-478a-94cf-060dfe7f25e9",
      when: "Monday, August 24 at 9:00 AM", vehicle: "2022 Toyota RAV4",
      ops: ["Oil & filter change"], unscheduled: false,
    }],
  };
  const p = buildInboundSystemPrompt(ctx, "soft");
  assert.ok(p.includes("id=0f50f03d-6a35-478a-94cf-060dfe7f25e9"), "the appointment id is missing");
  assert.ok(/do not call list_appointments to find them/i.test(p),
    "the agent isn't told it already has these");
  assert.ok(/not as an opening/i.test(p),
    "nothing stops the agent leading with an appointment the caller didn't ask about");
});

test("rescheduling books the new time before cancelling the old one", () => {
  // There is no move tool. Cancelling first would leave the caller with nothing if the new slot
  // turns out to be unavailable.
  const ctx: InboundContext = {
    companyId: "c", companyName: "T", timezone: "America/Los_Angeles",
    customerId: "cu", customerName: "Omar Said", customerLanguage: null,
    vehicles: [], offerings: [], transferNumber: null, greeting: null, personaTemplate: null,
    identifyMode: "caller_id_only", agentEnabled: true, businessHours: {},
    todayLabel: "Friday, August 21, 2026", inService: null, matchCount: 1,
    upcoming: [{ id: "a1", when: "Monday at 9:00 AM", vehicle: "2022 Toyota RAV4", ops: [], unscheduled: false }],
  };
  const p = buildInboundSystemPrompt(ctx, "soft");
  assert.ok(/THEN cancel_appointment on the old one/i.test(p), "no reschedule ordering rule");
  assert.ok(/Never leave both on the books/i.test(p), "nothing prevents a duplicate visit");
});

test("a caller with no upcoming appointments gets no appointment block", () => {
  const ctx: InboundContext = {
    companyId: "c", companyName: "T", timezone: "America/Los_Angeles",
    customerId: "cu", customerName: "Omar Said", customerLanguage: null,
    vehicles: [], offerings: [], transferNumber: null, greeting: null, personaTemplate: null,
    identifyMode: "caller_id_only", agentEnabled: true, businessHours: {},
    todayLabel: "Friday, August 21, 2026", inService: null, matchCount: 1, upcoming: [],
  };
  const p = buildInboundSystemPrompt(ctx, "soft");
  assert.ok(!/THEIR UPCOMING APPOINTMENT/.test(p),
    "an empty appointment block is rendered, inviting the model to invent one");
});

test("the agent offers a beat before transferring, without asking permission", () => {
  // A transfer announced and executed in one breath reads as being got rid of, and loses the
  // second thing the caller rang about. But "is that OK?" invites a no the agent can't act on —
  // it still cannot answer their question.
  const ctx: InboundContext = {
    companyId: "c", companyName: "T", timezone: "America/Los_Angeles",
    customerId: "cu", customerName: "Omar Said", customerLanguage: null,
    vehicles: [], offerings: [], transferNumber: "+14085550111", greeting: null,
    personaTemplate: null, identifyMode: "caller_id_only", agentEnabled: true, businessHours: {},
    todayLabel: "Friday, August 21, 2026", inService: null, matchCount: 1, upcoming: [],
  };
  const p = buildInboundSystemPrompt(ctx, "soft");
  assert.ok(/anything else you need\s+while I have you/i.test(p), "no pre-transfer check-in");
  assert.ok(/Never ask permission to transfer/i.test(p),
    "the agent may ask permission and get a no it can't honour");
  assert.ok(/Skip the check entirely when they've ASKED for a person, or they're angry/i.test(p),
    "an angry caller is still made to sit through small talk");
});

test("the agent is told to call endCall, not just say goodbye", () => {
  // In production the call never hung up — the agent said goodbye and the line stayed open with
  // the caller sitting in billed silence. "END THE CALL" never named the tool that does it.
  const ctx: InboundContext = {
    companyId: "c", companyName: "T", timezone: "America/Los_Angeles",
    customerId: "cu", customerName: "Omar Said", customerLanguage: null,
    vehicles: [], offerings: [], transferNumber: null, greeting: null, personaTemplate: null,
    identifyMode: "caller_id_only", agentEnabled: true, businessHours: {},
    todayLabel: "Friday, August 21, 2026", inService: null, matchCount: 1, upcoming: [],
  };
  const p = buildInboundSystemPrompt(ctx, "soft");
  assert.ok(/CALL THE endCall TOOL/.test(p), "the prompt never names endCall");
  assert.ok(/Saying goodbye does NOT hang up/.test(p),
    "nothing explains that a closing line leaves the line open");
});

test("the agent doesn't narrate its own tool calls", () => {
  // "Hold on a sec" on every turn — the filler takes longer than the lookup it covers.
  const ctx: InboundContext = {
    companyId: "c", companyName: "T", timezone: "America/Los_Angeles",
    customerId: "cu", customerName: "Omar Said", customerLanguage: null,
    vehicles: [], offerings: [], transferNumber: null, greeting: null, personaTemplate: null,
    identifyMode: "caller_id_only", agentEnabled: true, businessHours: {},
    todayLabel: "Friday, August 21, 2026", inService: null, matchCount: 1, upcoming: [],
  };
  const p = buildInboundSystemPrompt(ctx, "soft");
  assert.ok(/Do NOT narrate your own work/.test(p), "filler narration isn't forbidden");
});

test("an unfamiliar name is read back before it's saved", () => {
  // A caller saying "Aya Elarid" was stored as "Alarid Elirid". A name is the one field that
  // can't be inferred from context and the one an advisor needs to find them later.
  const ctx: InboundContext = {
    companyId: "c", companyName: "T", timezone: "America/Los_Angeles",
    customerId: null, customerName: null, customerLanguage: null,
    vehicles: [], offerings: [], transferNumber: null, greeting: null, personaTemplate: null,
    identifyMode: "caller_id_only", agentEnabled: true, businessHours: {},
    todayLabel: "Friday, August 21, 2026", inService: null, matchCount: 0, upcoming: [],
  };
  const p = buildInboundSystemPrompt(ctx, "soft");
  assert.ok(/read it back once/.test(p), "no name-confirmation rule");
  assert.ok(/take their correction verbatim/.test(p), "the agent isn't told to accept the correction");
  // From a real call: the caller spelled "E l a r i d" and the agent read back "Elirid", got a
  // yes to a name she never said, and stored it looking verified.
  assert.ok(/those letters ARE the name/.test(p), "a spelled-out name isn't treated as definitive");
  assert.ok(/Never confirm a name back with different letters/.test(p),
    "the agent may still read back a spelling different from the one it was given");
  // A real caller's name must not end up baked into every prompt.
  assert.ok(!/Elarid/i.test(p), "a real caller's name is hardcoded in the prompt");
});

test("no real caller's name is baked into the prompt", () => {
  // The spelling example needs a name; it must not be one from an actual call, or it ships in
  // every anonymous caller's prompt.
  const ctx: InboundContext = {
    companyId: "c", companyName: "T", timezone: "America/Los_Angeles",
    customerId: null, customerName: null, customerLanguage: null,
    vehicles: [], offerings: [], transferNumber: null, greeting: null, personaTemplate: null,
    identifyMode: "caller_id_only", agentEnabled: true, businessHours: {},
    todayLabel: "Friday, August 21, 2026", inService: null, matchCount: 0, upcoming: [],
  };
  const p = buildInboundSystemPrompt(ctx, "soft");
  for (const name of ["Elarid", "Elirid", "Alarid"]) {
    assert.ok(!new RegExp(name, "i").test(p), `a real caller's name (${name}) is in the prompt`);
  }
});
