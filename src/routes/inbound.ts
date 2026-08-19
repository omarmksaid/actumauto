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
import { resolveInboundContext, loadVehiclesWithDue, InboundContext } from "../inbound/identify";
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
  customerId: string | null;   // null ⇒ anonymous: customer tools MUST refuse
  callerNumber: string | null;
}

async function runTool(name: string, args: any, pinned: PinnedCall): Promise<string> {
  switch (name) {
    case "lookup_services":   return await lookupServices(args.query ?? "", pinned);
    case "get_my_vehicles":   return await getMyVehicles(pinned);
    case "get_due_service":   return await getDueService(pinned);
    case "book_service":      return await bookService(args, pinned);
    case "log_handoff":         return await logHandoff(args, pinned);
    // Older name kept so a call already in flight during a deploy doesn't break.
    case "transfer_to_service": return await logHandoff(args, pinned);
    default:                  return "That isn't something I can do.";
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
  let q = supabaseAdmin
    .from("service_offerings")
    .select("name, description, category, typical_duration_min")
    .eq("company_id", pinned.companyId).eq("active", true);

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
    let score = 0;
    for (const w of stems) {
      const inName = new RegExp(`\\b${w}`).test(name);          // word-start in the NAME
      const inDesc = new RegExp(`\\b${w}`).test((o.description ?? "").toLowerCase());
      if (inName) score += 10;
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

async function bookService(args: any, pinned: PinnedCall): Promise<string> {
  if (!pinned.customerId) return ANON_REFUSAL;

  const preferredTime = String(args.preferred_time ?? "").trim();
  if (!preferredTime) return "Ask the caller what day and time works for them first.";

  // Hours are also in the prompt, but a prompt rule is guidance, not a guarantee: capturing
  // "tomorrow at 9 PM" for a shop that shuts at 6 creates a promise someone has to walk back.
  const outOfHours = await checkHours(pinned.companyId, preferredTime);
  if (outOfHours) return outOfHours;

  // vehicle_id is the ONLY id we accept from the model — so validate it belongs to this caller.
  let vehicleId: string | null = null;
  const vehicles = await loadVehiclesWithDue(pinned.companyId, pinned.customerId, todayIso());
  if (args.vehicle_id) {
    const match = vehicles.find((v) => v.id === args.vehicle_id);
    if (!match) return "That vehicle isn't on this caller's account — ask which of their cars they mean.";
    vehicleId = match.id;
  } else if (vehicles.length === 1) {
    vehicleId = vehicles[0].id;
  } else if (vehicles.length > 1) {
    return "This caller has more than one vehicle — ask which one, then call book_service with its id.";
  }

  const booking = getBookingProvider();
  const result = await booking.createAppointment({
    companyId: pinned.companyId,
    customerId: pinned.customerId,
    vehicleId,
    preferredTime,
    serviceOps: Array.isArray(args.service_ops) ? args.service_ops.map(String) : [],
    notes: [String(args.notes ?? "").trim(), "(booked on inbound call)"].filter(Boolean).join(" "),
  });

  // Mode-gated wording: in soft mode this promises a confirmation, never a firm slot (§2).
  return result.confirmationText;
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
