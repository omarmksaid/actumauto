"use client";

/**
 * Marketing landing page.
 *
 * The root used to redirect straight to /today, which meant anyone who wasn't already signed in
 * hit a login wall with no explanation of what the product is. Now: what we do, a contact-sales
 * form (dealerships are sold to, not self-served), and a clearly separated client portal for
 * existing customers.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { createClient, isDemo } from "@/lib/supabase";

export default function Landing() {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  useEffect(() => {
    const params = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
    // /?contact=1 opens the form directly, so "Contact sales" links elsewhere land on it.
    if (params?.get("contact") === "1") setOpen(true);

    if (isDemo) return;
    // ...but an explicit ?contact=1 means they WANT the marketing page, even signed in.
    if (params?.get("contact") === "1") return;

    // Signed-in visitors go to the dashboard. The page still RENDERS for everyone — gating it
    // behind a session check would ship an empty marketing page to crawlers and slow connections.
    let cancelled = false;
    createClient().auth.getSession().then(({ data: { session } }) => {
      if (!cancelled && session) router.replace("/dashboard");
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [router]);

  return (
    <div style={{ background: "var(--bg)", minHeight: "100vh" }}>
      <header style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "18px 28px", borderBottom: "1px solid var(--line)", background: "var(--surface)",
        position: "sticky", top: 0, zIndex: 10,
      }}>
        <div className="brand" style={{ padding: 0, fontSize: 19 }}>Actum<em>Auto</em></div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <button className="btn btn-primary" onClick={() => setOpen(true)}>Contact sales</button>
          <Link href="/login" className="btn">Client portal</Link>
        </div>
      </header>

      <main style={{ maxWidth: 940, margin: "0 auto", padding: "0 28px 80px" }}>
        <section style={{ padding: "76px 0 56px", textAlign: "center" }}>
          <h1 style={{ fontSize: 44, lineHeight: 1.12, letterSpacing: "-0.02em", margin: "0 0 18px" }}>
            Your service line, answered every time.
          </h1>
          <p style={{ fontSize: 18, color: "var(--muted)", maxWidth: 620, margin: "0 auto 30px", lineHeight: 1.55 }}>
            ActumAuto picks up when your service department can&apos;t. It knows who&apos;s calling,
            what they drive, and what their car is due for — and hands the call to your team the
            moment a person is needed.
          </p>
          <button className="btn btn-primary" style={{ padding: "11px 26px", fontSize: 15 }}
            onClick={() => setOpen(true)}>
            Contact sales
          </button>
        </section>

        <section className="grid-3" style={{ marginBottom: 20 }}>
          <Card title="Knows the caller"
            body="Recognizes customers by phone number and greets them by name — no account numbers, no menus. Unrecognized callers are never told someone else's details." />
          <Card title="Knows the car"
            body="Pulls their vehicle and projects what's due from mileage and service history, so it can recommend the right work without guessing." />
          <Card title="Books the visit"
            body="Captures a preferred time inside your real operating hours and passes it to your advisors to confirm." />
        </section>
        <section className="grid-3">
          <Card title="Answers service questions"
            body="Describes exactly the services you offer — nothing invented, and never a price it isn't authorized to quote." />
          <Card title="Hands off cleanly"
            body="&quot;Where's my car?&quot; always goes to a person. Every handoff is logged, so a caller is never dropped." />
          <Card title="Every call on record"
            body="Recordings, transcripts, and outcomes in one dashboard — with the callback queue front and center." />
        </section>

        <section style={{
          marginTop: 56, padding: "34px 30px", background: "var(--surface)",
          border: "1px solid var(--line)", borderRadius: "var(--radius)",
          display: "flex", alignItems: "center", justifyContent: "space-between", gap: 22, flexWrap: "wrap",
        }}>
          <div>
            <div style={{ fontSize: 19, fontWeight: 650, marginBottom: 6 }}>See it on your own service line</div>
            <div className="hint" style={{ fontSize: 14 }}>
              We&apos;ll set it up with your customer list and walk your advisors through it.
            </div>
          </div>
          <button className="btn btn-primary" onClick={() => setOpen(true)}>Contact sales</button>
        </section>
      </main>

      <footer style={{
        borderTop: "1px solid var(--line)", background: "var(--surface)",
        padding: "20px 28px", display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 10,
      }}>
        <span className="hint">© {new Date().getFullYear()} ActumAuto</span>
        <Link href="/login" className="hint" style={{ color: "var(--accent-deep)", fontWeight: 600 }}>
          Client portal →
        </Link>
      </footer>

      {open && <ContactSales onClose={() => setOpen(false)} />}
    </div>
  );
}

function Card({ title, body }: { title: string; body: string }) {
  return (
    <div className="card card-pad">
      <div style={{ fontWeight: 650, marginBottom: 8 }}>{title}</div>
      <div className="hint" style={{ fontSize: 13.5, lineHeight: 1.55 }}>{body}</div>
    </div>
  );
}

function ContactSales({ onClose }: { onClose: () => void }) {
  const [f, setF] = useState({
    first_name: "", last_name: "", dealership_name: "", dealership_address: "",
    email: "", phone: "", notes: "",
  });
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const res = await apiFetch("/leads", { method: "POST", body: JSON.stringify(f) });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error || "Something went wrong. Please try again.");
      }
      setSent(true);
    } catch (err: any) {
      setError(err.message);
    } finally { setBusy(false); }
  }

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(22,34,46,0.45)",
      display: "flex", alignItems: "center", justifyContent: "center", padding: 20, zIndex: 50,
    }}>
      <div onClick={(e) => e.stopPropagation()} className="card card-pad"
        style={{ width: "100%", maxWidth: 520, maxHeight: "90vh", overflowY: "auto" }}>
        {sent ? (
          <div style={{ textAlign: "center", padding: "26px 0" }}>
            <div style={{ fontSize: 19, fontWeight: 650, marginBottom: 8 }}>Thanks — we&apos;ll be in touch.</div>
            <p className="hint">Someone from our team will reach out shortly.</p>
            <button className="btn" style={{ marginTop: 18 }} onClick={onClose}>Close</button>
          </div>
        ) : (
          <form onSubmit={submit}>
            <div className="row-between" style={{ marginBottom: 4 }}>
              <div style={{ fontSize: 18, fontWeight: 650 }}>Contact sales</div>
              <button type="button" className="btn btn-quiet" onClick={onClose}>Close</button>
            </div>
            <p className="hint" style={{ marginTop: 0 }}>
              Tell us about your dealership and we&apos;ll get you set up.
            </p>
            {error && <div className="banner banner-error" style={{ marginBottom: 12 }}>{error}</div>}

            <div className="grid-2">
              <Field label="First name *"><input value={f.first_name} onChange={set("first_name")} required /></Field>
              <Field label="Last name *"><input value={f.last_name} onChange={set("last_name")} required /></Field>
            </div>
            <Field label="Dealership name *">
              <input value={f.dealership_name} onChange={set("dealership_name")} placeholder="Milpitas Toyota" required />
            </Field>
            <Field label="Dealership address">
              <input value={f.dealership_address} onChange={set("dealership_address")} placeholder="1350 S Park Victoria Dr, Milpitas, CA" />
            </Field>
            <div className="grid-2">
              <Field label="Work email"><input type="email" value={f.email} onChange={set("email")} /></Field>
              <Field label="Phone"><input value={f.phone} onChange={set("phone")} /></Field>
            </div>
            <Field label="Anything we should know?">
              <textarea rows={3} value={f.notes} onChange={set("notes")} />
            </Field>

            <button className="btn btn-primary" style={{ width: "100%", marginTop: 16 }} disabled={busy}>
              {busy ? "Sending…" : "Send"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "block", marginTop: 12 }}>
      <div className="hint" style={{ marginBottom: 4 }}>{label}</div>
      {children}
    </label>
  );
}
