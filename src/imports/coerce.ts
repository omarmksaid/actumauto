/**
 * Type coercion for imported cell values (PLAN.md §3 step 5).
 * Each returns { value, error? } so the worker can collect per-row errors into imports.stats
 * without aborting the whole import. Used by both the live preview and the import worker.
 */

import { DateTime } from "luxon";
import { FieldType } from "./fields";

export interface Coerced {
  value: string | number | null;
  error?: string;
}

export function coerce(type: FieldType, raw: unknown): Coerced {
  const s = raw == null ? "" : String(raw).trim();
  if (s === "") return { value: null };

  switch (type) {
    case "string":
      return { value: s };

    case "email": {
      const ok = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);
      return ok ? { value: s.toLowerCase() } : { value: null, error: `invalid email "${s}"` };
    }

    case "phone":
      return coercePhone(s);

    case "int": {
      // Strip commas, units, spaces ("52,300 mi" → 52300).
      const digits = s.replace(/[^0-9]/g, "");
      if (!digits) return { value: null, error: `no digits in "${s}"` };
      return { value: parseInt(digits, 10) };
    }

    case "date":
      return coerceDate(s);

    default:
      return { value: s };
  }
}

/** Best-effort E.164. Defaults to US/Canada (+1) when a bare 10-digit number is given. */
export function coercePhone(s: string): Coerced {
  let digits = s.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) {
    const rest = digits.slice(1).replace(/\D/g, "");
    if (rest.length < 8) return { value: null, error: `phone too short "${s}"` };
    return { value: "+" + rest };
  }
  digits = digits.replace(/\D/g, "");
  if (digits.length === 10) return { value: "+1" + digits };
  if (digits.length === 11 && digits.startsWith("1")) return { value: "+" + digits };
  if (digits.length >= 8) return { value: "+" + digits };
  return { value: null, error: `unrecognized phone "${s}"` };
}

const DATE_FORMATS = [
  "M/d/yyyy", "MM/dd/yyyy", "M-d-yyyy", "yyyy-MM-dd", "d/M/yyyy",
  "MMM d, yyyy", "MMMM d, yyyy", "d MMM yyyy", "M/d/yy", "MM/dd/yy",
];

/** Parse a messy date to an ISO date (yyyy-MM-dd). Tries ISO, then common dealership formats. */
export function coerceDate(s: string): Coerced {
  const iso = DateTime.fromISO(s);
  if (iso.isValid) return { value: iso.toISODate() };

  for (const fmt of DATE_FORMATS) {
    const dt = DateTime.fromFormat(s, fmt);
    if (dt.isValid) return { value: dt.toISODate() };
  }
  const js = DateTime.fromJSDate(new Date(s));
  if (js.isValid) return { value: js.toISODate() };

  return { value: null, error: `unparseable date "${s}"` };
}
