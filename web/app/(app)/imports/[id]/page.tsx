"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { apiCall } from "@/lib/api";
import { isDemo } from "@/lib/supabase";

interface TargetField {
  key: string; label: string; entity: "customer" | "vehicle";
  type: string; required: boolean;
}

interface UploadResult {
  import: { id: string; filename: string; status: string };
  headers: string[];
  targetFields: TargetField[];
  guess: Record<string, string>;      // targetKey -> header
  confidence: Record<string, number>;
  sample: Record<string, string>[];
}

// Demo payload so the mapping UI is explorable with zero backend.
const DEMO: UploadResult = {
  import: { id: "demo", filename: "sample_customers.csv", status: "parsing" },
  headers: ["Customer Name", "Cell Phone", "E-Mail", "Make", "Model", "Model Yr", "Date Sold", "Odometer", "VIN #"],
  targetFields: [
    { key: "full_name", label: "Full name", entity: "customer", type: "string", required: true },
    { key: "email", label: "Email", entity: "customer", type: "email", required: true },
    { key: "phone", label: "Phone", entity: "customer", type: "phone", required: true },
    { key: "make", label: "Make", entity: "vehicle", type: "string", required: true },
    { key: "model", label: "Model", entity: "vehicle", type: "string", required: true },
    { key: "year", label: "Year", entity: "vehicle", type: "int", required: true },
    { key: "sold_on", label: "Purchase / sold date", entity: "vehicle", type: "date", required: true },
    { key: "mileage", label: "Mileage (odometer)", entity: "vehicle", type: "int", required: true },
    { key: "mileage_as_of", label: "Mileage as-of date", entity: "vehicle", type: "date", required: false },
    { key: "vin", label: "VIN", entity: "vehicle", type: "string", required: false },
    { key: "trim", label: "Trim", entity: "vehicle", type: "string", required: false },
    { key: "last_service_on", label: "Last service date", entity: "vehicle", type: "date", required: false },
    { key: "mileage_at_last_service", label: "Mileage at last service", entity: "vehicle", type: "int", required: false },
  ],
  guess: {
    full_name: "Customer Name", phone: "Cell Phone", email: "E-Mail", make: "Make",
    model: "Model", year: "Model Yr", sold_on: "Date Sold", mileage: "Odometer", vin: "VIN #",
  },
  confidence: { full_name: 0.85, phone: 0.85, email: 0.6, year: 0.5 },
  sample: [
    { "Customer Name": "Maria Chen", "Cell Phone": "(408) 555-0142", "E-Mail": "maria@example.com", "Make": "Toyota", "Model": "RAV4", "Model Yr": "2022", "Date Sold": "3/14/2022", "Odometer": "31,200", "VIN #": "JTMB1234500000001" },
    { "Customer Name": "Devon Park", "Cell Phone": "408-555-0199", "E-Mail": "devon@example.com", "Make": "Toyota", "Model": "Camry", "Model Yr": "2021", "Date Sold": "07/02/2021", "Odometer": "48,905", "VIN #": "4T1B1234500000002" },
  ],
};

export default function ImportMappingPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [data, setData] = useState<UploadResult | null>(null);
  const [map, setMap] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      if (isDemo) { setData(DEMO); setMap(DEMO.guess); setLoading(false); return; }
      try {
        // The upload response is cached client-side in a real build; here we re-fetch the
        // import + its stored headers/sample. (GET /imports/:id returns import + targetFields;
        // headers/sample live in import.stats from the upload step.)
        const res = await apiCall<{ import: any; targetFields: TargetField[] }>(`/imports/${id}`);
        const imp = res.import;
        setData({
          import: imp,
          headers: imp.stats?.headers ?? [],
          targetFields: res.targetFields,
          guess: imp.column_map ?? {},
          confidence: imp.stats?.confidence ?? {},
          sample: imp.stats?.sample ?? [],
        });
        setMap(imp.column_map ?? {});
      } catch (e: any) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [id]);

  const missingRequired = useMemo(() => {
    if (!data) return [];
    return data.targetFields.filter((f) => f.required && !map[f.key]).map((f) => f.label);
  }, [data, map]);

  async function save(run: boolean) {
    if (isDemo) { setError("Demo mode — connect Supabase to save the mapping and import."); return; }
    setSaving(true); setError(null);
    try {
      await apiCall(`/imports/${id}/mapping`, { method: "PUT", body: JSON.stringify({ columnMap: map }) });
      if (run) await apiCall(`/imports/${id}/run`, { method: "POST" });
      router.push("/imports");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="muted">Loading…</div>;
  if (!data) return <div className="banner banner-error">{error ?? "Import not found."}</div>;

  const customerFields = data.targetFields.filter((f) => f.entity === "customer");
  const vehicleFields = data.targetFields.filter((f) => f.entity === "vehicle");

  return (
    <div>
      <h1 className="page-title">Map columns</h1>
      <p className="page-sub">{data.import.filename} — confirm which column feeds each field.</p>

      {isDemo && <div className="banner banner-warn" style={{ marginBottom: 16 }}>Demo mode — mapping is illustrative.</div>}
      {error && <div className="banner banner-error" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="grid-2">
        <div className="card card-pad">
          <div className="section-label">Customer</div>
          {customerFields.map((f) => (
            <MapRow key={f.key} field={f} headers={data.headers} value={map[f.key]}
              confidence={data.confidence[f.key]} onChange={(h) => setMap({ ...map, [f.key]: h })} />
          ))}
        </div>
        <div className="card card-pad">
          <div className="section-label">Vehicle</div>
          {vehicleFields.map((f) => (
            <MapRow key={f.key} field={f} headers={data.headers} value={map[f.key]}
              confidence={data.confidence[f.key]} onChange={(h) => setMap({ ...map, [f.key]: h })} />
          ))}
        </div>
      </div>

      <div className="card" style={{ marginTop: 20 }}>
        <div className="card-pad section-label" style={{ marginBottom: 0 }}>
          Preview — first {data.sample.length} rows as mapped
        </div>
        <div className="preview-table">
          <table>
            <thead>
              <tr>{data.targetFields.filter((f) => map[f.key]).map((f) => <th key={f.key}>{f.label}</th>)}</tr>
            </thead>
            <tbody>
              {data.sample.map((row, i) => (
                <tr key={i}>
                  {data.targetFields.filter((f) => map[f.key]).map((f) => (
                    <td key={f.key}>{row[map[f.key]] ?? <span className="muted">—</span>}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="row-between" style={{ marginTop: 20 }}>
        <div>
          {missingRequired.length > 0
            ? <span className="banner banner-warn">Map required fields: {missingRequired.join(", ")}</span>
            : <span className="banner banner-ok">All required fields mapped.</span>}
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button className="btn" disabled={saving || missingRequired.length > 0} onClick={() => save(false)}>
            Save mapping
          </button>
          <button className="btn btn-primary" disabled={saving || missingRequired.length > 0} onClick={() => save(true)}>
            {saving ? "Starting…" : "Save & import"}
          </button>
        </div>
      </div>
    </div>
  );
}

function MapRow({ field, headers, value, confidence, onChange }: {
  field: TargetField; headers: string[]; value?: string; confidence?: number;
  onChange: (header: string) => void;
}) {
  const lowConf = value && confidence != null && confidence < 0.6;
  return (
    <div className="map-row">
      <div>
        {field.label}{field.required && <span className="req-star"> *</span>}
        <div className="hint">{field.type}</div>
      </div>
      <select value={value ?? ""} onChange={(e) => onChange(e.target.value)}>
        <option value="">— not mapped —</option>
        {headers.map((h) => <option key={h} value={h}>{h}</option>)}
      </select>
      <div className="hint">
        {value ? (lowConf ? <span style={{ color: "var(--warm)" }}>check</span> : <span style={{ color: "var(--ok)" }}>guessed</span>) : ""}
      </div>
    </div>
  );
}
