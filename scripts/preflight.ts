/**
 * Preflight — verify configuration against the REAL services before taking a call.
 *
 * A failed phone call is a terrible debugger: Vapi reports "assistant request failed" whether the
 * cause is a bad key, an unmigrated database, or a number that isn't mapped. This checks each
 * dependency independently and says exactly which one is wrong.
 *
 *   npm run preflight
 */

import "dotenv/config";

type Status = "ok" | "warn" | "fail";
const results: { name: string; status: Status; detail: string }[] = [];
const add = (name: string, status: Status, detail: string) => results.push({ name, status, detail });

const need = (k: string) => (process.env[k] ?? "").trim();

async function main() {
  // ── 1. Required env present ──
  const required = ["APP_URL", "DATABASE_URL", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY",
                    "SUPABASE_JWT_SECRET", "ANTHROPIC_API_KEY", "VAPI_API_KEY", "VAPI_WEBHOOK_SECRET"];
  const missing = required.filter((k) => !need(k));
  if (missing.length) {
    add("env", "fail", `missing: ${missing.join(", ")}`);
    report();
    process.exit(1);
  }
  add("env", "ok", `all ${required.length} required vars set`);

  // ── 2. DATABASE_URL shape (the silent pg-boss killer) ──
  const db = need("DATABASE_URL");
  if (db.includes(":6543")) {
    add("DATABASE_URL", "fail",
      "port 6543 = TRANSACTION-mode pooler. pg-boss needs SESSION mode (5432) or jobs never run.");
  } else if (!db.includes(":5432")) {
    add("DATABASE_URL", "warn", "expected port 5432 (session pooler) — double-check this is session mode");
  } else {
    add("DATABASE_URL", "ok", "session-mode pooler (5432)");
  }

  // ── 3. Supabase: can we reach it with the service-role key, and is the schema migrated? ──
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(need("SUPABASE_URL"), need("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false },
  });

  try {
    const { error } = await sb.from("companies").select("id").limit(1);
    if (error) throw new Error(error.message);
    add("supabase", "ok", "connected with service-role key");
  } catch (e: any) {
    add("supabase", "fail", `cannot query: ${e.message}`);
    report(); process.exit(1);
  }

  // Every table the inbound path touches.
  for (const t of ["companies", "customers", "vehicles", "calls", "transcripts",
                   "service_schedules", "service_intervals", "service_offerings",
                   "handoff_requests", "phone_numbers", "appointments", "webhook_events"]) {
    const { error } = await sb.from(t).select("*", { head: true, count: "exact" }).limit(1);
    if (error) add(`table ${t}`, "fail", error.message);
  }
  if (!results.some((r) => r.name.startsWith("table "))) {
    add("schema", "ok", "all inbound tables present");
  }

  // The caller-identification function — the heart of the inbound path.
  try {
    const { error } = await sb.rpc("identify_inbound_caller",
      { p_to_number: "+10000000000", p_from_number: "+10000000001" });
    if (error) throw new Error(error.message);
    add("identify_inbound_caller()", "ok", "callable (unknown number returns no rows, as expected)");
  } catch (e: any) {
    add("identify_inbound_caller()", "fail", `${e.message} — did migration 0004 run?`);
  }

  // ── 4. Dealership data readiness ──
  const { data: companies } = await sb.from("companies").select("id, name, settings");
  if (!companies?.length) {
    add("dealership", "fail", "no companies — run create_workspace() while signed in as your user");
  } else {
    add("dealership", "ok", companies.map((c) => c.name).join(", "));

    for (const co of companies) {
      const label = co.name;
      const settings = (co.settings ?? {}) as any;

      const { data: nums } = await sb.from("phone_numbers")
        .select("e164, vapi_phone_id, enabled").eq("company_id", co.id);
      const routable = (nums ?? []).filter((n) => n.enabled);
      if (!routable.length) {
        add(`${label}: numbers`, "fail", "no enabled number — inbound returns 404 and won't answer");
      } else {
        const unlinked = routable.filter((n) => !n.vapi_phone_id).map((n) => n.e164);
        add(`${label}: numbers`, unlinked.length ? "warn" : "ok",
          routable.map((n) => n.e164).join(", ") +
          (unlinked.length ? ` (no vapi_phone_id on ${unlinked.join(", ")})` : ""));
      }

      const transfer = settings.inbound?.transfer_number;
      add(`${label}: transfer number`, transfer ? "ok" : "warn",
        transfer || "not set — agent can only take a message, never transfer");

      const { count: svc } = await sb.from("service_offerings")
        .select("*", { head: true, count: "exact" }).eq("company_id", co.id).eq("active", true);
      add(`${label}: services catalog`, svc ? "ok" : "warn",
        svc ? `${svc} active` : "empty — every service question gets transferred");

      const { count: cust } = await sb.from("customers")
        .select("*", { head: true, count: "exact" }).eq("company_id", co.id);
      add(`${label}: customers`, cust ? "ok" : "warn",
        cust ? `${cust} imported` : "none — every caller will be anonymous");
    }
  }

  // Service schedules are global-or-company; without them nothing is ever "due".
  const { count: sched } = await sb.from("service_intervals")
    .select("*", { head: true, count: "exact" });
  add("service intervals", sched ? "ok" : "warn",
    sched ? `${sched} intervals loaded` : "none — the agent can't say what's due (run the seed)");

  // ── 5. Anthropic ──
  try {
    const r = await fetch("https://api.anthropic.com/v1/models?limit=1", {
      headers: { "x-api-key": need("ANTHROPIC_API_KEY"), "anthropic-version": "2023-06-01" },
    });
    add("anthropic", r.ok ? "ok" : "fail", r.ok ? "key valid" : `HTTP ${r.status}`);
  } catch (e: any) {
    add("anthropic", "fail", e.message);
  }

  // ── 6. Vapi: key valid, and is any number pointed at our assistant endpoint? ──
  try {
    const r = await fetch("https://api.vapi.ai/phone-number", {
      headers: { Authorization: `Bearer ${need("VAPI_API_KEY")}` },
    });
    if (!r.ok) {
      add("vapi", "fail", `HTTP ${r.status} — check VAPI_API_KEY`);
    } else {
      const nums = await r.json();
      const list = Array.isArray(nums) ? nums : [];
      add("vapi", "ok", `key valid, ${list.length} number(s) in Vapi`);

      const appUrl = need("APP_URL").replace(/\/$/, "");
      const wired = list.filter((n: any) =>
        (n.server?.url ?? n.assistantId ?? "").toString().includes(`${appUrl}/inbound/assistant`));
      if (list.length && !wired.length) {
        add("vapi inbound wiring", "warn",
          `no Vapi number points at ${appUrl}/inbound/assistant — set the number's server URL`);
      } else if (wired.length) {
        add("vapi inbound wiring", "ok", `${wired.length} number(s) routed to this API`);
      }
    }
  } catch (e: any) {
    add("vapi", "fail", e.message);
  }

  // ── 7. APP_URL reachability by an external caller ──
  const appUrl = need("APP_URL");
  if (/localhost|127\.0\.0\.1/.test(appUrl)) {
    add("APP_URL", "warn",
      `${appUrl} is local — Vapi cannot reach it. Use a tunnel (ngrok) before taking a real call.`);
  } else {
    try {
      const r = await fetch(`${appUrl.replace(/\/$/, "")}/health`);
      add("APP_URL", r.ok ? "ok" : "fail",
        r.ok ? `${appUrl}/health reachable` : `HTTP ${r.status} — is the API running?`);
    } catch (e: any) {
      add("APP_URL", "fail", `${appUrl}/health unreachable: ${e.message}`);
    }
  }

  report();
  process.exit(results.some((r) => r.status === "fail") ? 1 : 0);
}

function report() {
  const icon = { ok: "✓", warn: "!", fail: "✗" };
  const width = Math.max(...results.map((r) => r.name.length));
  console.log("\n  Preflight\n  " + "─".repeat(width + 40));
  for (const r of results) {
    console.log(`  ${icon[r.status]} ${r.name.padEnd(width)}  ${r.detail}`);
  }
  const fails = results.filter((r) => r.status === "fail").length;
  const warns = results.filter((r) => r.status === "warn").length;
  console.log("  " + "─".repeat(width + 40));
  console.log(fails ? `  ${fails} blocking problem(s)${warns ? `, ${warns} warning(s)` : ""}.\n`
                    : warns ? `  Ready, with ${warns} warning(s).\n`
                            : "  All checks passed.\n");
}

main().catch((e) => { console.error("preflight crashed:", e); process.exit(1); });
