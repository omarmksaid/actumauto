/**
 * Soft booking provider (PLAN.md §2). The default until real myKaarma exists.
 *
 * It does NOT reserve a slot. It captures the customer's preferred time and writes a
 * `pending_confirmation` appointment for an advisor to place manually — and returns wording that
 * only ever promises a follow-up confirmation, never a firm booking. This is what keeps the AI
 * honest: "worse than not calling" is telling someone they're booked when they aren't.
 */

import { supabaseAdmin } from "../lib/supabase";
import {
  AvailabilitySlot, BookingProvider, CreateAppointmentInput, CreateAppointmentResult,
} from "./types";

export const softBooking: BookingProvider = {
  mode: "soft",

  // No live calendar in soft mode — availability is advisory only; the AI collects a preferred time.
  async getAvailability(): Promise<AvailabilitySlot[]> {
    return [];
  },

  async createAppointment(input: CreateAppointmentInput): Promise<CreateAppointmentResult> {
    const { data, error } = await supabaseAdmin.from("appointments").insert({
      company_id: input.companyId,
      customer_id: input.customerId,
      vehicle_id: input.vehicleId,
      provider: "soft",
      preferred_time: input.preferredTime,
      service_ops: { ops: input.serviceOps },
      drop_off: input.dropOff ?? "unknown",
      starts_at: input.startsAt?.toISOString() ?? null,
      ends_at: input.startsAt
        ? new Date(input.startsAt.getTime() + (input.durationMin ?? 45) * 60_000).toISOString()
        : null,
      notes: input.notes,
      status: "pending_confirmation",
    }).select("id").single();
    if (error) throw error;

    // Tag the notes with our appointment id for the shown-RO loop (§6b), then persist.
    const tag = `AA:${data.id}`;
    await supabaseAdmin.from("appointments")
      .update({ notes: `${input.notes} ${tag}`.trim() }).eq("id", data.id);

    return {
      appointmentId: data.id,
      mode: "soft",
      firm: false,
      startsAt: null,
      confirmationText:
        `Got it — I've noted you'd like to come in around ${input.preferredTime}. ` +
        `Our service team will text you shortly to confirm the exact time. Thanks!`,
    };
  },

  async cancelAppointment(appointmentId: string): Promise<void> {
    await supabaseAdmin.from("appointments")
      .update({ status: "canceled" }).eq("id", appointmentId);
  },
};
