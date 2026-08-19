/**
 * Seed a dealership for an end-to-end inbound test.
 *
 * Idempotent: re-running updates rather than duplicating. Pass the caller's mobile number so the
 * agent recognizes them; omit it to seed everything except the test customer.
 *
 *   npx tsx scripts/seed-pilot.ts [+1XXXXXXXXXX]
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import ws from "ws";

const VAPI_PHONE_ID = "882554a6-f9a9-4f37-92e0-00be7f67e25a";
const E164 = "+16282851278";

async function main() {
  const callerNumber = process.argv[2] ?? null;
  const sb = createClient((process.env.SUPABASE_URL ?? "").replace(/\/+$/, ""),
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false }, realtime: { transport: ws as any } });

  const { data: co } = await sb.from("companies").select("id, name, settings").limit(1).single();
  if (!co) { console.error("no company — run create_workspace() first"); process.exit(1); }
  console.log(`dealership: ${co.name}`);

  // 1. The number callers dial → this dealership. Without it, inbound 404s.
  const { data: existingNum } = await sb.from("phone_numbers")
    .select("id").eq("company_id", co.id).eq("e164", E164).maybeSingle();
  if (existingNum) {
    await sb.from("phone_numbers").update({ vapi_phone_id: VAPI_PHONE_ID, enabled: true }).eq("id", existingNum.id);
    console.log(`  number ${E164} updated`);
  } else {
    const { error } = await sb.from("phone_numbers").insert({
      company_id: co.id, e164: E164, provider: "twilio", vapi_phone_id: VAPI_PHONE_ID,
      cnam: co.name, enabled: true,
    });
    console.log(error ? `  number FAILED: ${error.message}` : `  number ${E164} added`);
  }

  // 2. Transfer destination. Reuses the caller's number so "where is my car" rings a real phone.
  if (callerNumber) {
    const settings = { ...((co.settings ?? {}) as any) };
    settings.inbound = { ...(settings.inbound ?? {}), transfer_number: callerNumber, identify_mode: "caller_id_only" };
    await sb.from("companies").update({ settings }).eq("id", co.id);
    console.log(`  transfer number -> ${callerNumber}`);
  }

  // 3. Services catalog — the ONLY things the agent may say we offer.
  const services = [
    { name: "Oil & filter change", description: "Full synthetic oil and filter with a multi-point inspection.", category: "maintenance", typical_duration_min: 45 },
    { name: "Tire rotation & balance", description: "Rotate and balance all four tires and set pressures.", category: "tires", typical_duration_min: 40 },
    { name: "Brake pad replacement", description: "Front or rear brake pad replacement with rotor inspection.", category: "repair", typical_duration_min: 120 },
    { name: "Wheel alignment", description: "Four-wheel alignment to factory specification.", category: "repair", typical_duration_min: 90 },
    { name: "Battery test & replacement", description: "Test the battery and charging system, replace if needed.", category: "repair", typical_duration_min: 30 },
    { name: "Multi-point inspection", description: "Complimentary inspection of brakes, fluids, belts, and tires.", category: "inspection", typical_duration_min: 30 },
  ];
  for (const s of services) {
    const { data: ex } = await sb.from("service_offerings")
      .select("id").eq("company_id", co.id).eq("name", s.name).maybeSingle();
    if (ex) await sb.from("service_offerings").update({ ...s, active: true }).eq("id", ex.id);
    else await sb.from("service_offerings").insert({ company_id: co.id, ...s, active: true });
  }
  console.log(`  services: ${services.length} in catalog`);

  // 4. A test customer whose caller ID the agent will recognize, with a car that IS due.
  if (callerNumber) {
    const { data: exCust } = await sb.from("customers")
      .select("id").eq("company_id", co.id).eq("phone", callerNumber).maybeSingle();

    let customerId = exCust?.id;
    if (!customerId) {
      const { data, error } = await sb.from("customers").insert({
        company_id: co.id, full_name: "Omar Said", phone: callerNumber,
        email: "alexklaib@gmail.com", customer_type: "loyal", detected_language: "en",
        personality: { summary: "Direct, appreciates quick answers." },
      }).select("id").single();
      if (error) { console.error(`  customer FAILED: ${error.message}`); process.exit(1); }
      customerId = data.id;
    }
    console.log(`  customer: Omar Said (${callerNumber})`);

    // 2022 RAV4, serviced 7 months ago → the 6-month interval is now due.
    const soldOn = "2022-03-01";
    const lastService = new Date(Date.now() - 210 * 86400_000).toISOString().slice(0, 10);
    const { data: exVeh } = await sb.from("vehicles")
      .select("id").eq("customer_id", customerId).eq("vin", "JTMB1234500000001").maybeSingle();
    const vehicle = {
      company_id: co.id, customer_id: customerId, make: "Toyota", model: "RAV4", year: 2022,
      sold_on: soldOn, mileage: 31200, mileage_as_of: new Date(Date.now() - 60 * 86400_000).toISOString().slice(0, 10),
      last_service_on: lastService, mileage_at_last_service: 28000,
      avg_miles_per_day: 38, vin: "JTMB1234500000001", trim: "XLE",
    };
    if (exVeh) await sb.from("vehicles").update(vehicle).eq("id", exVeh.id);
    else await sb.from("vehicles").insert(vehicle);
    console.log(`  vehicle : 2022 Toyota RAV4 (last serviced ${lastService})`);
  }

  console.log("\ndone — run `npm run preflight` to confirm.");
}
main().catch((e) => { console.error("failed:", e.message); process.exit(1); });
