// Demo data — rendered when NEXT_PUBLIC_SUPABASE_URL is unset (isDemo), so the dashboard
// runs with zero config (PLAN.md §6). Each fetcher documents its real query in comments.

export interface ImportRow {
  id: string;
  filename: string;
  kind: "customers" | "ro";
  status: "parsing" | "mapped" | "importing" | "done" | "failed";
  row_count: number | null;
  stats: any;
  created_at: string;
}

export const demoImports: ImportRow[] = [
  {
    id: "demo-1",
    filename: "milpitas_toyota_service_customers_Q2.csv",
    kind: "customers",
    status: "done",
    row_count: 1042,
    stats: { customers_upserted: 1018, vehicles_upserted: 1042, skipped: 24, error_count: 24 },
    created_at: "2026-08-14T17:20:00Z",
  },
  {
    id: "demo-2",
    filename: "lapsed_owners_2023.csv",
    kind: "customers",
    status: "mapped",
    row_count: null,
    stats: {},
    created_at: "2026-08-16T09:05:00Z",
  },
];

// Real query (imports page):
//   apiCall("/imports")  → { imports: [...] }

// ── Today (inbound) ──  apiCall("/agent/funnel")
export const demoFunnel = {
  inbound: {
    calls_30d: 84, calls_today: 6, identified: 51, anonymous: 33, ambiguous: 7,
    identify_rate: 0.607, booked: 19, avg_duration_sec: 148, cost_usd_30d: 18.42,
  },
  appointments: { pending_confirmation: 12, confirmed: 9, shown: 7, no_show: 1 },
  handoffs: {
    total: 29, open: 11, needs_callback: 3,
    by_reason: { where_is_my_car: 14, pricing: 8, requested_human: 4, complaint: 2, out_of_scope: 1 },
  },
};

// ── Calls list ──  apiCall("/agent/calls")
export interface CallRow {
  id: string; vapi_call_id: string | null; duration_sec: number | null;
  outcome: string | null; cost_usd: number | null; created_at: string;
  /** Inbound calls have no touchpoint, and no customer when caller ID doesn't match (§16a). */
  from_number?: string | null;
  customers: { full_name: string; phone: string | null } | null;
}
export const demoCalls: CallRow[] = [
  { id: "c4", vapi_call_id: "v4", from_number: "+14085550142", duration_sec: 214, outcome: "booked", cost_usd: 0.41, created_at: "2026-08-17T15:42:00Z", customers: { full_name: "Maria Chen", phone: "+14085550142" } },
  { id: "c5", vapi_call_id: "v5", from_number: "+14085550177", duration_sec: 96, outcome: "answered", cost_usd: 0.19, created_at: "2026-08-17T15:20:00Z", customers: null },
  { id: "c6", vapi_call_id: "v6", from_number: "+14085550199", duration_sec: 61, outcome: "answered", cost_usd: 0.12, created_at: "2026-08-17T14:05:00Z", customers: { full_name: "Devon Park", phone: "+14085550199" } },
];


export const demoCallDetail = {
  call: { id: "c1", recording_url: null, duration_sec: 132, outcome: "booked", cost_usd: 0.29, created_at: "2026-08-16T16:10:00Z", customers: { full_name: "Maria Chen", phone: "+14085550142", email: "maria@example.com" } },
  transcript: [
    { role: "ai", content: "Hi Maria, this is a quick reminder from Milpitas Toyota service — your 2022 RAV4 is coming due for service. Is now an okay time?", ts: "2026-08-16T16:10:02Z" },
    { role: "customer", content: "Sure, what's it need?", ts: "2026-08-16T16:10:10Z" },
    { role: "ai", content: "It's due for an oil and filter change plus a tire rotation. I can note a preferred time and our team will text to confirm — what works for you?", ts: "2026-08-16T16:10:16Z" },
    { role: "customer", content: "Maybe Tuesday morning.", ts: "2026-08-16T16:10:24Z" },
    { role: "ai", content: "Got it — Tuesday morning. Our service team will text you shortly to confirm the exact time. Thanks Maria!", ts: "2026-08-16T16:10:30Z" },
  ],
};

// ── Directory ──  apiCall("/agent/directory?q=")  /  apiCall("/agent/customers/:id")
export const demoDirectory = [
  { customer_id: "cust1", full_name: "Maria Chen", phone: "+14085550142", email: "maria@example.com", customer_type: "loyal", vehicle_count: 2 },
  { customer_id: "cust2", full_name: "Devon Park", phone: "+14085550199", email: "devon@example.com", customer_type: "lapsed", vehicle_count: 1 },
];
// ── Team ──  apiCall("/team")
export const demoTeam = {
  members: [
    { user_id: "u1", email: "owner@milpitastoyota.com", role: "owner", phone: null },
    { user_id: "u2", email: "advisor.jen@milpitastoyota.com", role: "advisor", phone: "+14085550170" },
  ],
  invites: [
    { email: "newhire@milpitastoyota.com", role: "advisor", expires_at: "2026-08-23T00:00:00Z", accepted_at: null },
  ],
};

// ── Settings ──  apiCall("/settings")  /  apiCall("/settings/numbers")
export const demoSettings = {
  company: { name: "Milpitas Toyota", timezone: "America/Los_Angeles" },
  voice: { provider: "cartesia", voice_id: "sonic-english" },
  persona_prompt: "You are the service department's phone assistant for Milpitas Toyota. Warm, efficient, and respectful of the caller's time.",
  customer_types: ["loyal", "lapsed", "new", "vip"],
};

export const demoNumbers = [
  { id: "n1", e164: "+14085550100", provider: "telnyx", vapi_phone_id: "vp_123", cnam: "Milpitas Toyota", enabled: true },
  { id: "n2", e164: "+14085550101", provider: "telnyx", vapi_phone_id: null, cnam: "Milpitas Toyota", enabled: false },
];


export const demoCustomer = {
  customer: { id: "cust1", full_name: "Maria Chen", phone: "+14085550142", email: "maria@example.com", customer_type: "loyal", tags: ["repeat", "prefers-text"], detected_language: "en", personality: { summary: "Friendly, direct, values quick answers. Prefers texts over calls." }, notes: "", opted_out: false, do_not_contact: false },
  vehicles: [
    { id: "v1", make: "Toyota", model: "RAV4", year: 2022, mileage: 31200, mileage_as_of: "2026-06-16", avg_miles_per_day: 38, last_service_on: "2026-03-16", vin: "JTMB1234500000001", trim: "XLE" },
    { id: "v2", make: "Toyota", model: "Sienna", year: 2019, mileage: 74050, mileage_as_of: "2026-05-01", avg_miles_per_day: 41, last_service_on: "2025-12-02", vin: "5TDY1234500000002", trim: "LE" },
  ],
  recentCalls: [{ id: "c1", outcome: "booked", duration_sec: 132, created_at: "2026-08-16T16:10:00Z" }],
  appointments: [{ id: "a1", status: "pending_confirmation", starts_at: null, preferred_time: "Tuesday morning", created_at: "2026-08-16T16:10:00Z" }],
};

// ── Inbound service line (§16) ──────────────────────────────────────────────

// apiCall("/agent/handoffs")
export interface HandoffRow {
  id: string;
  call_id: string | null;
  customer_id: string | null;
  caller_number: string | null;
  reason: string;
  vehicle_hint: string | null;
  notes: string | null;
  transferred: boolean;
  status: "open" | "resolved";
  created_at: string;
  customers: { full_name: string; phone: string | null } | null;
}
export const demoHandoffs: HandoffRow[] = [
  { id: "h1", call_id: "c1", customer_id: "cust1", caller_number: "+14085550142", reason: "where_is_my_car", vehicle_hint: "silver RAV4", notes: "Dropped off Tuesday, asking if it's ready.", transferred: true, status: "open", created_at: "2026-08-17T15:42:00Z", customers: { full_name: "Maria Chen", phone: "+14085550142" } },
  { id: "h2", call_id: "c4", customer_id: null, caller_number: "+14085550177", reason: "pricing", vehicle_hint: "2018 Camry", notes: "Wants a quote on front brakes.", transferred: false, status: "open", created_at: "2026-08-17T15:20:00Z", customers: null },
  { id: "h3", call_id: "c5", customer_id: "cust2", caller_number: "+14085550199", reason: "requested_human", vehicle_hint: null, notes: "Asked for their advisor by name.", transferred: true, status: "open", created_at: "2026-08-17T14:05:00Z", customers: { full_name: "Devon Park", phone: "+14085550199" } },
  { id: "h4", call_id: "c6", customer_id: null, caller_number: "+14085550163", reason: "complaint", vehicle_hint: null, notes: "Unhappy with last visit.", transferred: false, status: "open", created_at: "2026-08-17T11:31:00Z", customers: null },
];

// apiCall("/settings/services")
export interface ServiceOffering {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  operations: string[];
  typical_duration_min: number | null;
  active: boolean;
}
export const demoServices: ServiceOffering[] = [
  { id: "s1", name: "Oil & filter change", description: "Full synthetic oil and filter replacement with a multi-point inspection.", category: "maintenance", operations: ["LOF"], typical_duration_min: 45, active: true },
  { id: "s2", name: "Tire rotation & balance", description: "Rotate and balance all four tires, set pressures.", category: "tires", operations: ["ROT", "BAL"], typical_duration_min: 40, active: true },
  { id: "s3", name: "Brake pad replacement", description: "Front or rear pad replacement with rotor inspection.", category: "repair", operations: ["BRK-F", "BRK-R"], typical_duration_min: 120, active: true },
  { id: "s4", name: "Wheel alignment", description: "Four-wheel alignment to factory spec.", category: "repair", operations: ["ALN"], typical_duration_min: 90, active: true },
  { id: "s5", name: "Multi-point inspection", description: "Complimentary inspection of brakes, fluids, belts, and tires.", category: "inspection", operations: ["MPI"], typical_duration_min: 30, active: true },
  { id: "s6", name: "Cabin & engine air filter", description: "Replace cabin and engine air filters.", category: "maintenance", operations: ["CAF", "EAF"], typical_duration_min: 25, active: true },
];

export const demoInboundSettings = {
  transfer_number: "+14085550100",
  identify_mode: "caller_id_only" as const,
  greeting: "",
  persona_prompt: "",
  voice: null,
};

// ── Service schedules ──  apiCall("/schedules")
export interface ScheduleInterval {
  id: string;
  mileage: number | null;
  months: number | null;
  service_name: string;
  operations: string[];
  severity: string;
}
export interface ScheduleRow {
  id: string;
  make: string;
  model: string | null;
  year_from: number | null;
  year_to: number | null;
  source: string | null;
  notes: string | null;
  is_global: boolean;
  intervals: ScheduleInterval[];
}
export const demoSchedules: ScheduleRow[] = [
  {
    id: "sch1", make: "Toyota", model: null, year_from: null, year_to: null,
    source: "Public Toyota maintenance-schedule references (compiled)",
    notes: "APPROXIMATE — verify with dealer. Applies to most gas Toyota models on the normal schedule.",
    is_global: true,
    intervals: [
      { id: "i1", mileage: 5000, months: 6, service_name: "Oil & filter, tire rotation, multi-point inspection", operations: ["oil_change", "tire_rotation", "multipoint_inspection"], severity: "standard" },
      { id: "i2", mileage: 10000, months: 12, service_name: "Oil & filter, tire rotation, inspect brakes & fluids", operations: ["oil_change", "tire_rotation", "brake_inspection", "fluid_check"], severity: "standard" },
      { id: "i3", mileage: 15000, months: 18, service_name: "Oil & filter, tire rotation, cabin/engine air filter check", operations: ["oil_change", "tire_rotation", "air_filter_check"], severity: "standard" },
      { id: "i4", mileage: 30000, months: 36, service_name: "Major service: fluids, filters, brakes, drivetrain inspection", operations: ["oil_change", "brake_service", "transmission_check", "coolant_check"], severity: "major" },
      { id: "i5", mileage: 60000, months: 72, service_name: "Major service: spark plugs, drive belts, coolant, brake fluid", operations: ["spark_plugs", "drive_belts", "coolant_flush", "brake_fluid"], severity: "major" },
      { id: "i6", mileage: 90000, months: 108, service_name: "Major service: 90k inspection, plugs, fluids, timing components", operations: ["spark_plugs", "coolant_flush", "transmission_service", "inspection"], severity: "major" },
    ],
  },
];
