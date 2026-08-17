import { env } from "../lib/env";
import { BookingProvider } from "./types";
import { softBooking } from "./soft";

/**
 * Resolve the active booking provider. Until a real myKaarma adapter + credentials exist, this is
 * always `softBooking`. When myKaarmaBooking lands, gate on env.MYKAARMA_API_KEY here — the call
 * flow doesn't change (PLAN.md §2).
 */
export function getBookingProvider(): BookingProvider {
  // if (env.MYKAARMA_API_KEY) return myKaarmaBooking;
  return softBooking;
}

export type { BookingProvider } from "./types";
