"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase";
import { apiCall } from "@/lib/api";

function JoinForm() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const token = searchParams.get("token") ?? "";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [phone, setPhone] = useState("");
  const [company, setCompany] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [inviteLoaded, setInviteLoaded] = useState(false);

  // An invite is bound to an email — resolve it and lock the field. The API re-checks against the
  // verified JWT regardless; pinning here just prevents the mistake.
  useEffect(() => {
    if (!token) { setInviteLoaded(true); setError("Missing invite token. Use the link from your email."); return; }
    (async () => {
      try {
        const inv = await apiCall<{ email: string; company: string | null }>(`/team/invite?token=${encodeURIComponent(token)}`);
        setEmail(inv.email); setCompany(inv.company);
      } catch (e: any) {
        setError(e?.message ?? "This invite link is no longer valid.");
      } finally { setInviteLoaded(true); }
    })();
  }, [token]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!email || !password) { setError("Email and password are required."); return; }
    if (!token) { setError("Missing invite token."); return; }
    setLoading(true);
    try {
      const supabase = createClient();

      // Existing account is a normal case on an invite link — try sign-in, else sign up.
      let signedIn = false;
      const { error: signInErr } = await supabase.auth.signInWithPassword({ email, password });
      if (!signInErr) signedIn = true;
      if (!signedIn) {
        const { data, error: signUpErr } = await supabase.auth.signUp({ email, password });
        if (signUpErr) { setError(signUpErr.message); setLoading(false); return; }
        if (!data.session) {
          const { error: e2 } = await supabase.auth.signInWithPassword({ email, password });
          if (e2) { setError(e2.message); setLoading(false); return; }
        }
      }

      // Accept: creates the membership from the invite (JWT-verified server-side).
      await apiCall("/team/accept", { method: "POST", body: JSON.stringify({ token, phone: phone || null }) });
      router.push("/dashboard");
    } catch (e: any) {
      setError(e.message ?? "Something went wrong");
      setLoading(false);
    }
  }

  if (!inviteLoaded) return <div className="muted" style={{ margin: "10vh auto", textAlign: "center" }}>Loading invite…</div>;

  return (
    <div style={{ maxWidth: 380, margin: "9vh auto", padding: "0 20px" }}>
      <Link href="/" className="brand" style={{ padding: 0 }}>Actum<em>Auto</em></Link>
      <h1 className="page-title" style={{ marginTop: 18 }}>Join{company ? ` ${company}` : ""}</h1>
      <p className="page-sub">Set a password to accept your invite.</p>
      <form onSubmit={handleSubmit} className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <input type="email" value={email} readOnly placeholder="you@dealership.com" style={{ background: "var(--bg)" }} />
        <input type="password" placeholder="Choose a password (8+)" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} required />
        <input type="tel" placeholder="Mobile (optional — for on-call texts)" value={phone} onChange={(e) => setPhone(e.target.value)} />
        {error && <p style={{ color: "var(--hot)", fontSize: 14, margin: 0 }}>{error}</p>}
        <button className="btn btn-primary" type="submit" disabled={loading}>{loading ? "Joining…" : "Accept invite"}</button>
      </form>
    </div>
  );
}

export default function Join() {
  return <Suspense fallback={<div className="muted" style={{ margin: "10vh auto", textAlign: "center" }}>Loading…</div>}><JoinForm /></Suspense>;
}
