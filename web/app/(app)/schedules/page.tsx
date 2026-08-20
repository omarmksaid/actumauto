"use client";

/**
 * Services — the catalog we offer, plus the maintenance intervals behind every recommendation.
 *
 * Both live here because they answer the same question from a caller's point of view: what can you
 * do for my car, and what does it need next. Editing either changes what the agent says on the
 * NEXT call, so rows are editable in place rather than hidden behind a separate settings screen.
 *
 * Advisors get read-only. The server enforces that (requireAdmin); this just avoids showing
 * buttons that would 403.
 */

import { useEffect, useState } from "react";
import { apiCall } from "@/lib/api";
import { isDemo } from "@/lib/supabase";
import { demoSchedules, demoServices, ScheduleRow, ServiceOffering } from "@/lib/data";

const SEVERITY_CHIP: Record<string, string> = {
  standard: "chip-muted", major: "chip-warm", safety: "chip-hot",
};
const CATEGORIES = ["maintenance", "repair", "inspection", "tires", "diagnostic", "warranty", "other"];

export default function ServicesPage() {
  const [services, setServices] = useState<ServiceOffering[]>(isDemo ? demoServices : []);
  const [schedules, setSchedules] = useState<ScheduleRow[]>(isDemo ? demoSchedules : []);
  const [role, setRole] = useState<string>(isDemo ? "owner" : "advisor");
  const [loading, setLoading] = useState(!isDemo);
  const [error, setError] = useState<string | null>(null);

  const canEdit = role === "owner" || role === "admin";

  useEffect(() => {
    if (isDemo) return;
    Promise.all([
      apiCall<{ services: ServiceOffering[] }>("/settings/services"),
      apiCall<{ schedules: ScheduleRow[] }>("/schedules"),
      apiCall<{ role: string }>("/agent/me").catch(() => ({ role: "advisor" })),
    ])
      .then(([sv, sc, me]) => { setServices(sv.services); setSchedules(sc.schedules); setRole(me.role); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="muted">Loading…</div>;

  return (
    <div>
      <h1 className="page-title">Services</h1>
      <p className="page-sub">
        What we offer, and the maintenance intervals behind every recommendation. Changes apply on
        the next call.
      </p>
      {isDemo && <div className="banner banner-warn" style={{ marginBottom: 16 }}>Demo data.</div>}
      {error && <div className="banner banner-error" style={{ marginBottom: 16 }}>{error}</div>}
      {!canEdit && (
        <div className="banner banner-warn" style={{ marginBottom: 16 }}>
          You have advisor access — this page is read-only. An admin can make changes.
        </div>
      )}

      <ServiceCatalog services={services} setServices={setServices} canEdit={canEdit} />

      <div className="section-label" style={{ marginTop: 30 }}>Maintenance schedules</div>
      <p className="hint" style={{ marginTop: -6, marginBottom: 12 }}>
        Intervals come first on whichever axis is reached sooner — mileage or time. Mileage is
        projected from the last known odometer reading.
      </p>

      {schedules.length === 0 && (
        <div className="banner banner-warn">
          No schedules loaded — the agent can&apos;t tell callers what&apos;s due.
        </div>
      )}

      {schedules.map((s) => (
        <div className="card" key={s.id} style={{ marginBottom: 16 }}>
          <div className="card-pad" style={{ paddingBottom: 8 }}>
            <div className="row-between">
              <div>
                <b style={{ fontSize: 15 }}>
                  {s.make}{s.model ? ` ${s.model}` : " — all models"}
                  {s.year_from || s.year_to ? ` (${s.year_from ?? "…"}–${s.year_to ?? "…"})` : ""}
                </b>
                <div className="hint">{s.source ?? "—"}</div>
              </div>
              <span className={`chip ${s.is_global ? "chip-muted" : "chip-ai"}`}>
                {s.is_global ? "built-in default" : "your dealership"}
              </span>
            </div>
            {s.notes && <p className="hint" style={{ marginTop: 8, marginBottom: 0 }}>{s.notes}</p>}
            {s.is_global && canEdit && (
              <p className="hint" style={{ marginTop: 8, marginBottom: 0 }}>
                Built-in schedules are shared across dealerships and can&apos;t be edited. Add your
                own for this make to override it.
              </p>
            )}
          </div>
          <table>
            <thead><tr><th>Mileage</th><th>Time</th><th>Service</th><th>Type</th></tr></thead>
            <tbody>
              {s.intervals.map((iv) => (
                <tr key={iv.id}>
                  <td>{iv.mileage != null ? `${iv.mileage.toLocaleString()} mi` : "—"}</td>
                  <td className="hint">{iv.months != null ? `${iv.months} mo` : "—"}</td>
                  <td>{iv.service_name}</td>
                  <td><span className={`chip ${SEVERITY_CHIP[iv.severity] ?? "chip-muted"}`}>{iv.severity}</span></td>
                </tr>
              ))}
              {s.intervals.length === 0 && <tr><td colSpan={4} className="muted">No intervals.</td></tr>}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

/** The services catalog — the ONLY things the agent will say we offer. Rows edit in place. */
function ServiceCatalog({ services, setServices, canEdit }:
  { services: ServiceOffering[]; setServices: (s: ServiceOffering[]) => void; canEdit: boolean }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<any>(null);
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function startEdit(sv: ServiceOffering) {
    setEditing(sv.id); setAdding(false); setErr(null);
    setDraft({ name: sv.name, description: sv.description ?? "", category: sv.category ?? "maintenance",
               typical_duration_min: sv.typical_duration_min ?? "" });
  }
  function startAdd() {
    setAdding(true); setEditing(null); setErr(null);
    setDraft({ name: "", description: "", category: "maintenance", typical_duration_min: "" });
  }

  async function save() {
    if (!draft?.name?.trim()) { setErr("Name is required."); return; }
    const body = {
      name: draft.name.trim(),
      description: draft.description?.trim() || null,
      category: draft.category || null,
      typical_duration_min: draft.typical_duration_min ? parseInt(draft.typical_duration_min, 10) : null,
    };
    try {
      if (adding) {
        if (isDemo) setServices([...services, { id: `demo-${Date.now()}`, operations: [], active: true, ...body } as ServiceOffering]);
        else {
          const { service } = await apiCall<{ service: ServiceOffering }>("/settings/services",
            { method: "POST", body: JSON.stringify(body) });
          setServices([...services, service]);
        }
      } else {
        if (isDemo) setServices(services.map((x) => x.id === editing ? { ...x, ...body } as ServiceOffering : x));
        else {
          const { service } = await apiCall<{ service: ServiceOffering }>(`/settings/services/${editing}`,
            { method: "PATCH", body: JSON.stringify(body) });
          setServices(services.map((x) => x.id === editing ? service : x));
        }
      }
      setEditing(null); setAdding(false); setDraft(null);
    } catch (e: any) { setErr(e.message); }
  }

  async function toggle(sv: ServiceOffering) {
    if (isDemo) { setServices(services.map((x) => x.id === sv.id ? { ...x, active: !x.active } : x)); return; }
    const { service } = await apiCall<{ service: ServiceOffering }>(`/settings/services/${sv.id}`,
      { method: "PATCH", body: JSON.stringify({ active: !sv.active }) });
    setServices(services.map((x) => x.id === sv.id ? service : x));
  }

  async function remove(sv: ServiceOffering) {
    if (isDemo) { setServices(services.filter((x) => x.id !== sv.id)); return; }
    await apiCall(`/settings/services/${sv.id}`, { method: "DELETE" });
    setServices(services.filter((x) => x.id !== sv.id));
  }

  const editor = (
    <tr>
      <td colSpan={5} style={{ background: "var(--bg)" }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label style={{ flex: "1 1 170px" }}>
            <div className="hint" style={{ marginBottom: 4 }}>Service name</div>
            <input value={draft?.name ?? ""} onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="Brake pad replacement" autoFocus />
          </label>
          <label style={{ flex: "2 1 240px" }}>
            <div className="hint" style={{ marginBottom: 4 }}>What it involves</div>
            <input value={draft?.description ?? ""} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          </label>
          <label style={{ flex: "0 1 130px" }}>
            <div className="hint" style={{ marginBottom: 4 }}>Category</div>
            <select value={draft?.category ?? "maintenance"} onChange={(e) => setDraft({ ...draft, category: e.target.value })}>
              {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <label style={{ flex: "0 1 100px" }}>
            <div className="hint" style={{ marginBottom: 4 }}>Minutes</div>
            <input type="number" value={draft?.typical_duration_min ?? ""}
              onChange={(e) => setDraft({ ...draft, typical_duration_min: e.target.value })} />
          </label>
          <button className="btn btn-primary" onClick={save}>Save</button>
          <button className="btn btn-quiet" onClick={() => { setEditing(null); setAdding(false); }}>Cancel</button>
        </div>
        {err && <div className="hint" style={{ color: "var(--hot)", marginTop: 8 }}>{err}</div>}
      </td>
    </tr>
  );

  return (
    <div className="card">
      <div className="card-pad" style={{ paddingBottom: 0 }}>
        <div className="row-between">
          <div>
            <div className="section-label" style={{ marginBottom: 4 }}>Services we offer</div>
            <p className="hint">
              The agent answers &ldquo;do you do X?&rdquo; from this list only, and never quotes a price.
            </p>
          </div>
          {canEdit && !adding && <button className="btn btn-primary" onClick={startAdd}>Add service</button>}
        </div>
      </div>
      <table>
        <thead><tr><th>Service</th><th>Category</th><th>Duration</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {adding && editor}
          {services.map((sv) => editing === sv.id ? <tr key={sv.id}>{editor.props.children}</tr> : (
            <tr key={sv.id}>
              <td>{sv.name}<div className="hint">{sv.description ?? "—"}</div></td>
              <td className="hint">{sv.category ?? "—"}</td>
              <td className="hint">{sv.typical_duration_min ? `${sv.typical_duration_min} min` : "—"}</td>
              <td><span className={`chip ${sv.active ? "chip-ok" : "chip-muted"}`}>{sv.active ? "active" : "hidden"}</span></td>
              <td style={{ whiteSpace: "nowrap", textAlign: "right" }}>
                {canEdit ? (
                  <>
                    <button className="btn" onClick={() => startEdit(sv)}>Edit</button>{" "}
                    <button className="btn" onClick={() => toggle(sv)}>{sv.active ? "Hide" : "Show"}</button>{" "}
                    <button className="btn btn-quiet" onClick={() => remove(sv)}>Remove</button>
                  </>
                ) : <span className="hint">—</span>}
              </td>
            </tr>
          ))}
          {services.length === 0 && !adding && (
            <tr><td colSpan={5} className="muted">
              No services yet — the agent will transfer every service question until you add some.
            </td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
