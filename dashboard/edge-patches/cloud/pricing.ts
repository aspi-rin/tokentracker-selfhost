import { createClient } from "npm:@insforge/sdk";
import pricingCore from "../../../src/lib/pricing/core.js";
import catalogFormat from "../../../src/lib/pricing/catalog.js";

const engine = pricingCore.createPricingEngine();
let catalog: any = null;
export const getRowPricing = engine.getRowPricing;
export const getModelPricingInfo = engine.getModelPricingInfo;
export const computeRowCost = engine.computeRowCost;
export const ZERO_PRICING = engine.ZERO_PRICING;
export const getModelPricing = (model: string, source = "") => engine.getModelPricing(model, source);
function client() { return createClient({ baseUrl: Deno.env.get("INSFORGE_BASE_URL")!,
  edgeFunctionToken: Deno.env.get("INSFORGE_SERVICE_ROLE_KEY"), anonKey: Deno.env.get("ANON_KEY") }); }
export async function loadPricing() {
  if (Deno.env.get("TOKENTRACKER_SELF_HOSTED") !== "1") {
    catalog = await catalogFormat.createCatalog(undefined, {updatedAt:"2026-11-17T00:00:00.000Z"});
    engine.setCatalog(catalog, "bundled");
    return catalog;
  }
  const { data, error } = await client().database.from("tokentracker_pricing_catalog").select("payload").eq("id",1).maybeSingle();
  if (error) throw Error("Pricing catalog unavailable");
  catalog = data?.payload ? await catalogFormat.validateCatalog(data.payload)
    : await catalogFormat.createCatalog(undefined, { updatedAt: "2026-11-17T00:00:00.000Z" });
  engine.setCatalog(catalog, catalog.source);
  return catalog;
}
export async function refreshPricing(force = false) {
  const previous = await loadPricing();
  if (!force && previous.source !== "bundled" && Date.now()-Date.parse(previous.updatedAt)<86400000) return previous;
  let raw;
  try { raw = await catalogFormat.fetchRates(); } catch (error) { if (force) throw error; return previous; }
  const next = await catalogFormat.createCatalog(raw, { curated: previous.curated, source: catalogFormat.UPSTREAM_URL });
  // Compare-and-set prevents a slower refresh from overwriting a newer publication.
  const { data, error } = await client().database.rpc("self_host_publish_pricing", { p_previous_version: previous.version, p_payload: next });
  if (error) throw Error("Pricing publication failed");
  return await loadPricing();
}
export function pricingHeaders() {
  return catalog ? { "X-TokenTracker-Pricing-Version": catalog.version,
    "X-TokenTracker-Pricing-Updated-At": catalog.updatedAt } : {};
}

// Authenticated owner publication allows reviewed overrides without deploying code.
export async function publishPricing(value: unknown, expectedVersion: string) {
  const next = await catalogFormat.validateCatalog(value);
  const previous = await loadPricing();
  if (previous.version !== expectedVersion) throw Error("catalog_changed");
  const {data,error} = await client().database.rpc("self_host_publish_pricing",{
    p_previous_version:expectedVersion,p_payload:next,
  });
  if(error)throw Error("Pricing publication failed");
  if(data?.ok!==true)throw Error("catalog_changed");
  return await loadPricing();
}
