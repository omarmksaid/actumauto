/**
 * Slot resolution — the timezone maths behind every offered appointment.
 *
 * Getting this wrong doesn't crash; it books someone at 2am. Railway runs UTC and the dealership
 * is Pacific, so anything using the server's local time is wrong half the year.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openWindow, spokenTime, ShopConfig } from "../src/scheduling/slots";

const CFG: ShopConfig = {
  timezone: "America/Los_Angeles",
  hours: { mon: ["07:00","18:00"], tue: ["07:00","18:00"], wed: ["07:00","18:00"],
           thu: ["07:00","18:00"], fri: ["07:00","18:00"], sat: ["08:00","16:00"], sun: null },
  capacity: 4, slotMinutes: 30,
};

test("open window is read in the DEALERSHIP's timezone", () => {
  assert.deepEqual(openWindow(CFG, "2026-08-24"), [420, 1080], "Monday 7am-6pm");
  assert.deepEqual(openWindow(CFG, "2026-08-22"), [480, 960],  "Saturday 8am-4pm");
  assert.equal(openWindow(CFG, "2026-08-23"), null, "Sunday should be closed");
});

test("a UTC instant is spoken as the dealership's local time", () => {
  // 16:00 UTC in August = 9am Pacific (PDT, UTC-7).
  const s = spokenTime(new Date("2026-08-22T16:00:00Z"), CFG.timezone);
  assert.ok(/9:00 AM/.test(s), `expected 9:00 AM, got "${s}"`);
  assert.ok(/Saturday/.test(s), `expected Saturday, got "${s}"`);
});

test("survives the DST boundary", () => {
  // 16:00 UTC in January = 8am Pacific (PST, UTC-8) — one hour earlier than in August.
  const winter = spokenTime(new Date("2026-01-10T16:00:00Z"), CFG.timezone);
  assert.ok(/8:00 AM/.test(winter), `DST handled wrong: "${winter}"`);
});

test("a day with no configured hours is closed, not open-all-day", () => {
  assert.equal(openWindow({ ...CFG, hours: {} }, "2026-08-24"), null);
});

test("availability fetches the WHOLE day, not just the first few slots", () => {
  // A 6-slot fetch meant "is 10am free?" answered "no" because 10am was never in the list —
  // the shop was empty and a caller was told it was booked.
  const src = readFileSync("src/routes/inbound.ts", "utf8");
  const call = src.match(/availableSlots\(pinned\.companyId, cfg, date, mins, (\d+)\)/);
  assert.ok(call, "couldn't find the availability call");
  assert.ok(Number(call![1]) >= 50, `only fetches ${call![1]} slots — a later time will look booked`);
});

test("availability never claims times outside the returned list are full", () => {
  const src = readFileSync("src/routes/inbound.ts", "utf8");
  assert.ok(!/Any other time that day is full/.test(src),
    "still tells the agent unlisted times are booked, which is false when the list is truncated");
});

test("the no-date availability reply is marked as a sample, not the full schedule", () => {
  // From a real call: check_availability({}) returned "Soonest: 10 AM ... Further out: ...",
  // the caller asked for 11 AM, and the agent said it wasn't available — on a day with fifteen
  // open slots. It read a short sample as the complete inventory.
  const SRC = readFileSync("src/routes/inbound.ts", "utf8");
  const fn = SRC.slice(SRC.indexOf("async function checkAvailability"));
  assert.ok(/EXAMPLES, not the full list/.test(fn),
    "the no-date reply doesn't say it's a sample");
  assert.ok(/do NOT say it's unavailable/i.test(fn),
    "nothing stops the model judging availability from the sample");
});

test("check_availability exposes a `time` argument", () => {
  // The handler read args.time and the reply told the model to pass it, but `time` was never
  // declared in the tool schema — so the model COULD NOT check a specific time and had to
  // answer from whatever the previous call returned.
  const SRC = readFileSync("src/inbound/assistant.ts", "utf8");
  const tool = SRC.slice(SRC.indexOf('name: "check_availability"'), SRC.indexOf('name: "book_service"'));
  assert.ok(/\btime: \{/.test(tool), "`time` is missing from the check_availability schema");
});
