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
  range: "1d",
  inbound: {
    calls: 18, identified: 12, anonymous: 6, ambiguous: 1,
    identify_rate: 0.667, booked: 5, avg_duration_sec: 74,
    cost_usd: 1.53, cost_per_call: 0.085,
  },
  volume: Array.from({ length: 24 }, (_, h) => ({
    label: String(h).padStart(2, "0"),
    count: h < 7 || h > 18 ? 0 : [1, 2, 3, 2, 4, 1, 2, 3, 1, 0, 1, 2][h - 7] ?? 0,
  })),
  appointments: { pending_confirmation: 5, confirmed: 3, shown: 2, no_show: 1 },
  handoffs: {
    total: 7, open: 2, oldest_open_min: 12, needs_callback: 1, failed_transfers: 1,
    by_reason: { where_is_my_car: 3, pricing: 2, requested_human: 1, complaint: 1 },
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
export const demoCalls: any[] = [
  { id: "c1", name: "Omar Said", phone: "+16283587659", status: "answered", detail: null, duration_sec: 5, cost_usd: 0.01, has_recording: true, attempts: 1, created_at: new Date(Date.now() - 3600_000).toISOString() },
  { id: "c2", name: "Omar Said", phone: "+16283587659", status: "missed", detail: "hung up <2s", duration_sec: 0, cost_usd: null, has_recording: false, attempts: 4, attempt_span_min: 3, created_at: new Date(Date.now() - 7200_000).toISOString() },
  { id: "c3", name: "Omar Said", phone: "+16283587659", status: "handed off", detail: "pricing", duration_sec: 53, cost_usd: 0.06, has_recording: true, attempts: 1, created_at: new Date(Date.now() - 10800_000).toISOString() },
  { id: "c4", name: null, phone: "+14155551234", status: "missed", detail: "no connect", duration_sec: 0, cost_usd: null, has_recording: false, attempts: 1, created_at: new Date(Date.now() - 90000_000).toISOString() },
  { id: "c5", name: "Devon Park", phone: "+14085550199", status: "booked", detail: null, duration_sec: 132, cost_usd: 0.14, has_recording: true, attempts: 1, created_at: new Date(Date.now() - 95000_000).toISOString() },
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
export const demoDirectory: any[] = [
  { customer_id: "cust1", full_name: "Maria Chen", phone: "+14085550142", email: "maria@example.com",
    customer_type: "loyal", vehicle_count: 2,
    vehicles: [
      { id: "v1", year: 2022, make: "Toyota", model: "RAV4", mileage: 31200 },
      { id: "v2", year: 2019, make: "Toyota", model: "Sienna", mileage: 74050 },
    ] },
  { customer_id: "cust2", full_name: "Devon Park", phone: "+14085550199", email: "devon@example.com",
    customer_type: "lapsed", vehicle_count: 1,
    vehicles: [{ id: "v3", year: 2020, make: "Toyota", model: "Camry", mileage: 48900 }] },
  { customer_id: "cust3", full_name: "Priya Nair", phone: "+14085550188", email: null,
    customer_type: null, vehicle_count: 0, vehicles: [] },
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
  agent_enabled: true,
  business_hours: {
    mon: ["07:00", "18:00"], tue: ["07:00", "18:00"], wed: ["07:00", "18:00"],
    thu: ["07:00", "18:00"], fri: ["07:00", "18:00"], sat: ["08:00", "16:00"], sun: null,
  },
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
  aliases?: string[];
}
export const demoServices: ServiceOffering[] = [
  { id: "s1", name: "Oil & filter change", description: "Full synthetic oil and filter replacement with a multi-point inspection.", category: "maintenance", operations: ["LOF"], typical_duration_min: 45, active: true, aliases: ["oil change", "LOF"] },
  { id: "s2", name: "Tire rotation & balance", description: "Rotate and balance all four tires, set pressures.", category: "tires", operations: ["ROT", "BAL"], typical_duration_min: 40, active: true },
  { id: "s3", name: "Brake pad replacement", description: "Front or rear pad replacement with rotor inspection.", category: "repair", operations: ["BRK-F", "BRK-R"], typical_duration_min: 120, active: true, aliases: ["squeaking", "grinding", "brake job"] },
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
