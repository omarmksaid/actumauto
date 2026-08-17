"use client";

import { useEffect, useState } from "react";
import { apiCall } from "@/lib/api";
import { isDemo } from "@/lib/supabase";
import { demoFunnel } from "@/lib/data";

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

  const f = data.funnel;
  const a = data.appointments;

  return (
    <div>
      <h1 className="page-title">Today</h1>
      <p className="page-sub">Where every reminder stands — from slotted to a shown appointment.</p>
      {isDemo && <div className="banner banner-warn" style={{ marginBottom: 16 }}>Demo data.</div>}

      <div className="section-label">Outreach funnel</div>
      <div className="grid-4">
        <Stat n={f.slotted} label="Slotted for calls" />
        <Stat n={f.called} label="Called" />
        <Stat n={f.answered} label="Answered" />
        <Stat n={f.booked} label="Booked" accent />
      </div>
      <div className="grid-4" style={{ marginTop: 16 }}>
        <Stat n={f.no_answer} label="No answer" />
        <Stat n={f.voicemail} label="Voicemail" />
        <Stat n={f.declined} label="Declined" />
        <Stat n={f.spam_or_error} label="Spam / other issues" warn={f.spam_or_error > 0} />
      </div>

      <div className="section-label" style={{ marginTop: 28 }}>Appointments → shown ROs</div>
      <div className="grid-4">
        <Stat n={a.pending_confirmation} label="Pending confirmation" />
        <Stat n={a.confirmed} label="Confirmed" />
        <Stat n={a.shown} label="Shown (real RO)" accent />
        <Stat n={a.no_show} label="No-show" warn={a.no_show > 0} />
      </div>

      <div className="section-label" style={{ marginTop: 28 }}>Number pool health</div>
      <div className="card">
        <table>
          <thead><tr><th>Number</th><th>Answer rate (7d)</th><th>Health</th><th>Today</th><th>Status</th></tr></thead>
          <tbody>
            {data.numbers.map((n: any) => (
              <tr key={n.e164}>
                <td>{n.e164}</td>
                <td>{n.answer_rate_7d != null ? `${Math.round(n.answer_rate_7d * 100)}%` : "—"}</td>
                <td><HealthChip score={n.health_score} /></td>
                <td className="hint">{n.sent_today ?? 0} / {n.daily_cap ?? 400}</td>
                <td>{n.quarantined_at ? <span className="chip chip-hot">quarantined</span>
                  : n.enabled ? <span className="chip chip-ok">active</span>
                  : <span className="chip chip-muted">disabled</span>}</td>
              </tr>
            ))}
            {data.numbers.length === 0 && <tr><td colSpan={5} className="muted">No numbers in the pool yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Stat({ n, label, accent, warn }: { n: number; label: string; accent?: boolean; warn?: boolean }) {
  return (
    <div className="card stat">
      <b style={{ color: accent ? "var(--accent-deep)" : warn && n > 0 ? "var(--hot)" : undefined }}>{n}</b>
      <span>{label}</span>
    </div>
  );
}

function HealthChip({ score }: { score: number | null }) {
  if (score == null) return <span className="chip chip-muted">—</span>;
  if (score >= 0.75) return <span className="chip chip-ok">good</span>;
  if (score >= 0.5) return <span className="chip chip-warm">watch</span>;
  return <span className="chip chip-hot">poor</span>;
}
