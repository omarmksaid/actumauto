/**
 * Slot resolution — the timezone maths behind every offered appointment.
 *
 * Getting this wrong doesn't crash; it books someone at 2am. Railway runs UTC and the dealership
 * is Pacific, so anything using the server's local time is wrong half the year.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
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
