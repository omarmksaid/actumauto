"use client";

/**
 * Today — the inbound service line at a glance (PLAN.md §16).
 *
 * The headline is no longer a conversion funnel (we don't run campaigns), it's: how many people
 * called, how many of them we could recognize, what we booked, and who is still waiting on a
 * human. The identify rate is the number that decides whether caller-ID-only matching is good
 * enough, so it gets a tile of its own (§16g).
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiCall } from "@/lib/api";
import { isDemo } from "@/lib/supabase";
import { demoFunnel } from "@/lib/data";

const REASON_LABEL: Record<string, string> = {
  where_is_my_car: "Where is my car",
  pricing: "Pricing / billing",
  complaint: "Complaint",
  requested_human: "Asked for a person",
  out_of_scope: "Out of scope",
  other: "Other",
};

export default function TodayPage() {
  const [data, setData] = useState<any>(isDemo ? demoFunnel : null);
  const [loading, setLoading] = useState(!isDemo);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isDemo) return;
    apiCall("/agent/funnel")
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="muted">Loading…</div>;
  if (error) return <div className="banner banner-error">{error}</div>;
  if (!data) return null;

  const i = data.inbound;
  const a = data.appointments;
  const h = data.handoffs;
  const reasons = Object.entries(h.by_reason ?? {}).sort((x: any, y: any) => y[1] - x[1]);

  return (
    <div>
      <h1 className="page-title">Today</h1>
      <p className="page-sub">Calls coming into the service line — who we recognized, what we booked, who needs a person.</p>
      {isDemo && <div className="banner banner-warn" style={{ marginBottom: 16 }}>Demo data.</div>}

      <div className="section-label">Inbound calls</div>
      <div className="grid-4">
        <Stat n={i.calls_today} label="Calls today" />
        <Stat n={i.calls_30d} label="Last 30 days" />
        <Stat
          n={i.identify_rate != null ? `${Math.round(i.identify_rate * 100)}%` : "—"}
          label={`Identified — ${i.anonymous} anonymous`}
          accent
        />
        <Stat n={i.booked} label="Booked from a call" accent />
      </div>

      {i.ambiguous > 0 && (
        <p className="hint" style={{ marginTop: 10 }}>
          {i.ambiguous} caller{i.ambiguous === 1 ? "" : "s"} matched more than one customer (shared
          or work numbers). Those are treated as anonymous on purpose — we never guess between two
          people.
        </p>
      )}

      <div className="section-label" style={{ marginTop: 28 }}>
        Waiting on a service employee
      </div>
      <div className="grid-4">
        <Stat n={h.open} label="Open handoffs" />
        <Stat n={h.needs_callback} label="Transfer didn't connect" warn={h.needs_callback > 0} />
        <Stat n={i.avg_duration_sec ? fmtDur(i.avg_duration_sec) : "—"} label="Avg call length" />
        <Stat n={`$${(i.cost_usd_30d ?? 0).toFixed(2)}`} label="Call spend (30d)" />
      </div>

      {h.needs_callback > 0 && (
        <div className="banner banner-warn" style={{ marginTop: 12 }}>
          {h.needs_callback} caller{h.needs_callback === 1 ? " is" : "s are"} waiting on a callback —
          the transfer never connected. <Link href="/handoffs">Open the queue →</Link>
        </div>
      )}

      {reasons.length > 0 && (
        <>
          <div className="section-label" style={{ marginTop: 28 }}>Why callers get handed off</div>
          <div className="card">
            <table>
              <thead><tr><th>Reason</th><th>Count</th></tr></thead>
              <tbody>
                {reasons.map(([reason, count]: any) => (
                  <tr key={reason}>
                    <td>{REASON_LABEL[reason] ?? reason}</td>
                    <td className="hint">{count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <div className="section-label" style={{ marginTop: 28 }}>Appointments → shown ROs</div>
      <div className="grid-4">
        <Stat n={a.pending_confirmation} label="Pending confirmation" />
        <Stat n={a.confirmed} label="Confirmed" />
        <Stat n={a.shown} label="Shown (real RO)" accent />
        <Stat n={a.no_show} label="No-show" warn={a.no_show > 0} />
      </div>
    </div>
  );
}

function Stat({ n, label, accent, warn }: { n: number | string; label: string; accent?: boolean; warn?: boolean }) {
  const isWarn = warn && typeof n === "number" && n > 0;
  return (
    <div className="card stat">
      <b style={{ color: accent ? "var(--accent-deep)" : isWarn ? "var(--hot)" : undefined }}>{n}</b>
      <span>{label}</span>
    </div>
  );
}

function fmtDur(s: number): string {
  const m = Math.floor(s / 60), r = s % 60;
  return m ? `${m}m ${r}s` : `${r}s`;
}
