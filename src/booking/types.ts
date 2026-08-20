/**
 * BookingProvider (PLAN.md §2 booking). Abstracts myKaarma so the call flow never changes when
 * the real adapter arrives. The critical rule: NEVER let the AI claim a firm booking that didn't
 * happen. Booking is a MODE, not a fake stub.
 *
 *  - `soft`  (default until the real adapter exists): capture a preferred time, promise a
 *            confirmation text/call, write a `pending_confirmation` appointment for an advisor to
 *            place. The AI's wording is gated on this mode.
 *  - `live`  (real myKaarma): actually reserves the slot and returns a firm confirmation.
 */

export type BookingMode = "soft" | "live";

export interface AvailabilitySlot {
  startsAt: string;         // ISO
  label: string;            // human phrasing, e.g. "Tuesday at 9:00 AM"
}

export interface CreateAppointmentInput {
  companyId: string;
  customerId: string;
  vehicleId: string | null;
  preferredTime: string;    // free-text or ISO the customer stated
  serviceOps: string[];
  /** Whether they're staying on site. Decides how the shop schedules the work. */
  dropOff?: "waiting" | "dropping_off" | "unknown";
  notes: string;            // includes the AA:<appointment_id> tag for the shown-RO loop (§6b)
}

export interface CreateAppointmentResult {
  appointmentId: string;
  mode: BookingMode;
  firm: boolean;            // true only in live mode with a real reservation
  startsAt: string | null;
  /** Wording the AI is allowed to say back, matched to reality. */
  confirmationText: string;
}

export interface BookingProvider {
  mode: BookingMode;
  getAvailability(companyId: string, rangeStartIso: string, rangeEndIso: string, ops: string[]): Promise<AvailabilitySlot[]>;
  createAppointment(input: CreateAppointmentInput): Promise<CreateAppointmentResult>;
  cancelAppointment(appointmentId: string): Promise<void>;
}
