"use client";

/**
 * Customer Directory.
 *
 * Tiles rather than a table: a service advisor is usually looking up ONE person mid-call, and the
 * question is "is this them, and what do they drive?" — a name plus their cars, readable at a
 * glance. A table optimizes for scanning columns, which isn't the job here.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiCall } from "@/lib/api";
import { isDemo } from "@/lib/supabase";
import { demoDirectory } from "@/lib/data";

export default function Directory() {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      setLoading(true); setError(null);
      try {
        if (isDemo) {
          const ql = q.trim().toLowerCase();
          const rows = ql
            ? demoDirectory.filter((r: any) => r.full_name.toLowerCase().includes(ql) ||
                (r.phone ?? "").includes(q) || (r.email ?? "").includes(ql))
            : [...demoDirectory].sort((a: any, b: any) => a.full_name.localeCompare(b.full_name));
          if (!cancelled) setResults(rows);
        } else {
          const { results } = await apiCall<{ results: any[] }>(
            `/agent/directory${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ""}`);
          if (!cancelled) setResults(results);
        }
      } catch (e: any) { if (!cancelled) setError(e.message); }
      finally { if (!cancelled) setLoading(false); }
    }, q ? 250 : 0);                       // debounce typing; load immediately on mount
    return () => { cancelled = true; clearTimeout(t); };
  }, [q]);

  return (
    <div>
      <h1 className="page-title">Customer Directory</h1>
      <p className="page-sub">Look up any customer by phone, name, or VIN.</p>
      {isDemo && <div className="banner banner-warn" style={{ marginBottom: 16 }}>Demo data.</div>}

      <div className="row-between" style={{ marginBottom: 18, gap: 10 }}>
        <input style={{ flex: 1, maxWidth: 420 }} placeholder="Phone, name, or VIN…"
          value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="hint">
          {loading ? "Loading…" : `${results.length} customer${results.length === 1 ? "" : "s"}`}
          {!q && results.length >= 200 && " (first 200)"}
        </span>
      </div>

      {error && <div className="banner banner-error" style={{ marginBottom: 16 }}>{error}</div>}

      {!loading && results.length === 0 && (
        <div className="card card-pad muted">
          {q ? "No matches." : "No customers yet — import a CSV to get started."}
        </div>
      )}

      <div style={{
        display: "grid", gap: 14,
        gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
      }}>
        {results.map((r) => (
          <div key={r.customer_id} className="card card-pad rowlink"
            onClick={() => router.push(`/directory/${r.customer_id}`)}
            style={{ cursor: "pointer", display: "flex", flexDirection: "column", gap: 10 }}>

            <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
              <Avatar name={r.full_name} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 650, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {r.full_name}
                </div>
                <div className="hint">{fmtPhone(r.phone)}</div>
              </div>
              {r.customer_type && <span className="chip chip-muted">{r.customer_type}</span>}
            </div>

            {r.email && (
              <div className="hint" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {r.email}
              </div>
            )}

            <div style={{ borderTop: "1px solid var(--line)", paddingTop: 10, marginTop: "auto" }}>
              {(r.vehicles ?? []).length === 0 ? (
                <div className="hint">
                  {r.vehicle_count > 0 ? `${r.vehicle_count} vehicle(s)` : "No vehicle on file"}
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  {r.vehicles.map((v: any) => (
                    <div key={v.id} style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 13.5 }}>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {[v.year, v.make, v.model].filter(Boolean).join(" ")}
                      </span>
                      {v.mileage != null && (
                        <span className="hint" style={{ flexShrink: 0 }}>
                          {v.mileage.toLocaleString()} mi
                        </span>
                      )}
                    </div>
                  ))}
                  {/* Vehicles are capped server-side; say so rather than silently truncating. */}
                  {r.vehicle_count > r.vehicles.length && (
                    <div className="hint">+{r.vehicle_count - r.vehicles.length} more</div>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Avatar({ name }: { name: string }) {
  const initials = (name || "?").split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase();
  return (
    <div style={{
      width: 38, height: 38, borderRadius: "50%", flexShrink: 0,
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: 13, fontWeight: 700, background: "var(--accent-wash)", color: "var(--accent-deep)",
    }}>{initials}</div>
  );
}

const fmtPhone = (p: string | null) => {
  if (!p) return "No phone";
  const d = p.replace(/\D/g, "").slice(-10);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : p;
};
