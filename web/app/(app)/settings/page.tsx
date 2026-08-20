"use client";

import { useEffect, useState } from "react";
import { apiCall } from "@/lib/api";
import { isDemo } from "@/lib/supabase";
import { demoSettings, demoNumbers, demoInboundSettings } from "@/lib/data";

export default function SettingsPage() {
  const [s, setS] = useState<any>(isDemo ? { ...demoSettings, inbound: demoInboundSettings } : null);
  const [numbers, setNumbers] = useState<any[]>(isDemo ? demoNumbers : []);
  const [loading, setLoading] = useState(!isDemo);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isDemo) return;
    Promise.all([
      apiCall("/settings"),
      apiCall<{ numbers: any[] }>("/settings/numbers"),
    ])
      .then(([settings, n]) => { setS(settings); setNumbers(n.numbers); })
      .catch((e) => setError(e.message)).finally(() => setLoading(false));
  }, []);

  async function save() {
    setError(null); setSaved(false);
    if (isDemo) { setSaved(true); return; }
    try {
      await apiCall("/settings", { method: "PUT", body: JSON.stringify({
        inbound: s.inbound,
        business_hours: s.business_hours,
      }) });
      setSaved(true);
    } catch (e: any) { setError(e.message); }
  }

  if (loading) return <div className="muted">Loading…</div>;
  if (!s) return <div className="banner banner-error">{error ?? "Could not load settings."}</div>;

  const inb = s.inbound ?? {};
  const setInb = (patch: any) => setS({ ...s, inbound: { ...inb, ...patch } });

  return (
    <div>
      <h1 className="page-title">Settings</h1>
      <p className="page-sub">How the agent answers your service line, what it can offer, and which numbers route to it.</p>
      {isDemo && <div className="banner banner-warn" style={{ marginBottom: 16 }}>Demo data — changes aren&apos;t saved.</div>}
      {error && <div className="banner banner-error" style={{ marginBottom: 16 }}>{error}</div>}

      {/* ── Inbound service line (§16) ── */}
      <div className="card card-pad">
        <div className="section-label">Inbound service line</div>
        <p className="hint" style={{ marginTop: -4 }}>
          How the agent answers calls coming into the dealership.
        </p>
        <div className="grid-2">
          <Field label="Transfer to (service line)">
            <input placeholder="+1408…" value={inb.transfer_number ?? ""}
              onChange={(e) => setInb({ transfer_number: e.target.value })} />
          </Field>
          <Field label="Caller identification">
            <select value={inb.identify_mode ?? "caller_id_only"}
              onChange={(e) => setInb({ identify_mode: e.target.value })}>
              <option value="caller_id_only">Caller ID only</option>
              <option value="verbal_verify">Verbally verify on a miss (not yet built)</option>
            </select>
          </Field>
        </div>
        <p className="hint">
          With <b>caller ID only</b>, a caller whose number isn&apos;t on file — or whose number
          matches more than one customer — gets general answers about services and hours, and is
          never read any account or vehicle details.
        </p>
        {!inb.transfer_number && (
          <div className="banner banner-warn" style={{ marginTop: 12 }}>
            No transfer number set. The agent can&apos;t hand callers to a service employee — it
            will take a message instead.
          </div>
        )}
        <Field label="Greeting (optional — leave blank for the default)">
          <input value={inb.greeting ?? ""} onChange={(e) => setInb({ greeting: e.target.value })} />
        </Field>
      </div>

      <div className="row-between" style={{ margin: "20px 0" }}>
        {saved ? <span className="banner banner-ok">Saved.</span> : <span />}
        <button className="btn btn-primary" onClick={save}>Save settings</button>
      </div>

      {/* ── Number pool ── */}
      <NumberPool numbers={numbers} setNumbers={setNumbers} />
    </div>
  );
}

function NumberPool({ numbers, setNumbers }: { numbers: any[]; setNumbers: (n: any[]) => void }) {
  const [e164, setE164] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function add() {
    if (!e164) return;
    if (isDemo) { setNumbers([...numbers, { id: `demo-${Date.now()}`, e164, provider: "telnyx", vapi_phone_id: null, cnam: null, enabled: true }]); setE164(""); return; }
    setBusy(true); setErr(null);
    try {
      const { number } = await apiCall<{ number: any }>("/settings/numbers", { method: "POST", body: JSON.stringify({ e164 }) });
      setNumbers([...numbers, number]); setE164("");
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  async function toggle(n: any) {
    if (isDemo) { setNumbers(numbers.map((x) => x.id === n.id ? { ...x, enabled: !x.enabled } : x)); return; }
    const { number } = await apiCall<{ number: any }>(`/settings/numbers/${n.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !n.enabled }) });
    setNumbers(numbers.map((x) => x.id === n.id ? number : x));
  }

  return (
    <div className="card">
      <div className="card-pad section-label" style={{ marginBottom: 0 }}>Numbers that route to the agent</div>
      <table>
        <thead><tr><th>Number</th><th>Caller ID name</th><th>Vapi number id</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {numbers.map((n) => (
            <tr key={n.id}>
              <td>{n.e164}</td>
              <td className="hint">{n.cnam ?? "—"}</td>
              <td className="hint">{n.vapi_phone_id ?? <span style={{ color: "var(--hot)" }}>not linked</span>}</td>
              <td>{n.enabled ? <span className="chip chip-ok">routing</span> : <span className="chip chip-muted">disabled</span>}</td>
              <td><button className="btn" onClick={() => toggle(n)}>{n.enabled ? "Disable" : "Enable"}</button></td>
            </tr>
          ))}
          {numbers.length === 0 && <tr><td colSpan={5} className="muted">No numbers yet — the agent can\u2019t answer until a number routes to it.</td></tr>}
        </tbody>
      </table>
      <div className="card-pad" style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <input placeholder="+1408…" value={e164} onChange={(e) => setE164(e.target.value)} style={{ maxWidth: 200 }} />
        <button className="btn btn-primary" onClick={add} disabled={busy}>Add number</button>
        {err && <span className="hint" style={{ color: "var(--hot)" }}>{err}</span>}
      </div>
    </div>
  );
}

/**
 * Operating hours. The agent quotes these to callers and REFUSES to capture a booking outside
 * them, so a wrong value here becomes a wrong promise on a live call.
 */
function BusinessHours({ hours, onChange }: { hours: any; onChange: (h: any) => void }) {
  const DAYS: [string, string][] = [
    ["mon", "Monday"], ["tue", "Tuesday"], ["wed", "Wednesday"], ["thu", "Thursday"],
    ["fri", "Friday"], ["sat", "Saturday"], ["sun", "Sunday"],
  ];

  const set = (day: string, idx: 0 | 1, value: string) => {
    const cur = Array.isArray(hours[day]) ? [...hours[day]] : ["09:00", "17:00"];
    cur[idx] = value;
    onChange({ ...hours, [day]: cur });
  };
  const toggle = (day: string) => {
    onChange({ ...hours, [day]: Array.isArray(hours[day]) ? null : ["08:00", "17:00"] });
  };

  return (
    <div className="card card-pad">
      <div className="section-label">Operating hours</div>
      <p className="hint" style={{ marginTop: -4 }}>
        The agent tells callers these hours and won&apos;t take a booking outside them.
      </p>
      <table>
        <tbody>
          {DAYS.map(([key, label]) => {
            const open = Array.isArray(hours[key]);
            return (
              <tr key={key}>
                <td style={{ width: 120 }}>{label}</td>
                <td style={{ width: 110 }}>
                  <button className="btn" onClick={() => toggle(key)}>
                    {open ? "Open" : "Closed"}
                  </button>
                </td>
                <td>
                  {open ? (
                    <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <input type="time" value={hours[key][0]} onChange={(e) => set(key, 0, e.target.value)} style={{ maxWidth: 130 }} />
                      <span className="hint">to</span>
                      <input type="time" value={hours[key][1]} onChange={(e) => set(key, 1, e.target.value)} style={{ maxWidth: 130 }} />
                    </span>
                  ) : <span className="hint">—</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label style={{ display: "block", marginTop: 12 }}><div className="hint" style={{ marginBottom: 4 }}>{label}</div>{children}</label>;
}
function Num({ label, v, on }: { label: string; v: number; on: (v: number) => void }) {
  return <Field label={label}><input type="number" value={v ?? 0} onChange={(e) => on(parseInt(e.target.value, 10))} /></Field>;
}
function Check({ label, v, on }: { label: string; v: boolean; on: (v: boolean) => void }) {
  return <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 24 }}>
    <input type="checkbox" checked={!!v} onChange={(e) => on(e.target.checked)} style={{ width: "auto" }} /> {label}
  </label>;
}
