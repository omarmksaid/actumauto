"use client";

/**
 * Password reset request. Supabase emails the link; /reset-password handles the return.
 *
 * Always reports success, even for an unknown address — otherwise the form doubles as a way to
 * discover which emails have accounts.
 */

import Link from "next/link";
import { useState } from "react";
import { createClient, isDemo } from "@/lib/supabase";

export default function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(""); setLoading(true);
    if (isDemo) { setSent(true); setLoading(false); return; }
    const supabase = createClient();
    const { error: err } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    setLoading(false);
    // Deliberately not surfacing "user not found" — that would leak which emails exist.
    if (err && !/not found|invalid/i.test(err.message)) { setError(err.message); return; }
    setSent(true);
  }

  return (
    <div style={{ maxWidth: 380, margin: "10vh auto", padding: "0 20px" }}>
      <Link href="/" className="brand" style={{ padding: 0 }}>Actum<em>Auto</em></Link>
      <h1 className="page-title" style={{ marginTop: 18 }}>Reset your password</h1>

      {sent ? (
        <div className="card card-pad">
          <p style={{ margin: 0 }}>
            If an account exists for <b>{email}</b>, we&apos;ve sent a reset link. Check your inbox.
          </p>
          <Link href="/login" className="btn" style={{ marginTop: 16, display: "inline-block" }}>
            Back to sign in
          </Link>
        </div>
      ) : (
        <>
          <p className="page-sub">We&apos;ll email you a link to set a new one.</p>
          <form onSubmit={handleSubmit} className="card card-pad"
            style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <input type="email" placeholder="you@dealership.com" value={email}
              onChange={(e) => setEmail(e.target.value)} required={!isDemo} />
            {error && <p style={{ color: "var(--hot)", fontSize: 14, margin: 0 }}>{error}</p>}
            <button className="btn btn-primary" type="submit" disabled={loading}>
              {loading ? "Sending…" : "Send reset link"}
            </button>
          </form>
          <p style={{ fontSize: 14, color: "var(--muted)", textAlign: "center", marginTop: 16 }}>
            <Link href="/login" style={{ color: "var(--accent-deep)", fontWeight: 600 }}>Back to sign in</Link>
          </p>
        </>
      )}
    </div>
  );
}
