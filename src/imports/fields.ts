/**
 * Target-field registry for CSV import (PLAN.md §3).
 *
 * Extensible by design: adding a new importable field = one entry here (label, required,
 * coercion, synonyms). The fuzzy auto-guess (guess.ts) and the import worker (worker) both
 * read this list — nothing else changes.
 *
 * `entity` says which row the field lands on: the customer or their vehicle. A single CSV row
 * becomes one customer + one vehicle (deduped downstream).
 */

export type FieldType = "string" | "email" | "phone" | "int" | "date";
export type Entity = "customer" | "vehicle";

export interface TargetField {
  key: string;              // canonical key used in column_map + by the worker
  label: string;            // shown in the mapping UI
  entity: Entity;
  type: FieldType;
  required: boolean;
  // Normalized synonyms the fuzzy matcher scores source headers against.
  synonyms: string[];
}

export const TARGET_FIELDS: TargetField[] = [
  // ── Customer ──
  { key: "full_name", label: "Full name", entity: "customer", type: "string", required: true,
    synonyms: ["name", "full name", "customer", "customer name", "client", "contact", "owner", "first last"] },
  { key: "email", label: "Email", entity: "customer", type: "email", required: true,
    synonyms: ["email", "e-mail", "email address", "mail"] },
  { key: "phone", label: "Phone", entity: "customer", type: "phone", required: true,
    synonyms: ["phone", "phone number", "cell", "cellphone", "mobile", "tel", "telephone", "contact number"] },

  // ── Vehicle ──
  { key: "make", label: "Make", entity: "vehicle", type: "string", required: true,
    synonyms: ["make", "manufacturer", "brand", "vehicle make"] },
  { key: "model", label: "Model", entity: "vehicle", type: "string", required: true,
    synonyms: ["model", "vehicle model", "car model"] },
  { key: "year", label: "Year", entity: "vehicle", type: "int", required: true,
    synonyms: ["year", "model year", "vehicle year", "yr", "my"] },
  { key: "sold_on", label: "Purchase / sold date", entity: "vehicle", type: "date", required: true,
    synonyms: ["sold on", "sold date", "sale date", "purchase date", "date sold", "delivery date", "purchased", "bought"] },
  { key: "mileage", label: "Mileage (odometer)", entity: "vehicle", type: "int", required: true,
    synonyms: ["mileage", "miles", "odometer", "odo", "km", "kilometers", "current mileage"] },

  // ── Vehicle (optional but valuable) ──
  { key: "mileage_as_of", label: "Mileage as-of date", entity: "vehicle", type: "date", required: false,
    synonyms: ["mileage date", "odometer date", "mileage as of", "reading date", "as of"] },
  { key: "vin", label: "VIN", entity: "vehicle", type: "string", required: false,
    synonyms: ["vin", "vin number", "vehicle id", "vehicle identification number", "chassis"] },
  { key: "trim", label: "Trim", entity: "vehicle", type: "string", required: false,
    synonyms: ["trim", "trim level", "grade", "package"] },
  { key: "last_service_on", label: "Last service date", entity: "vehicle", type: "date", required: false,
    synonyms: ["last service", "last service date", "last visit", "last ro date", "serviced on"] },
  { key: "mileage_at_last_service", label: "Mileage at last service", entity: "vehicle", type: "int", required: false,
    synonyms: ["mileage at service", "last service mileage", "service odometer", "ro mileage"] },
];

export const REQUIRED_FIELDS = TARGET_FIELDS.filter(f => f.required).map(f => f.key);

export function fieldByKey(key: string): TargetField | undefined {
  return TARGET_FIELDS.find(f => f.key === key);
}
