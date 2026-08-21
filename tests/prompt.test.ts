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
