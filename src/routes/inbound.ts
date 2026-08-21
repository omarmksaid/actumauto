/**
 * Inbound service line — Vapi assistant-request + in-call tools (PLAN.md §16).
 *
 * Two entry points, both authenticated by the Vapi shared secret (provider auth, NOT requireAuth):
 *
 *   POST /inbound/assistant   Vapi asks "who's calling and how should I behave?" on every inbound
 *                             call. We identify the caller from the numbers and answer with a
 *                             fully-assembled assistant config, synchronously.
 *   POST /inbound/tools       The in-call tool calls (lookup_services, get_my_vehicles,
 *                             get_due_service, book_service, transfer_to_service).
 *
 * SECURITY — the rule the whole inbound design rests on (§8 invariant 2, §16e):
 * no tool trusts an id from the model. Every request re-resolves the caller from the Vapi CALL ID
 * (via `inbound_calls` written at assistant-request time), so:
 *   - an anonymous caller can never reach customer data, whatever the model is talked into asking;
 *   - an identified caller can only ever reach THEIR OWN data.
 * `vehicle_id` is the one id accepted from the model, and it's validated to belong to the pinned
 * customer before use.
 */

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase";
import { env } from "../lib/env";
import { resolveInboundContext, loadVehiclesWithDue, loadUpcomingAppointments, InboundContext, INBOUND_DUE_HORIZON_DAYS } from "../inbound/identify";
import { computeDue } from "../scheduling/due";
import { loadShopConfig, availableSlots, nextAvailableSlots, checkSlot, openWindow, currentlyInService, spokenTime } from "../scheduling/slots";

/**
 * Resolve "friday" / "tomorrow" / "2026-08-22" to a local YYYY-MM-DD in the shop's timezone.
 * Weekday names always mean the NEXT occurrence, which is what a caller means by "Friday".
 */
function resolveDate(input: string, tz: string): string | null {
  const raw = input.toLowerCase().trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  const local = (d: Date) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
      .format(d);
  const dayIndex = (d: Date) =>
    ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].indexOf(
      new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(d).toLowerCase().slice(0, 3));

  const now = new Date();
  if (/^today$/.test(raw)) return local(now);
  if (/^tomorrow$/.test(raw)) return local(new Date(now.getTime() + 86400_000));

  const NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const want = NAMES.findIndex((n) => raw.includes(n.slice(0, 3)) && raw.length <= 14);
  if (want >= 0) {
    for (let i = 1; i <= 7; i++) {
      const cand = new Date(now.getTime() + i * 86400_000);
      if (dayIndex(cand) === want) return local(cand);
    }
  }
  return null;
}

/**
 * What an advisor reads on the appointment row. They're placing this in myKaarma without
 * listening to the call, so it has to answer: who, which car, what work, waiting or dropping off.
 */
function buildAppointmentNote(a: {
  customerName: string; phone: string | null; vehicle: string | null; vehicleOnFile: boolean;
  ops: string[]; dropOff: string; when: string; agentNotes: string;
}): string {
  const lines = [
    `${a.customerName}${a.phone ? ` (${a.phone})` : ""} — booked by phone`,
    a.vehicle
      ? `Vehicle: ${a.vehicle}${a.vehicleOnFile ? "" : " — NOT ON FILE, add it"}`
      : "Vehicle: not specified",
    `Requested: ${a.ops.length ? a.ops.join(", ") : "service not specified"}`,
    `When: ${a.when}`,
    a.dropOff === "waiting" ? "Customer will WAIT on site"
      : a.dropOff === "dropping_off" ? "Customer is dropping off"
      : "Waiting vs drop-off: not asked",
  ];
  if (a.agentNotes) lines.push(`Notes: ${a.agentNotes}`);
  return lines.join("\n");
}

/** Parse "2026-08-22T10:00" as local time in the given zone, not the server's. */
function localTimeToInstant(raw: string, tz: string): Date {
  const naive = new Date(`${raw.replace(" ", "T")}${raw.length <= 16 ? ":00" : ""}Z`);
  if (isNaN(naive.getTime())) return naive;
  const shown = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(naive).reduce((a: any, p) => (a[p.type] = p.value, a), {});
  const wantMin = naive.getUTCHours() * 60 + naive.getUTCMinutes();
  const gotMin = (Number(shown.hour) % 24) * 60 + Number(shown.minute);
  return new Date(naive.getTime() - (gotMin - wantMin) * 60_000);
}
import { loadIntervalsForVehicle } from "../scheduling/schedules";
import { buildInboundAssistant } from "../inbound/assistant";
import { getBookingProvider } from "../booking";

export const inboundRoutes = new Hono();

/** Provider auth — same shared secret as the Vapi webhook. */
function vapiAuthed(c: any): boolean {
  const secret = c.req.header("x-vapi-secret") ?? "";
  return !!env.VAPI_WEBHOOK_SECRET && secret === env.VAPI_WEBHOOK_SECRET;
}

const todayIso = () => new Date().toISOString().slice(0, 10);

// ── Assistant request: identify the caller, return the assistant ─────────────
inboundRoutes.post("/assistant", async (c) => {
  if (!vapiAuthed(c)) return c.json({ error: "unauthorized" }, 401);

  let payload: any = {};
  try { payload = await c.req.json(); } catch { /* keep {} */ }

  const msg = payload?.message ?? {};
  const call = msg.call ?? {};
  const toNumber: string = call.phoneNumber?.number ?? msg.phoneNumber?.number ?? "";
  const fromNumber: string | null = call.customer?.number ?? msg.customer?.number ?? null;
  const vapiCallId: string | null = call.id ?? null;

  const ctx = await resolveInboundContext(toNumber, fromNumber, todayIso());

  // The dialed number isn't one of ours — we can't attribute the call to a dealership, so we
  // can't safely say anything. Let Vapi fall back to its default handling.
  if (!ctx) {
    console.warn(`[inbound] unrecognized destination number: ${toNumber}`);
    return c.json({ error: "unknown destination" }, 404);
  }

  // Pin identity to the call id. Every later tool call resolves through this row rather than
  // trusting the model — this is what makes the anonymous case safe.
  if (vapiCallId) {
    await supabaseAdmin.from("calls").insert({
      company_id: ctx.companyId,
      customer_id: ctx.customerId,
      vapi_call_id: vapiCallId,
      direction: "inbound",
      from_number: fromNumber,
      metadata: { identified: !!ctx.customerId, match_count: ctx.matchCount, to_number: toNumber },
    });
  }

  console.log(
    `[inbound] call=${vapiCallId} company=${ctx.companyId} ` +
    `identified=${!!ctx.customerId} matches=${ctx.matchCount}`   // §16g: the match-rate metric
  );

  const settings = await companyVoice(ctx.companyId);
  return c.json({ assistant: buildInboundAssistant(ctx, settings) });
});

// ── In-call tools ────────────────────────────────────────────────────────────
inboundRoutes.post("/tools", async (c) => {
  if (!vapiAuthed(c)) return c.json({ error: "unauthorized" }, 401);

  let payload: any = {};
  try { payload = await c.req.json(); } catch { /* keep {} */ }

  const msg = payload?.message ?? {};
  const toolCalls: any[] = msg.toolCalls ?? msg.toolCallList ?? [];
  const vapiCallId: string | null = msg.call?.id ?? null;

  // Re-resolve the pinned identity from the call id. Never from the tool arguments.
  const pinned = await resolvePinnedCall(vapiCallId);
  if (!pinned) return c.json({ results: toolCalls.map((t) => toolError(t, "Call context unavailable.")) });

  const results: { toolCallId: any; result: string }[] = [];
  for (const tc of toolCalls) {
    const name = tc.function?.name ?? tc.name;
    const args = parseArgs(tc.function?.arguments ?? tc.arguments);
    try {
      results.push({ toolCallId: tc.id, result: await runTool(name, args, pinned) });
    } catch (e: any) {
      console.error(`[inbound] tool ${name} failed:`, e.message);
      results.push(toolError(tc, "Sorry — I couldn't pull that up. Let me get you to the service team."));
    }
  }
  return c.json({ results });
});

// ── Tool dispatch ────────────────────────────────────────────────────────────

interface PinnedCall {
  callId: string;
  companyId: string;
  /**
   * null ⇒ anonymous: customer tools MUST refuse.
   *
   * Mutable, because register_customer can fill it mid-call. Vapi may send several tool calls in
   * ONE request, which resolves `pinned` a single time — so if register_customer and book_service
   * arrive together, writing back to the DB alone would leave book_service holding a stale null
   * and refusing the booking it was just given a customer for. Assigning here fixes the whole
   * batch; the DB write covers every later request.
   */
  customerId: string | null;
  callerNumber: string | null;
}

async function runTool(name: string, args: any, pinned: PinnedCall): Promise<string> {
  switch (name) {
    case "lookup_services":   return await lookupServices(args.query ?? "", pinned);
    case "get_my_vehicles":   return await getMyVehicles(pinned);
    case "get_due_service":   return await getDueService(pinned);
    case "check_service_due":  return await checkServiceDue(args, pinned);
    case "register_customer":  return await registerCustomer(args, pinned);
    case "book_service":      return await bookService(args, pinned);
    case "create_profile":
    case "register_customer":
    case "create_customer":    return await createProfile(args, pinned);
    case "check_availability": return await checkAvailability(args, pinned);
    case "list_appointments":  return await listAppointments(pinned);
    case "cancel_appointment": return await cancelAppointment(args, pinned);
    case "log_handoff":         return await logHandoff(args, pinned);
    // Older name kept so a call already in flight during a deploy doesn't break.
    case "transfer_to_service": return await logHandoff(args, pinned);
    default:
      // Name the real tools: a model that invented a name can usually recover if told the set.
      console.warn(`[inbound] unknown tool: ${name}`);
      return `FAILED — there's no tool called "${name}". Available: lookup_services, ` +
        `check_service_due, check_availability, book_service, list_appointments, ` +
        `cancel_appointment, create_profile, log_handoff, transferCall.`;
  }
}

/** Words that would match everything and drown the real signal. */
const STOPWORDS = new Set([
  "the", "and", "for", "you", "your", "our", "any", "can", "does", "did", "with", "about",
  "have", "has", "get", "got", "need", "want", "please", "service", "car", "vehicle",
  // Generic service-noise words: they appear in half the catalog, so matching on them returns
  // near-arbitrary rows. "windshield replacement" once matched "Brake pad replacement" on
  // `replacement` alone — offering brake pads to a cracked windshield.
  "replacement", "replace", "repair", "check", "inspection", "inspect", "new", "fix",
]);

/**
 * Reject a requested time that falls outside opening hours. Deliberately conservative: it only
 * refuses when it can confidently read a day and hour out of the caller's phrasing, so free-text
 * like "sometime next week" still passes through for an advisor to sort out.
 * Returns null when the time is acceptable (or unparseable).
 */
async function checkHours(companyId: string, phrase: string): Promise<string | null> {
  const { data: co } = await supabaseAdmin
    .from("companies").select("business_hours").eq("id", companyId).maybeSingle();
  const hours = (co?.business_hours ?? {}) as Record<string, [string, string] | null>;
  if (!Object.keys(hours).length) return null;

  const p = phrase.toLowerCase();
  const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const NAMES: Record<string, string> = { sun: "Sunday", mon: "Monday", tue: "Tuesday",
    wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday" };

  // Which day are they asking for? Only handle forms we can read unambiguously.
  let dayKey: string | null = null;
  for (const d of DAYS) if (new RegExp(`\\b${NAMES[d].toLowerCase()}`).test(p)) dayKey = d;
  if (!dayKey && /\btomorrow\b/.test(p)) dayKey = DAYS[(new Date().getDay() + 1) % 7];
  if (!dayKey && /\btoday\b|\bthis afternoon\b|\bthis morning\b/.test(p)) dayKey = DAYS[new Date().getDay()];
  if (!dayKey) return null;

  // Which hour? "9pm", "9 pm", "9:30am", "at 9" (bare number stays ambiguous -> allow).
  const m = p.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const mins = m[2] ? parseInt(m[2], 10) : 0;
  const ampm = m[3];
  if (ampm === "pm" && hour !== 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;
  const asked = hour * 60 + mins;

  const window = hours[dayKey];
  const label = NAMES[dayKey];
  const fmt = (t: string) => {
    const [h, mm] = t.split(":").map(Number);
    const suffix = h >= 12 ? "PM" : "AM";
    const hr = h % 12 === 0 ? 12 : h % 12;
    return mm ? `${hr}:${String(mm).padStart(2, "0")} ${suffix}` : `${hr} ${suffix}`;
  };

  if (!window || !Array.isArray(window)) {
    const open = DAYS.filter((d) => hours[d]).map((d) => NAMES[d]);
    return `We're closed ${label}. Tell the caller that, mention we're open ${open.join(", ")}, ` +
      `and ask what else works. Do NOT book this.`;
  }

  const [o, c] = window.map((t) => { const [h, mm] = t.split(":").map(Number); return h * 60 + mm; });
  if (asked < o || asked >= c) {
    return `${label} we're open ${fmt(window[0])} to ${fmt(window[1])}, so that time won't work. ` +
      `Tell the caller warmly, offer a time inside those hours, and ask what they'd prefer. ` +
      `Do NOT book this.`;
  }
  return null;
}

/** The anonymous refusal. Server-side, so prompt wording is not the only thing protecting this. */
/**
 * How callers actually talk -> the words the catalog uses. Without this, "my AC is broken" finds
 * nothing because the entry reads "Air conditioning service", and the agent would tell a caller
 * we don't do something we do.
 */
const SYNONYMS: Record<string, string[]> = {
  ac: ["air", "conditioning"], "a/c": ["air", "conditioning"], aircon: ["air", "conditioning"],
  heater: ["air", "conditioning"], heat: ["air", "conditioning"],
  tune: ["spark", "plug"], tuneup: ["spark", "plug"],
  squeak: ["brake"], squeal: ["brake"], grinding: ["brake"], rotor: ["brake"],
  battery: ["battery"], dead: ["battery"], jump: ["battery"],
  smog: ["smog"], emission: ["smog"], registration: ["smog"],
  alignment: ["alignment"], pulling: ["alignment"], steering: ["alignment"],
  wiper: ["wiper"], blade: ["wiper"],
  headlight: ["headlight"], bulb: ["headlight"], light: ["headlight"],
  overheat: ["coolant"], overheating: ["coolant"], radiator: ["coolant"], antifreeze: ["coolant"],
  transmission: ["transmission"], shifting: ["transmission"], gear: ["transmission"],
  flat: ["tire"], puncture: ["tire"], nail: ["tire"], tread: ["tire"], tpm: ["tire"],
  recall: ["recall"], warranty: ["warranty"], detail: ["detailing"], wash: ["detailing"],
  noise: ["exhaust"], loud: ["exhaust"], muffler: ["exhaust"],
};

const ANON_REFUSAL =
  "I'm not able to look up account or vehicle details on this call — I don't have the caller " +
  "identified. Offer to transfer them to the service team.";

async function lookupServices(query: string, pinned: PinnedCall): Promise<string> {
  // Safe for anonymous callers: the catalog is dealership-level, not customer-level.
  const base = () => supabaseAdmin
    .from("service_offerings")
    .select("name, description, category, typical_duration_min, aliases")
    .eq("company_id", pinned.companyId).eq("active", true);

  // ALIASES FIRST. A caller saying "CEL" or "MPI" is giving the strongest possible signal, but
  // those are short acronyms that the stemmer and stopword filter would discard. Check the raw
  // query and its words against the dealership's own alias list before falling back to fuzzy
  // matching on names and descriptions.
  const rawWords = [query.trim(), ...query.toLowerCase().split(/[^a-z0-9/']+/)]
    .map((w) => w.trim()).filter((w) => w.length >= 2);
  if (rawWords.length) {
    const { data: all } = await base();
    const hit = (all ?? []).filter((o: any) =>
      (o.aliases ?? []).some((a: string) =>
        rawWords.some((w) => a.toLowerCase() === w.toLowerCase())));
    if (hit.length) {
      return hit.slice(0, 5).map((o: any) =>
        `- ${o.name}${o.description ? `: ${o.description}` : ""}` +
        `${o.typical_duration_min ? ` (about ${o.typical_duration_min} min)` : ""}`
      ).join("\n") + "\n(No pricing available — an advisor quotes cost.)";
    }
  }

  let q = base();

  // Callers speak naturally ("brakes", "my brakes are squeaking"), catalog entries are formal
  // ("Brake pad replacement"). Match on individual word STEMS so plurals and phrases still hit:
  // a raw `ilike %brakes%` misses "Brake" entirely and we'd wrongly say we don't do brake work.
  const term = query.trim();
  const stems = term
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    // Expand short-but-meaningful words (ac, a/c) BEFORE the length filter drops them.
    .flatMap((w) => (SYNONYMS[w] && w.length < 3 ? SYNONYMS[w] : [w]))
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
    .map((w) => w.replace(/(ies|es|s)$/, ""))        // brakes→brake, batteries→batter
    .filter((w) => w.length >= 3)
    .flatMap((w) => SYNONYMS[w] ?? [w])              // "ac" -> air, conditioning
    .slice(0, 8);

  if (stems.length) {
    q = q.or(stems.flatMap((w) =>
      [`name.ilike.%${w}%`, `description.ilike.%${w}%`, `category.ilike.%${w}%`]).join(","));
  }

  const { data } = await q.limit(30);
  if (!data?.length) {
    return `Nothing in our service catalog matches "${term}". Don't guess — tell the caller you'll ` +
      `check with the service team, and offer to transfer.`;
  }

  // ilike is substring matching, so short stems produce junk: "air" hits repAIR and chAIN, and
  // "air conditioning" pulled back 13 of 30 services. Rank by where the stem actually landed and
  // return only the top few — a long list read aloud is useless to a caller anyway.
  const scored = data.map((o) => {
    const name = o.name.toLowerCase();
    const aliasText = ((o as any).aliases ?? []).join(" ").toLowerCase();
    let score = 0;
    for (const w of stems) {
      const inName = new RegExp(`\\b${w}`).test(name);          // word-start in the NAME
      const inAlias = new RegExp(`\\b${w}`).test(aliasText);
      const inDesc = new RegExp(`\\b${w}`).test((o.description ?? "").toLowerCase());
      // Aliases outrank the description: they're the dealership telling us what callers say.
      if (inName) score += 10;
      else if (inAlias) score += 8;
      else if (inDesc) score += 3;
      else if (name.includes(w)) score += 1;                    // mid-word: weak (repAIR)
    }
    return { o, score };
  }).sort((a, b) => b.score - a.score);

  // Keep only matches that landed on a word boundary somewhere; a purely mid-word hit is noise.
  const strong = scored.filter((x) => x.score >= 3).slice(0, 5);
  const chosen = strong.length ? strong : scored.slice(0, 3);

  return chosen.map(({ o }) =>
    `- ${o.name}${o.description ? `: ${o.description}` : ""}` +
    `${o.typical_duration_min ? ` (about ${o.typical_duration_min} min)` : ""}`
  ).join("\n") + "\n(No pricing available — an advisor quotes cost.)";
}

async function getMyVehicles(pinned: PinnedCall): Promise<string> {
  if (!pinned.customerId) return ANON_REFUSAL;
  const vehicles = await loadVehiclesWithDue(pinned.companyId, pinned.customerId, todayIso());
  if (!vehicles.length) return "We have no vehicles on file for this caller.";
  return vehicles.map((v) =>
    `- id=${v.id} · ${v.year} ${v.make} ${v.model}` +
    `${v.mileage ? ` (~${v.mileage.toLocaleString()} mi)` : ""}`
  ).join("\n");
}

async function getDueService(pinned: PinnedCall): Promise<string> {
  if (!pinned.customerId) return ANON_REFUSAL;
  const vehicles = await loadVehiclesWithDue(pinned.companyId, pinned.customerId, todayIso());
  const due = vehicles.filter((v) => v.due);
  if (!due.length) return "Nothing is coming due on their vehicles right now. Don't invent a recommendation.";
  return due.map((v) =>
    `- ${v.year} ${v.make} ${v.model} (id=${v.id}): ${v.due!.service}, due around ${v.due!.dueOn}` +
    `${v.due!.reason === "mileage" ? ` (~${v.due!.projectedMileage.toLocaleString()} mi)` : " (time-based)"}`
  ).join("\n");
}

/**
 * What's due, computed from details the CALLER states rather than a stored record.
 *
 * Safe for anonymous callers: nothing is read from the database about them — only the platform's
 * service schedules, which are dealership-level. It refuses rather than guesses when the caller
 * can't supply either mileage or a rough last-service date, because a fabricated due date spoken
 * with confidence is worse than admitting we need the car in front of us.
 */
async function checkServiceDue(args: any, pinned: PinnedCall): Promise<string> {
  const make = String(args.make ?? "").trim();
  const model = String(args.model ?? "").trim();
  const year = Number(args.year);
  if (!make || !model || !year) return "Ask them the make, model, and year first.";

  const mileage = args.mileage != null ? Number(args.mileage) : null;
  const monthsAgo = args.last_service_months_ago != null ? Number(args.last_service_months_ago) : null;
  const atLastService = args.mileage_at_last_service != null ? Number(args.mileage_at_last_service) : null;

  if (mileage == null && monthsAgo == null) {
    return "Ask roughly what the odometer reads, or about how long since the last service — " +
      "without one of those we can't say what's due. Don't guess.";
  }

  const today = todayIso();
  const lastServiceOn = monthsAgo != null
    ? new Date(new Date(today).setMonth(new Date(today).getMonth() - monthsAgo)).toISOString().slice(0, 10)
    : null;

  const intervals = await loadIntervalsForVehicle(pinned.companyId, { make, model, year });
  if (!intervals.length) {
    return `We don't have a maintenance schedule for a ${year} ${make} ${model}. Say you'd rather ` +
      `have a technician confirm, and offer to transfer.`;
  }

  const due = computeDue({
    id: "adhoc", make, model, year,
    sold_on: null,
    mileage,
    mileage_as_of: mileage != null ? today : null,
    last_service_on: lastServiceOn,
    mileage_at_last_service: atLastService,
    avg_miles_per_day: null,          // falls back to the fleet prior
  }, intervals, today, INBOUND_DUE_HORIZON_DAYS);

  if (!due) {
    return "Not enough detail to say what's due. Offer to have an advisor look it up properly.";
  }

  return `Their ${year} ${make} ${model} is due for ${due.interval.service_name} around ` +
    `${due.dueOn}` +
    (due.reason === "mileage" ? ` (~${due.projectedMileage.toLocaleString()} mi)` : " (time-based)") +
    `. Tell them what's due, then ask if they'd like you to book them in.`;
}

/**
 * Create a customer (and optionally their vehicle) from what a new caller tells us, then adopt
 * that identity for the rest of the call.
 *
 * This is the one tool that takes personal data from the model, because there is no other source:
 * an unrecognized caller ID means nothing on file to read. So everything it writes is treated as
 * UNVERIFIED — a spoken name heard over a phone line is a guess at a spelling, and the caller
 * could be a wrong number. `created_on_call_id` marks the provenance so the dealership can tell
 * these apart from records it imported and vouches for.
 *
 * It is idempotent per call: calling it twice updates the row it already made rather than
 * creating a second one, because a model that re-confirms a name should not fork the customer.
 */
async function registerCustomer(args: any, pinned: PinnedCall): Promise<string> {
  const fullName = String(args.full_name ?? "").trim().replace(/\s+/g, " ");
  // A single token is usually the agent jumping the gun on "who am I speaking with" — it heard
  // "Omar" and called immediately. Ask for the surname rather than storing a half record.
  if (!fullName || !/\s/.test(fullName)) {
    return "Ask for their full name — first AND last — before calling this.";
  }

  // Already identified: either a known caller (never call this) or intake already ran.
  if (pinned.customerId) {
    const { data: existing } = await supabaseAdmin
      .from("customers").select("id, created_on_call_id")
      .eq("id", pinned.customerId).maybeSingle();

    // A CSV-imported customer must never be renamed by something heard on a call.
    if (existing && existing.created_on_call_id !== pinned.callId) {
      return "This caller is already on file — don't overwrite their record. " +
        "Use their existing details, and transfer them if something looks wrong.";
    }
    await supabaseAdmin.from("customers")
      .update({ full_name: fullName, updated_at: new Date().toISOString() })
      .eq("id", pinned.customerId).eq("created_on_call_id", pinned.callId);
    return await attachVehicle(args, pinned, fullName, "updated");
  }

  const { data: created, error } = await supabaseAdmin.from("customers").insert({
    company_id: pinned.companyId,
    full_name: fullName,
    phone: pinned.callerNumber,          // the number they're calling from, NOT one the model states
    customer_type: "new",
    created_on_call_id: pinned.callId,
    notes: "Created by the phone assistant during an inbound call — details unverified.",
  }).select("id").single();

  if (error || !created) {
    console.error("[inbound] register_customer failed:", error?.message);
    return "Couldn't save their details. Offer to transfer them to the service team.";
  }

  // Adopt the new identity: write it to the pinned call row (authority for later requests) AND
  // to the in-memory object (so the rest of THIS batch can already book).
  await supabaseAdmin.from("calls")
    .update({ customer_id: created.id }).eq("id", pinned.callId);
  pinned.customerId = created.id;

  return await attachVehicle(args, pinned, fullName, "created");
}

/**
 * Store the caller's vehicle, if they gave us one. Split out so register_customer can be called
 * again later in the call — reason first, car once it's relevant — without duplicating either row.
 */
async function attachVehicle(
  args: any, pinned: PinnedCall, fullName: string, mode: "created" | "updated"
): Promise<string> {
  const make = String(args.make ?? "").trim();
  const model = String(args.model ?? "").trim();
  const year = Number(args.year);
  const first = fullName.split(" ")[0];

  if (!make || !model || !year) {
    return `Saved ${fullName}. When it's relevant, ask what they drive — year, make, and model — ` +
      `and call this again with those to add the car.`;
  }

  const mileage = args.mileage != null && Number(args.mileage) > 0 ? Number(args.mileage) : null;

  // Don't duplicate the car if intake runs twice on one call.
  const { data: already } = await supabaseAdmin
    .from("vehicles").select("id")
    .eq("customer_id", pinned.customerId!)
    .eq("make", make).eq("model", model).eq("year", year)
    .maybeSingle();

  if (already) {
    return `Already have the ${year} ${make} ${model} on ${first}'s record. Carry on.`;
  }

  const { error } = await supabaseAdmin.from("vehicles").insert({
    company_id: pinned.companyId,
    customer_id: pinned.customerId,
    make, model, year,
    mileage,
    mileage_as_of: mileage != null ? todayIso() : null,
    created_on_call_id: pinned.callId,
  });

  if (error) {
    console.error("[inbound] vehicle insert failed:", error.message);
    return `Saved ${fullName}, but couldn't save the vehicle. Carry on without it — ` +
      `an advisor can add the car when they confirm.`;
  }

  return `Saved ${fullName} and their ${year} ${make} ${model}. You can now check availability ` +
    `and book for them. Don't re-read their details back — just carry on.`;
}

async function bookService(args: any, pinned: PinnedCall): Promise<string> {
  if (!pinned.customerId) {
    return "FAILED — no record for this caller yet, so there's nothing to attach a booking to. " +
      "Do NOT say it's booked. Ask their name and what they drive, call create_profile, then " +
      "book again.";
  }

  const preferredTime = String(args.preferred_time ?? "").trim();
  if (!preferredTime) return "FAILED — no time given. Do NOT say it's booked. Ask what day and time works.";

  // A resolved slot reserves real time; free text alone can't be checked for conflicts.
  const cfg = await loadShopConfig(pinned.companyId);
  let startsAt: Date | null = null;
  if (args.starts_at) {
    const raw = String(args.starts_at).trim();
    // Interpret a bare local timestamp in the SHOP's timezone, not the server's.
    const parsed = /Z|[+-]\d{2}:\d{2}$/.test(raw)
      ? new Date(raw)
      : localTimeToInstant(raw, cfg.timezone);
    if (!isNaN(parsed.getTime())) {
      const durationMin = Number(args.service_minutes) > 0 ? Number(args.service_minutes) : 45;
      const verdict = await checkSlot(pinned.companyId, cfg, parsed, durationMin);
      if (!verdict.ok) {
        return `FAILED — ${verdict.reason}. Do NOT say it's booked. Call check_availability and offer a real time.`;
      }
      startsAt = parsed;
    }
  }

  // Hours are also in the prompt, but a prompt rule is guidance, not a guarantee: capturing
  // "tomorrow at 9 PM" for a shop that shuts at 6 creates a promise someone has to walk back.
  if (!startsAt) {
    const outOfHours = await checkHours(pinned.companyId, preferredTime);
    if (outOfHours) return outOfHours;
  }

  // vehicle_id is the ONLY id we accept from the model — so validate it belongs to this caller.
  let vehicleId: string | null = null;
  const vehicles = await loadVehiclesWithDue(pinned.companyId, pinned.customerId, todayIso());
  const otherVehicle = String(args.other_vehicle ?? "").trim();

  // The vehicle must be CONFIRMED OUT LOUD, not assumed. A customer who bought a second car we
  // don't have on file would otherwise get their old one booked without ever being asked.
  const confirmed = args.vehicle_confirmed === true || args.vehicle_confirmed === "true";
  if (!confirmed) {
    const list = vehicles.length
      ? vehicles.map((v) => `${v.year} ${v.make} ${v.model}`).join(" or ")
      : "no vehicle on file";
    return `FAILED — you haven't confirmed which vehicle. Do NOT say it's booked. Ask them ` +
      `directly: "is this for your ${list}?" If it's a car we don't have on file, say we'll ` +
      `add it and note the make and model. Then call book_service again with ` +
      `vehicle_confirmed: true.`;
  }

  if (otherVehicle) {
    // A car we don't hold. Leave vehicle_id null and carry the description into the notes.
    vehicleId = null;
  } else if (args.vehicle_id) {
    const match = vehicles.find((v) => v.id === args.vehicle_id);
    if (match) vehicleId = match.id;
    else if (vehicles.length === 1) {
      // The model invented an id like "2022_Toyota_RAV4" instead of the UUID. Safe to fall back
      // only because the vehicle was explicitly confirmed with the caller above.
      vehicleId = vehicles[0].id;
    } else {
      return "FAILED — that vehicle id isn't on this caller's account. Do NOT tell them it's " +
        "booked. Call get_my_vehicles, ask which car, and book again with the exact id.";
    }
  } else if (vehicles.length === 1) {
    vehicleId = vehicles[0].id;
  } else if (vehicles.length > 1) {
    return "FAILED — more than one vehicle on file. Do NOT say it's booked. Ask which car, then book with its id.";
  }

  const chosen = vehicleId ? vehicles.find((v) => v.id === vehicleId) : null;
  const vehicleLabel = chosen ? `${chosen.year} ${chosen.make} ${chosen.model}` : null;
  const { data: cust } = await supabaseAdmin
    .from("customers").select("full_name").eq("id", pinned.customerId).maybeSingle();
  const customerName = cust?.full_name ?? null;

  const opsList = Array.isArray(args.service_ops) ? args.service_ops.map(String) : [];

  // MERGE INSTEAD OF DUPLICATING.
  //
  // book_service used to insert unconditionally. A caller who books an oil change and then says
  // "add a tire rotation" produced two rows at the same time for the same car, and the advisor
  // saw three 11 AM appointments for one visit. Retrying after a failed turn did the same.
  //
  // A live appointment for this customer + vehicle + start time is the SAME visit, so fold the
  // new operations into it. Cancelled and completed rows are left alone — those are history.
  if (startsAt) {
    const { data: existing } = await supabaseAdmin
      .from("appointments")
      .select("id, service_ops, drop_off, notes")
      .eq("company_id", pinned.companyId)
      .eq("customer_id", pinned.customerId)
      .eq("starts_at", startsAt.toISOString())
      .in("status", ["pending_confirmation", "confirmed", "in_service"])
      .limit(1)
      .maybeSingle();

    if (existing && (vehicleId ? true : !otherVehicle)) {
      const prevOps = ((existing.service_ops as any)?.ops ?? []) as string[];
      // Case-insensitive union, keeping the wording already stored.
      const seen = new Set(prevOps.map((o) => o.toLowerCase()));
      const mergedOps = [...prevOps, ...opsList.filter((o) => !seen.has(o.toLowerCase()))];
      const added = mergedOps.length - prevOps.length;

      await supabaseAdmin.from("appointments").update({
        service_ops: { ops: mergedOps },
        drop_off: ["waiting", "dropping_off"].includes(args.drop_off) ? args.drop_off : existing.drop_off,
        notes: buildAppointmentNote({
          customerName: customerName ?? "Caller",
          phone: pinned.callerNumber,
          vehicle: vehicleLabel ?? otherVehicle ?? null,
          vehicleOnFile: !!vehicleId,
          ops: mergedOps,
          dropOff: ["waiting", "dropping_off"].includes(args.drop_off) ? args.drop_off : String(existing.drop_off ?? "unknown"),
          when: spokenTime(startsAt, cfg.timezone),
          agentNotes: String(args.notes ?? "").trim(),
        }),
      }).eq("id", existing.id);

      return added > 0
        ? `Added ${opsList.join(" and ")} to their existing ${spokenTime(startsAt, cfg.timezone)} ` +
          `appointment — it's ONE visit, not a second booking. Say you've added it to the same ` +
          `appointment. Do NOT say they have two.`
        : `They already have that appointment at ${spokenTime(startsAt, cfg.timezone)} with the ` +
          `same work. Nothing changed. Confirm the existing booking; do NOT say you made another.`;
    }
  }

  const booking = getBookingProvider();
  const result = await booking.createAppointment({
    companyId: pinned.companyId,
    customerId: pinned.customerId,
    vehicleId,
    preferredTime,
    serviceOps: opsList,
    dropOff: ["waiting", "dropping_off"].includes(args.drop_off) ? args.drop_off : "unknown",
    startsAt,
    durationMin: Number(args.service_minutes) > 0 ? Number(args.service_minutes) : 45,
    notes: buildAppointmentNote({
      customerName: customerName ?? "Caller",
      phone: pinned.callerNumber,
      vehicle: vehicleLabel ?? otherVehicle ?? null,
      vehicleOnFile: !!vehicleId,
      ops: opsList,
      dropOff: ["waiting", "dropping_off"].includes(args.drop_off) ? args.drop_off : "unknown",
      when: startsAt ? spokenTime(startsAt, cfg.timezone) : preferredTime,
      agentNotes: String(args.notes ?? "").trim(),
    }),
  });

  // Mode-gated wording: in soft mode this promises a confirmation, never a firm slot (§2).
  return result.confirmationText;
}

/**
 * Create a record for a caller we don't have on file.
 *
 * Deliberately scoped to ANONYMOUS callers: creating a new row risks nothing an advisor curated,
 * whereas modifying an identified customer's record from an unverified call does. If the number
 * later turns out to belong to an existing customer, an advisor merges — a duplicate is a much
 * cheaper mistake than a corrupted record.
 */
async function createProfile(args: any, pinned: PinnedCall): Promise<string> {
  if (pinned.customerId) {
    return "FAILED — this caller already has a record. Don't create another; use their vehicles.";
  }

  const fullName = String(args.full_name ?? "").trim();
  if (!fullName) return "FAILED — no name given. Ask who you're speaking with first.";

  // Race guard: two calls from one number shouldn't create two records.
  const digits = (pinned.callerNumber ?? "").replace(/\D/g, "").slice(-10);
  if (digits.length === 10) {
    const { data: existing } = await supabaseAdmin
      .from("customers").select("id").eq("company_id", pinned.companyId)
      .ilike("phone", `%${digits}%`).limit(1).maybeSingle();
    if (existing) {
      await supabaseAdmin.from("calls").update({ customer_id: existing.id }).eq("id", pinned.callId);
      return "They already have a record — it's linked now. Carry on and book them normally.";
    }
  }

  const { data: customer, error } = await supabaseAdmin.from("customers").insert({
    company_id: pinned.companyId,
    full_name: fullName,
    phone: pinned.callerNumber,
    email: String(args.email ?? "").trim() || null,
    customer_type: "new",
    // Flagged so an advisor can verify details taken over the phone.
    notes: "Created from an inbound call — details unverified.",
  }).select("id").single();
  if (error) {
    console.error("[create_profile]", error.message);
    return "FAILED — couldn't create the record. Offer to transfer them instead.";
  }

  let vehicleNote = "";
  const make = String(args.make ?? "").trim();
  const model = String(args.model ?? "").trim();
  const year = Number(args.year);
  if (make && model && year) {
    const mileage = Number(args.mileage) > 0 ? Number(args.mileage) : null;
    await supabaseAdmin.from("vehicles").insert({
      company_id: pinned.companyId, customer_id: customer.id,
      make, model, year, mileage,
      mileage_as_of: mileage ? todayIso() : null,
    });
    vehicleNote = ` and their ${year} ${make} ${model}`;
  }

  // Pin the new identity to this call so the customer-scoped tools work for the rest of it.
  await supabaseAdmin.from("calls").update({ customer_id: customer.id }).eq("id", pinned.callId);

  return `Record created for ${fullName}${vehicleNote}. You can book them now — call ` +
    `get_my_vehicles to get the vehicle id.`;
}

/** Open times on a date, so the agent only ever offers slots the shop can actually take. */
async function checkAvailability(args: any, pinned: PinnedCall): Promise<string> {
  if (!pinned.customerId) {
    return "FAILED — no record for this caller, so nothing can be booked yet and offering times " +
      "would be a promise you can't keep. Ask their name and what they drive, call " +
      "create_profile, then check availability.";
  }

  const cfg = await loadShopConfig(pinned.companyId);
  const mins = Number(args.service_minutes) > 0 ? Number(args.service_minutes) : 45;
  const rawDate = String(args.date ?? "").trim();

  // NO DATE = "whenever you can take me". Scan forward for the soonest real opening instead of
  // making the model pick a date: a guessed date lands on a closed day and returns nothing, and
  // the caller hears "nothing available" from a shop with a free slot tomorrow. Also looks a week
  // out in the same pass, so someone booking in advance doesn't cost seven round-trips.
  if (!rawDate) {
    const days = Number(args.days) > 0 ? Math.min(Number(args.days), 14) : 7;
    const byDay = await nextAvailableSlots(pinned.companyId, cfg, todayIso(), mins, days, 6);
    if (!byDay.length) {
      return `FAILED — nothing open in the next ${days} days. Do NOT say it's booked. Offer to ` +
      `have an advisor call them back.`;
    }
    const soonest = byDay[0].slots[0];
    const later = byDay.slice(1).flatMap((d) => d.slots.map((s) => s.label)).slice(0, 4);
    // This is a SAMPLE, not the inventory. Without saying so, the model treats these few labels
    // as the only openings and tells a caller asking for 11 AM that we're full — on a day with
    // fifteen free slots. Every "is X available?" has to become a real lookup.
    return `Soonest: ${soonest.label}. Offer that one first. ` +
      (later.length
        ? `Further out: ${later.join(", ")} — only mention these if they'd rather plan ahead. `
        : `Nothing else open in that window. `) +
      `These are EXAMPLES, not the full list — most other times are probably open too. If they ` +
      `ask for a specific time, do NOT say it's unavailable: call check_availability again with ` +
      `date and time to check it.`;
  }

  // Accept a weekday name or "tomorrow" as well as a date. The model reliably knows what the
  // caller SAID but miscounts which date that is — it offered "Saturday the 23rd" when the 23rd
  // was a Sunday. Resolving here removes a whole class of confidently-wrong answers.
  const date = resolveDate(rawDate, cfg.timezone);
  if (!date) return "Couldn't read that date — pass YYYY-MM-DD, a weekday name, or 'tomorrow'.";
  // Fetch the WHOLE day: the caller may ask about any time, and truncating here makes a free
  // slot look booked. Only the spoken reply is shortened.
  const slots = await availableSlots(pinned.companyId, cfg, date, mins, 100);

  const dayName = new Intl.DateTimeFormat("en-US", { timeZone: cfg.timezone, weekday: "long", month: "short", day: "numeric" })
    .format(new Date(`${date}T12:00:00Z`));

  if (!slots.length) {
    // Don't dead-end on a full or closed day — name the real alternatives in the same breath.
    const why = openWindow(cfg, date) ? "we're full" : "we're closed";
    const fallback = await nextAvailableSlots(pinned.companyId, cfg, date, mins, 7, 3);
    if (!fallback.length) {
      return `${why} ${dayName}, and nothing else is open this week. Offer an advisor callback.`;
    }
    return `${dayName}: ${why}. Next available: ` +
      `${fallback.flatMap((d) => d.slots.map((s) => s.label)).slice(0, 3).join(", ")}. ` +
      `Tell them ${why} then, and offer these.`;
  }
  // Two or three read naturally aloud; a list of six does not.
  // If the caller named a time, answer THAT question first — telling them "we have 7, 7:30 or 8"
  // when they asked about 10 and 10 is free is worse than useless.
  const asked = String(args.time ?? "").trim();
  const fmt = (d: Date) => new Intl.DateTimeFormat("en-US",
    { timeZone: cfg.timezone, hour: "numeric", minute: "2-digit" }).format(d);

  if (asked) {
    // Match on minutes-since-midnight, not on the formatted label. The caller says "11am",
    // "11", "11:00" — exact string equality against "11:00 AM" fails all three and reports a
    // free slot as unavailable.
    const parseAsked = (t: string): number | null => {
      const m = t.toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
      if (!m) return null;
      let h = Number(m[1]);
      const min = Number(m[2] ?? 0);
      const mer = m[3];
      if (mer === "pm" && h < 12) h += 12;
      if (mer === "am" && h === 12) h = 0;
      // No am/pm: a service department running 7-6 means "3" is 3 PM, not 3 AM.
      if (!mer && h < 7) h += 12;
      return h * 60 + min;
    };
    const wantedMin = parseAsked(asked);
    const slotMin = (d: Date) => {
      const parts = new Intl.DateTimeFormat("en-US", { timeZone: cfg.timezone, hour: "2-digit", minute: "2-digit", hour12: false })
        .formatToParts(d).reduce((a: any, x) => (a[x.type] = x.value, a), {});
      return (Number(parts.hour) % 24) * 60 + Number(parts.minute);
    };
    const wanted = wantedMin == null ? undefined : slots.find((sl) => slotMin(sl.startsAt) === wantedMin);
    if (wanted) {
      return `${dayName} at ${fmt(wanted.startsAt)} is OPEN — offer it and book it. ` +
        `Pass starts_at "${wanted.startsAt.toISOString()}" to book_service.`;
    }
    const near = slots.slice(0, 3).map((sl) => fmt(sl.startsAt));
    return `${dayName} at ${asked} is NOT available. Nearest open: ${near.join(", ")}. ` +
      `Offer those.`;
  }

  const times = slots.slice(0, 4).map((sl) => fmt(sl.startsAt));
  return `${dayName} is the date — say exactly that, don't recalculate it. ` +
    `${slots.length} slots open, earliest: ${times.join(", ")}. Offer two or three. ` +
    `If they ask about a specific time, call check_availability again with that time to check it.`;
}

/** The caller's upcoming visits, so they can ask about, change, or cancel one. */
async function listAppointments(pinned: PinnedCall): Promise<string> {
  if (!pinned.customerId) return ANON_REFUSAL;

  // Same loader the call context uses, so this tool and the prompt can never disagree about
  // what's on the books — and it already filters out past visits and formats in the
  // dealership's timezone rather than the server's UTC.
  const cfg = await loadShopConfig(pinned.companyId);
  const upcoming = await loadUpcomingAppointments(pinned.companyId, pinned.customerId, cfg.timezone);

  if (!upcoming.length) return "They have no upcoming appointments on file.";

  return upcoming.map((a) =>
    `- id=${a.id} · ${a.when} · ${a.vehicle}` +
    (a.ops.length ? ` · ${a.ops.join(", ")}` : "") +
    (a.unscheduled ? " (no firm time yet)" : "")
  ).join("\n");
}

/**
 * Cancel one of the caller's appointments.
 *
 * appointment_id is accepted from the model, so it is validated against THIS caller — otherwise a
 * hallucinated or guessed id could cancel a stranger's visit.
 */
async function cancelAppointment(args: any, pinned: PinnedCall): Promise<string> {
  if (!pinned.customerId) return ANON_REFUSAL;

  const id = String(args.appointment_id ?? "").trim();
  if (!id) return "Call list_appointments first, then cancel by id.";

  const { data: appt } = await supabaseAdmin
    .from("appointments")
    .select("id, customer_id, status, preferred_time, starts_at")
    .eq("id", id).eq("customer_id", pinned.customerId).maybeSingle();

  if (!appt) return "That appointment isn't on this caller's account — read back what you found " +
    "from list_appointments and ask which one they mean.";
  if (appt.status === "canceled") return "That one is already canceled.";

  const { error } = await supabaseAdmin.from("appointments").update({
    status: "canceled",
    canceled_at: new Date().toISOString(),
    cancel_reason: args.reason ? String(args.reason).slice(0, 300) : "canceled by caller",
  }).eq("id", id).eq("customer_id", pinned.customerId);
  if (error) return "Couldn't cancel that — offer to transfer them to the service team.";

  // The advisor queue is how a soft-booked appointment gets placed in myKaarma; a cancellation
  // has to reach the same people, or they'd hold a slot the customer no longer wants.
  await supabaseAdmin.from("handoff_requests").insert({
    company_id: pinned.companyId,
    call_id: pinned.callId,
    customer_id: pinned.customerId,
    caller_number: pinned.callerNumber,
    reason: "other",
    notes: `CANCELED: appointment ${appt.preferred_time ?? appt.starts_at ?? ""}`.trim(),
    transferred: true,
    status: "open",
  });

  const when = appt.starts_at ? new Date(appt.starts_at).toLocaleString() : appt.preferred_time;
  return `Canceled${when ? ` the ${when} appointment` : ""}. Confirm it's canceled and ask if ` +
    `they'd like to rebook for another time.`;
}

/**
 * Record the handoff (§16b). This does NOT move the call — returning a JSON "transfer" blob as a
 * tool result only puts text in front of the model, which is exactly how a caller ends up hearing
 * "connecting you now" and then silence. Vapi's native transferCall tool performs the leg change;
 * this writes the row that makes the caller recoverable if the transfer never connects.
 */
async function logHandoff(args: any, pinned: PinnedCall): Promise<string> {
  const reason = String(args.reason ?? "other");
  const allowed = ["where_is_my_car", "pricing", "complaint", "requested_human", "out_of_scope", "other"];

  const { data: company } = await supabaseAdmin
    .from("companies").select("settings").eq("id", pinned.companyId).single();
  const transferNumber = ((company?.settings ?? {}) as any)?.inbound?.transfer_number ?? null;

  await supabaseAdmin.from("handoff_requests").insert({
    company_id: pinned.companyId,
    call_id: pinned.callId,
    customer_id: pinned.customerId,
    caller_number: pinned.callerNumber,
    reason: allowed.includes(reason) ? reason : "other",
    vehicle_hint: args.vehicle_hint ? String(args.vehicle_hint) : null,
    notes: args.notes ? String(args.notes) : null,
    // Whether we ATTEMPTED a transfer. Whether one actually connected is only known at
    // end-of-call, from Vapi's endedReason — see calls/events.ts, which resolves the row then.
    transferred: !!transferNumber,
  });

  if (!transferNumber) {
    // No destination configured — fall back to taking a message rather than dropping them.
    return "No transfer line is configured. Take their name, callback number, and what they need, " +
      "tell them the service team will call them right back, then end the call politely.";
  }

  // Tell the model to actually perform the transfer. Returning a control blob here would do
  // nothing — only the native transferCall tool moves the call.
  return "Handoff recorded. Now call the transferCall tool to connect them.";
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Resolve the pinned identity for a Vapi call id — the server-side source of truth. */
async function resolvePinnedCall(vapiCallId: string | null): Promise<PinnedCall | null> {
  if (!vapiCallId) return null;
  const { data } = await supabaseAdmin
    .from("calls").select("id, company_id, customer_id, from_number")
    .eq("vapi_call_id", vapiCallId).eq("direction", "inbound").maybeSingle();
  if (!data) return null;
  return {
    callId: data.id,
    companyId: data.company_id,
    customerId: data.customer_id,
    callerNumber: data.from_number,
  };
}

async function companyVoice(companyId: string): Promise<{ provider: string; voice_id: string }> {
  const { data } = await supabaseAdmin.from("companies").select("settings").eq("id", companyId).single();
  const settings = (data?.settings ?? {}) as any;

  // A dealership can explicitly opt into Vapi's built-in voice by storing
  // { provider: "vapi" }. That must WIN over the env default — otherwise `??` falls straight
  // through to DEFAULT_TTS_PROVIDER and "use the built-in" is unreachable.
  const configured = settings.inbound?.voice ?? settings.voice;
  if (configured?.provider === "vapi") {
    return { provider: "vapi", voice_id: configured.voice_id || "Elliot" };
  }

  const voice = configured ?? {};
  return {
    provider: voice.provider ?? env.DEFAULT_TTS_PROVIDER,
    voice_id: voice.voice_id ?? env.DEFAULT_VOICE_ID,
  };
}

function parseArgs(raw: any): any {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try { return JSON.parse(raw); } catch { return {}; }
}

function toolError(tc: any, message: string) {
  return { toolCallId: tc?.id, result: message };
}
