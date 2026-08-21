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

test("every book_service failure path says FAILED and forbids confirming", () => {
  const start = SRC.indexOf("async function bookService");
  const body = SRC.slice(start, SRC.indexOf("\nasync function", start + 10));
  const returns = [...body.matchAll(/return\s+[`"]([^`"]{20,})/g)].map((m) => m[1]);
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
  const start = SRC.indexOf("async function bookService");
  const body = SRC.slice(start, SRC.indexOf("\nasync function", start + 10));
  assert.ok(/vehicle_confirmed/.test(body), "no confirmation gate before booking");
  assert.ok(/haven't confirmed which vehicle/i.test(body),
    "the refusal doesn't tell the agent to ask which car");
});

test("a vehicle not on file is never booked against a different car", () => {
  const start = SRC.indexOf("async function bookService");
  const body = SRC.slice(start, SRC.indexOf("\nasync function", start + 10));
  // other_vehicle must be checked BEFORE the single-vehicle fallback, or a Tacoma gets stored
  // as the customer's RAV4 and the advisor never learns which car is arriving.
  assert.ok(body.indexOf("if (otherVehicle)") < body.indexOf("vehicles.length === 1"),
    "the single-vehicle fallback can override an explicitly different vehicle");
  assert.ok(/VEHICLE NOT ON FILE/.test(body), "unknown vehicle isn't recorded for the advisor");
});
