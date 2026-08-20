"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { createClient, isDemo } from "@/lib/supabase";

const TIMEZONES = [
  "America/Los_Angeles", "America/Denver", "America/Chicago",
  "America/New_York", "America/Phoenix", "America/Toronto",
];

export default function Signup() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [tz, setTz] = useState("America/Los_Angeles");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (isDemo) { router.push("/dashboard"); return; }
    setLoading(true);
    try {
      const supabase = createClient();

      // 1. Sign up the user.
      const { data: authData, error: authError } = await supabase.auth.signUp({
        email, password, options: { data: { dealership_name: name } },
      });
      if (authError) { setError(authError.message); setLoading(false); return; }
      if (!authData.user?.id) { setError("Signup succeeded but no user id returned."); setLoading(false); return; }

      // Ensure a session (some Supabase configs don't auto-set one on signUp).
      if (!authData.session) {
        const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
        if (signInError) { setError(signInError.message); setLoading(false); return; }
      }

      // 2. create_workspace RPC — dealership + owner membership + default cadence, atomically.
      //    Param names match the ActumAuto RPC (seed.example.sql): p_name, p_timezone.
      const { error: wsError } = await supabase.rpc("create_workspace", {
        p_name: name, p_timezone: tz,
      });
      if (wsError) { setError(wsError.message); setLoading(false); return; }

      router.push("/dashboard");
    } catch (err: any) {
      setError(err.message ?? "Something went wrong");
      setLoading(false);
    }
  }

  return (
    <div style={{ maxWidth: 400, margin: "9vh auto", padding: "0 20px" }}>
      <Link href="/" className="brand" style={{ padding: 0 }}>Actum<em>Auto</em></Link>
      <h1 className="page-title" style={{ marginTop: 18 }}>Create your workspace</h1>
      <p className="page-sub">Set up your dealership&apos;s service-reminder outreach.</p>
      <form onSubmit={handleSubmit} className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <input placeholder="Dealership name (e.g. Milpitas Toyota)" value={name} onChange={(e) => setName(e.target.value)} required={!isDemo} />
        <input type="email" placeholder="you@dealership.com" value={email} onChange={(e) => setEmail(e.target.value)} required={!isDemo} />
        <input type="password" placeholder="Password (8+ characters)" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} required={!isDemo} />
        <select value={tz} onChange={(e) => setTz(e.target.value)}>
          {TIMEZONES.map((z) => <option key={z} value={z}>{z}</option>)}
        </select>
        {error && <p style={{ color: "var(--hot)", fontSize: 14, margin: 0 }}>{error}</p>}
        <button className="btn btn-primary" type="submit" disabled={loading}>
          {loading ? "Creating…" : "Create workspace"}
        </button>
      </form>
      <p style={{ fontSize: 14, color: "var(--muted)", textAlign: "center", marginTop: 16 }}>
        Already have an account? <Link href="/login" style={{ color: "var(--accent-deep)", fontWeight: 600 }}>Sign in</Link>
      </p>
    </div>
  );
}
