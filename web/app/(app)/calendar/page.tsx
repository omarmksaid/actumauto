"use client";

/**
 * Appointment calendar — week or day.
 *
 * All local times are computed SERVER-side in the dealership's timezone. A browser in another
 * zone (or a laptop with the wrong clock) would otherwise place a 5pm Pacific appointment on the
 * following day, since it's stored as midnight UTC.
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
  // Without an entry a cancelled visit falls back to the confirmed style and reads as live.
  canceled:             { bg: "var(--bg)", fg: "var(--muted)", label: "cancelled" },
};

export default function Calendar() {
  const [d, setD] = useState<any>(isDemo ? demoCalendar : null);
  const [view, setView] = useState<"week" | "day">("week");
  const [anchor, setAnchor] = useState("");
  const [selected, setSelected] = useState<any>(null);
  const [loading, setLoading] = useState(!isDemo);
  const [error, setError] = useState<string | null>(null);

  async function load(date?: string, v: "week" | "day" = view) {
    if (isDemo) return;
    setLoading(true);
    try {
      const res = await apiCall<any>(`/agent/calendar?view=${v}${date ? `&date=${date}` : ""}`);
      setD(res); setAnchor(res.days[0]?.date ?? "");
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }
  useEffect(() => {
    // Respect ?date= so a link to a specific week opens there rather than on today.
    const q = new URLSearchParams(window.location.search).get("date");
    const valid = q && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(q);
    load(valid ? q : undefined);
  }, []);

  async function act(id: string, action: string) {
    if (isDemo) return;
    try {
      await apiCall(`/agent/appointments/${id}`, { method: "PATCH", body: JSON.stringify({ action }) });
      setSelected(null);
      await load(anchor);
    } catch (e: any) { setError(e.message); }
  }

  function shift(dir: number) {
    const step = view === "week" ? 7 : 1;
    const base = new Date(`${anchor || d?.days[0]?.date}T12:00:00Z`);
    base.setUTCDate(base.getUTCDate() + dir * step);
    load(base.toISOString().slice(0, 10));
  }

  if (loading && !d) return <div className="muted">Loading…</div>;
  if (!d) return <div className="banner banner-error">{error ?? "Could not load the calendar."}</div>;

  const days = d.days ?? [];
  const total = days.reduce((n: number, x: any) => n + x.appointments.length, 0);
  const range = days.length > 1
    ? `${fmtDay(days[0].date)} – ${fmtDay(days[days.length - 1].date)}`
    : fmtDay(days[0]?.date);

  return (
    <div>
      <div className="row-between" style={{ alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 className="page-title">Calendar</h1>
          <p className="page-sub">
            {range} · {total} appointment{total === 1 ? "" : "s"} · times shown in {tzLabel(d.timezone)}
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: 3, background: "var(--surface)", border: "1px solid var(--line)", borderRadius: "var(--radius)", padding: 3 }}>
            {(["week", "day"] as const).map((v) => (
              <button key={v} onClick={() => {
                  setView(v);
                  // Week to day: show today if it's in the visible week, else the first open day.
                  // The week's anchor is Sunday, usually closed — landing there looks broken.
                  const target = v === "day" && days.length > 1
                    ? (days.some((x: any) => x.date === d.today)
                        ? d.today
                        : (days.find((x: any) => !x.closed)?.date ?? anchor))
                    : anchor;
                  load(target, v);
                }}
                style={{
                  border: "none", cursor: "pointer", padding: "5px 12px", borderRadius: 6,
                  font: "inherit", fontSize: 13, fontWeight: 600,
                  background: view === v ? "var(--accent-wash)" : "transparent",
                  color: view === v ? "var(--accent-deep)" : "var(--muted)",
                }}>{v}</button>
            ))}
          </div>
          <button className="btn" onClick={() => shift(-1)}>←</button>
          <button className="btn" onClick={() => load()}>Today</button>
          <button className="btn" onClick={() => shift(1)}>→</button>
        </div>
      </div>

      {isDemo && <div className="banner banner-warn" style={{ marginBottom: 16 }}>Demo data.</div>}
      {error && <div className="banner banner-error" style={{ marginBottom: 16 }}>{error}</div>}

      <div style={{
        display: "grid", gap: 10, marginTop: 8,
        gridTemplateColumns: days.length > 1 ? "repeat(auto-fit, minmax(150px, 1fr))" : "1fr",
      }}>
        {days.map((day: any) => (
          <div key={day.date} className="card" style={{
            padding: 10, minHeight: 150,
            background: day.closed ? "var(--bg)" : undefined,
            borderColor: day.date === d.today ? "var(--accent)" : undefined,
          }}>
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontWeight: 700, fontSize: 13,
                color: day.date === d.today ? "var(--accent-deep)" : undefined }}>
                {day.weekday} {Number(day.date.slice(-2))}
              </div>
              <div className="hint" style={{ fontSize: 11 }}>
                {day.closed ? "closed" : `${day.appointments.length} booked`}
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              {day.appointments.map((a: any) => {
                const st = STATUS[a.status] ?? STATUS.confirmed;
                return (
                  <button key={a.id} onClick={() => setSelected(a)} style={{
                    textAlign: "left", border: "none", cursor: "pointer", width: "100%",
                    background: st.bg, color: st.fg, borderRadius: 6, padding: "6px 8px", font: "inherit",
                  }}>
                    <div style={{ fontSize: 12, fontWeight: 700 }}>{a.local_time}</div>
                    <div style={{ fontSize: 11.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {a.customer ?? "Unknown"}
                    </div>
                    <div style={{ fontSize: 11, opacity: 0.8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {a.vehicle ?? "—"}
                    </div>
                  </button>
                );
              })}
              {!day.closed && day.appointments.length === 0 && (
                <div className="hint" style={{ fontSize: 11.5 }}>—</div>
              )}
            </div>
          </div>
        ))}
      </div>

      {d.unscheduled.length > 0 && (
        <>
          <div className="section-label" style={{ marginTop: 26 }}>Needs a time · {d.unscheduled.length}</div>
          <p className="hint" style={{ marginTop: -6, marginBottom: 10 }}>
            The caller gave a preference, not a specific slot. Someone has to place these.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {d.unscheduled.map((a: any) => (
              <button key={a.id} className="card card-pad" onClick={() => setSelected(a)}
                style={{ textAlign: "left", cursor: "pointer", border: "1px solid var(--line)", font: "inherit" }}>
                <div style={{ fontWeight: 650 }}>{a.customer ?? "Unknown"}</div>
                <div className="hint">
                  {a.vehicle ?? "vehicle not specified"} · asked for &ldquo;{a.preferred_time}&rdquo;
                </div>
              </button>
            ))}
          </div>
        </>
      )}

      {selected && <Detail a={selected} onClose={() => setSelected(null)} act={act} />}
    </div>
  );
}

function Detail({ a, onClose, act }: { a: any; onClose: () => void; act: (id: string, action: string) => void }) {
  const st = STATUS[a.status] ?? STATUS.confirmed;
  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(22,34,46,.45)", zIndex: 50,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
    }}>
      <div onClick={(e) => e.stopPropagation()} className="card card-pad"
        style={{ width: "100%", maxWidth: 500, maxHeight: "85vh", overflowY: "auto" }}>
        <div className="row-between" style={{ marginBottom: 10 }}>
          <div>
            <div style={{ fontWeight: 650, fontSize: 17 }}>{a.customer ?? "Unknown customer"}</div>
            <div className="hint">{a.phone ?? ""}</div>
          </div>
          <span style={{ background: st.bg, color: st.fg, padding: "4px 10px", borderRadius: 999, fontSize: 12.5, fontWeight: 600 }}>
            {st.label}
          </span>
        </div>

        <div className="hint" style={{ marginBottom: 10 }}>
          {a.local_time ? `${a.local_time}` : `asked for "${a.preferred_time}"`}
          {a.vehicle && ` · ${a.vehicle}`}
          {a.drop_off === "waiting" && " · waiting on site"}
          {a.drop_off === "dropping_off" && " · dropping off"}
        </div>

        {a.notes && (
          <pre style={{
            margin: 0, whiteSpace: "pre-wrap", fontSize: 12.5, lineHeight: 1.55, fontFamily: "inherit",
            background: "var(--bg)", padding: 12, borderRadius: "var(--radius)", color: "var(--ink)",
          }}>{a.notes.replace(/\nAA:[0-9a-f-]+/i, "")}</pre>
        )}

        <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
          {a.status === "pending_confirmation" && <button className="btn" onClick={() => act(a.id, "confirm")}>Confirm</button>}
          {(a.status === "confirmed" || a.status === "pending_confirmation") && (
            <button className="btn btn-primary" onClick={() => act(a.id, "check_in")}>Check in</button>
          )}
          {a.status === "in_service" && <button className="btn btn-primary" onClick={() => act(a.id, "complete")}>Complete</button>}
          {(a.status === "shown" || a.status === "no_show" || a.status === "canceled") && (
            <button className="btn" onClick={() => act(a.id, "reopen")}>Reopen</button>
          )}
          {a.status !== "shown" && a.status !== "no_show" && (
            <button className="btn btn-quiet" onClick={() => act(a.id, "cancel")}>Cancel</button>
          )}
          <button className="btn btn-quiet" style={{ marginLeft: "auto" }} onClick={onClose}>Close</button>
        </div>

        {/* Bring the visit to now and check it in, so the phone agent greets this caller with
            "we have your car in with us". Separated from the buttons above because it MOVES the
            appointment — that's a bigger change than a status flip and shouldn't sit inline
            with them. */}
        {a.status !== "in_service" ? (
          <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--line)" }}>
            <button className="btn" onClick={() => act(a.id, "start_now")}>
              Move to now &amp; check in
            </button>
            <p className="hint" style={{ marginTop: 8, marginBottom: 0 }}>
              Sets this visit to right now and marks the car in service. When {a.phone ?? "this caller"}{" "}
              calls, the agent opens with the car being in the shop and offers to answer questions
              about it.
            </p>
          </div>
        ) : (
          <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--line)" }}>
            <p className="hint" style={{ margin: 0 }}>
              In the shop now. A call from {a.phone ?? "this customer's number"} is greeted with the
              car being in service. Status questions still transfer to an advisor.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

const fmtDay = (d?: string) =>
  d ? new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { timeZone: "UTC", month: "short", day: "numeric" }) : "";
const tzLabel = (tz: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" })
    .formatToParts(new Date()).find((p) => p.type === "timeZoneName")?.value ?? tz;
