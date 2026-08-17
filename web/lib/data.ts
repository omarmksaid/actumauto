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
