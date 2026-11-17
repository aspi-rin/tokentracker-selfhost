import { getModelPricing, getRowPricing, computeRowCost, getModelPricingInfo, ZERO_PRICING, loadPricing } from "./cloud/pricing.ts";
/**
 * InsForge Edge: account-wide daily usage (cross-device, aggregated by user_id).
 * Mirrors local-api.js `tokentracker-usage-daily` response schema.
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
 * Kept deliberately plain: do NOT add Content-Encoding here.
 *
 * This endpoint carried a gzip branch for a while (body over 1 KB and a caller
 * advertising gzip got a compressed stream). It never reached a client. The
 * InsForge gateway decompresses an encoded edge response and forwards it as
 * identity: `Vary: Accept-Encoding` is passed through, `Content-Encoding` is
 * stripped, and both `Content-Length` and the ETag are computed over the plain
 * body. Verified end to end on 2026-09-20 against the public leaderboard
 * endpoint with cache-busted requests: 77529 bytes on the wire either way, and
 * a body starting with `{"en` rather than the gzip magic 1f 8b.
 *
 * So compressing here only burns CPU twice. The way to shrink these responses
 * is fewer bytes (the *_compact RPCs) or fewer requests (client-side caches).
 */
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * Convert a UTC timestamp to the caller's local YYYY-MM-DD. Mirrors the
 * convention used by src/lib/local-api.js#getZonedParts:
 *   - tz: IANA name (preferred); resolved via Intl.DateTimeFormat("en-CA")
 *   - offsetMinutes: positive = east of UTC (e.g. +480 for Asia/Shanghai)
 * Falls back to UTC slice when neither is provided/valid.
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
 * Verify legacy HS256 and current RS256 InsForge JWTs locally. InsForge 2.2.2+
 * signs newly refreshed access tokens with RS256/JWT_PUBLIC_KEY while existing
 * sessions may still present HS256/JWT_SECRET tokens during the transition.
 * Returns null on any failure so an unverified sub can never reach user data.
 */
async function verifiedUserIdFromJwt(authHeader: string | null): Promise<string | null> {
  if (!authHeader) return null;
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(
      new TextDecoder().decode(b64urlToBytes(parts[0])),
    ) as Record<string, unknown>;
    const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const sig = b64urlToBytes(parts[2]);
    let ok = false;
    if (header.alg === "HS256") {
      const secret = Deno.env.get("JWT_SECRET");
      if (!secret) return null;
      const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"],
      );
      ok = await crypto.subtle.verify("HMAC", key, sig, data);
    } else if (header.alg === "RS256") {
      const publicKeyPem = Deno.env.get("JWT_PUBLIC_KEY");
      if (!publicKeyPem) return null;
      const publicKeyDer = Uint8Array.from(
        atob(publicKeyPem.replace(/-----[^-]+-----|\s/g, "")),
        (char) => char.charCodeAt(0),
      );
      const key = await crypto.subtle.importKey(
        "spki",
        publicKeyDer,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
      ok = await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        key,
        sig,
        data,
      );
    } else {
      return null;
    }
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
  conversations: number | null;
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

/**
 * What account_daily_compact() returns.
 *
 * `days` carries everything a day needs except its cost; `cost_dims` keeps the
 * (source, model, pricing_tier) split because pricing depends on it, but the
 * day's rows are already summed per dim and the JSON key names are gone.
 */
interface CompactDaily {
  // [day, total, input, output, cache_read, cache_write, reasoning,
  //  conversations, { model: tokens }]
  days: [string, number | string, number | string, number | string, number | string,
    number | string, number | string, number | string, Record<string, number | string> | null][];
  // [day, source, model, pricing_tier, input, output, cache_read, cache_write, reasoning]
  cost_dims: [string, string | null, string | null, string | null, number | string,
    number | string, number | string, number | string, number | string][];
}

interface DailyWire {
  model_names: (string | null)[];
  source_names: (string | null)[];
  pricing_tiers: (string | null)[];
  days: [string, number | string, number | string, number | string, number | string,
    number | string, number | string, number | string, (number | string)[] | null][];
  cost_dims: [string, number, number, number, number | string, number | string,
    number | string, number | string, number | string][];
}

// Expand the database-only dictionary before the existing response logic.
// Keep values untouched here; pricing/output performs the same Number() coercion
// as it did for the original compact RPC.
function expandModelPairs(
  pairs: (number | string)[] | null,
  modelNames: (string | null)[],
): Record<string, number | string> | null {
  if (pairs === null) return null;
  const entries: [string, number | string][] = [];
  for (let i = 0; i < pairs.length; i += 2) {
    entries.push([modelNames[Number(pairs[i])] as string, pairs[i + 1]]);
  }
  return Object.fromEntries(entries);
}

function decodeDailyWire(data: unknown): CompactDaily {
  const payload = (data ?? {}) as Partial<DailyWire>;
  const modelNames = Array.isArray(payload.model_names) ? payload.model_names : [];
  const sourceNames = Array.isArray(payload.source_names) ? payload.source_names : [];
  const pricingTiers = Array.isArray(payload.pricing_tiers) ? payload.pricing_tiers : [];
  return {
    days: (Array.isArray(payload.days) ? payload.days : []).map(([day, tt, i, o, cr, cw, rs, cv, pairs]) =>
      [day, tt, i, o, cr, cw, rs, cv, expandModelPairs(pairs, modelNames)]
    ),
    cost_dims: (Array.isArray(payload.cost_dims) ? payload.cost_dims : []).map(([day, source, model, tier, i, o, cr, cw, rs]) =>
      [day, sourceNames[source], modelNames[model], pricingTiers[tier], i, o, cr, cw, rs]
    ),
  };
}

const COMPACT_TTL_MS = 30_000;
const COMPACT_STALE_IF_ERROR_MS = 5 * 60_000;
const compactCache = new Map<string, { fetchedAt: number; value: CompactDaily }>();
const compactInFlight = new Map<string, Promise<CompactDaily>>();

/**
 * Server-side aggregation, folded to what this endpoint emits.
 *
 * account_daily_compact() runs the very same account_usage_grouped_cached() scan
 * underneath — same 30s shared Postgres cache, same cross-device dedup — but
 * rolls each day up in Postgres. Unlike summary/heatmap/model-breakdown, daily
 * genuinely needs a per-model split (it prints a cost per day), so the win here
 * is smaller: dropping the repeated JSON key names and pre-summing each day's
 * rows per dim takes a 30-day window for a heavy account from ~146 KB to ~60 KB
 * (-59%) rather than -90%.
 */
async function fetchCompactDaily(
  client: ReturnType<typeof createClient>,
  userId: string,
  requestedDeviceId: string | null,
  fromIso: string,
  toIso: string,
  rangeFrom: string,
  rangeTo: string,
  tz: string | null,
  tzOffsetMinutes: number | null,
): Promise<CompactDaily> {
  const cacheKey = JSON.stringify([userId, requestedDeviceId, fromIso, toIso, rangeFrom, rangeTo, tz, tzOffsetMinutes]);
  const cached = compactCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < COMPACT_TTL_MS) return cached.value;
  const existing = compactInFlight.get(cacheKey);
  if (existing) return existing;

  const pending = (async () => {
    try {
      const { data, error } = await client.database.rpc("account_daily_wire", {
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
      const value = decodeDailyWire(data);
      compactCache.set(cacheKey, { fetchedAt: Date.now(), value });
      if (compactCache.size > 64) {
        const oldest = compactCache.keys().next().value;
        if (oldest) compactCache.delete(oldest);
      }
      return value;
    } catch (error) {
      const stale = compactCache.get(cacheKey);
      if (stale && Date.now() - stale.fetchedAt < COMPACT_STALE_IF_ERROR_MS) return stale.value;
      throw error;
    }
  })().finally(() => compactInFlight.delete(cacheKey));
  compactInFlight.set(cacheKey, pending);
  return pending;
}


export default async function (req: Request): Promise<Response> {
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

  // Widen the UTC query window by ±1 day so TZ-shifted buckets at the
  // edges still capture the relevant hours (up to 14h offset worldwide).
  const startDate = new Date(`${from}T00:00:00Z`);
  startDate.setUTCDate(startDate.getUTCDate() - 1);
  const endDate = new Date(`${to}T00:00:00Z`);
  endDate.setUTCDate(endDate.getUTCDate() + 2);
  const rangeStart = startDate.toISOString();
  const rangeEnd = endDate.toISOString();

  let compact: CompactDaily;
  try {
    compact = await fetchCompactDaily(client, userId, requestedDeviceId, rangeStart, rangeEnd, from, to, tz, tzOffsetMinutes);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }

  const byDay = new Map<string, {
    day: string;
    total_tokens: number;
    billable_total_tokens: number;
    total_cost_usd: number;
    input_tokens: number;
    output_tokens: number;
    cached_input_tokens: number;
    cache_creation_input_tokens: number;
    reasoning_output_tokens: number;
    conversation_count: number;
    // Per-model token totals for the day, so the dashboard Usage Trend can stack
    // by MODEL in cloud (account) mode — mirrors src/lib/local-api.js daily output.
    // Without this the trend falls back to a token-type breakdown in cloud mode.
    models: Record<string, number>;
  }>();
  // Postgres already bucketed to the local day and kept only [from, to] — the
  // same inclusive range the `day < from || day > to` skip used to enforce —
  // and folded a NULL/empty model into "unknown" just as String(model || …) did.
  for (const [day, tt, i, o, cr, cw, rs, cv, models] of compact.days) {
    const total = Number(tt) || 0;
    const mdl: Record<string, number> = {};
    if (models) for (const name of Object.keys(models)) mdl[name] = Number(models[name]) || 0;
    byDay.set(day, {
      day,
      total_tokens: total,
      billable_total_tokens: total,
      total_cost_usd: 0,
      input_tokens: Number(i) || 0,
      output_tokens: Number(o) || 0,
      cached_input_tokens: Number(cr) || 0,
      cache_creation_input_tokens: Number(cw) || 0,
      reasoning_output_tokens: Number(rs) || 0,
      conversation_count: Number(cv) || 0,
      models: mdl,
    });
  }

  // Cost stays on the edge because the price table lives here. Each dim is one
  // day's rows already summed per (source, model, pricing_tier); computeRowCost
  // is linear in every token column, so adding the dims up per day gives the
  // same total the per-day rows did.
  for (const [day, source, model, tier, i, o, cr, cw, rs] of compact.cost_dims) {
    const a = byDay.get(day);
    if (!a) continue;
    a.total_cost_usd += computeRowCost({
      bucket: day,
      source: source as string,
      model: model as string,
      pricing_tier: tier ?? undefined,
      input_tokens: Number(i) || 0,
      output_tokens: Number(o) || 0,
      cached_input_tokens: Number(cr) || 0,
      cache_creation_input_tokens: Number(cw) || 0,
      reasoning_output_tokens: Number(rs) || 0,
      total_tokens: 0,
      conversations: 0,
    });
  }

  const data = Array.from(byDay.values()).sort((a, b) => a.day.localeCompare(b.day));
  return json({ from, to, data });
}
