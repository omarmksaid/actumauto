"use client";

/**
 * Calls list.
 *
 * Grouped by day, with the caller identified where we know them. Repeat missed attempts from the
 * same number collapse into one row — four rows for one frustrated caller redialing is noise, and
 * it hides how many DISTINCT people called.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiCall } from "@/lib/api";
import { isDemo } from "@/lib/supabase";
import { demoCalls, CallRow } from "@/lib/data";

const STATUS_STYLE: Record<string, { bg: string; fg: string }> = {
  answered:     { bg: "var(--ok-wash)",     fg: "var(--ok)" },
  booked:       { bg: "var(--accent-wash)", fg: "var(--accent-deep)" },
  "handed off": { bg: "var(--warm-wash)",   fg: "var(--warm)" },
  missed:       { bg: "var(--cold-wash)",   fg: "var(--cold)" },
};

const REASON_LABEL: Record<string, string> = {
  where_is_my_car: "where is my car", pricing: "pricing", complaint: "complaint",
  requested_human: "asked for a person", out_of_scope: "out of scope", other: "other",
};

export default function CallsPage() {
  const router = useRouter();
  const [data, setData] = useState<any>(isDemo ? { calls: demoCalls, counts: demoCounts(demoCalls) } : null);
  const [filter, setFilter] = useState("all");
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(!isDemo);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isDemo) return;
    const t = setTimeout(() => {
      setLoading(true);
      apiCall(`/agent/calls${q ? `?q=${encodeURIComponent(q)}` : ""}`)
        .then(setData).catch((e) => setError(e.message)).finally(() => setLoading(false));
    }, q ? 300 : 0);            // debounce typing
    return () => clearTimeout(t);
  }, [q]);

  const calls = (data?.calls ?? []).filter((c: any) => filter === "all" || c.status === filter);
  const groups = groupByDay(calls);

  return (
    <div>
      <div className="row-between" style={{ alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 className="page-title">Calls</h1>
          <p className="page-sub">Every call into the service line — play back the recording, read the transcript.</p>
        </div>
        <input placeholder="(628) 358-7659 or Omar" value={q} onChange={(e) => setQ(e.target.value)}
          style={{ maxWidth: 260 }} />
      </div>

      {isDemo && <div className="banner banner-warn" style={{ marginBottom: 16 }}>Demo data.</div>}
      {error && <div className="banner banner-error" style={{ marginBottom: 16 }}>{error}</div>}

      <div style={{ display: "flex", gap: 8, margin: "4px 0 18px", flexWrap: "wrap" }}>
        {["all", "answered", "missed", "handed off", "booked"].map((k) => (
          <button key={k} onClick={() => setFilter(k)}
            style={{
              border: "1px solid var(--line)", cursor: "pointer", padding: "6px 14px",
              borderRadius: 999, font: "inherit", fontSize: 13, fontWeight: 600,
              background: filter === k ? "var(--ink)" : "var(--surface)",
              color: filter === k ? "#fff" : "var(--muted)",
            }}>
            {k[0].toUpperCase() + k.slice(1)} · {data?.counts?.[k] ?? 0}
          </button>
        ))}
      </div>

      {loading && !data ? <div className="muted">Loading…</div>
        : groups.length === 0 ? <div className="card card-pad muted">No calls{q ? " match that search" : " yet"}.</div>
        : groups.map(([day, items]: any) => (
          <div key={day} style={{ marginBottom: 22 }}>
            <div className="hint" style={{ marginBottom: 8, fontWeight: 600 }}>{day}</div>
            <div className="card" style={{ overflow: "hidden" }}>
              {items.map((call: any, idx: number) => (
                <div key={call.id} className="rowlink"
                  onClick={() => router.push(`/calls/${call.id}`)}
                  style={{
                    display: "flex", alignItems: "center", gap: 14, padding: "14px 18px",
                    borderTop: idx ? "1px solid var(--line)" : undefined, cursor: "pointer",
                  }}>
                  <Avatar name={call.name} dim={call.status === "missed"} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: 650, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      {call.name ?? <span className="muted">Not identified</span>}
                      {call.attempts > 1 && (
                        <span className="chip chip-muted" style={{ fontWeight: 500 }}>
                          {call.attempts} attempts in {call.attempt_span_min} min
                        </span>
                      )}
                    </div>
                    <div className="hint">{fmtPhone(call.phone)}</div>
                  </div>
                  <StatusChip status={call.status} detail={call.detail} />
                  <span className="hint" style={{ minWidth: 46, textAlign: "right" }}>
                    {call.duration_sec ? fmtDur(call.duration_sec) : "—"}
                  </span>
                  <span className="hint" style={{ minWidth: 68, textAlign: "right" }}>{fmtTime(call.created_at)}</span>
                  <span aria-hidden style={{ color: "var(--muted)", fontSize: 13 }}>
                    {call.has_recording ? "▶" : "›"}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
    </div>
  );
}

function Avatar({ name, dim }: { name: string | null; dim?: boolean }) {
  const initials = name
    ? name.split(" ").map((p: string) => p[0]).slice(0, 2).join("").toUpperCase()
    : "?";
  return (
    <div style={{
      width: 36, height: 36, borderRadius: "50%", flexShrink: 0,
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: 12.5, fontWeight: 700, letterSpacing: "0.02em",
      background: name && !dim ? "var(--accent-wash)" : "var(--bg)",
      color: name && !dim ? "var(--accent-deep)" : "var(--muted)",
      border: name ? "none" : "1px dashed var(--line)",
    }}>{initials}</div>
  );
}

function StatusChip({ status, detail }: { status: string; detail: string | null }) {
  const st = STATUS_STYLE[status] ?? STATUS_STYLE.missed;
  const label = detail ? `${status} · ${REASON_LABEL[detail] ?? detail}` : status;
  return (
    <span style={{
      background: st.bg, color: st.fg, padding: "5px 11px", borderRadius: 999,
      fontSize: 12.5, fontWeight: 600, whiteSpace: "nowrap",
    }}>{label}</span>
  );
}

function groupByDay(calls: any[]): [string, any[]][] {
  const out = new Map<string, any[]>();
  const today = new Date().toDateString();
  const yest = new Date(Date.now() - 86400_000).toDateString();
  for (const c of calls) {
    const d = new Date(c.created_at);
    const key = d.toDateString() === today ? `Today · ${fmtDay(d)}`
      : d.toDateString() === yest ? `Yesterday · ${fmtDay(d)}`
      : fmtDay(d);
    if (!out.has(key)) out.set(key, []);
    out.get(key)!.push(c);
  }
  return [...out.entries()];
}

const fmtDay = (d: Date) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
const fmtTime = (s: string) => new Date(s).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const fmtDur = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
const fmtPhone = (p: string | null) => {
  if (!p) return "—";
  const d = p.replace(/\D/g, "").slice(-10);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : p;
};
const demoCounts = (calls: any[]) => ({
  all: calls.length,
  answered: calls.filter((c) => c.status === "answered").length,
  missed: calls.filter((c) => c.status === "missed").length,
  "handed off": calls.filter((c) => c.status === "handed off").length,
  booked: calls.filter((c) => c.status === "booked").length,
});
