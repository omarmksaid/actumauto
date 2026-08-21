/**
 * Appointment state for terminal testing.
 *
 *   npx tsx scripts/appts.ts list                    what's on the books
 *   npx tsx scripts/appts.ts book <when> [--wait]    e.g. "saturday 9am"
 *   npx tsx scripts/appts.ts checkin [id]            mark in service (drives the greeting)
 *   npx tsx scripts/appts.ts complete [id]
 *   npx tsx scripts/appts.ts fill <when>             book to capacity, to test "fully booked"
 *   npx tsx scripts/appts.ts clear                   remove all test appointments
 *
 * Exists because the interesting new behaviour depends on STATE, not conversation: the agent
 * only says "your car is with us today" if something is checked in, and only refuses a slot if
 * the day is full. Setting that up by hand in SQL each time is slow and error-prone.
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import ws from "ws";
import { loadShopConfig, availableSlots, spokenTime } from "../src/scheduling/slots";

const sb = createClient((process.env.SUPABASE_URL ?? "").replace(/\/+$/, ""),
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false }, realtime: { transport: ws as any } });

const TEST_TAG = "[test-appt]";   // so `clear` only removes what this script created

async function ctx() {
  const { data: co } = await sb.from("companies").select("id, timezone").limit(1).single();
  const { data: cu } = await sb.from("customers").select("id, full_name").limit(1).single();
  const { data: v } = await sb.from("vehicles").select("id, year, make, model").eq("customer_id", cu!.id).limit(1).maybeSingle();
  return { co: co!, cu: cu!, v };
}

/** "saturday 9am" / "tomorrow 10:30" -> the matching open slot. */
async function resolve(companyId: string, phrase: string) {
  const cfg = await loadShopConfig(companyId);
  const now = new Date();
  const localDate = (d: Date) => new Intl.DateTimeFormat("en-CA",
    { timeZone: cfg.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const dayOf = (d: Date) => new Intl.DateTimeFormat("en-US",
    { timeZone: cfg.timezone, weekday: "long" }).format(d).toLowerCase();

  const p = phrase.toLowerCase();
  let date = localDate(now);
  if (p.includes("tomorrow")) date = localDate(new Date(now.getTime() + 86400_000));
  else {
    for (const name of ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"]) {
      if (!p.includes(name.slice(0, 3))) continue;
      for (let i = 1; i <= 7; i++) {
        const c = new Date(now.getTime() + i * 86400_000);
        if (dayOf(c) === name) { date = localDate(c); break; }
      }
      break;
    }
  }

  const slots = await availableSlots(companyId, cfg, date, 45, 40);
  if (!slots.length) return { cfg, slot: null, date };

  const m = p.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (!m) return { cfg, slot: slots[0], date };
  let hour = parseInt(m[1], 10);
  if (m[3] === "pm" && hour !== 12) hour += 12;
  if (m[3] === "am" && hour === 12) hour = 0;
  const want = hour * 60 + (m[2] ? parseInt(m[2], 10) : 0);

  const hhmm = (d: Date) => {
    const f = new Intl.DateTimeFormat("en-US", { timeZone: cfg.timezone, hour: "2-digit", minute: "2-digit", hour12: false })
      .formatToParts(d).reduce((a: any, x) => (a[x.type] = x.value, a), {});
    return (Number(f.hour) % 24) * 60 + Number(f.minute);
  };
  const best = slots.reduce((b, s) => Math.abs(hhmm(s.startsAt) - want) < Math.abs(hhmm(b.startsAt) - want) ? s : b, slots[0]);
  return { cfg, slot: best, date };
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { co, cu, v } = await ctx();
  const cfg = await loadShopConfig(co.id);

  if (!cmd || cmd === "list") {
    const { data } = await sb.from("appointments")
      .select("id, starts_at, preferred_time, status, drop_off, vehicles(year, make, model)")
      .eq("company_id", co.id).not("status", "in", "(canceled)")
      .order("starts_at", { ascending: true, nullsFirst: false }).limit(20);
    if (!data?.length) return console.log("  nothing booked");
    for (const a of data as any[]) {
      const when = a.starts_at ? spokenTime(new Date(a.starts_at), cfg.timezone) : `"${a.preferred_time}"`;
      const car = a.vehicles ? `${a.vehicles.year} ${a.vehicles.make} ${a.vehicles.model}` : "—";
      console.log(`  ${a.id.slice(0, 8)}  ${when.padEnd(30)} ${a.status.padEnd(21)} ${a.drop_off ?? ""}  ${car}`);
    }
    return;
  }

  if (cmd === "book" || cmd === "fill") {
    const phrase = rest.filter((r) => !r.startsWith("--")).join(" ") || "tomorrow 9am";
    const { slot } = await resolve(co.id, phrase);
    if (!slot) return console.log(`  no open slot for "${phrase}" — closed or full`);
    const n = cmd === "fill" ? cfg.capacity : 1;
    for (let i = 0; i < n; i++) {
      await sb.from("appointments").insert({
        company_id: co.id, customer_id: cu.id, vehicle_id: v?.id ?? null, provider: "soft",
        status: "confirmed", starts_at: slot.startsAt.toISOString(), ends_at: slot.endsAt.toISOString(),
        preferred_time: phrase, drop_off: rest.includes("--wait") ? "waiting" : "dropping_off",
        service_ops: { ops: ["Oil & filter change"] }, notes: TEST_TAG,
      });
    }
    console.log(`  booked ${n} × ${slot.label}${cmd === "fill" ? "  (slot now at capacity)" : ""}`);
    return;
  }

  if (cmd === "checkin" || cmd === "complete") {
    let id = rest[0];
    if (!id) {
      const { data } = await sb.from("appointments").select("id")
        .eq("company_id", co.id)
        .in("status", cmd === "checkin" ? ["confirmed", "pending_confirmation"] : ["in_service"])
        .order("starts_at", { ascending: true, nullsFirst: false }).limit(1).maybeSingle();
      if (!data) return console.log(`  nothing to ${cmd}`);
      id = data.id;
    }
    const patch = cmd === "checkin"
      ? { status: "in_service", checked_in_at: new Date().toISOString() }
      : { status: "shown", completed_at: new Date().toISOString(), shown_at: new Date().toISOString() };
    const { data, error } = await sb.from("appointments").update(patch)
      .eq("id", id).eq("company_id", co.id).select("status").maybeSingle();
    console.log(error ? `  failed: ${error.message}` : `  ${id.slice(0, 8)} -> ${data?.status}`);
    if (cmd === "checkin" && !error) console.log(`  now call: npx tsx scripts/chat.ts   (${cu.full_name} should be greeted about their car)`);
    return;
  }

  if (cmd === "clear") {
    const { data } = await sb.from("appointments").delete().eq("company_id", co.id).eq("notes", TEST_TAG).select("id");
    console.log(`  removed ${(data ?? []).length} test appointment(s)`);
    return;
  }

  console.log("  usage: list | book <when> [--wait] | fill <when> | checkin [id] | complete [id] | clear");
}
main().catch((e) => { console.error("failed:", e.message); process.exit(1); });
