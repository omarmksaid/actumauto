"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { createClient, isDemo } from "@/lib/supabase";

export default function Login() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [removed, setRemoved] = useState(false);

  useEffect(() => {
    if (typeof window !== "undefined") {
      setRemoved(new URLSearchParams(window.location.search).get("removed") === "1");
    }
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (isDemo) { router.push("/today"); return; }  // demo: no auth, straight in
    setLoading(true);
    const supabase = createClient();
    const { error: authError } = await supabase.auth.signInWithPassword({ email, password });
    if (authError) { setError(authError.message); setLoading(false); return; }
    router.push("/today");
  }

  return (
    <div style={{ maxWidth: 380, margin: "10vh auto", padding: "0 20px" }}>
      <Link href="/" className="brand" style={{ padding: 0 }}>Actum<em>Auto</em></Link>
      <h1 className="page-title" style={{ marginTop: 18 }}>Sign in</h1>
      <p className="page-sub">Use your work email.</p>
      <form onSubmit={handleSubmit} className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <input type="email" placeholder="you@dealership.com" value={email} onChange={(e) => setEmail(e.target.value)} required={!isDemo} />
        <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required={!isDemo} />
        {removed && !error && (
          <p style={{ color: "var(--muted)", fontSize: 14, margin: 0 }}>
            You no longer have access to that workspace. Sign in again, or ask an admin to re-invite you.
          </p>
        )}
        {error && <p style={{ color: "var(--hot)", fontSize: 14, margin: 0 }}>{error}</p>}
        <button className="btn btn-primary" type="submit" disabled={loading}>
          {loading ? "Signing in…" : "Sign in"}
        </button>
      </form>
      <p style={{ fontSize: 14, color: "var(--muted)", textAlign: "center", marginTop: 14 }}>
        <Link href="/forgot-password" style={{ color: "var(--accent-deep)", fontWeight: 600 }}>
          Forgot your password?
        </Link>
      </p>
      {/* Dealerships are sold to, not self-served — so this points at sales, not signup. */}
      <p style={{ fontSize: 14, color: "var(--muted)", textAlign: "center", marginTop: 4 }}>
        New dealership? <Link href="/?contact=1" style={{ color: "var(--accent-deep)", fontWeight: 600 }}>Contact sales</Link>
      </p>
    </div>
  );
}
