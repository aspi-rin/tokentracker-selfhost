import { getModelPricing, getRowPricing, computeRowCost, getModelPricingInfo, ZERO_PRICING, loadPricing } from "./cloud/pricing.ts";
/**
 * InsForge Edge: account-wide usage broken down by source + model (cross-device, by user_id).
 * Mirrors local-api.js `tokentracker-usage-model-breakdown` response schema.
 */
import { createClient } from "npm:@insforge/sdk";
import { cloudReadAccess, cloudFailure, cloudHistoryFailure } from "./cloud/access.ts";

const SOURCES_WITH_AUTHORITATIVE_COST = new Set(["grok", "cline"]);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

/**
 * The legacy /functions gateway decompresses encoded edge responses and sends
 * identity to clients. On 2026-09-20 its public leaderboard response stayed
 * 77529 bytes with or without gzip; encoding was stripped and length/ETag were
 * recomputed over the plain body. The verified direct function2 route now
 * preserves gzip. The response wrapper negotiates that transfer encoding after
 * the existing handler; legacy clients still receive the original JSON body.
 */
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function acceptsGzip(value: string | null): boolean {
  let gzip: number | null = null;
  let wildcard = 0;
  let identity: number | null = null;
  for (const entry of (value || "").split(",")) {
    const [coding, ...parameters] = entry.trim().toLowerCase().split(";");
    const name = coding.trim();
    const weight = parameters.find((part) => /^\s*q\s*=/.test(part));
    const parsed = weight === undefined ? 1 : Number(weight.split("=")[1].trim());
    const quality = Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0;
    if (name === "gzip") gzip = gzip === null ? quality : Math.min(gzip, quality);
    if (name === "*") wildcard = quality;
    if (name === "identity") identity = quality;
  }
  const quality = gzip ?? wildcard;
  return quality > 0 && (identity === null || quality >= identity);
}

async function encodeJsonResponse(req: Request, response: Response): Promise<Response> {
  if (req.method !== "GET" || response.status !== 200 ||
      !response.headers.get("Content-Type")?.toLowerCase().startsWith("application/json") ||
      response.headers.has("Content-Encoding") || response.headers.has("Content-Range") ||
      /\bno-transform\b/i.test(response.headers.get("Cache-Control") || "")) return response;
  const headers = new Headers(response.headers);
  if (!(headers.get("Vary") || "").split(",").some((part) => part.trim().toLowerCase() === "accept-encoding")) {
    headers.append("Vary", "Accept-Encoding");
  }
  const identity = () => new Response(response.body, {
    status: response.status, statusText: response.statusText, headers,
  });
  if (!acceptsGzip(req.headers.get("Accept-Encoding")) || typeof CompressionStream === "undefined") return identity();
  try {
    const bytes = new Uint8Array(await response.clone().arrayBuffer());
    if (bytes.byteLength < 1024) return identity();
    const compressed = new Uint8Array(await new Response(
      new Response(bytes).body!.pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer());
    if (compressed.byteLength >= bytes.byteLength) return identity();
    const encodedHeaders = new Headers(headers);
    encodedHeaders.set("Content-Encoding", "gzip");
    encodedHeaders.set("Content-Length", String(compressed.byteLength));
    encodedHeaders.delete("ETag");
    return new Response(compressed, {
      status: response.status, statusText: response.statusText, headers: encodedHeaders,
    });
  } catch {
    return identity();
  }
}

/**
 * Convert a UTC timestamp to a local YYYY-MM-DD key using either an IANA tz
 * name or a fixed offset in minutes. Positive offsetMinutes = east of UTC.
 * Mirrors the helper in the other 5 account-* edge functions.
 */
function zonedDayKey(hourStart: string, tz: string | null, offsetMinutes: number | null): string {
  if (tz) {
    try {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(new Date(hourStart));
      const y = parts.find((p) => p.type === "year")?.value;
      const m = parts.find((p) => p.type === "month")?.value;
      const d = parts.find((p) => p.type === "day")?.value;
      if (y && m && d) return `${y}-${m}-${d}`;
    } catch { /* fall through */ }
  }
  if (offsetMinutes != null && Number.isFinite(offsetMinutes)) {
    const shifted = new Date(new Date(hourStart).getTime() + offsetMinutes * 60000);
    return shifted.toISOString().slice(0, 10);
  }
  return hourStart.slice(0, 10);
}

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (b64.length % 4)) % 4;
  const raw = atob(b64 + "=".repeat(pad));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Verify HS256 JWT against JWT_SECRET and return its sub. Mirrors the helper
 * in tokentracker-device-token-issue.ts. Returns null on any failure — caller
 * surfaces that as 401. InsForge does NOT validate JWTs at the gateway, so
 * exposing per-user data without local verification lets anyone forge
 * {"sub":"<victim>"} and read another user's data.
 */
async function verifiedUserIdFromJwt(authHeader: string | null): Promise<string | null> {
  if (!authHeader) return null;
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0]))) as Record<string, unknown>;
    const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const sig = b64urlToBytes(parts[2]);
    let ok = false;
    if (header.alg === "HS256") {
      const secret = Deno.env.get("JWT_SECRET");
      if (!secret) return null;
      const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
      ok = await crypto.subtle.verify("HMAC", key, sig, data);
    } else if (header.alg === "RS256") {
      const publicKeyPem = Deno.env.get("JWT_PUBLIC_KEY");
      if (!publicKeyPem) return null;
      const publicKeyDer = Uint8Array.from(atob(publicKeyPem.replace(/-----[^-]+-----|\s/g, "")), (char) => char.charCodeAt(0));
      const key = await crypto.subtle.importKey("spki", publicKeyDer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
      ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, data);
    } else return null;
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1]))) as Record<string, unknown>;
    if (typeof payload.exp === "number" && Date.now() / 1000 > payload.exp) return null;
    const sub = payload.sub;
    if (typeof sub === "string" && sub.length > 0) return sub;
    const uid = payload.user_id;
    if (typeof uid === "string" && uid.length > 0) return uid;
  } catch { /* ignore */ }
  return null;
}


// MODEL_PRICING + getModelPricing synced from tokentracker-leaderboard-refresh.ts
// 2026-05-28: includes mimo, gpt-5.5, glm, grok, deepseek-v4, kiro, hy3-preview (86 models).
// Keep this block byte-identical with leaderboard-refresh.ts; see feedback_model_pricing_sync.


interface HourlyRow {
  hour_start: string;
  source: string;
  model: string;
  total_tokens: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  reasoning_output_tokens: number | null;
}

interface Totals {
  total_tokens: number;
  billable_total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  cache_creation_input_tokens: number;
  reasoning_output_tokens: number;
  conversation_count: number;
  total_cost_usd: string;
}

interface GroupedRow {
  bucket: string;
  source: string;
  model: string;
  total_tokens: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  reasoning_output_tokens: number | null;
  total_cost_usd?: number | null;
  conversations: number | null;
  pricing_tier?: string;
}

// [source, model, pricing_tier, total, input, output, cache_read, cache_write,
// reasoning, conversations] already summed over [from, to], as returned by
// account_model_breakdown_compact. Conversations rides at index 9 so
// request-only rows (0 tokens, N requests) survive the fold (#990); rows from
// a database that predates that column simply stop at index 8.
type CompactDim = [string | null, string | null, string | null, number | string,
  number | string, number | string, number | string, number | string, number | string,
  number | string];

interface ModelBreakdownWire {
  source_names: (string | null)[];
  model_names: (string | null)[];
  pricing_tiers: (string | null)[];
  dims: [number, number, number, ...(number | string)[]][];
}

function decodeModelBreakdownWire(data: unknown): CompactDim[] {
  // Small results keep their legacy array when dictionaries would cost more.
  if (Array.isArray(data)) return data as CompactDim[];
  if (data == null) return [];
  const wire = data as ModelBreakdownWire;
  if (!Array.isArray(wire.dims)) return [];
  const token = (row: ModelBreakdownWire["dims"][number], index: number): number | string =>
    index < row.length ? row[index] : 0;
  return wire.dims.map((row): CompactDim => [
    wire.source_names[row[0]], wire.model_names[row[1]], wire.pricing_tiers[row[2]],
    token(row, 3), token(row, 4), token(row, 5), token(row, 6), token(row, 7), token(row, 8),
    token(row, 9),
  ]);
}

const COMPACT_TTL_MS = 30_000;
const COMPACT_STALE_IF_ERROR_MS = 5 * 60_000;
const compactCache = new Map<string, { fetchedAt: number; dims: CompactDim[] }>();
const compactInFlight = new Map<string, Promise<CompactDim[]>>();

/**
 * Server-side aggregation, folded down to what this endpoint emits.
 *
 * account_model_breakdown_compact() runs the very same
 * account_usage_grouped_cached() scan underneath — same 30s shared Postgres
 * cache, same cross-device dedup — but drops the day dimension in Postgres.
 * This endpoint groups by (source, model) and hardcodes `days: 0`, so the
 * per-day rows only ever crossed the network to be summed and discarded; for a
 * typical account they are 9-23% as many rows once folded.
 *
 * pricing_tier stays in the key so DeepSeek V4 peak/off_peak rows for one model
 * keep their separate prices, and the loop below re-splits them into the same
 * model entry exactly as the per-day rows did.
 */
async function fetchCompactDims(
  client: ReturnType<typeof createClient>,
  userId: string,
  requestedDeviceId: string | null,
  fromIso: string,
  toIso: string,
  rangeFrom: string,
  rangeTo: string,
  tz: string | null,
  tzOffsetMinutes: number | null,
): Promise<CompactDim[]> {
  const cacheKey = JSON.stringify([userId, requestedDeviceId, fromIso, toIso, rangeFrom, rangeTo, tz, tzOffsetMinutes]);
  const cached = compactCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < COMPACT_TTL_MS) return cached.dims;
  const existing = compactInFlight.get(cacheKey);
  if (existing) return existing;

  const pending = (async () => {
    try {
      const { data, error } = await client.database.rpc("account_model_breakdown_wire", {
        p_user_id: userId,
        p_device_id: requestedDeviceId,
        p_from: fromIso,
        p_to: toIso,
        p_tz: tz,
        p_offset_min: tzOffsetMinutes,
        p_range_from: rangeFrom,
        p_range_to: rangeTo,
      });
      if (error) throw new Error(error.message);
      const dims = decodeModelBreakdownWire(data);
      compactCache.set(cacheKey, { fetchedAt: Date.now(), dims });
      if (compactCache.size > 64) {
        const oldest = compactCache.keys().next().value;
        if (oldest) compactCache.delete(oldest);
      }
      return dims;
    } catch (error) {
      const stale = compactCache.get(cacheKey);
      if (stale && Date.now() - stale.fetchedAt < COMPACT_STALE_IF_ERROR_MS) return stale.dims;
      throw error;
    }
  })().finally(() => compactInFlight.delete(cacheKey));
  compactInFlight.set(cacheKey, pending);
  return pending;
}

function getUsageModelPricing(model: string, source: string) {
  return getModelPricingInfo(model, { source });
}

async function handleAccountRequest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS")
    return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

  const url = new URL(req.url);
  let from = url.searchParams.get("from") || "";
  const to = url.searchParams.get("to") || "";
  if (!from || !to) return json({ error: "Missing from/to" }, 400);
  // Bound the span: every distinct range is a cold fill for the shared PG
  // cache and a full-history scan, so arbitrary from/to must not be accepted
  // verbatim. 3 years covers every real "total" view for years to come.
  const MAX_RANGE_DAYS = 1095;
  const fromMs = Date.parse(`${from}T00:00:00Z`);
  const toMs = Date.parse(`${to}T00:00:00Z`);
  if (Number.isFinite(fromMs) && Number.isFinite(toMs) && toMs > fromMs) {
    const maxFromMs = toMs - MAX_RANGE_DAYS * 86_400_000;
    if (fromMs < maxFromMs) from = new Date(maxFromMs).toISOString().slice(0, 10);
  }
  const tz = url.searchParams.get("tz") || null;
  const tzOffsetRaw = url.searchParams.get("tz_offset_minutes");
  const tzOffsetMinutes = tzOffsetRaw != null && tzOffsetRaw !== "" ? Number(tzOffsetRaw) : null;

  const baseUrl = Deno.env.get("INSFORGE_BASE_URL")!;
  const incomingApiKey =
    req.headers.get("apikey") ?? req.headers.get("Apikey") ?? req.headers.get("x-api-key") ?? undefined;
  const anonKey =
    Deno.env.get("INSFORGE_ANON_KEY") ?? Deno.env.get("ANON_KEY") ?? incomingApiKey ?? undefined;
  const serviceRoleKey = Deno.env.get("INSFORGE_SERVICE_ROLE_KEY");
  if (!serviceRoleKey) return json({ error: "server misconfigured" }, 500);

  const client = createClient({
    baseUrl,
    edgeFunctionToken: serviceRoleKey,
    anonKey,
    ...(anonKey ? { headers: { apikey: anonKey } } : {}),
  });

  const userId = await verifiedUserIdFromJwt(req.headers.get("Authorization"));
  if (!userId) return json({ error: "Unauthorized" }, 401);

  let cloudAccess;
  try { cloudAccess = await cloudReadAccess(client, userId, "daily"); }
  catch { return json({ error: "Cloud access unavailable", code: "cloud_access_unavailable" }, 503); }
  if (!cloudAccess.ok) return cloudFailure(cloudAccess, corsHeaders);
  const historyFailure = cloudHistoryFailure(cloudAccess, to);
  if (historyFailure) return cloudFailure(historyFailure, corsHeaders);
  try { await loadPricing(); } catch { return new Response(JSON.stringify({error:"Pricing catalog unavailable"}), {status:503,headers:{"Content-Type":"application/json"}}); }
  if (cloudAccess.available_from && from < cloudAccess.available_from) from = cloudAccess.available_from;

  const rawDeviceId = url.searchParams.get("device_id");
  const requestedDeviceId = rawDeviceId && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(rawDeviceId)
    ? rawDeviceId
    : null;

  // Widen the UTC query window by ±1 day so a caller in a non-UTC zone (e.g.
  // Asia/Shanghai for Day=2026-05-18, which spans UTC 2026-05-17T16:00 to
  // 2026-05-18T16:00) still gets every hourly row that maps into a local day
  // in [from, to]. Matches the same widening other account-* aggregators do.
  const startDate = new Date(`${from}T00:00:00Z`);
  startDate.setUTCDate(startDate.getUTCDate() - 1);
  const endDate = new Date(`${to}T00:00:00Z`);
  endDate.setUTCDate(endDate.getUTCDate() + 2);
  const rangeStart = startDate.toISOString();
  const rangeEnd = endDate.toISOString();

  let dims: CompactDim[];
  try {
    dims = await fetchCompactDims(client, userId, requestedDeviceId, rangeStart, rangeEnd, from, to, tz, tzOffsetMinutes);
  } catch {
    return json({ error: "Failed to fetch model breakdown" }, 500);
  }

  // The RPC bucketed each row to its local day (honoring tz / tz_offset_minutes)
  // and kept only the days in [from, to] — same inclusive semantics as the
  // `r.bucket >= from && r.bucket <= to` filter this used to do here — then
  // summed the days away. `bucket` is gone; conversations survives as the
  // compact's 10th column because the totals below surface it as the request
  // counts that keep request-only rows visible (#990).
  const filtered: GroupedRow[] = dims.map((d) => ({
    bucket: "",
    source: d[0] as string,
    model: d[1] as string,
    pricing_tier: d[2] ?? undefined,
    total_tokens: Number(d[3]) || 0,
    input_tokens: Number(d[4]) || 0,
    output_tokens: Number(d[5]) || 0,
    cached_input_tokens: Number(d[6]) || 0,
    cache_creation_input_tokens: Number(d[7]) || 0,
    reasoning_output_tokens: Number(d[8]) || 0,
    conversations: Number(d[9]) || 0,
  }));

  interface ModelAgg {
    model: string;
    model_id: string;
    totals: Totals;
    totalCostUsd: number;
  }
  interface SourceAgg {
    source: string;
    totals: Totals;
    models: Map<string, ModelAgg>;
  }

  const newTotals = (): Totals => ({
    total_tokens: 0,
    billable_total_tokens: 0,
    input_tokens: 0,
    output_tokens: 0,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    reasoning_output_tokens: 0,
    conversation_count: 0,
    total_cost_usd: "0",
  });

  const bySource = new Map<string, SourceAgg>();
  for (const row of filtered) {
    const src = row.source || "unknown";
    const mdl = String(row.model || "unknown").trim() || "unknown";
    let sa = bySource.get(src);
    if (!sa) {
      sa = { source: src, totals: newTotals(), models: new Map() };
      bySource.set(src, sa);
    }
    const tt = Number(row.total_tokens) || 0;
    sa.totals.total_tokens += tt;
    sa.totals.billable_total_tokens += tt;
    sa.totals.input_tokens += Number(row.input_tokens) || 0;
    sa.totals.output_tokens += Number(row.output_tokens) || 0;
    sa.totals.cached_input_tokens += Number(row.cached_input_tokens) || 0;
    sa.totals.cache_creation_input_tokens += Number(row.cache_creation_input_tokens) || 0;
    sa.totals.reasoning_output_tokens += Number(row.reasoning_output_tokens) || 0;
    // Request-only sources (#948: credit-billed transcripts that report no
    // tokens) carry their activity solely as conversation_count — thread it
    // through so the dashboard can surface "0 tokens / N requests" (#990).
    sa.totals.conversation_count += Number(row.conversations) || 0;

    let ma = sa.models.get(mdl);
    if (!ma) {
      ma = { model: mdl, model_id: mdl, totals: newTotals(), totalCostUsd: 0 };
      sa.models.set(mdl, ma);
    }
    ma.totals.total_tokens += tt;
    ma.totals.billable_total_tokens += tt;
    ma.totals.input_tokens += Number(row.input_tokens) || 0;
    ma.totals.output_tokens += Number(row.output_tokens) || 0;
    ma.totals.cached_input_tokens += Number(row.cached_input_tokens) || 0;
    ma.totals.cache_creation_input_tokens += Number(row.cache_creation_input_tokens) || 0;
    ma.totals.reasoning_output_tokens += Number(row.reasoning_output_tokens) || 0;
    ma.totals.conversation_count += Number(row.conversations) || 0;
    ma.totalCostUsd += computeRowCost(row);
  }

  const sources = Array.from(bySource.values()).map((s) => {
    const models = Array.from(s.models.values())
      .map((m) => {
        return {
          model: m.model,
          model_id: m.model_id,
          pricing: getUsageModelPricing(m.model, s.source),
          cost_source: "model_pricing",
          totals: { ...m.totals, total_cost_usd: m.totalCostUsd.toFixed(6) },
        };
      })
      .sort((a, b) => b.totals.total_tokens - a.totals.total_tokens);
    const sourceCost = models.reduce((sum, m) => sum + Number(m.totals.total_cost_usd), 0);
    return {
      source: s.source,
      totals: { ...s.totals, total_cost_usd: sourceCost.toFixed(6) },
      models,
    };
  });

  return json({
    from,
    to,
    days: 0,
    sources,
    pricing: {
      model: "per-model",
      pricing_mode: "per_token_type",
      source: "litellm",
      effective_from: new Date().toISOString().slice(0, 10),
    },
  });
}

export default async function (req: Request): Promise<Response> {
  return encodeJsonResponse(req, await handleAccountRequest(req));
}
