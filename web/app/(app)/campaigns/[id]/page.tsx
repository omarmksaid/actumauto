"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { apiCall } from "@/lib/api";
import { isDemo } from "@/lib/supabase";
import { demoCampaignDetail } from "@/lib/data";

export default function CampaignDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<any>(isDemo ? demoCampaignDetail : null);
  const [loading, setLoading] = useState(!isDemo);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    if (isDemo) return;
    try { setData(await apiCall(`/campaigns/${id}`)); }
    catch (e: any) { setError(e.message); } finally { setLoading(false); }
  }
  useEffect(() => { load(); }, [id]);

  async function action(verb: "launch" | "pause") {
    if (isDemo) { setData({ ...data, campaign: { ...data.campaign, status: verb === "launch" ? "active" : "paused" } }); return; }
    setBusy(true); setError(null);
    try { await apiCall(`/campaigns/${id}/${verb}`, { method: "POST" }); await load(); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }

  if (loading) return <div className="muted">Loading…</div>;
  if (!data) return <div className="banner banner-error">{error ?? "Not found."}</div>;

  const { campaign, progress } = data;
  const windowDays = campaign.pacing?.window_days;

  return (
    <div>
      <Link href="/campaigns" className="hint">← Campaigns</Link>
      <div className="row-between" style={{ marginTop: 8 }}>
        <div>
          <h1 className="page-title">{campaign.name}</h1>
          <p className="page-sub">
            <span className={`chip ${campaign.status === "active" ? "chip-ok" : "chip-muted"}`}>{campaign.status}</span>
            {windowDays != null && <> · calls {windowDays} days before service is due</>}
          </p>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          {campaign.status !== "active"
            ? <button className="btn btn-primary" disabled={busy} onClick={() => action("launch")}>Launch</button>
            : <button className="btn" disabled={busy} onClick={() => action("pause")}>Pause</button>}
        </div>
      </div>
      {isDemo && <div className="banner banner-warn" style={{ marginBottom: 16 }}>Demo data.</div>}
      {error && <div className="banner banner-error" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="grid-3">
        <Stat n={progress.scheduled} label="Slotted" />
        <Stat n={progress.in_flight} label="In flight" />
        <Stat n={progress.completed} label="Completed" />
      </div>
      <div className="grid-3" style={{ marginTop: 16 }}>
        <Stat n={progress.booked} label="Booked" accent />
        <Stat n={progress.canceled} label="Canceled" />
        <Stat n={progress.total} label="Total touchpoints" />
      </div>

      {campaign.status === "draft" && (
        <div className="banner banner-warn" style={{ marginTop: 20 }}>
          This campaign hasn&apos;t been launched. Launching computes which vehicles are due and slots
          the calls (one per customer, covering all their due cars).
        </div>
      )}
    </div>
  );
}

function Stat({ n, label, accent }: { n: number; label: string; accent?: boolean }) {
  return (
    <div className="card stat">
      <b style={{ color: accent ? "var(--accent-deep)" : undefined }}>{n}</b>
      <span>{label}</span>
    </div>
  );
}
