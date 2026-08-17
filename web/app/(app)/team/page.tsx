"use client";

import { useEffect, useState } from "react";
import { apiCall } from "@/lib/api";
import { isDemo } from "@/lib/supabase";
import { demoTeam } from "@/lib/data";

export default function TeamPage() {
  const [data, setData] = useState<any>(isDemo ? demoTeam : null);
  const [loading, setLoading] = useState(!isDemo);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("advisor");
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    if (isDemo) return;
    try { setData(await apiCall("/team")); }
    catch (e: any) { setError(e.message); } finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    if (!email) return;
    setError(null); setMsg(null);
    if (isDemo) {
      setData({ ...data, invites: [...data.invites, { email, role, expires_at: null, accepted_at: null }] });
      setEmail(""); setMsg("Invite created (demo)."); return;
    }
    try {
      await apiCall("/team/invites", { method: "POST", body: JSON.stringify({ email, role }) });
      setEmail(""); setMsg(`Invite sent to ${email}.`); await load();
    } catch (e: any) { setError(e.message); }
  }

  async function revoke(inviteEmail: string) {
    if (isDemo) { setData({ ...data, invites: data.invites.filter((i: any) => i.email !== inviteEmail) }); return; }
    await apiCall("/team/invites", { method: "DELETE", body: JSON.stringify({ email: inviteEmail }) });
    await load();
  }

  if (loading) return <div className="muted">Loading…</div>;
  if (!data) return <div className="banner banner-error">{error ?? "Could not load team."}</div>;

  return (
    <div>
      <h1 className="page-title">Team</h1>
      <p className="page-sub">Invite service advisors under your dealership.</p>
      {isDemo && <div className="banner banner-warn" style={{ marginBottom: 16 }}>Demo data.</div>}
      {error && <div className="banner banner-error" style={{ marginBottom: 16 }}>{error}</div>}
      {msg && <div className="banner banner-ok" style={{ marginBottom: 16 }}>{msg}</div>}

      <form onSubmit={invite} className="card card-pad" style={{ display: "flex", gap: 10, alignItems: "flex-end", marginBottom: 16 }}>
        <label style={{ flex: 1 }}><div className="hint">Email</div><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="advisor@dealership.com" /></label>
        <label><div className="hint">Role</div>
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="advisor">Advisor</option>
            <option value="admin">Admin</option>
          </select>
        </label>
        <button className="btn btn-primary" type="submit">Send invite</button>
      </form>

      <div className="card">
        <div className="card-pad section-label" style={{ marginBottom: 0 }}>Members</div>
        <table>
          <thead><tr><th>Email</th><th>Role</th><th>Phone</th></tr></thead>
          <tbody>
            {data.members.map((m: any) => (
              <tr key={m.user_id}>
                <td>{m.email}</td>
                <td><span className="chip chip-muted">{m.role}</span></td>
                <td className="hint">{m.phone ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {data.invites.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-pad section-label" style={{ marginBottom: 0 }}>Pending invites</div>
          <table>
            <thead><tr><th>Email</th><th>Role</th><th>Expires</th><th></th></tr></thead>
            <tbody>
              {data.invites.map((inv: any) => (
                <tr key={inv.email}>
                  <td>{inv.email}</td>
                  <td><span className="chip chip-muted">{inv.role}</span></td>
                  <td className="hint">{inv.expires_at ? new Date(inv.expires_at).toLocaleDateString() : "—"}</td>
                  <td><button className="btn" onClick={() => revoke(inv.email)}>Revoke</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
