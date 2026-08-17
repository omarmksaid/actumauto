/**
 * Import worker (PLAN.md §3 step 5–6): registered on the `import` pg-boss queue.
 *
 * Streams the stored CSV, applies the confirmed column_map, coerces types, and upserts
 * customers + vehicles + vehicle_mileage. Per-row errors are collected into imports.stats
 * instead of aborting — a dealership CSV with 20 bad rows should still import the other 980.
 *
 * Dedup: customers on (company_id, phone|email); vehicles on (company_id, vin) when present,
 * else (customer_id, make, model, year).
 */

import Papa from "papaparse";
import type PgBoss from "pg-boss";
import { supabaseAdmin } from "../lib/supabase";
import { TARGET_FIELDS } from "./fields";
import { coerce } from "./coerce";
import { deriveAvgMilesPerDay } from "./mileage";

interface ImportJob { importId: string; }

interface RowError { row: number; field?: string; message: string; }

export function registerImport(boss: PgBoss) {
  return boss.work<ImportJob>("import", { batchSize: 1 }, async ([job]) => {
    const { importId } = job.data;
    const { data: imp } = await supabaseAdmin
      .from("imports").select("*").eq("id", importId).single();
    if (!imp) return;

    await supabaseAdmin.from("imports").update({ status: "importing" }).eq("id", importId);

    try {
      const csv = await downloadCsv(imp.storage_path);
      const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true });
      const rows = parsed.data;
      const map: Record<string, string> = imp.column_map ?? {};

      const errors: RowError[] = [];
      let customersUpserted = 0, vehiclesUpserted = 0, skipped = 0;

      for (let i = 0; i < rows.length; i++) {
        const raw = rows[i];
        const rowNum = i + 2; // +1 header, +1 to 1-index

        // Coerce every mapped field.
        const vals: Record<string, string | number | null> = {};
        let rowFailed = false;
        for (const field of TARGET_FIELDS) {
          const header = map[field.key];
          if (!header) continue;
          const { value, error } = coerce(field.type, raw[header]);
          if (error) {
            errors.push({ row: rowNum, field: field.key, message: error });
            if (field.required) rowFailed = true;
          }
          vals[field.key] = value;
        }

        // A row needs a contact handle + the required identity fields.
        if (rowFailed || (!vals.phone && !vals.email) || !vals.full_name) {
          skipped++;
          if (!rowFailed) errors.push({ row: rowNum, message: "missing required contact/identity fields" });
          continue;
        }

        try {
          const customerId = await upsertCustomer(imp.company_id, vals);
          customersUpserted++;
          const changed = await upsertVehicle(imp.company_id, customerId, vals);
          if (changed) vehiclesUpserted++;
        } catch (e: any) {
          errors.push({ row: rowNum, message: `db: ${e.message}` });
          skipped++;
        }
      }

      await supabaseAdmin.from("imports").update({
        status: "done",
        row_count: rows.length,
        stats: {
          rows: rows.length, customers_upserted: customersUpserted,
          vehicles_upserted: vehiclesUpserted, skipped,
          error_count: errors.length, errors: errors.slice(0, 500),
        },
      }).eq("id", importId);
    } catch (e: any) {
      await supabaseAdmin.from("imports")
        .update({ status: "failed", error: e.message }).eq("id", importId);
      throw e;
    }
  });
}

async function downloadCsv(path: string): Promise<string> {
  const { data, error } = await supabaseAdmin.storage.from("imports").download(path);
  if (error || !data) throw new Error(`download failed: ${error?.message ?? "no data"}`);
  return await data.text();
}

async function upsertCustomer(companyId: string, v: Record<string, any>): Promise<string> {
  // Match an existing customer by phone, then email, within the company.
  let existing: { id: string } | null = null;
  if (v.phone) {
    const { data } = await supabaseAdmin.from("customers")
      .select("id").eq("company_id", companyId).eq("phone", v.phone).maybeSingle();
    existing = data;
  }
  if (!existing && v.email) {
    const { data } = await supabaseAdmin.from("customers")
      .select("id").eq("company_id", companyId).eq("email", v.email).maybeSingle();
    existing = data;
  }

  const patch = {
    full_name: v.full_name, email: v.email ?? null, phone: v.phone ?? null,
    updated_at: new Date().toISOString(),
  };

  if (existing) {
    await supabaseAdmin.from("customers").update(patch).eq("id", existing.id);
    return existing.id;
  }
  const { data, error } = await supabaseAdmin.from("customers")
    .insert({ company_id: companyId, ...patch }).select("id").single();
  if (error) throw error;
  return data.id;
}

/** Returns true if a vehicle row was inserted or updated. */
async function upsertVehicle(companyId: string, customerId: string, v: Record<string, any>): Promise<boolean> {
  if (!v.make || !v.model || !v.year) return false;

  // Dedup on VIN if present, else (customer, make, model, year).
  let existing: { id: string } | null = null;
  if (v.vin) {
    const { data } = await supabaseAdmin.from("vehicles")
      .select("id").eq("company_id", companyId).eq("vin", v.vin).maybeSingle();
    existing = data;
  }
  if (!existing) {
    const { data } = await supabaseAdmin.from("vehicles")
      .select("id").eq("customer_id", customerId)
      .eq("make", v.make).eq("model", v.model).eq("year", v.year).maybeSingle();
    existing = data;
  }

  const avg = deriveAvgMilesPerDay({
    mileage: v.mileage ?? null,
    soldOn: v.sold_on ?? null,
    mileageAsOf: v.mileage_as_of ?? v.sold_on ?? null,
    lastServiceOn: v.last_service_on ?? null,
    mileageAtLastService: v.mileage_at_last_service ?? null,
  });

  const patch = {
    make: v.make, model: v.model, year: v.year,
    sold_on: v.sold_on ?? null, mileage: v.mileage ?? null,
    mileage_as_of: v.mileage_as_of ?? null,
    last_service_on: v.last_service_on ?? null,
    mileage_at_last_service: v.mileage_at_last_service ?? null,
    vin: v.vin ?? null, trim: v.trim ?? null,
    avg_miles_per_day: avg,
    updated_at: new Date().toISOString(),
  };

  let vehicleId: string;
  if (existing) {
    await supabaseAdmin.from("vehicles").update(patch).eq("id", existing.id);
    vehicleId = existing.id;
  } else {
    const { data, error } = await supabaseAdmin.from("vehicles")
      .insert({ company_id: companyId, customer_id: customerId, ...patch }).select("id").single();
    if (error) throw error;
    vehicleId = data.id;
  }

  // Accumulate odometer snapshots for the slope (§2 vehicle_mileage).
  if (v.mileage != null && (v.mileage_as_of || v.sold_on)) {
    await supabaseAdmin.from("vehicle_mileage").insert({
      company_id: companyId, vehicle_id: vehicleId,
      mileage: v.mileage, observed_on: v.mileage_as_of ?? v.sold_on, source: "csv",
    });
  }
  return true;
}
