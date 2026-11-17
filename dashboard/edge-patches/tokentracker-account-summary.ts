import { getModelPricing, getRowPricing, computeRowCost, getModelPricingInfo, ZERO_PRICING, loadPricing } from "./cloud/pricing.ts";
/**
 * InsForge Edge: account-wide usage summary (cross-device, aggregated by user_id).
 * Mirrors local-api.js `tokentracker-usage-summary` response schema.
 *
 * Auth: HS256 JWT_SECRET signature verification (same template as
 * tokentracker-device-token-issue). InsForge does NOT validate JWTs at the
 * gateway, so edge functions that expose per-user data MUST verify the
 * signature themselves — otherwise any caller can forge {"sub":"<victim>"}
 * and read another user's full token history.
 *
 * Cross-device aggregation lives server-side in the account_usage_grouped RPC
 * (this function just buckets/sums what the RPC returns). The RPC splits by
 * source class — see its header + test/account-source-parity.test.js:
 *   * MACHINE-LEVEL sources (claude/codex/gemini/...): real independent
 *     per-machine work → SUM across the user's ACTIVE devices (revoked_at IS
 *     NULL). The active-device filter + machine-stable device_name (the
 *     dashboard derives it from /functions/tokentracker-machine-id, see
 *     cloud-sync.ts resolveDeviceNameSuffix) drop historic device_id churn so
 *     SUM doesn't double-count one machine opened in multiple browsers.
 *   * ACCOUNT-LEVEL sources (cursor): data comes from a per-ACCOUNT cloud API,
 *     NOT machine logs, so every device that synced it stores an IDENTICAL
 *     copy. These are DEDUPED across ALL devices (one canonical whole row per
 *     hour/source/model), NOT summed. Summing multiplied a user's Cursor total
 *     by their device count — the v0.42–0.43 double-count bug (a 2-machine
 *     user's Cursor was ~2x; ~5% of their grand total).
 *
 *   Cross-device = additive (GitHub Discussion #101) still holds for the
 *   machine-level sources that motivated it. The dashboard total and the
 *   leaderboard rank now use the SAME two-class semantic
 *   (leaderboard-refresh.ts / leaderboard-profile.ts), so they agree.
 */
import { createClient } from "npm:@insforge/sdk";
import { cloudReadAccess, cloudFailure, cloudHistoryFailure } from "./cloud/access.ts";

const SOURCES_WITH_AUTHORITATIVE_COST = new Set(["grok", "cline"]);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * Convert UTC timestamp to local YYYY-MM-DD (see local-api.js#getZonedParts).
 * Positive offsetMinutes = east of UTC.
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
 * in tokentracker-device-token-issue.ts. Returns null on any failure (bad
 * shape, bad signature, expired) — caller surfaces that as 401.
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

/** Per-model pricing (USD per million tokens). Synced from src/lib/local-api.js. */

// NOTE: MODEL_PRICING + getModelPricing synced from tokentracker-leaderboard-refresh.ts
// to fix dashboard cost under-reporting (e.g. mimo-v2.5-pro → $0, gpt-5.5 → fallback gpt-5).
// TODO: extract to a shared edge-pricing module; tracked in feedback_model_pricing_sync.



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
 * What account_summary_compact() returns. Everything this endpoint actually
 * emits, and nothing more:
 *
 *  - cost_dims:    [source, model, pricing_tier, input, output, cache_read,
 *                  cache_write, reasoning] summed over the requested [from, to]
 *                  with the day dimension dropped. Pricing depends only on
 *                  (source, model, pricing_tier) and computeRowCost is linear in
 *                  every token column, so folding the days away before pricing is
 *                  exact. Checked against the per-day path on 12 real heavy
 *                  accounts: worst relative difference 8.5e-16 (double epsilon),
 *                  zero differences at the emitted toFixed(6).
 *  - day_rollup:   [local day, total_tokens, conversations] over the whole
 *                  rolling window, which is all last_7d / last_30d need.
 *  - range_totals: token columns + conversation_count + active_days over
 *                  [from, to].
 */
interface CompactSummary {
  cost_dims: [string | null, string | null, string | null, number | string, number | string, number | string, number | string, number | string][];
  day_rollup: [string, number | string, number | string][];
  range_totals: Record<string, number | string>;
}

interface SummaryWire {
  source_names: (string | null)[];
  model_names: (string | null)[];
  pricing_tiers: (string | null)[];
  cost_dims: [number, number, number, ...(number | string)[]][];
  day_start: string | null;
  day_rollup: [number, number | string, number | string][];
  range_totals: (number | string)[];
}

const SUMMARY_TOTAL_KEYS = [
  "total_tokens", "input_tokens", "output_tokens", "cached_input_tokens",
  "cache_creation_input_tokens", "reasoning_output_tokens", "conversation_count", "active_days",
];

function decodeSummaryWire(data: unknown): CompactSummary {
  const payload = (data ?? {}) as Partial<CompactSummary> | SummaryWire;
  // The SQL wrapper returns the legacy object when dictionary metadata would
  // increase transfer size. Positional totals distinguish the smaller format.
  if (!Array.isArray(payload.range_totals)) {
    const compact = payload as Partial<CompactSummary>;
    return {
      cost_dims: Array.isArray(compact.cost_dims) ? compact.cost_dims : [],
      day_rollup: Array.isArray(compact.day_rollup) ? compact.day_rollup : [],
      range_totals: compact.range_totals ?? {},
    };
  }
  const wire = payload as SummaryWire;
  // Missing trailing slots mean numeric zero. Keep explicit values, including
  // numeric strings, unchanged before the existing price calculation.
  const token = (row: SummaryWire["cost_dims"][number], index: number): number | string =>
    index < row.length ? row[index] : 0;
  const startMs = Date.parse(`${wire.day_start}T00:00:00Z`);
  return {
    cost_dims: wire.cost_dims.map((row): CompactSummary["cost_dims"][number] => [
      wire.source_names[row[0]], wire.model_names[row[1]], wire.pricing_tiers[row[2]],
      token(row, 3), token(row, 4), token(row, 5), token(row, 6), token(row, 7),
    ]),
    day_rollup: wire.day_rollup.map((row) => [
      new Date(startMs + row[0] * 86_400_000).toISOString().slice(0, 10), row[1], row[2],
    ]),
    range_totals: Object.fromEntries(SUMMARY_TOTAL_KEYS.map((key, index) => [key, wire.range_totals[index]])),
  };
}

const COMPACT_TTL_MS = 30_000;
const COMPACT_STALE_IF_ERROR_MS = 5 * 60_000;
const compactCache = new Map<string, { fetchedAt: number; value: CompactSummary }>();
const compactInFlight = new Map<string, Promise<CompactSummary>>();

/**
 * Server-side aggregation, folded down to what this endpoint emits.
 *
 * account_summary_compact() runs the very same account_usage_grouped_cached()
 * scan underneath — same 30s shared Postgres cache, same cross-device dedup —
 * but does the day/model rollup in Postgres instead of shipping every
 * (bucket, source, model, pricing_tier) row to the edge to be summed and then
 * dropped. This endpoint never emitted per-day rows at all: it emits totals, a
 * day count and two rolling windows. A 30-day window for a heavy account goes
 * from ~99 KB to ~4.8 KB, and the common `from=today&to=today` poll to ~1.6 KB
 * (~98% less). Measured p90 also drops from ~7.3s to ~1.1s, because the tail was
 * large-payload transfer jitter rather than query time.
 */
async function fetchCompactSummary(
  client: ReturnType<typeof createClient>,
  userId: string,
  requestedDeviceId: string | null,
  fromIso: string,
  toIso: string,
  rangeFrom: string,
  rangeTo: string,
  tz: string | null,
  tzOffsetMinutes: number | null,
): Promise<CompactSummary> {
  const cacheKey = JSON.stringify([userId, requestedDeviceId, fromIso, toIso, rangeFrom, rangeTo, tz, tzOffsetMinutes]);
  const cached = compactCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < COMPACT_TTL_MS) return cached.value;
  const existing = compactInFlight.get(cacheKey);
  if (existing) return existing;

  const pending = (async () => {
    try {
      const { data, error } = await client.database.rpc("account_summary_wire", {
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
      const value = decodeSummaryWire(data);
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


interface DayRoll {
  billable_total_tokens: number;
  conversation_count: number;
}

// Prices one already-day-folded cost_dims tuple. computeRowCost only reads
// source / model / pricing_tier and the five priced token columns, so the
// remaining GroupedRow fields are filled with the neutral values the per-day
// rows would have contributed.
function costOfDim(dim: CompactSummary["cost_dims"][number]): number {
  return computeRowCost({
    bucket: "",
    source: dim[0] ?? "",
    model: dim[1] ?? "unknown",
    pricing_tier: dim[2] ?? undefined,
    input_tokens: Number(dim[3]) || 0,
    output_tokens: Number(dim[4]) || 0,
    cached_input_tokens: Number(dim[5]) || 0,
    cache_creation_input_tokens: Number(dim[6]) || 0,
    reasoning_output_tokens: Number(dim[7]) || 0,
    total_tokens: 0,
    conversations: 0,
  });
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

  // The v2 RPC resolves and validates device ownership in the same database
  // statement as aggregation, avoiding a second PostgREST connection.
  const rawDeviceId = url.searchParams.get("device_id");
  const requestedDeviceId = rawDeviceId && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(rawDeviceId)
    ? rawDeviceId
    : null;

  // Range for requested [from, to]; widen ±1 day to capture TZ-shifted
  // edge hours for non-UTC callers.
  const startDate = new Date(`${from}T00:00:00Z`);
  startDate.setUTCDate(startDate.getUTCDate() - 1);
  const nextDay = new Date(`${to}T00:00:00Z`);
  nextDay.setUTCDate(nextDay.getUTCDate() + 2);
  const rangeStart = startDate.toISOString();
  const rangeEnd = nextDay.toISOString();

  // Anchor rolling windows to the caller's local "today" (matches daily
  // buckets which are keyed by local day via zonedDayKey).
  const todayStr = zonedDayKey(new Date().toISOString(), tz, tzOffsetMinutes);
  const todayUtcMidnight = new Date(`${todayStr}T00:00:00Z`);
  const thirtyAgo = new Date(todayUtcMidnight);
  thirtyAgo.setUTCDate(thirtyAgo.getUTCDate() - 29);
  const thirtyAgoStr = thirtyAgo.toISOString().slice(0, 10);
  // Widen ±1 UTC day around the local-day boundary for query safety.
  const rollingStartDate = new Date(`${(thirtyAgoStr < from ? thirtyAgoStr : from)}T00:00:00Z`);
  rollingStartDate.setUTCDate(rollingStartDate.getUTCDate() - 1);
  const rollingEndDate = new Date(todayUtcMidnight);
  rollingEndDate.setUTCDate(rollingEndDate.getUTCDate() + 2);
  const rollingStart = rollingStartDate.toISOString();
  const rollingEndNext = rollingEndDate;

  let compact: CompactSummary;
  try {
    compact = await fetchCompactSummary(client, userId, requestedDeviceId, rollingStart, rollingEndNext.toISOString(), from, to, tz, tzOffsetMinutes);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }

  // Postgres already summed [from, to]; only the pricing stays here, because the
  // model price table lives in this file (and its four siblings) and must not be
  // duplicated into SQL as a sixth copy.
  const rt = compact.range_totals;
  const num = (key: string) => Number(rt[key]) || 0;
  let totalCost = 0;
  for (const dim of compact.cost_dims) totalCost += costOfDim(dim);

  const totals = {
    total_tokens: num("total_tokens"),
    billable_total_tokens: num("total_tokens"),
    total_cost_usd: totalCost,
    input_tokens: num("input_tokens"),
    output_tokens: num("output_tokens"),
    cached_input_tokens: num("cached_input_tokens"),
    cache_creation_input_tokens: num("cache_creation_input_tokens"),
    reasoning_output_tokens: num("reasoning_output_tokens"),
    conversation_count: num("conversation_count"),
  };

  const byDay = new Map<string, DayRoll>();
  for (const [day, tokens, conversations] of compact.day_rollup) {
    byDay.set(day, {
      billable_total_tokens: Number(tokens) || 0,
      conversation_count: Number(conversations) || 0,
    });
  }

  const collectDays = (n: number) => {
    const out: DayRoll[] = [];
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(todayUtcMidnight);
      d.setUTCDate(d.getUTCDate() - i);
      const dd = byDay.get(d.toISOString().slice(0, 10));
      if (dd) out.push(dd);
    }
    return out;
  };
  const sumDays = (days: DayRoll[]) =>
    days.reduce(
      (a, r) => {
        a.billable_total_tokens += r.billable_total_tokens;
        a.conversation_count += r.conversation_count;
        return a;
      },
      { billable_total_tokens: 0, conversation_count: 0 },
    );

  const l7 = collectDays(7);
  const l30 = collectDays(30);
  const l7t = sumDays(l7);
  const l30t = sumDays(l30);
  const l7from = new Date(todayUtcMidnight);
  l7from.setUTCDate(l7from.getUTCDate() - 6);
  const l30from = new Date(todayUtcMidnight);
  l30from.setUTCDate(l30from.getUTCDate() - 29);

  return json({
    from,
    to,
    days: num("active_days"),
    totals: { ...totals, total_cost_usd: totalCost.toFixed(6) },
    rolling: {
      last_7d: {
        from: l7from.toISOString().slice(0, 10),
        to: todayStr,
        active_days: l7.length,
        totals: l7t,
      },
      last_30d: {
        from: l30from.toISOString().slice(0, 10),
        to: todayStr,
        active_days: l30.length,
        totals: l30t,
        avg_per_active_day:
          l30.length > 0 ? Math.round(l30t.billable_total_tokens / l30.length) : 0,
      },
    },
  });
}
