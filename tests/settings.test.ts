/**
 * Operating hours must stay wired end to end.
 *
 * The BusinessHours component was defined and its value was included in the save payload, but
 * it was never rendered — so the section silently disappeared from Settings while every other
 * part of the chain kept working and typechecking. Nothing caught it. These assertions cover
 * the seam that broke: defined AND rendered AND saved.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const PAGE = readFileSync("web/app/(app)/settings/page.tsx", "utf8");

test("the operating-hours editor is rendered, not just defined", () => {
  assert.ok(/function BusinessHours\b/.test(PAGE), "BusinessHours is not defined");
  assert.ok(/<BusinessHours\b/.test(PAGE),
    "BusinessHours is defined but never rendered — the section is invisible in Settings");
});

test("edited hours are sent to the API", () => {
  const save = PAGE.slice(PAGE.indexOf("async function save"), PAGE.indexOf("if (loading)"));
  assert.ok(/business_hours/.test(save), "save() doesn't send business_hours");
  assert.ok(/onChange=\{\(h\) => setS\(\{ \.\.\.s, business_hours: h \}\)\}/.test(PAGE),
    "edits don't flow back into the settings state, so Save would post stale hours");
});

test("every weekday is editable", () => {
  const body = PAGE.slice(PAGE.indexOf("function BusinessHours"));
  for (const d of ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]) {
    assert.ok(new RegExp(`"${d}"`).test(body), `${d} is missing from the hours editor`);
  }
});
