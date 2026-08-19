/**
 * Inbound caller identification (PLAN.md §16a).
 *
 * Caller-ID-only matching, per the chosen `caller_id_only` mode. The rule that matters:
 * ZERO matches and MULTIPLE matches BOTH produce an anonymous call. A shared household or work
 * number must never cause the agent to read the wrong person's vehicle history — so ambiguity
 * resolves to "tell them nothing", not "pick the first row".
 *
 * An anonymous call carries no customer-specific data at all: not in the prompt (§16a) and not
 * reachable through the tools (§16e), because every tool resolves identity from the pinned
 * server-side context rather than from anything the model says.
 */

import { supabaseAdmin } from "../lib/supabase";
import { computeDue, DueResult, VehicleForDue } from "../scheduling/due";
import { loadIntervalsForVehicle } from "../scheduling/schedules";

/** How far ahead we consider service "coming up" when recommending on an inbound call. */
export const INBOUND_DUE_HORIZON_DAYS = 45;

export type IdentifyMode = "caller_id_only" | "verbal_verify";

export interface InboundVehicle {
  id: string;
  make: string;
  model: string;
  year: number;
  vin: string | null;
  mileage: number | null;
  /** Null when nothing is due within the horizon. */
  due: { service: string; dueOn: string; reason: "mileage" | "months"; projectedMileage: number } | null;
}

export interface InboundContext {
  companyId: string;
  companyName: string;
  timezone: string;
  /** null ⇒ anonymous: the agent may answer generic questions ONLY. */
  customerId: string | null;
  customerName: string | null;
  customerLanguage: string | null;
  vehicles: InboundVehicle[];
  offerings: { name: string; description: string | null; category: string | null; typical_duration_min: number | null }[];
  transferNumber: string | null;
  greeting: string | null;
  personaTemplate: string | null;
  identifyMode: IdentifyMode;
  /** false ⇒ kill switch is on: greet briefly and hand to a human, don't converse. */
  agentEnabled: boolean;
  /** Opening hours per weekday, dealership-local. null for a day means closed. */
  businessHours: Record<string, [string, string] | null>;
  /** Today, in the dealership's timezone — the agent can't resolve "tomorrow" without it. */
  todayLabel: string;
  /** Diagnostics: how many customers matched the caller ID (0, 1, or >1 ⇒ ambiguous). */
  matchCount: number;
}

/**
 * Resolve everything an inbound call needs, from just the two phone numbers Vapi gives us.
 * `toNumber` (the dialed pool number) determines the dealership — never trust a company id
 * from the request body (§8 invariant 1).
 */
export async function resolveInboundContext(
  toNumber: string,
  fromNumber: string | null,
  todayIso: string
): Promise<InboundContext | null> {
  const { data: match } = await supabaseAdmin
    .rpc("identify_inbound_caller", { p_to_number: toNumber, p_from_number: fromNumber })
    .maybeSingle();

  const row = match as { company_id: string; customer_id: string | null; match_count: number } | null;
  if (!row?.company_id) return null; // number isn't ours — caller handles the fallback

  const companyId = row.company_id;

  const [{ data: company }, { data: offerings }] = await Promise.all([
    supabaseAdmin.from("companies").select("name, timezone, settings, agent_enabled, business_hours").eq("id", companyId).single(),
    supabaseAdmin.from("service_offerings")
      .select("name, description, category, typical_duration_min")
      .eq("company_id", companyId).eq("active", true).order("category"),
  ]);

  const settings = (company?.settings ?? {}) as any;
  const inbound = settings.inbound ?? {};

  const ctx: InboundContext = {
    companyId,
    companyName: company?.name ?? "the dealership",
    timezone: company?.timezone ?? "America/Los_Angeles",
    customerId: null,
    customerName: null,
    customerLanguage: null,
    vehicles: [],
    offerings: offerings ?? [],
    transferNumber: inbound.transfer_number ?? null,
    greeting: inbound.greeting ?? null,
    personaTemplate: inbound.persona_prompt ?? null,
    identifyMode: (inbound.identify_mode as IdentifyMode) ?? "caller_id_only",
    agentEnabled: company?.agent_enabled !== false,
    businessHours: (company?.business_hours ?? {}) as Record<string, [string, string] | null>,
    todayLabel: new Date().toLocaleDateString("en-US", {
      weekday: "long", month: "long", day: "numeric", year: "numeric",
      timeZone: company?.timezone ?? "America/Los_Angeles",
    }),
    matchCount: Number(row.match_count ?? 0),
  };

  // Kill switch on, or anonymous: return WITHOUT loading customer data. Nothing
  // customer-specific can reach the prompt or the tools, because it was never fetched.
  if (!ctx.agentEnabled || !row.customer_id) return ctx;

  const { data: customer } = await supabaseAdmin
    .from("customers")
    .select("id, full_name, detected_language, opted_out, do_not_contact")
    .eq("id", row.customer_id).eq("company_id", companyId).maybeSingle();
  if (!customer) return ctx;

  ctx.customerId = customer.id;
  ctx.customerName = customer.full_name;
  ctx.customerLanguage = customer.detected_language;
  ctx.vehicles = await loadVehiclesWithDue(companyId, customer.id, todayIso);

  return ctx;
}

/**
 * A customer's vehicles plus what's coming due on each — the same `computeDue` engine the
 * outbound slotter uses (§4), called live instead of on a cron (§16d).
 */
export async function loadVehiclesWithDue(
  companyId: string,
  customerId: string,
  todayIso: string
): Promise<InboundVehicle[]> {
  const { data: vehicles } = await supabaseAdmin
    .from("vehicles")
    .select("id, make, model, year, vin, sold_on, mileage, mileage_as_of, last_service_on, mileage_at_last_service, avg_miles_per_day")
    .eq("customer_id", customerId).eq("company_id", companyId);

  const out: InboundVehicle[] = [];
  for (const v of (vehicles ?? []) as (VehicleForDue & { vin: string | null })[]) {
    let due: DueResult | null = null;
    try {
      const intervals = await loadIntervalsForVehicle(companyId, v);
      due = computeDue(v, intervals, todayIso, INBOUND_DUE_HORIZON_DAYS);
    } catch {
      due = null; // a missing schedule must not break the call — we just don't recommend
    }
    out.push({
      id: v.id,
      make: v.make,
      model: v.model,
      year: v.year,
      vin: v.vin ?? null,
      mileage: v.mileage ?? null,
      due: due
        ? {
            service: due.interval.service_name,
            dueOn: due.dueOn,
            reason: due.reason,
            projectedMileage: due.projectedMileage,
          }
        : null,
    });
  }
  return out;
}
