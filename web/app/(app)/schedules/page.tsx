"use client";

/**
 * Service schedules (PLAN.md §2, §6).
 *
 * These intervals are what the agent uses to tell an inbound caller what their car is due for
 * (§16d), so what's shown here is literally what it will recommend. The seeded Toyota data is
 * approximate and marked for dealer verification — a dealership can add its own schedule, which
 * takes precedence over the seed for matching vehicles.
 */

import { useEffect, useState } from "react";
import { apiCall } from "@/lib/api";
import { isDemo } from "@/lib/supabase";
import { demoSchedules, ScheduleRow } from "@/lib/data";

const SEVERITY_CHIP: Record<string, string> = {
  standard: "chip-muted", major: "chip-warm", safety: "chip-hot",
};

export default function SchedulesPage() {
  const [schedules, setSchedules] = useState<ScheduleRow[]>(isDemo ? demoSchedules : []);
  const [loading, setLoading] = useState(!isDemo);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isDemo) return;
    apiCall<{ schedules: ScheduleRow[] }>("/schedules")
      .then((r) => setSchedules(r.schedules))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="muted">Loading…</div>;

  return (
    <div>
      <h1 className="page-title">Service Schedules</h1>
      <p className="page-sub">
        The maintenance intervals behind every recommendation — when a caller asks what their car
        needs, this is where the answer comes from.
      </p>
      {isDemo && <div className="banner banner-warn" style={{ marginBottom: 16 }}>Demo data.</div>}
      {error && <div className="banner banner-error" style={{ marginBottom: 16 }}>{error}</div>}

      {schedules.length === 0 && (
        <div className="banner banner-warn">
          No schedules loaded. Without them the agent can&apos;t tell callers what&apos;s due —
          run the seed in <code>supabase/seed.example.sql</code>.
        </div>
      )}

      {schedules.map((s) => (
        <div className="card" key={s.id} style={{ marginBottom: 16 }}>
          <div className="card-pad" style={{ paddingBottom: 8 }}>
            <div className="row-between">
              <div>
                <b style={{ fontSize: 15 }}>
                  {s.make}{s.model ? ` ${s.model}` : " — all models"}
                  {s.year_from || s.year_to ? ` (${s.year_from ?? "…"}–${s.year_to ?? "…"})` : ""}
                </b>
                <div className="hint">{s.source ?? "—"}</div>
              </div>
              <span className={`chip ${s.is_global ? "chip-muted" : "chip-ai"}`}>
                {s.is_global ? "built-in default" : "your dealership"}
              </span>
            </div>
            {s.notes && (
              <p className="hint" style={{ marginTop: 8, marginBottom: 0 }}>{s.notes}</p>
            )}
          </div>
          <table>
            <thead>
              <tr><th>Mileage</th><th>Time</th><th>Service</th><th>Operations</th><th>Type</th></tr>
            </thead>
            <tbody>
              {s.intervals.map((iv) => (
                <tr key={iv.id}>
                  <td>{iv.mileage != null ? `${iv.mileage.toLocaleString()} mi` : "—"}</td>
                  <td className="hint">{iv.months != null ? `${iv.months} mo` : "—"}</td>
                  <td>{iv.service_name}</td>
                  <td className="hint">{iv.operations?.length ? iv.operations.join(", ") : "—"}</td>
                  <td>
                    <span className={`chip ${SEVERITY_CHIP[iv.severity] ?? "chip-muted"}`}>
                      {iv.severity}
                    </span>
                  </td>
                </tr>
              ))}
              {s.intervals.length === 0 && (
                <tr><td colSpan={5} className="muted">No intervals on this schedule.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      ))}

      <p className="hint">
        Intervals come first on whichever axis is reached sooner — mileage or time. Mileage is
        projected from the last known odometer reading, so a car driven harder comes due earlier.
      </p>
    </div>
  );
}
