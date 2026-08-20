"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiCall } from "@/lib/api";
import { isDemo } from "@/lib/supabase";
import { demoDirectory } from "@/lib/data";

export default function DirectoryPage() {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load on mount and re-run as the query changes: an empty box lists everyone alphabetically,
  // so the page is useful before you know who you're looking for.
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      setLoading(true); setError(null);
      try {
        if (isDemo) {
          const ql = q.trim().toLowerCase();
          const rows = ql
            ? demoDirectory.filter((r) => r.full_name.toLowerCase().includes(ql) ||
                (r.phone ?? "").includes(q) || (r.email ?? "").includes(ql))
            : [...demoDirectory].sort((a, b) => a.full_name.localeCompare(b.full_name));
          if (!cancelled) setResults(rows);
        } else {
          const { results } = await apiCall<{ results: any[] }>(
            `/agent/directory${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ""}`);
          if (!cancelled) setResults(results);
        }
      } catch (e: any) { if (!cancelled) setError(e.message); }
      finally { if (!cancelled) setLoading(false); }
    }, q ? 250 : 0);                       // debounce typing, but load immediately on mount
    return () => { cancelled = true; clearTimeout(t); };
  }, [q]);

  return (
    <div>
      <h1 className="page-title">Customer Directory</h1>
      <p className="page-sub">Look up any customer by phone, name, or VIN.</p>
      {isDemo && <div className="banner banner-warn" style={{ marginBottom: 16 }}>Demo data — try &quot;Maria&quot; or a phone number.</div>}

      <div className="row-between" style={{ marginBottom: 16, gap: 10 }}>
        <input style={{ flex: 1, maxWidth: 420 }} placeholder="Phone, name, or VIN…"
          value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="hint">
          {loading ? "Loading…" : `${results.length} customer${results.length === 1 ? "" : "s"}`}
          {!q && results.length >= 200 && " (first 200)"}
        </span>
      </div>

      {error && <div className="banner banner-error">{error}</div>}

      <div className="card">
          <table>
            <thead><tr><th>Name</th><th>Phone</th><th>Email</th><th>Type</th><th>Vehicles</th></tr></thead>
            <tbody>
              {results.map((r) => (
                <tr key={r.customer_id} className="rowlink" onClick={() => router.push(`/directory/${r.customer_id}`)}>
                  <td>{r.full_name}</td>
                  <td className="hint">{r.phone ?? "—"}</td>
                  <td className="hint">{r.email ?? "—"}</td>
                  <td>{r.customer_type ? <span className="chip chip-muted">{r.customer_type}</span> : "—"}</td>
                  <td className="hint">{r.vehicle_count}</td>
                </tr>
              ))}
              {results.length === 0 && !loading && (
                <tr><td colSpan={5} className="muted">
                  {q ? "No matches." : "No customers yet — import a CSV to get started."}
                </td></tr>
              )}
            </tbody>
        </table>
      </div>
    </div>
  );
}
