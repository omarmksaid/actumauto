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

// ── Funnel (Today) ──  apiCall("/agent/funnel")
export const demoFunnel = {
  funnel: {
    slotted: 214, in_flight: 6, called: 388, answered: 171, booked: 92,
    declined: 54, no_answer: 121, voicemail: 46, spam_or_error: 9,
  },
  appointments: { pending_confirmation: 31, confirmed: 48, shown: 37, no_show: 6 },
  numbers: [
    { e164: "+14085550110", enabled: true, answer_rate_7d: 0.44, health_score: 0.9, quarantined_at: null, sent_today: 180, daily_cap: 400 },
    { e164: "+14085550111", enabled: true, answer_rate_7d: 0.29, health_score: 0.6, quarantined_at: null, sent_today: 210, daily_cap: 400 },
  ],
};

// ── Calls list ──  apiCall("/agent/calls")
export interface CallRow {
  id: string; vapi_call_id: string | null; duration_sec: number | null;
  outcome: string | null; cost_usd: number | null; created_at: string;
  customers: { full_name: string; phone: string | null } | null;
}
export const demoCalls: CallRow[] = [
  { id: "c1", vapi_call_id: "v1", duration_sec: 132, outcome: "booked", cost_usd: 0.29, created_at: "2026-08-16T16:10:00Z", customers: { full_name: "Maria Chen", phone: "+14085550142" } },
  { id: "c2", vapi_call_id: "v2", duration_sec: 41, outcome: "declined", cost_usd: 0.09, created_at: "2026-08-16T16:02:00Z", customers: { full_name: "Devon Park", phone: "+14085550199" } },
  { id: "c3", vapi_call_id: "v3", duration_sec: 0, outcome: "no_answer", cost_usd: 0.02, created_at: "2026-08-16T15:50:00Z", customers: { full_name: "Priya Nair", phone: "+14085550188" } },
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
export const demoCustomer = {
  customer: { id: "cust1", full_name: "Maria Chen", phone: "+14085550142", email: "maria@example.com", customer_type: "loyal", tags: ["repeat", "prefers-text"], detected_language: "en", personality: { summary: "Friendly, direct, values quick answers. Prefers texts over calls." }, notes: "", opted_out: false, do_not_contact: false },
  vehicles: [
    { id: "v1", make: "Toyota", model: "RAV4", year: 2022, mileage: 31200, mileage_as_of: "2026-06-16", avg_miles_per_day: 38, last_service_on: "2026-03-16", vin: "JTMB1234500000001", trim: "XLE" },
    { id: "v2", make: "Toyota", model: "Sienna", year: 2019, mileage: 74050, mileage_as_of: "2026-05-01", avg_miles_per_day: 41, last_service_on: "2025-12-02", vin: "5TDY1234500000002", trim: "LE" },
  ],
  recentCalls: [{ id: "c1", outcome: "booked", duration_sec: 132, created_at: "2026-08-16T16:10:00Z" }],
  recentMessages: [{ channel: "sms", direction: "outbound", content: "Hi Maria, your RAV4 is due for service…", created_at: "2026-08-10T18:00:00Z" }],
  appointments: [{ id: "a1", status: "pending_confirmation", starts_at: null, preferred_time: "Tuesday morning", created_at: "2026-08-16T16:10:00Z" }],
};
