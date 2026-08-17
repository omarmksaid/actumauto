"use client";

import { useEffect, useState } from "react";
import { apiCall } from "@/lib/api";
import { isDemo } from "@/lib/supabase";
import { demoSettings, demoNumbers } from "@/lib/data";

export default function SettingsPage() {
  const [s, setS] = useState<any>(isDemo ? demoSettings : null);
  const [numbers, setNumbers] = useState<any[]>(isDemo ? demoNumbers : []);
  const [loading, setLoading] = useState(!isDemo);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isDemo) return;
    Promise.all([apiCall("/settings"), apiCall<{ numbers: any[] }>("/settings/numbers")])
      .then(([settings, n]) => { setS(settings); setNumbers(n.numbers); })
      .catch((e) => setError(e.message)).finally(() => setLoading(false));
  }, []);

  async function save() {
    setError(null); setSaved(false);
    if (isDemo) { setSaved(true); return; }
    try {
      await apiCall("/settings", { method: "PUT", body: JSON.stringify({
        cadence: s.cadence, voice: s.voice, persona_prompt: s.persona_prompt, customer_types: s.customer_types,
      }) });
      setSaved(true);
    } catch (e: any) { setError(e.message); }
  }

  if (loading) return <div className="muted">Loading…</div>;
  if (!s) return <div className="banner banner-error">{error ?? "Could not load settings."}</div>;

  const cad = s.cadence ?? {};
  const setCad = (patch: any) => setS({ ...s, cadence: { ...cad, ...patch } });

  return (
    <div>
      <h1 className="page-title">Settings</h1>
      <p className="page-sub">Follow-up timing, voice &amp; behavior, and your number pool.</p>
      {isDemo && <div className="banner banner-warn" style={{ marginBottom: 16 }}>Demo data — changes aren&apos;t saved.</div>}
      {error && <div className="banner banner-error" style={{ marginBottom: 16 }}>{error}</div>}

      {/* ── Cadence ── */}
      <div className="card card-pad">
        <div className="section-label">Follow-up cadence</div>
        <div className="grid-3">
          <Num label="No-answer retry (min)" v={cad.no_answer_retry_after_min} on={(v) => setCad({ no_answer_retry_after_min: v })} />
          <Num label="Max call attempts" v={cad.max_call_attempts} on={(v) => setCad({ max_call_attempts: v })} />
          <Num label="SMS fallback after (min)" v={cad.sms_fallback_after_min} on={(v) => setCad({ sms_fallback_after_min: v })} />
          <Num label="Email fallback after (min)" v={cad.email_fallback_after_min} on={(v) => setCad({ email_fallback_after_min: v })} />
          <Field label="Quiet hours start"><input type="time" value={cad.quiet_start ?? "20:00"} onChange={(e) => setCad({ quiet_start: e.target.value })} /></Field>
          <Field label="Quiet hours end"><input type="time" value={cad.quiet_end ?? "09:00"} onChange={(e) => setCad({ quiet_end: e.target.value })} /></Field>
        </div>
        <div className="grid-3" style={{ marginTop: 12 }}>
          <Field label="On voicemail">
            <select value={cad.on_machine ?? "drop_message"} onChange={(e) => setCad({ on_machine: e.target.value })}>
              <option value="drop_message">Drop a message</option>
              <option value="hangup">Hang up</option>
            </select>
          </Field>
          <Check label="Voicemail counts as attempt" v={cad.voicemail_counts_as_attempt} on={(v) => setCad({ voicemail_counts_as_attempt: v })} />
          <Check label="Immediate SMS after voicemail" v={cad.voicemail_sms_immediate} on={(v) => setCad({ voicemail_sms_immediate: v })} />
        </div>
        <Field label="Appointment reminder offsets (min before, comma-separated)">
          <input value={(cad.reminder_offsets_min ?? []).join(", ")}
            onChange={(e) => setCad({ reminder_offsets_min: e.target.value.split(",").map((x: string) => parseInt(x.trim(), 10)).filter((n: number) => !isNaN(n)) })} />
        </Field>
      </div>

      {/* ── Voice & persona ── */}
      <div className="card card-pad">
        <div className="section-label">Voice &amp; behavior</div>
        <div className="grid-2">
          <Field label="TTS provider">
            <select value={s.voice?.provider ?? "cartesia"} onChange={(e) => setS({ ...s, voice: { ...s.voice, provider: e.target.value } })}>
              <option value="cartesia">Cartesia</option>
              <option value="deepgram">Deepgram Aura-2</option>
              <option value="11labs">ElevenLabs</option>
            </select>
          </Field>
          <Field label="Voice ID"><input value={s.voice?.voice_id ?? ""} onChange={(e) => setS({ ...s, voice: { ...s.voice, voice_id: e.target.value } })} /></Field>
        </div>
        <Field label="Behavior prompt (wraps hardcoded guardrails)">
          <textarea rows={4} value={s.persona_prompt ?? ""} onChange={(e) => setS({ ...s, persona_prompt: e.target.value })} />
        </Field>
        <Field label="Customer types (comma-separated)">
          <input value={(s.customer_types ?? []).join(", ")}
            onChange={(e) => setS({ ...s, customer_types: e.target.value.split(",").map((x: string) => x.trim()).filter(Boolean) })} />
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
    if (isDemo) { setNumbers([...numbers, { id: `demo-${Date.now()}`, e164, provider: "telnyx", enabled: true, weight: 1, daily_cap: 400, sent_today: 0, effective_cap_today: 20, ramp_started_on: new Date().toISOString().slice(0, 10), answer_rate_7d: null, health_score: null, quarantined_at: null }]); setE164(""); return; }
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
      <div className="card-pad section-label" style={{ marginBottom: 0 }}>Number pool (volume knobs &amp; health)</div>
      <table>
        <thead><tr><th>Number</th><th>CNAM</th><th>Weight</th><th>Today / cap</th><th>Answer 7d</th><th>Ramp</th><th></th></tr></thead>
        <tbody>
          {numbers.map((n) => (
            <tr key={n.id}>
              <td>{n.e164}{n.quarantined_at && <span className="chip chip-hot" style={{ marginLeft: 8 }}>quarantined</span>}</td>
              <td className="hint">{n.cnam ?? "—"}</td>
              <td>{n.weight}</td>
              <td className="hint">{n.sent_today ?? 0} / {n.effective_cap_today ?? n.daily_cap}</td>
              <td className="hint">{n.answer_rate_7d != null ? `${Math.round(n.answer_rate_7d * 100)}%` : "—"}</td>
              <td className="hint">{n.effective_cap_today < n.daily_cap ? `ramping (${n.effective_cap_today})` : "full"}</td>
              <td><button className="btn" onClick={() => toggle(n)}>{n.enabled ? "Disable" : "Enable"}</button></td>
            </tr>
          ))}
          {numbers.length === 0 && <tr><td colSpan={7} className="muted">No numbers yet.</td></tr>}
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
