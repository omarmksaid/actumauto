"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { apiCall } from "@/lib/api";
import { isDemo } from "@/lib/supabase";
import { demoCustomer } from "@/lib/data";

export default function CustomerPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<any>(isDemo ? demoCustomer : null);
  const [loading, setLoading] = useState(!isDemo);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isDemo) return;
    apiCall(`/agent/customers/${id}`).then(setData).catch((e) => setError(e.message)).finally(() => setLoading(false));
  }, [id]);

  if (loading) return <div className="muted">Loading…</div>;
  if (error) return <div className="banner banner-error">{error}</div>;
  if (!data) return null;

  const { customer, vehicles, recentCalls, recentMessages, appointments } = data;
  const personality = customer.personality?.summary;

  return (
    <div>
      <Link href="/directory" className="hint">← Directory</Link>
      <div className="row-between" style={{ marginTop: 8, alignItems: "flex-start" }}>
        <div>
          <h1 className="page-title">{customer.full_name}</h1>
          <p className="page-sub">
            {customer.phone} · {customer.email}
            {customer.customer_type && <> · <span className="chip chip-muted">{customer.customer_type}</span></>}
            {customer.opted_out && <> · <span className="chip chip-hot">opted out</span></>}
          </p>
        </div>
      </div>
      {isDemo && <div className="banner banner-warn" style={{ marginBottom: 16 }}>Demo data.</div>}

      <div className="grid-2">
        <div>
          <div className="card card-pad">
            <div className="section-label">Vehicles &amp; upcoming service</div>
            {vehicles.map((v: any) => (
              <div key={v.id} className="doc-row" style={{ display: "block", padding: "12px 0" }}>
                <div style={{ fontWeight: 600 }}>{v.year} {v.make} {v.model}{v.trim ? ` ${v.trim}` : ""}</div>
                <div className="hint">
                  {v.mileage?.toLocaleString() ?? "?"} mi
                  {v.avg_miles_per_day && ` · ~${Math.round(v.avg_miles_per_day)} mi/day`}
                  {v.last_service_on && ` · last service ${new Date(v.last_service_on).toLocaleDateString()}`}
                  {v.vin && ` · VIN ${v.vin}`}
                </div>
              </div>
            ))}
            {vehicles.length === 0 && <div className="muted hint">No vehicles on file.</div>}
          </div>

          {personality && (
            <div className="card card-pad">
              <div className="section-label">Personality (from past conversations)</div>
              <div>{personality}</div>
            </div>
          )}

          <div className="card card-pad">
            <div className="section-label">Appointments</div>
            {appointments.map((a: any) => (
              <div key={a.id} className="doc-row">
                <span>{a.starts_at ? new Date(a.starts_at).toLocaleString() : a.preferred_time ?? "—"}</span>
                <span className="chip chip-muted">{a.status.replace(/_/g, " ")}</span>
              </div>
            ))}
            {appointments.length === 0 && <div className="muted hint">None.</div>}
          </div>
        </div>

        <div>
          <div className="card card-pad">
            <div className="section-label">Recent calls</div>
            {recentCalls.map((c: any) => (
              <Link key={c.id} href={`/calls/${c.id}`} className="doc-row rowlink" style={{ display: "flex" }}>
                <span>{new Date(c.created_at).toLocaleDateString()}</span>
                <span className="chip chip-muted">{c.outcome?.replace(/_/g, " ") ?? "—"}</span>
              </Link>
            ))}
            {recentCalls.length === 0 && <div className="muted hint">None.</div>}
          </div>

          <div className="card card-pad">
            <div className="section-label">Recent messages</div>
            {recentMessages.map((m: any, i: number) => (
              <div key={i} className="doc-row" style={{ display: "block", padding: "10px 0" }}>
                <div className="hint">{m.channel} · {m.direction} · {new Date(m.created_at).toLocaleDateString()}</div>
                <div>{m.content}</div>
              </div>
            ))}
            {recentMessages.length === 0 && <div className="muted hint">None.</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
