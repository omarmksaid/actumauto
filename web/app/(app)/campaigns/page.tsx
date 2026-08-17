"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiCall } from "@/lib/api";
import { isDemo } from "@/lib/supabase";
import { demoCampaigns } from "@/lib/data";

const STATUS_CHIP: Record<string, string> = {
  active: "chip-ok", draft: "chip-muted", paused: "chip-warm", done: "chip-ai",
};

export default function CampaignsPage() {
  const router = useRouter();
  const [campaigns, setCampaigns] = useState<any[]>(isDemo ? demoCampaigns : []);
  const [imports, setImports] = useState<any[]>([]);
  const [loading, setLoading] = useState(!isDemo);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [importId, setImportId] = useState("");
  const [windowDays, setWindowDays] = useState(30);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    if (isDemo) return;
    try {
      const [{ campaigns }, { imports }] = await Promise.all([
        apiCall<{ campaigns: any[] }>("/campaigns"),
        apiCall<{ imports: any[] }>("/imports"),
      ]);
      setCampaigns(campaigns); setImports(imports.filter((i) => i.status === "done"));
    } catch (e: any) { setError(e.message); } finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!name) return;
    if (isDemo) { setCampaigns([{ id: `demo-${Date.now()}`, name, status: "draft", import_id: importId || null, pacing: { window_days: windowDays }, created_at: new Date().toISOString() }, ...campaigns]); setName(""); setCreating(false); return; }
    try {
      const { campaign } = await apiCall<{ campaign: any }>("/campaigns", {
        method: "POST", body: JSON.stringify({ name, import_id: importId || null, window_days: windowDays }),
      });
      setCampaigns([campaign, ...campaigns]); setName(""); setCreating(false);
    } catch (e: any) { setError(e.message); }
  }

  return (
    <div>
      <div className="row-between">
        <div>
          <h1 className="page-title">Campaigns</h1>
          <p className="page-sub">A service-reminder run. Launch one to slot calls for due vehicles.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setCreating(!creating)}>New campaign</button>
      </div>
      {isDemo && <div className="banner banner-warn" style={{ marginBottom: 16 }}>Demo data.</div>}
      {error && <div className="banner banner-error" style={{ marginBottom: 16 }}>{error}</div>}

      {creating && (
        <form onSubmit={create} className="card card-pad" style={{ marginBottom: 16, display: "grid", gap: 12 }}>
          <div className="grid-3">
            <label><div className="hint">Name</div><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Q3 lapsed owners" required /></label>
            <label><div className="hint">Source import (optional)</div>
              <select value={importId} onChange={(e) => setImportId(e.target.value)}>
                <option value="">All customers</option>
                {imports.map((i) => <option key={i.id} value={i.id}>{i.filename}</option>)}
              </select>
            </label>
            <label><div className="hint">Call window (days before due)</div><input type="number" value={windowDays} onChange={(e) => setWindowDays(parseInt(e.target.value, 10))} /></label>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button className="btn btn-primary" type="submit">Create</button>
            <button className="btn" type="button" onClick={() => setCreating(false)}>Cancel</button>
          </div>
        </form>
      )}

      <div className="card">
        {loading ? <div className="card-pad muted">Loading…</div> : (
          <table>
            <thead><tr><th>Name</th><th>Status</th><th>Slotted</th><th>Created</th></tr></thead>
            <tbody>
              {campaigns.map((cp) => (
                <tr key={cp.id} className="rowlink" onClick={() => router.push(`/campaigns/${cp.id}`)}>
                  <td>{cp.name}</td>
                  <td><span className={`chip ${STATUS_CHIP[cp.status] ?? "chip-muted"}`}>{cp.status}</span></td>
                  <td className="hint">{cp.pacing?.last_slot?.touchpointsCreated ?? "—"}</td>
                  <td className="hint">{new Date(cp.created_at).toLocaleDateString()}</td>
                </tr>
              ))}
              {campaigns.length === 0 && <tr><td colSpan={4} className="muted">No campaigns yet.</td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
