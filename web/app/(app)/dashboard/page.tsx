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
          <span className="hint">
            {range === "1d" ? "Hourly" : range === "ytd" || range === "all" ? "Monthly" : "Daily"}
            {(d.volume ?? []).length > 0 && ` · peak ${Math.max(...(d.volume ?? []).map((v: any) => v.count))}`}
          </span>
        </div>
        <Sparkline points={d.volume ?? []} hourly={range === "1d"} />
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

/**
 * Inline SVG chart — a library isn't worth 40KB for one series.
 *
 * Hovering snaps to the nearest point and shows its label and value, because a bare line can't
 * tell you WHICH day a peak was, which is the first thing anyone asks. Smoothed with a monotone
 * cubic fit: straight segments between sparse daily counts read as sharper swings than the data
 * supports, but a naive spline overshoots and invents values below zero.
 */
function Sparkline({ points, hourly }: { points: { label: string; count: number }[]; hourly: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  if (!points.length) return <div className="hint">No data yet.</div>;

  const W = 900, H = 150, PAD_T = 14, PAD_B = 26;
  const max = Math.max(1, ...points.map((p) => p.count));
  const x = (i: number) => (points.length === 1 ? W / 2 : (i / (points.length - 1)) * W);
  const y = (v: number) => PAD_T + (1 - v / max) * (H - PAD_T - PAD_B);

  // Monotone cubic: keeps the curve inside the data's own range so it never dips below zero or
  // overshoots a peak the way a Catmull-Rom spline would.
  const path = (() => {
    if (points.length < 2) return `M ${x(0)} ${y(points[0].count)}`;
    const pts = points.map((p, i) => ({ x: x(i), y: y(p.count) }));
    const slopes = pts.map((_, i) => {
      if (i === 0 || i === pts.length - 1) return 0;
      const dl = pts[i].y - pts[i - 1].y, dr = pts[i + 1].y - pts[i].y;
      return dl * dr <= 0 ? 0 : (dl + dr) / 2;      // flatten at local extremes
    });
    let d = `M ${pts[0].x} ${pts[0].y}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const dx = (pts[i + 1].x - pts[i].x) / 3;
      d += ` C ${pts[i].x + dx} ${pts[i].y + slopes[i] / 3}, ${pts[i + 1].x - dx} ${pts[i + 1].y - slopes[i + 1] / 3}, ${pts[i + 1].x} ${pts[i + 1].y}`;
    }
    return d;
  })();

  const area = `${path} L ${x(points.length - 1)} ${H - PAD_B} L ${x(0)} ${H - PAD_B} Z`;
  const peakIdx = points.reduce((b, p, i) => (p.count > points[b].count ? i : b), 0);
  const active = hover ?? null;

  return (
    <div style={{ position: "relative" }}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none"
        style={{ width: "100%", height: 150, display: "block", overflow: "visible" }}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const rel = ((e.clientX - r.left) / r.width) * W;
          // Snap to the nearest point rather than interpolating — the reading should match a real
          // bucket, not a position between two.
          let best = 0, bestD = Infinity;
          points.forEach((_, i) => { const d = Math.abs(x(i) - rel); if (d < bestD) { bestD = d; best = i; } });
          setHover(best);
        }}>
        <defs>
          <linearGradient id="volFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.18" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Baseline so an all-zero stretch still reads as "zero", not "no chart". */}
        <line x1="0" y1={H - PAD_B} x2={W} y2={H - PAD_B} stroke="var(--line)" strokeWidth={1}
          vectorEffect="non-scaling-stroke" />

        <path d={area} fill="url(#volFill)" />
        <path d={path} fill="none" stroke="var(--accent)" strokeWidth={2.5}
          vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />

        {active !== null && (
          <>
            <line x1={x(active)} y1={PAD_T - 6} x2={x(active)} y2={H - PAD_B}
              stroke="var(--accent)" strokeWidth={1} strokeDasharray="3 3"
              vectorEffect="non-scaling-stroke" opacity={0.5} />
            <circle cx={x(active)} cy={y(points[active].count)} r={4.5}
              fill="var(--surface)" stroke="var(--accent)" strokeWidth={2.5}
              vectorEffect="non-scaling-stroke" />
          </>
        )}
        {active === null && points[peakIdx].count > 0 && (
          <circle cx={x(peakIdx)} cy={y(points[peakIdx].count)} r={3.5} fill="var(--accent)" />
        )}
      </svg>

      {/* Tooltip in HTML, not SVG: preserveAspectRatio="none" would stretch SVG text. */}
      {active !== null && (
        <div style={{
          position: "absolute", top: -4, pointerEvents: "none",
          left: `${(x(active) / W) * 100}%`,
          transform: `translateX(${x(active) > W * 0.75 ? "-100%" : x(active) < W * 0.25 ? "0" : "-50%"})`,
          background: "var(--ink)", color: "#fff", padding: "6px 10px", borderRadius: 6,
          fontSize: 12.5, fontWeight: 600, whiteSpace: "nowrap",
          boxShadow: "0 2px 8px rgba(0,0,0,.18)",
        }}>
          {fmtBucket(points[active].label, hourly)} · {points[active].count} call{points[active].count === 1 ? "" : "s"}
        </div>
      )}

      <div className="hint" style={{ display: "flex", justifyContent: "space-between", marginTop: 2 }}>
        <span>{fmtBucket(points[0]?.label, hourly)}</span>
        <span>{fmtBucket(points[points.length - 1]?.label, hourly)}</span>
      </div>
    </div>
  );
}

/** "08-13" -> "Aug 13", "14" -> "2 PM". Raw bucket keys aren't readable on an axis. */
function fmtBucket(label: string | undefined, hourly: boolean): string {
  if (!label) return "";
  if (hourly) {
    const h = parseInt(label, 10);
    if (isNaN(h)) return label;
    return h === 0 ? "12 AM" : h === 12 ? "12 PM" : h < 12 ? `${h} AM` : `${h - 12} PM`;
  }
  if (/^\d{4}-\d{2}$/.test(label)) {                     // ytd/all months
    const [yr, mo] = label.split("-").map(Number);
    return new Date(yr, mo - 1, 1).toLocaleDateString(undefined, { month: "short", year: "numeric" });
  }
  const [mo, d] = label.split("-").map(Number);
  if (!mo || !d) return label;
  return new Date(new Date().getFullYear(), mo - 1, d)
    .toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const fmtDur = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);
const fmtMin = (m: number | null) =>
  m === null ? "—" : m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}m`;
