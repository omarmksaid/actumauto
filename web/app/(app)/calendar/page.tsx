"use client";

/**
 * Appointment calendar — the shop's day.
 *
 * Appointments the agent captured with a resolved time sit on the timeline; ones taken as free
 * text ("Friday morning") appear separately as "needs a time", because an advisor still has to
 * place those and hiding them would mean a booked customer nobody scheduled.
 */

import { useEffect, useState } from "react";
import { apiCall } from "@/lib/api";
import { isDemo } from "@/lib/supabase";
import { demoCalendar } from "@/lib/data";

const STATUS: Record<string, { bg: string; fg: string; label: string }> = {
  pending_confirmation: { bg: "var(--warm-wash)", fg: "var(--warm)", label: "needs confirming" },
  confirmed:            { bg: "var(--accent-wash)", fg: "var(--accent-deep)", label: "confirmed" },
  in_service:           { bg: "var(--ok-wash)", fg: "var(--ok)", label: "in service" },
  shown:                { bg: "var(--bg)", fg: "var(--muted)", label: "completed" },
  no_show:              { bg: "var(--hot-wash)", fg: "var(--hot)", label: "no-show" },
};

export default function Calendar() {
  const [date, setDate] = useState("");
  const [d, setD] = useState<any>(isDemo ? demoCalendar : null);
  const [loading, setLoading] = useState(!isDemo);
  const [error, setError] = useState<string | null>(null);

  async function load(day?: string) {
    if (isDemo) return;
    setLoading(true);
    try {
      const res = await apiCall<any>(`/agent/calendar${day ? `?date=${day}` : ""}`);
      setD(res); setDate(res.date);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  async function act(id: string, action: string) {
    if (isDemo) return;
    try { await apiCall(`/agent/appointments/${id}`, { method: "PATCH", body: JSON.stringify({ action }) }); await load(date); }
    catch (e: any) { setError(e.message); }
  }

  function shift(days: number) {
    const base = new Date(`${date || d?.date}T12:00:00Z`);
    base.setUTCDate(base.getUTCDate() + days);
    load(base.toISOString().slice(0, 10));
  }

  if (loading && !d) return <div className="muted">Loading…</div>;
  if (!d) return <div className="banner banner-error">{error ?? "Could not load the calendar."}</div>;

  const heading = new Date(`${d.date}T12:00:00Z`).toLocaleDateString(undefined,
    { weekday: "long", month: "long", day: "numeric" });

  // Group by local hour so the day reads as a schedule, not a list.
  const byHour = new Map<string, any[]>();
  for (const a of d.scheduled) {
    const h = new Date(a.starts_at).toLocaleTimeString(undefined,
      { timeZone: d.timezone, hour: "numeric", hour12: true });
    if (!byHour.has(h)) byHour.set(h, []);
    byHour.get(h)!.push(a);
  }

  return (
    <div>
      <div className="row-between" style={{ alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 className="page-title">Calendar</h1>
          <p className="page-sub">
            {d.scheduled.length} appointment{d.scheduled.length === 1 ? "" : "s"} · up to {d.capacity} at a time
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button className="btn" onClick={() => shift(-1)}>←</button>
          <input type="date" value={d.date} onChange={(e) => load(e.target.value)} />
          <button className="btn" onClick={() => shift(1)}>→</button>
        </div>
      </div>

      {isDemo && <div className="banner banner-warn" style={{ marginBottom: 16 }}>Demo data.</div>}
      {error && <div className="banner banner-error" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="section-label" style={{ marginTop: 8 }}>{heading}</div>

      {d.scheduled.length === 0 ? (
        <div className="card card-pad muted">Nothing scheduled.</div>
      ) : (
        [...byHour.entries()].map(([hour, list]) => (
          <div key={hour} style={{ display: "flex", gap: 14, marginBottom: 10 }}>
            <div className="hint" style={{ width: 76, paddingTop: 14, flexShrink: 0, fontWeight: 600 }}>{hour}</div>
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 8 }}>
              {list.map((a: any) => <Row key={a.id} a={a} tz={d.timezone} act={act} />)}
            </div>
          </div>
        ))
      )}

      {d.unscheduled.length > 0 && (
        <>
          <div className="section-label" style={{ marginTop: 26 }}>
            Needs a time · {d.unscheduled.length}
          </div>
          <p className="hint" style={{ marginTop: -6, marginBottom: 10 }}>
            The caller gave a preference, not a specific slot. Someone has to place these.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {d.unscheduled.map((a: any) => <Row key={a.id} a={a} tz={d.timezone} act={act} />)}
          </div>
        </>
      )}
    </div>
  );
}

function Row({ a, tz, act }: { a: any; tz: string; act: (id: string, action: string) => void }) {
  const st = STATUS[a.status] ?? STATUS.confirmed;
  return (
    <div className="card card-pad" style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 16px" }}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontWeight: 650, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {a.customer ?? "Unknown customer"}
          <span style={{ background: st.bg, color: st.fg, padding: "3px 9px", borderRadius: 999, fontSize: 12, fontWeight: 600 }}>
            {st.label}
          </span>
          {a.drop_off === "waiting" && <span className="chip chip-muted">waiting</span>}
          {a.drop_off === "dropping_off" && <span className="chip chip-muted">drop-off</span>}
        </div>
        <div className="hint">
          {a.vehicle ?? "vehicle not specified"}
          {a.ops.length > 0 && ` · ${a.ops.join(", ")}`}
          {!a.starts_at && a.preferred_time && ` · asked for "${a.preferred_time}"`}
        </div>
        {/* The full note — who called, what they asked for, and the call summary once it lands.
            An advisor places this in myKaarma without listening to the recording. */}
        {a.notes && (
          <details style={{ marginTop: 6 }}>
            <summary className="hint" style={{ cursor: "pointer", color: "var(--accent-deep)", fontWeight: 600 }}>
              Call notes
            </summary>
            <pre style={{
              margin: "6px 0 0", whiteSpace: "pre-wrap", fontSize: 12.5, lineHeight: 1.5,
              color: "var(--muted)", fontFamily: "inherit",
            }}>{a.notes.replace(/\nAA:[0-9a-f-]+/i, "")}</pre>
          </details>
        )}
      </div>
      <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
        {a.status === "pending_confirmation" && <button className="btn" onClick={() => act(a.id, "confirm")}>Confirm</button>}
        {(a.status === "confirmed" || a.status === "pending_confirmation") && (
          <button className="btn btn-primary" onClick={() => act(a.id, "check_in")}>Check in</button>
        )}
        {a.status === "in_service" && <button className="btn btn-primary" onClick={() => act(a.id, "complete")}>Complete</button>}
        {a.status !== "shown" && a.status !== "no_show" && (
          <button className="btn btn-quiet" onClick={() => act(a.id, "cancel")}>Cancel</button>
        )}
      </div>
    </div>
  );
}
