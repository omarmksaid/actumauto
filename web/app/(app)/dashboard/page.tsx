"use client";

/**
 * Service-line dashboard.
 *
 * Ordered by what a service manager has to ACT on. Open handoffs come first and are never
 * range-filtered — a caller waiting since yesterday is still waiting, and hiding them behind a
 * "today" filter is how someone gets forgotten. Volume and cost follow as context.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiCall } from "@/lib/api";
import { isDemo } from "@/lib/supabase";
import { demoFunnel } from "@/lib/data";

const RANGES: [string, string][] = [
  ["1d", "1D"], ["1w", "1W"], ["1m", "1M"], ["ytd", "YTD"], ["all", "All"],
];

const REASON_LABEL: Record<string, string> = {
  where_is_my_car: "Where is my car", pricing: "Pricing / billing", complaint: "Complaint",
  requested_human: "Asked for a person", out_of_scope: "Out of scope", other: "Other",
};

export default function Dashboard() {
  const router = useRouter();
  const [range, setRange] = useState("1d");
  const [d, setD] = useState<any>(isDemo ? demoFunnel : null);
  const [loading, setLoading] = useState(!isDemo);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isDemo) return;
    setLoading(true);
    apiCall(`/agent/funnel?range=${range}`)
      .then(setD).catch((e) => setError(e.message)).finally(() => setLoading(false));
  }, [range]);

  if (loading && !d) return <div className="muted">Loading…</div>;
  if (error) return <div className="banner banner-error">{error}</div>;
  if (!d) return null;

  const i = d.inbound, h = d.handoffs, a = d.appointments;
  const reasons = Object.entries(h.by_reason ?? {}).sort((x: any, y: any) => y[1] - x[1]);
  const label = { "1d": "today", "1w": "the last 7 days", "1m": "the last 30 days",
                  ytd: "this year", all: "all time" }[range] ?? "";

  return (
    <div>
      <div className="row-between" style={{ alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 className="page-title">Service line</h1>
          <p className="page-sub">
            Who we recognized, what we booked, who needs a person.{" "}
            <span className="muted">Showing {label}.</span>
          </p>
        </div>
        <div style={{ display: "flex", gap: 4, background: "var(--surface)", border: "1px solid var(--line)",
                      borderRadius: "var(--radius)", padding: 3 }}>
          {RANGES.map(([k, lbl]) => (
            <button key={k} onClick={() => setRange(k)}
              style={{
                border: "none", cursor: "pointer", padding: "6px 13px", borderRadius: 6, font: "inherit",
                fontSize: 13, fontWeight: 600,
                background: range === k ? "var(--accent-wash)" : "transparent",
                color: range === k ? "var(--accent-deep)" : "var(--muted)",
              }}>{lbl}</button>
          ))}
        </div>
      </div>

      {isDemo && <div className="banner banner-warn" style={{ marginBottom: 16 }}>Demo data.</div>}

      {/* The three that matter most, biggest first. */}
      <div className="grid-3">
        <div className="card card-pad" style={{
          background: h.open > 0 ? "var(--hot-wash)" : undefined,
          borderColor: h.open > 0 ? "var(--hot)" : undefined,
        }}>
          <div className="row-between">
            <span style={{ fontWeight: 650, color: h.open > 0 ? "var(--hot)" : undefined }}>Open handoffs</span>
            <span className="chip chip-muted">right now</span>
          </div>
          <b style={{ display: "block", fontSize: 40, lineHeight: 1.1, margin: "6px 0 2px",
                      color: h.open > 0 ? "var(--hot)" : undefined }}>{h.open}</b>
          <div className="hint">
            {h.open > 0
              ? <>Oldest waiting {fmtMin(h.oldest_open_min)} · <Link href="/handoffs" style={{ color: "inherit", fontWeight: 600 }}>view queue</Link></>
              : "Nobody waiting."}
          </div>
        </div>

        <div className="card card-pad">
          <div style={{ fontWeight: 650 }}>Booked from a call</div>
          <b style={{ display: "block", fontSize: 40, lineHeight: 1.1, margin: "6px 0 2px",
                      color: i.booked > 0 ? "var(--accent-deep)" : "var(--muted)" }}>
            {i.booked > 0 ? i.booked : "—"}
          </b>
          <div className="hint">{i.booked > 0 ? `of ${i.calls} calls` : `No bookings ${label}`}</div>
        </div>

        <div className="card card-pad">
          <div style={{ fontWeight: 650 }}>Callers identified</div>
          <b style={{ display: "block", fontSize: 40, lineHeight: 1.1, margin: "6px 0 2px",
                      color: i.identify_rate === null ? "var(--muted)"
                           : i.identify_rate >= 0.7 ? "var(--ok)" : "var(--warm)" }}>
            {i.identify_rate === null ? "—" : `${Math.round(i.identify_rate * 100)}%`}
          </b>
          <div className="hint">
            {i.calls ? `${i.anonymous} anonymous of ${i.calls} call${i.calls === 1 ? "" : "s"}` : "No calls yet"}
            {i.ambiguous > 0 && ` · ${i.ambiguous} shared number${i.ambiguous === 1 ? "" : "s"}`}
          </div>
        </div>
      </div>

      <div className="grid-4" style={{ marginTop: 16 }}>
        <Stat n={i.calls} label="Calls" />
        <Stat n={i.avg_duration_sec ? fmtDur(i.avg_duration_sec) : "—"} label="Avg call length" sub="target <90s"
              warn={i.avg_duration_sec > 90} />
        <Stat n={h.failed_transfers} label="Failed transfers" warn={h.failed_transfers > 0} />
        <Stat n={`$${(i.cost_per_call ?? 0).toFixed(2)}`} label="Cost per call" sub={`$${(i.cost_usd ?? 0).toFixed(2)} total`} />
      </div>

      <div className="card card-pad" style={{ marginTop: 16 }}>
        <div className="row-between" style={{ marginBottom: 10 }}>
          <span style={{ fontWeight: 650 }}>Call volume</span>
          <span className="hint">{range === "1d" ? "Hourly, today" : "Daily"}</span>
        </div>
        <Sparkline points={d.volume ?? []} />
      </div>

      <div className="grid-2" style={{ marginTop: 16 }}>
        <div className="card card-pad">
          <div style={{ fontWeight: 650, marginBottom: 12 }}>Appointments funnel</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <FunnelStep n={a.pending_confirmation} label="Pending" accent />
            <span className="hint">›</span>
            <FunnelStep n={a.confirmed} label="Confirmed" />
            <span className="hint">›</span>
            <FunnelStep n={a.shown} label="Shown" />
          </div>
          <div className="hint" style={{ marginTop: 10 }}>No-shows: {a.no_show}</div>
        </div>

        <div className="card card-pad">
          <div style={{ fontWeight: 650, marginBottom: 12 }}>Why callers get handed off</div>
          {reasons.length === 0 ? <div className="hint">No handoffs {label}.</div> : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {reasons.map(([reason, count]: any) => {
                const max = Math.max(...reasons.map(([, v]: any) => v));
                return (
                  <div key={reason} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ fontSize: 13.5, minWidth: 148 }}>{REASON_LABEL[reason] ?? reason}</span>
                    <div style={{ flex: 1, height: 9, background: "var(--bg)", borderRadius: 5 }}>
                      <div style={{ width: `${(count / max) * 100}%`, height: "100%",
                                    background: "var(--accent)", borderRadius: 5 }} />
                    </div>
                    <span className="hint" style={{ minWidth: 18, textAlign: "right" }}>{count}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ n, label, sub, warn }: { n: any; label: string; sub?: string; warn?: boolean }) {
  return (
    <div className="card stat">
      <b style={warn ? { color: "var(--hot)" } : undefined}>{n}</b>
      <span>{label}{sub && <span className="hint"> · {sub}</span>}</span>
    </div>
  );
}

function FunnelStep({ n, label, accent }: { n: number; label: string; accent?: boolean }) {
  return (
    <div style={{
      flex: 1, textAlign: "center", padding: "14px 8px", borderRadius: "var(--radius)",
      background: accent && n > 0 ? "var(--accent-wash)" : "var(--bg)",
    }}>
      <div style={{ fontSize: 26, fontWeight: 650, color: accent && n > 0 ? "var(--accent-deep)" : undefined }}>{n}</div>
      <div className="hint">{label}</div>
    </div>
  );
}

/** Inline SVG — a chart library isn't worth 40KB for one sparkline. */
function Sparkline({ points }: { points: { label: string; count: number }[] }) {
  if (!points.length) return <div className="hint">No data yet.</div>;
  const W = 900, H = 90, max = Math.max(1, ...points.map((p) => p.count));
  const step = points.length > 1 ? W / (points.length - 1) : W;
  const path = points.map((p, idx) =>
    `${idx === 0 ? "M" : "L"} ${(idx * step).toFixed(1)} ${(H - (p.count / max) * (H - 10)).toFixed(1)}`).join(" ");

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: "100%", height: 90, display: "block" }}>
        <path d={path} fill="none" stroke="var(--accent)" strokeWidth={2}
              vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      </svg>
      <div className="hint" style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
        <span>{points[0]?.label}</span>
        <span>peak {max}</span>
        <span>{points[points.length - 1]?.label}</span>
      </div>
    </div>
  );
}

const fmtDur = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);
const fmtMin = (m: number | null) =>
  m === null ? "—" : m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}m`;
