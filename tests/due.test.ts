/**
 * Service-due engine.
 *
 * Every case here is a bug we actually shipped and fixed. The engine speaks these answers aloud
 * to customers, so a regression is a wrong statement on a live call, not a rendering glitch.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeDue, projectMileage, ServiceInterval, VehicleForDue } from "../src/scheduling/due";

const INTERVALS: ServiceInterval[] = [
  { mileage: 5000,  months: 6,  service_name: "5k oil & rotation", operations: [], severity: "standard" },
  { mileage: 10000, months: 12, service_name: "10k service", operations: [], severity: "standard" },
  { mileage: 30000, months: 36, service_name: "30k MAJOR", operations: [], severity: "major" },
  { mileage: 60000, months: 72, service_name: "60k MAJOR", operations: [], severity: "major" },
];
const TODAY = "2026-08-21";
const base = { id: "v", make: "Toyota", model: "RAV4", year: 2022, avg_miles_per_day: 40 };

test("projects mileage from the odometer reading, not from today", () => {
  const v: VehicleForDue = { ...base, sold_on: "2022-01-01", mileage: 30000,
    mileage_as_of: "2026-07-22", last_service_on: null, mileage_at_last_service: null };
  // 30 days at 40 mi/day
  assert.equal(projectMileage(v, TODAY), 31200);
});

test("intervals REPEAT — a car serviced at 30k isn't due for the 30k again", () => {
  const v: VehicleForDue = { ...base, sold_on: "2022-01-01", mileage: 30400,
    mileage_as_of: "2026-08-01", last_service_on: "2026-07-15", mileage_at_last_service: 30000 };
  const due = computeDue(v, INTERVALS, TODAY, 45);
  assert.ok(due, "should find something due");
  assert.notEqual(due!.interval.service_name, "30k MAJOR",
    "re-recommended a service the car just had");
});

test("a major service wins over a concurrent minor one", () => {
  const v: VehicleForDue = { ...base, sold_on: "2020-01-01", mileage: 58000,
    mileage_as_of: "2026-08-01", last_service_on: "2024-01-10", mileage_at_last_service: 30000 };
  const due = computeDue(v, INTERVALS, TODAY, 45);
  assert.equal(due!.interval.severity, "major");
});

test("refuses to guess with no odometer and no dates", () => {
  const v: VehicleForDue = { ...base, sold_on: null, mileage: null, mileage_as_of: null,
    last_service_on: null, mileage_at_last_service: null, avg_miles_per_day: null };
  assert.equal(computeDue(v, INTERVALS, TODAY, 45), null,
    "fabricated a due date from nothing");
});

test("works from mileage alone, and from dates alone", () => {
  const mileageOnly: VehicleForDue = { ...base, sold_on: null, mileage: 12000,
    mileage_as_of: "2026-08-01", last_service_on: null, mileage_at_last_service: null };
  assert.ok(computeDue(mileageOnly, INTERVALS, TODAY, 45));

  const datesOnly: VehicleForDue = { ...base, sold_on: "2023-08-01", mileage: null,
    mileage_as_of: null, last_service_on: "2026-02-01", mileage_at_last_service: null,
    avg_miles_per_day: null };
  assert.ok(computeDue(datesOnly, INTERVALS, TODAY, 45));
});

test("never returns a due date in the past", () => {
  const v: VehicleForDue = { ...base, sold_on: "2019-01-01", mileage: 120000,
    mileage_as_of: "2026-08-01", last_service_on: "2020-01-01", mileage_at_last_service: 20000 };
  const due = computeDue(v, INTERVALS, TODAY, 45);
  if (due) assert.ok(due.dueOn >= TODAY, `due ${due.dueOn} is before ${TODAY}`);
});

test("returns null when the make has no schedule", () => {
  assert.equal(computeDue({ ...base, sold_on: "2022-01-01", mileage: 30000,
    mileage_as_of: TODAY, last_service_on: null, mileage_at_last_service: null }, [], TODAY, 45), null);
});
