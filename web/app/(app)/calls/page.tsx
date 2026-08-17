"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiCall } from "@/lib/api";
import { isDemo } from "@/lib/supabase";
import { demoCalls, CallRow } from "@/lib/data";

const OUTCOME_CHIP: Record<string, string> = {
  booked: "chip-ok", answered: "chip-ai", declined: "chip-warm",
  no_answer: "chip-muted", voicemail_dropped: "chip-muted",
  bad_number: "chip-hot", carrier_rejected: "chip-hot", provider_error: "chip-hot",
};

export default function CallsPage() {
  const router = useRouter();
  const [calls, setCalls] = useState<CallRow[]>(isDemo ? demoCalls : []);
  const [loading, setLoading] = useState(!isDemo);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isDemo) return;
    apiCall<{ calls: CallRow[] }>("/agent/calls")
      .then((r) => setCalls(r.calls)).catch((e) => setError(e.message)).finally(() => setLoading(false));
  }, []);

  return (
    <div>
      <h1 className="page-title">Calls</h1>
      <p className="page-sub">Every AI service-reminder call — play back the recording, read the transcript.</p>
      {isDemo && <div className="banner banner-warn" style={{ marginBottom: 16 }}>Demo data.</div>}
      {error && <div className="banner banner-error">{error}</div>}

      <div className="card">
        {loading ? <div className="card-pad muted">Loading…</div> : (
          <table>
            <thead><tr><th>Customer</th><th>Outcome</th><th>Duration</th><th>Cost</th><th>When</th></tr></thead>
            <tbody>
              {calls.map((call) => (
                <tr key={call.id} className="rowlink" onClick={() => router.push(`/calls/${call.id}`)}>
                  <td>{call.customers?.full_name ?? "—"}<div className="hint">{call.customers?.phone}</div></td>
                  <td>{call.outcome ? <span className={`chip ${OUTCOME_CHIP[call.outcome] ?? "chip-muted"}`}>{call.outcome.replace(/_/g, " ")}</span> : "—"}</td>
                  <td className="hint">{fmtDur(call.duration_sec)}</td>
                  <td className="hint">{call.cost_usd != null ? `$${call.cost_usd.toFixed(2)}` : "—"}</td>
                  <td className="hint">{new Date(call.created_at).toLocaleString()}</td>
                </tr>
              ))}
              {calls.length === 0 && <tr><td colSpan={5} className="muted">No calls yet.</td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function fmtDur(s: number | null): string {
  if (!s) return "—";
  const m = Math.floor(s / 60), r = s % 60;
  return m ? `${m}m ${r}s` : `${r}s`;
}
