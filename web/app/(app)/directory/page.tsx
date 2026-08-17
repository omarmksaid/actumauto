"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiCall } from "@/lib/api";
import { isDemo } from "@/lib/supabase";
import { demoDirectory } from "@/lib/data";

export default function DirectoryPage() {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<any[]>([]);
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function search(e: React.FormEvent) {
    e.preventDefault();
    if (!q.trim()) return;
    setLoading(true); setError(null); setSearched(true);
    try {
      if (isDemo) {
        const ql = q.toLowerCase();
        setResults(demoDirectory.filter((r) =>
          r.full_name.toLowerCase().includes(ql) || (r.phone ?? "").includes(q) || (r.email ?? "").includes(ql)));
      } else {
        const { results } = await apiCall<{ results: any[] }>(`/agent/directory?q=${encodeURIComponent(q)}`);
        setResults(results);
      }
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }

  return (
    <div>
      <h1 className="page-title">Customer Directory</h1>
      <p className="page-sub">Look up any customer by phone, name, or VIN.</p>
      {isDemo && <div className="banner banner-warn" style={{ marginBottom: 16 }}>Demo data — try &quot;Maria&quot; or a phone number.</div>}

      <form onSubmit={search} style={{ display: "flex", gap: 10, marginBottom: 20 }}>
        <input style={{ flex: 1 }} placeholder="Phone, name, or VIN…" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn btn-primary" disabled={loading}>{loading ? "Searching…" : "Search"}</button>
      </form>

      {error && <div className="banner banner-error">{error}</div>}

      {searched && (
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
              {results.length === 0 && <tr><td colSpan={5} className="muted">No matches.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
