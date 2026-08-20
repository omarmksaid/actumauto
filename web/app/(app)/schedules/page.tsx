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
  const [cat, setCat] = useState("all");
  const [search, setSearch] = useState("");

  function startEdit(sv: ServiceOffering) {
    setEditing(sv.id); setAdding(false); setErr(null);
    setDraft({ name: sv.name, description: sv.description ?? "", category: sv.category ?? "maintenance",
               typical_duration_min: sv.typical_duration_min ?? "",
               aliases: ((sv as any).aliases ?? []).join(", ") });
  }
  function startAdd() {
    setAdding(true); setEditing(null); setErr(null);
    setDraft({ name: "", description: "", category: "maintenance", typical_duration_min: "", aliases: "" });
  }

  async function save() {
    if (!draft?.name?.trim()) { setErr("Name is required."); return; }
    const body = {
      name: draft.name.trim(),
      description: draft.description?.trim() || null,
      category: draft.category || null,
      typical_duration_min: draft.typical_duration_min ? parseInt(draft.typical_duration_min, 10) : null,
      aliases: String(draft.aliases ?? "").split(",").map((a: string) => a.trim()).filter(Boolean),
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

  const editorFields = (
    <div>
        <div style={{ display: "grid", gap: 10, gridTemplateColumns: "1fr 1fr", alignItems: "start" }}>
          <label style={{ gridColumn: "1 / -1" }}>
            <div className="hint" style={{ marginBottom: 4 }}>Service name</div>
            <input value={draft?.name ?? ""} onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="Brake pad replacement" autoFocus style={{ width: "100%" }} />
          </label>
          <label style={{ gridColumn: "1 / -1" }}>
            <div className="hint" style={{ marginBottom: 4 }}>
              What it involves <span style={{ fontWeight: 400 }}>— the agent reads this aloud</span>
            </div>
            <textarea rows={2} value={draft?.description ?? ""} style={{ width: "100%", resize: "vertical" }}
              placeholder="Front or rear brake pad replacement with rotor inspection."
              onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          </label>
          <label>
            <div className="hint" style={{ marginBottom: 4 }}>Category</div>
            <select value={draft?.category ?? "maintenance"} style={{ width: "100%" }}
              onChange={(e) => setDraft({ ...draft, category: e.target.value })}>
              {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <label>
            <div className="hint" style={{ marginBottom: 4 }}>Typical duration (minutes)</div>
            <input type="number" value={draft?.typical_duration_min ?? ""} placeholder="45"
              onChange={(e) => setDraft({ ...draft, typical_duration_min: e.target.value })} />
          </label>
          <label style={{ gridColumn: "1 / -1" }}>
            <div className="hint" style={{ marginBottom: 4 }}>
              Also matches <span style={{ fontWeight: 400 }}>— what callers say for this, comma-separated</span>
            </div>
            <input value={draft?.aliases ?? ""} style={{ width: "100%" }}
              placeholder="CEL, check engine, warning light"
              onChange={(e) => setDraft({ ...draft, aliases: e.target.value })} />
          </label>
          <div style={{ gridColumn: "1 / -1", display: "flex", gap: 8 }}>
            <button className="btn btn-primary" onClick={save}>Save</button>
            <button className="btn btn-quiet" onClick={() => { setEditing(null); setAdding(false); }}>Cancel</button>
          </div>
        </div>
    </div>
  );

  const cats = [...new Set(services.map((sv) => sv.category ?? "other"))].sort();
  const shown = services.filter((sv) => {
    if (cat !== "all" && (sv.category ?? "other") !== cat) return false;
    if (!search.trim()) return true;
    const t = search.toLowerCase();
    return sv.name.toLowerCase().includes(t)
      || (sv.description ?? "").toLowerCase().includes(t)
      || ((sv as any).aliases ?? []).some((a: string) => a.toLowerCase().includes(t));
  });
  const grouped = cats
    .map((c) => [c, shown.filter((sv) => (sv.category ?? "other") === c)] as [string, ServiceOffering[]])
    .filter(([, list]) => list.length);

  return (
    <div>
      <div className="row-between" style={{ marginBottom: 10, gap: 10, flexWrap: "wrap" }}>
        <p className="hint" style={{ margin: 0, flex: "1 1 260px" }}>
          The agent answers &ldquo;do you do X?&rdquo; from this list only, and never quotes a price.
        </p>
        <div style={{ display: "flex", gap: 8 }}>
          <input placeholder="Search services or aliases" value={search}
            onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 230 }} />
          {canEdit && !adding && <button className="btn btn-primary" onClick={startAdd}>Add service</button>}
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        {[["all", `All · ${services.length}`] as [string, string],
          ...cats.map((c) => [c, `${c[0].toUpperCase()}${c.slice(1)} · ${services.filter((sv) => (sv.category ?? "other") === c).length}`] as [string, string])
        ].map(([k, label]) => (
          <button key={k} onClick={() => setCat(k)} style={{
            border: "1px solid var(--line)", cursor: "pointer", padding: "5px 13px", borderRadius: 999,
            font: "inherit", fontSize: 13, fontWeight: 600,
            background: cat === k ? "var(--ink)" : "var(--surface)",
            color: cat === k ? "#fff" : "var(--muted)",
          }}>{label}</button>
        ))}
      </div>

      {adding && <div className="card card-pad" style={{ marginBottom: 14 }}>{editorFields}</div>}
      {err && <div className="banner banner-error" style={{ marginBottom: 12 }}>{err}</div>}

      {grouped.map(([category, list]) => (
        <div key={category} style={{ marginBottom: 20 }}>
          <div className="section-label" style={{ marginBottom: 8 }}>{category}</div>
          <div className="card" style={{ overflow: "hidden" }}>
            {list.map((sv, idx) => editing === sv.id ? (
              <div key={sv.id} className="card-pad" style={{ borderTop: idx ? "1px solid var(--line)" : undefined, background: "var(--bg)" }}>
                {editorFields}
              </div>
            ) : (
              <div key={sv.id} style={{
                display: "flex", alignItems: "flex-start", gap: 14, padding: "14px 18px",
                borderTop: idx ? "1px solid var(--line)" : undefined,
                opacity: sv.active ? 1 : 0.55,
              }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ fontWeight: 650 }}>{sv.name}</span>
                    {!sv.active && (
                      <span className="chip chip-muted">not offered — agent declines</span>
                    )}
                  </div>
                  {sv.description && <div className="hint" style={{ marginTop: 2 }}>{sv.description}</div>}
                  <div className="hint" style={{ marginTop: 4, fontSize: 12.5 }}>
                    {((sv as any).aliases ?? []).length > 0
                      ? <>Also matches: {((sv as any).aliases ?? []).join(", ")}</>
                      : <span style={{ opacity: 0.7 }}>No aliases — callers must say the exact name</span>}
                  </div>
                </div>
                <span className="hint" style={{ flexShrink: 0, minWidth: 56, textAlign: "right" }}>
                  {sv.typical_duration_min ? `${sv.typical_duration_min} min` : "—"}
                </span>
                {canEdit ? (
                  <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                    <button className="btn" onClick={() => startEdit(sv)}>Edit</button>
                    <button className="btn" onClick={() => toggle(sv)}>{sv.active ? "Hide" : "Offer"}</button>
                    <button className="btn btn-quiet" onClick={() => remove(sv)}>Remove</button>
                  </div>
                ) : (
                  <span className={`chip ${sv.active ? "chip-ok" : "chip-muted"}`}>
                    {sv.active ? "offered" : "hidden"}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}

      {grouped.length === 0 && (
        <div className="card card-pad muted">
          {services.length === 0
            ? "No services yet — the agent will transfer every service question until you add some."
            : "No services match that filter."}
        </div>
      )}
    </div>
  );
}
