// Compatibility endpoint for existing clients; personal instances have no checkout.
import { createClient } from "npm:@insforge/sdk@1.4.5";
import { billingUserId } from "./cloud/auth.ts";
import { BillingError, uuid } from "./cloud/contracts.ts";

const membership = { status: "self_hosted", hosting_mode: "self_hosted", phase: "active",
  can_read_cloud: true, can_upload_cloud: true, trial_available: false, expires_at: null,
  machine_limit: null, sync_interval_seconds: 0, hourly_history_days: null, daily_history_months: null };
const json = (data: unknown, status = 200) => Response.json(data, { status,
  headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization,apikey,content-type", "Access-Control-Allow-Methods": "GET,POST,OPTIONS" } });
export default async function(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization,apikey,content-type", "Access-Control-Allow-Methods": "GET,POST,OPTIONS" } });
  if (!["GET", "POST"].includes(req.method)) return json({ error: "method_not_allowed" }, 405);
  const url = new URL(req.url), action = url.searchParams.get("action") || "account";
  if (action === "catalog" && req.method === "GET") return json({ environment: "live",
    policy: { phase: "active", launch_at: null, hosting_mode: "self_hosted" }, prices: [],
    providers: { waffo: false, paddle: false, wechat: false, alipay: false }, checkout_verified: false,
    limits: { machines: null, sync_minutes: 0, hourly_history_days: null, daily_history_months: null, trial_days: 0 } });
  try {
    const userId = await billingUserId(req.headers.get("authorization"), {
      jwtSecret: Deno.env.get("JWT_SECRET"), jwtPublicKey: Deno.env.get("JWT_PUBLIC_KEY") });
    if (!["account", "devices", "remove-device", "resume-device"].includes(action)) {
      return json({ error: "personal_instance", code: "self_hosted_free" }, 410);
    }
    if ((["account", "devices"].includes(action) && req.method !== "GET") ||
      (["remove-device", "resume-device"].includes(action) && req.method !== "POST")) return json({ error: "method_not_allowed" }, 405);
    const client = createClient({ baseUrl: Deno.env.get("INSFORGE_BASE_URL")!,
      edgeFunctionToken: Deno.env.get("INSFORGE_SERVICE_ROLE_KEY"), anonKey: Deno.env.get("ANON_KEY") });
    let result;
    if (action === "account" || action === "devices") {
      result = await client.database.rpc("cloud_list_machines", { p_user_id: userId,
        p_environment: "live", p_current_machine_id: url.searchParams.get("current_machine_id") });
      if (result.error) throw Error("Device lookup failed");
      if (action === "account") return json({ environment: "live", membership,
        machine_count: Number(result.data?.machine_count) || 0, payments: [], subscriptions: [],
        pending_orders: [], conflict_orders: [], gifts: [], gift_redemption_available: false });
    } else {
      const body = await req.json().catch(() => ({}));
      result = await client.database.rpc(action === "remove-device" ? "cloud_remove_machine" : "cloud_resume_machine",
        { p_user_id: userId, p_environment: "live", p_machine_id: uuid(body.machine_id) });
      if (result.error) throw Error("Device update failed");
    }
    return json(result.data, result.data?.ok === false ? Number(result.data.status) || 409 : 200);
  } catch (error) {
    return error instanceof BillingError ? json({ error: error.code }, error.status)
      : json({ error: "device_operation_failed" }, 503);
  }
}
