"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { apiCall } from "@/lib/api";
import { isDemo } from "@/lib/supabase";
import { demoCallDetail } from "@/lib/data";

export default function CallDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<any>(isDemo ? demoCallDetail : null);
  const [loading, setLoading] = useState(!isDemo);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isDemo) return;
    apiCall(`/agent/calls/${id}`).then(setData).catch((e) => setError(e.message)).finally(() => setLoading(false));
  }, [id]);

  if (loading) return <div className="muted">Loading…</div>;
  if (error) return <div className="banner banner-error">{error}</div>;
  if (!data) return null;

  const { call } = data;
  const transcript = data.transcript ?? [];   // never let a missing list white-screen the page

  return (
    <div>
      <Link href="/calls" className="hint">← Calls</Link>
      <h1 className="page-title" style={{ marginTop: 8 }}>{call.customers?.full_name ?? "Call"}</h1>
      <p className="page-sub">
        {call.outcome?.replace(/_/g, " ")} · {new Date(call.created_at).toLocaleString()}
        {call.cost_usd != null && ` · $${call.cost_usd.toFixed(2)}`}
      </p>
      {isDemo && <div className="banner banner-warn" style={{ marginBottom: 16 }}>Demo data — no audio in demo mode.</div>}

      <div className="card card-pad">
        <div className="section-label">Recording</div>
        {call.recording_url
          ? <audio controls src={call.recording_url} />
          : <div className="muted hint">No recording available.</div>}
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-pad section-label" style={{ marginBottom: 0 }}>Transcript</div>
        <div className="thread">
          {transcript.length === 0 && <div className="muted hint">No transcript.</div>}
          {transcript.map((t: any, i: number) => (
            <div key={i} className={`bubble bubble-${t.role === "ai" ? "ai" : t.role === "customer" ? "customer" : "system"}`}>
              {t.content}
              {t.ts && <time>{new Date(t.ts).toLocaleTimeString()}</time>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
