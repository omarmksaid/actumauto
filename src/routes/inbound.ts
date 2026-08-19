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
    case "transfer_to_service": return await transferToService(args, pinned);
    default:                  return "That isn't something I can do.";
  }
}

/** Words that would match everything and drown the real signal. */
const STOPWORDS = new Set([
  "the", "and", "for", "you", "your", "our", "any", "can", "does", "did", "with", "about",
  "have", "has", "get", "got", "need", "want", "please", "service", "car", "vehicle",
]);

/** The anonymous refusal. Server-side, so prompt wording is not the only thing protecting this. */
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
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
    .map((w) => w.replace(/(ies|es|s)$/, ""))        // brakes→brake, batteries→batter
    .filter((w) => w.length >= 3)
    .slice(0, 6);

  if (stems.length) {
    q = q.or(stems.flatMap((w) =>
      [`name.ilike.%${w}%`, `description.ilike.%${w}%`, `category.ilike.%${w}%`]).join(","));
  }

  const { data } = await q.limit(15);
  if (!data?.length) {
    return `Nothing in our service catalog matches "${term}". Don't guess — tell the caller you'll ` +
      `check with the service team, and offer to transfer.`;
  }
  return data.map((o) =>
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
    touchpointId: null,                          // inbound: no scheduled work behind this call (§16e)
    preferredTime,
    serviceOps: Array.isArray(args.service_ops) ? args.service_ops.map(String) : [],
    notes: [String(args.notes ?? "").trim(), "(booked on inbound call)"].filter(Boolean).join(" "),
  });

  // Mode-gated wording: in soft mode this promises a confirmation, never a firm slot (§2).
  return result.confirmationText;
}

/**
 * Transfer to the service line (§16b).
 *
 * Always writes a handoff_requests row BEFORE transferring, so the caller is recoverable even if
 * the transfer doesn't connect — "should pick up" is an expectation, not a guarantee.
 */
async function transferToService(args: any, pinned: PinnedCall): Promise<string> {
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

  // Vapi performs the actual transfer from this control instruction.
  return JSON.stringify({
    action: "transfer",
    destination: { type: "number", number: transferNumber, message: "Connecting you to our service team now." },
  });
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
  if (configured?.provider === "vapi") return { provider: "vapi", voice_id: "" };

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
