"use client";

/**
 * Where the emailed reset link lands. Supabase puts the user in a temporary recovery session,
 * so updateUser() is all that's needed to set the new password.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { createClient, isDemo } from "@/lib/supabase";

export default function ResetPassword() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (password.length < 8) { setError("Use at least 8 characters."); return; }
    if (password !== confirm) { setError("Those passwords don't match."); return; }
    if (isDemo) { router.push("/login"); return; }

    setLoading(true);
    const { error: err } = await createClient().auth.updateUser({ password });
    setLoading(false);
    if (err) {
      // Most common cause: the link expired or was already used.
      setError(`${err.message} — request a new reset link if this one has expired.`);
      return;
    }
    router.push("/today");
  }

  return (
    <div style={{ maxWidth: 380, margin: "10vh auto", padding: "0 20px" }}>
      <Link href="/" className="brand" style={{ padding: 0 }}>Actum<em>Auto</em></Link>
      <h1 className="page-title" style={{ marginTop: 18 }}>Choose a new password</h1>
      <form onSubmit={handleSubmit} className="card card-pad"
        style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <input type="password" placeholder="New password" value={password}
          onChange={(e) => setPassword(e.target.value)} required={!isDemo} />
        <input type="password" placeholder="Confirm new password" value={confirm}
          onChange={(e) => setConfirm(e.target.value)} required={!isDemo} />
        {error && <p style={{ color: "var(--hot)", fontSize: 14, margin: 0 }}>{error}</p>}
        <button className="btn btn-primary" type="submit" disabled={loading}>
          {loading ? "Saving…" : "Save password"}
        </button>
      </form>
      <p style={{ fontSize: 14, color: "var(--muted)", textAlign: "center", marginTop: 16 }}>
        <Link href="/forgot-password" style={{ color: "var(--accent-deep)", fontWeight: 600 }}>
          Request a new link
        </Link>
      </p>
    </div>
  );
}
