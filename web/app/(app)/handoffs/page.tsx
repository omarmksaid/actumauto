"use client";

/**
 * Handoff queue (PLAN.md §16b) — callers the inbound agent sent to a human.
 *
 * The rows that matter most are the ones where `transferred` is false: the transfer didn't
 * connect, so nobody has spoken to that caller yet and an advisor owes them a callback. Those are
 * pinned to the top and flagged, because a dropped caller is the failure mode this queue exists
 * to catch.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiCall } from "@/lib/api";
import { isDemo } from "@/lib/supabase";
import { demoHandoffs, demoFunnel, HandoffRow } from "@/lib/data";

const REASON_LABEL: Record<string, string> = {
  where_is_my_car: "Where is my car",
  pricing: "Pricing / billing",
  complaint: "Complaint",
  requested_human: "Asked for a person",
  out_of_scope: "Out of scope",
  other: "Other",
};

const REASON_CHIP: Record<string, string> = {
  where_is_my_car: "chip-ai",
  pricing: "chip-warm",
  complaint: "chip-hot",
  requested_human: "chip-muted",
  out_of_scope: "chip-muted",
  other: "chip-muted",
};

export default function HandoffsPage() {
  const router = useRouter();
  const [rows, setRows] = useState<HandoffRow[]>(isDemo ? demoHandoffs : []);
  const [stats, setStats] = useState<any>(isDemo ? demoFunnel : null);
  const [status, setStatus] = useState<"open" | "resolved" | "all">("open");
  const [loading, setLoading] = useState(!isDemo);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isDemo) return;
    setLoading(true);
    Promise.all([
      apiCall<{ handoffs: HandoffRow[] }>(`/agent/handoffs?status=${status}`),
      apiCall<any>("/agent/funnel"),
    ])
      .then(([h, s]) => { setRows(h.handoffs); setStats(s); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [status]);

  async function resolve(id: string) {
    const prev = rows;
    setRows((r) => r.filter((x) => x.id !== id || status !== "open"));
    try {
      await apiCall(`/agent/handoffs/${id}`, {
        method: "PATCH", body: JSON.stringify({ status: "resolved" }),
      });
    } catch (e: any) {
      setRows(prev);
      setError(e.message);
    }
  }

  // Callers nobody has spoken to yet come first.
  const sorted = [...rows].sort((a, b) => {
    if (a.transferred !== b.transferred) return a.transferred ? 1 : -1;
    return b.created_at.localeCompare(a.created_at);
  });

  return (
    <div>
      <h1 className="page-title">Handoffs</h1>
      <p className="page-sub">
        Inbound callers the agent passed to a service employee — vehicle status, pricing, and
        anything it isn&apos;t allowed to answer.
      </p>
      {isDemo && <div className="banner banner-warn" style={{ marginBottom: 16 }}>Demo data.</div>}
      {error && <div className="banner banner-error">{error}</div>}

      {stats && (
        <div className="grid-4" style={{ marginBottom: 16 }}>
          <Stat label="Open" value={stats.handoffs.open} />
          <Stat label="Needs callback" value={stats.handoffs.needs_callback} warn={stats.handoffs.needs_callback > 0} />
          <Stat label="Inbound calls (30d)" value={stats.inbound.calls_30d} />
          <Stat
            label={`Identified · ${stats.inbound.anonymous} anonymous`}
            value={stats.inbound.identify_rate != null ? `${Math.round(stats.inbound.identify_rate * 100)}%` : "—"}
          />
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        {(["open", "resolved", "all"] as const).map((s) => (
          <button
            key={s}
            className={`chip ${status === s ? "chip-ai" : "chip-muted"}`}
            style={{ cursor: "pointer", border: "none", font: "inherit" }}
            onClick={() => setStatus(s)}
          >
            {s}
          </button>
        ))}
      </div>

      <div className="card">
        {loading ? <div className="card-pad muted">Loading…</div> : (
          <table>
            <thead>
              <tr>
                <th>Caller</th><th>Reason</th><th>Vehicle</th><th>Notes</th>
                <th>Transfer</th><th>When</th><th></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((h) => (
                <tr key={h.id}>
                  <td>
                    {h.customers?.full_name ?? <span className="muted">Not identified</span>}
                    <div className="hint">{h.caller_number ?? "—"}</div>
                  </td>
                  <td>
                    <span className={`chip ${REASON_CHIP[h.reason] ?? "chip-muted"}`}>
                      {REASON_LABEL[h.reason] ?? h.reason}
                    </span>
                  </td>
                  <td className="hint">{h.vehicle_hint ?? "—"}</td>
                  <td className="hint">{h.notes ?? "—"}</td>
                  <td>
                    {h.transferred
                      ? <span className="hint">Connected</span>
                      : <span className="chip chip-hot">Call them back</span>}
                  </td>
                  <td className="hint">{new Date(h.created_at).toLocaleString()}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {h.call_id && (
                      <button
                        className="chip chip-muted"
                        style={{ cursor: "pointer", border: "none", font: "inherit", marginRight: 6 }}
                        onClick={() => router.push(`/calls/${h.call_id}`)}
                      >
                        Call
                      </button>
                    )}
                    {h.status === "open" && (
                      <button
                        className="chip chip-ok"
                        style={{ cursor: "pointer", border: "none", font: "inherit" }}
                        onClick={() => resolve(h.id)}
                      >
                        Resolve
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {sorted.length === 0 && (
                <tr><td colSpan={7} className="muted">Nothing here — no callers waiting.</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: any; warn?: boolean }) {
  return (
    <div className="card stat">
      <b style={warn ? { color: "var(--hot)" } : undefined}>{value}</b>
      <span>{label}</span>
    </div>
  );
}
