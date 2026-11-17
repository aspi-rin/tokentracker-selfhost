import { getModelPricing, getRowPricing, computeRowCost, getModelPricingInfo, ZERO_PRICING, loadPricing } from "./cloud/pricing.ts";
/**
 * Tokentracker leaderboard profile (DETAIL).
 *
 * Aggregates a single user's hourly rows into a rich profile payload used by
 * the in-page profile modal: hero totals, streak, best day, model favorites,
 * per-provider breakdown, 365-day activity heatmap and a period-scoped daily
 * trend.
 *
 * Previous implementation returned the existing snapshot row. The modal
 * needs time-series data the snapshot table doesn't carry, so the usage rows
 * come from the shared `account_usage_grouped(_cached)` RPC: Postgres does the
 * two-class cross-device aggregation at DAY grain (the modal only aggregates
 * by day), and repeat modal opens hit the shared 30s cache instead of
 * re-walking up to 60 pages of raw hourly rows per view.
 *
 * Pricing uses the shared portable engine and instance catalog.
 * to keep `getModelPricing` / `computeRowCost` byte-for-byte aligned across
 * cloud aggregators. Memory: feedback_model_pricing_sync — every edit here
 * MUST be mirrored to refresh.ts and src/lib/local-api.js.
 */
import { createClient } from "npm:@insforge/sdk";
const readProBadges = async (..._args: unknown[]): Promise<Record<string,boolean>> => ({});
import { billingUserId } from "./cloud/auth.ts";

const SOURCES_WITH_AUTHORITATIVE_COST = new Set(["grok", "cline"]);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, apikey, x-tokentracker-device-token-hash",
};
const BLOCKED_LEADERBOARD_USER_IDS = new Set(
  (Deno.env.get("LEADERBOARD_BLOCKED_USER_IDS") ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean),
);

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store", "CDN-Cache-Control": "no-store" },
  });
}

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (b64.length % 4)) % 4;
  const raw = atob(b64 + "=".repeat(pad));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function verifyCallerUserId(req: Request): Promise<string | null> {
  if (Deno.env.get("TOKENTRACKER_PUBLIC_PROFILES_ENABLED") === "1") {
    try { return await billingUserId(req.headers.get("Authorization"), {
      jwtSecret: Deno.env.get("JWT_SECRET"), jwtPublicKey: Deno.env.get("JWT_PUBLIC_KEY"),
    }); } catch { return null; }
  }
  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
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
    const payloadStr = new TextDecoder().decode(b64urlToBytes(parts[1]));
    const payload = JSON.parse(payloadStr) as Record<string, unknown>;
    if (typeof payload.exp === "number" && Date.now() / 1000 > payload.exp) return null;
    const sub = payload.sub;
    return typeof sub === "string" && sub.length > 0 ? sub : null;
  } catch {
    return null;
  }
}

function getClient() {
  const serviceRoleKey = Deno.env.get("INSFORGE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("INSFORGE_ANON_KEY") ?? Deno.env.get("ANON_KEY");
  return createClient({
    baseUrl: Deno.env.get("INSFORGE_BASE_URL")!,
    edgeFunctionToken: serviceRoleKey,
    anonKey: anonKey ?? undefined,
    isServerMode: true,
  });
}

// ─────────────────────────── Pricing (mirror from refresh.ts) ──────────────────────────


interface UsageRow {
  source: string;
  model: string;
  total_tokens: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  reasoning_output_tokens: number | null;
  total_cost_usd?: number | null;
  pricing_tier?: string;
}

// One row per (UTC day, source, model) as returned by account_usage_grouped
// with p_trunc="day" and no tz override.
interface GroupedRow extends UsageRow {
  bucket: string;
}


/** Map raw `source` to the canonical bucket used by the modal's by_provider list. */
const KNOWN_SOURCES = new Set([
  "acode", "codex", "claude", "gemini", "antigravity", "cursor", "opencode", "openclaw",
  "hermes", "kiro", "copilot", "pi-anthropic", "pi-github-copilot",
  "pi-copilot", "kimi", "droid", "dumate",
]);
function canonicalSource(s: string) {
  return KNOWN_SOURCES.has(s) ? s : "other";
}

// Account-level sources (data from a per-ACCOUNT cloud API, e.g. Cursor's usage
// CSV — NOT machine-local logs) are stored IDENTICALLY on every device that
// synced them, so they must be DEDUPED across devices, not summed. Machine-level
// sources are real independent per-machine work and SUM across active devices.
// The dedup itself now runs inside the account_usage_grouped RPC; this constant
// remains as the parity anchor checked against src/lib/source-metadata.js, the
// RPC, and tokentracker-leaderboard-refresh.ts
// (parity: test/account-source-parity.test.js).
// deno-lint-ignore no-unused-vars
const ACCOUNT_LEVEL_SOURCES = new Set<string>(["cursor", "trae-cn"]);

// ─────────────────────────── Window bounds ──────────────────────────
function normalizeTimeZone(value: string | null): string | null {
  const timeZone = value?.trim();
  if (!timeZone) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
    return timeZone;
  } catch {
    return null;
  }
}

function normalizeTimeZoneOffset(value: string | null): number | null {
  if (value == null || value === "") return null;
  const offset = Number(value);
  if (!Number.isFinite(offset) || Math.abs(offset) > 14 * 60) return null;
  return Math.trunc(offset);
}

function zonedDayKey(date: Date, timeZone: string | null, offsetMinutes: number | null): string {
  if (timeZone) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const year = parts.find((part) => part.type === "year")?.value;
    const month = parts.find((part) => part.type === "month")?.value;
    const day = parts.find((part) => part.type === "day")?.value;
    if (year && month && day) return `${year}-${month}-${day}`;
  }
  const shifted = offsetMinutes == null
    ? date
    : new Date(date.getTime() + offsetMinutes * 60_000);
  return shifted.toISOString().slice(0, 10);
}

function addCalendarDays(day: string, amount: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function windowBoundsForPeriod(period: string, todayDay: string): { from_day: string; to_day: string } {
  const now = new Date(`${todayDay}T00:00:00Z`);
  if (period === "week") {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)) /* ISO Mon-start, matches leaderboard-refresh+dashboard */;
    const from = d.toISOString().slice(0, 10);
    d.setUTCDate(d.getUTCDate() + 6);
    return { from_day: from, to_day: d.toISOString().slice(0, 10) };
  }
  if (period === "month") {
    const from = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
    const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0))
      .toISOString()
      .slice(0, 10);
    return { from_day: from, to_day: to };
  }
  // total: use heatmap range (365 days) — caller uses this same bound for trend
  const heatmapStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  heatmapStart.setUTCDate(heatmapStart.getUTCDate() - 364);
  return {
    from_day: heatmapStart.toISOString().slice(0, 10),
    to_day: todayDay,
  };
}

/** Compute current & longest consecutive-day streaks within a date set. */
function computeStreak(daysWithActivity: Set<string>, todayDay: string): { current_days: number; longest_days: number } {
  const todayUTC = new Date(`${todayDay}T00:00:00Z`);
  // Current: start from today; if today has nothing, allow yesterday as starting point.
  let cursor = new Date(todayUTC);
  let current = 0;
  if (!daysWithActivity.has(cursor.toISOString().slice(0, 10))) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  while (daysWithActivity.has(cursor.toISOString().slice(0, 10))) {
    current += 1;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  // Longest: walk all days chronologically.
  const sorted = Array.from(daysWithActivity).sort();
  let longest = 0;
  let run = 0;
  let prev: Date | null = null;
  for (const d of sorted) {
    const dt = new Date(d + "T00:00:00Z");
    if (prev && dt.getTime() - prev.getTime() === 86_400_000) {
      run += 1;
    } else {
      run = 1;
    }
    if (run > longest) longest = run;
    prev = dt;
  }
  return { current_days: current, longest_days: longest };
}

// ─────────────────────────── Main handler ──────────────────────────
// deno-lint-ignore no-explicit-any
async function fetchDailyGroupedRows(
  client: any,
  userId: string,
  rangeStartIso: string,
  rangeEndIso: string,
  timeZone: string | null,
  timeZoneOffsetMinutes: number | null,
): Promise<GroupedRow[]> {
  // The two-class cross-device aggregation runs in Postgres
  // (account_usage_grouped), matching tokentracker-leaderboard-refresh.ts:
  //   * ACCOUNT-LEVEL sources (cursor, trae-cn): ONE canonical whole row
  //     per (bucket, source, model), across ALL devices (device-independent).
  //   * MACHINE-LEVEL sources: summed across the user's ACTIVE devices
  //     (revoked_at IS NULL), dropping historic device churn.
  // Day grain is enough — the modal only aggregates by day. The cached
  // variant serves repeat modal opens from the shared 30s Postgres cache
  // instead of re-walking raw hourly pages on every view.
  let hasActiveDevice = false;
  {
    const { data: devs, error: dErr } = await client.database
      .from("tokentracker_devices")
      .select("id")
      .eq("user_id", userId)
      .is("revoked_at", null)
      .limit(1);
    if (dErr) throw new Error(dErr.message);
    hasActiveDevice = Array.isArray(devs) && devs.length > 0;
  }

  // account_usage_grouped_v2 (backing the cached variant) short-circuits to
  // [] for users with no active devices — but account-level history (cursor)
  // is device-independent and must still show on their profile. The uncached
  // array variant with an empty id list returns exactly that account branch.
  const common = {
    p_user_id: userId,
    p_from: rangeStartIso,
    p_to: rangeEndIso,
    p_trunc: "day",
    p_tz: timeZone,
    p_offset_min: timeZoneOffsetMinutes,
  };
  const { data, error } = hasActiveDevice
    ? await client.database.rpc("account_usage_grouped_cached", { ...common, p_device_id: null })
    : await client.database.rpc("account_usage_grouped", { ...common, p_device_ids: [] });
  if (error) throw new Error(error.message);
  return (Array.isArray(data) ? data : []) as GroupedRow[];
}

export default async function (req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

  const url = new URL(req.url);
  const userId = url.searchParams.get("user_id");
  const periodInput = url.searchParams.get("period") || "week";
  const period = ["week", "month", "total"].includes(periodInput) ? periodInput : "week";
  const timeZone = normalizeTimeZone(url.searchParams.get("tz"));
  const timeZoneOffsetMinutes = normalizeTimeZoneOffset(url.searchParams.get("tz_offset_minutes"));
  const now = new Date();
  const todayDay = zonedDayKey(now, timeZone, timeZoneOffsetMinutes);
  if (!userId) return json({ error: "user_id is required" }, 400);
  if (BLOCKED_LEADERBOARD_USER_IDS.has(userId)) return json({ error: "Not found" }, 404);

  const callerUserId = await verifyCallerUserId(req);
  const isSelf = Boolean(callerUserId && callerUserId === userId);
  const owner = Deno.env.get("TOKENTRACKER_OWNER_ID");
  if (!isSelf && ((owner && userId !== owner) || (Deno.env.get("TOKENTRACKER_SELF_HOSTED") === "1" && !owner))) return json({error:"Not found"},404);
  const client = getClient();

  // Achievements only need the precomputed badge rows. Keep this authenticated
  // owner-only fast path before every profile/snapshot/hourly query below: the
  // full response scans up to 365 days of raw hourly rows and can take seconds
  // for a heavy user, while user_badges_full is a small indexed lookup.
  if (url.searchParams.get("view") === "badges") {
    if (!isSelf) return json({ error: "Forbidden" }, 403);
    if (Deno.env.get("TOKENTRACKER_PUBLIC_PROFILES_ENABLED") === "1") return json({badges:[],badges_include_unearned:true});
    const { data, error } = await client.database.rpc("user_badges_full", {
      p_user_id: userId,
      p_include_unearned: true,
    });
    if (error) return json({ error: "Failed to fetch badges" }, 500);
    return json({
      badges: Array.isArray(data) ? data : [],
      badges_include_unearned: true,
    });
  }

  try { await loadPricing(); } catch { return new Response(JSON.stringify({error:"Pricing catalog unavailable"}), {status:503,headers:{"Content-Type":"application/json"}}); }
  // Privacy gate. Mirror the leaderboard list's exposure policy: if the user
  // already appears in the public snapshot table, their aggregate numbers are
  // visible to anyone scrolling the leaderboard — so the modal should not
  // gate them behind `leaderboard_public`. The `leaderboard_anonymous` flag
  // is enforced separately below by hiding display_name/avatar/github_url.
  // (A `leaderboard_public=true` check would 404 ~60% of listed rows here.)
  if (!isSelf && Deno.env.get("TOKENTRACKER_PUBLIC_PROFILES_ENABLED") === "1") {
    const {data: consent,error}=await client.database.from("tokentracker_user_settings")
      .select("leaderboard_public").eq("user_id",userId).maybeSingle();
    if(error || consent?.leaderboard_public !== true)return json({error:"Not found"},404);
  }
  if (!isSelf) {
    const { data: snap } = await client.database
      .from("tokentracker_leaderboard_snapshots")
      .select("user_id")
      .eq("user_id", userId)
      .limit(1)
      .maybeSingle();
    if (!snap) {
      return json({ error: "Not found" }, 404);
    }
  }

  // Hero/identity row: pull display_name + avatar from profile, and
  // anonymous/github flags + url from settings. Badges ride along in the same
  // round-trip: unearned (tier-0 progress) rows are included ONLY for the
  // verified owner. Fail-soft — a badges hiccup must not 500 the profile.
  const [settingsRes, profileRes, badgesRes, proBadges] = await Promise.all([
    client.database
      .from("tokentracker_user_settings")
      .select("leaderboard_anonymous, github_url, show_github_url")
      .eq("user_id", userId)
      .maybeSingle(),
    client.database
      .from("tokentracker_user_profiles")
      .select("display_name, avatar_url")
      .eq("user_id", userId)
      .maybeSingle(),
    client.database
      .rpc("user_badges_full", { p_user_id: userId, p_include_unearned: isSelf })
      .then(
        (res: { data?: unknown; error?: unknown }) => res,
        () => ({ data: null, error: true }),
      ),
    readProBadges(client, [userId]),
  ]);
  if (Deno.env.get("TOKENTRACKER_PUBLIC_PROFILES_ENABLED") === "1" && (settingsRes.error || profileRes.error)) {
    return json({error:"Failed to fetch profile"},500);
  }
  const badges = Array.isArray((badgesRes as { data?: unknown }).data)
    ? ((badgesRes as { data?: unknown }).data as Array<Record<string, unknown>>)
    : [];
  const settings = (settingsRes.data || {}) as {
    leaderboard_anonymous?: boolean;
    github_url?: string | null;
    show_github_url?: boolean;
  };
  const profile = (profileRes.data || {}) as {
    display_name?: string | null;
    avatar_url?: string | null;
  };

  // Rank: read from the period snapshot (the refresh job already computes it).
  // The query is pinned to the CURRENT (from_day, to_day) window — taking the
  // latest generated_at row for the period regardless of window returned the
  // PREVIOUS week/month's rank next to freshly-computed current-window totals
  // right after a window rollover ("Rank #3, 0 tokens").
  const periodBounds = windowBoundsForPeriod(period, todayDay);
  const snapshotBounds = windowBoundsForPeriod(period, now.toISOString().slice(0, 10));
  let snapFromDay = snapshotBounds.from_day;
  let snapToDay = snapshotBounds.to_day;
  if (period === "total") {
    // total snapshots are keyed (1970-01-01, <refresh day>) — mirror the
    // reader (tokentracker-leaderboard.ts) and resolve the latest pair.
    const { data: latestTotal, error: latestTotalError } = await client.database
      .from("tokentracker_leaderboard_snapshots")
      .select("from_day, to_day")
      .eq("period", "total")
      .order("to_day", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latestTotalError) return json({ error: "Failed to fetch profile" }, 500);
    const lt = latestTotal as { from_day?: string; to_day?: string } | null;
    snapFromDay = (lt?.from_day ?? "1970-01-01").slice(0, 10);
    snapToDay = (lt?.to_day ?? new Date().toISOString()).slice(0, 10);
  }
  const { data: snapRow, error: snapshotError } = await client.database
    .from("tokentracker_leaderboard_snapshots")
    .select("rank, display_name, avatar_url, generated_at, total_tokens, estimated_cost_usd")
    .eq("user_id", userId)
    .eq("period", period)
    .eq("from_day", snapFromDay)
    .eq("to_day", snapToDay)
    .order("generated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (snapshotError) return json({ error: "Failed to fetch profile" }, 500);
  const snap = (snapRow || null) as { total_tokens?: number | string | null; estimated_cost_usd?: number | string | null; rank?: number | null; display_name?: string | null; avatar_url?: string | null; generated_at?: string | null } | null;

  // Heatmap window: trailing 365 days (always).
  const heatmapEndDay = addCalendarDays(todayDay, 1);
  const heatmapStartDay = addCalendarDays(heatmapEndDay, -365);
  // Period range may be wider than 365d ("total" maps to 365d here); we scan
  // the heatmap window and slice the period window from the same map.
  const periodEndDay = addCalendarDays(periodBounds.to_day, 1);
  const scanStartDay = heatmapStartDay < periodBounds.from_day ? heatmapStartDay : periodBounds.from_day;
  const scanEndDay = heatmapEndDay > periodEndDay ? heatmapEndDay : periodEndDay;
  // Widen one UTC day on both sides so every IANA/offset-shifted local bucket
  // is present before the day-key filters below trim the response.
  const scanStartIso = `${addCalendarDays(scanStartDay, -1)}T00:00:00Z`;
  const scanEndIso = `${addCalendarDays(scanEndDay, 1)}T00:00:00Z`;

  let groupedRows: GroupedRow[];
  try {
    groupedRows = await fetchDailyGroupedRows(
      client,
      userId,
      scanStartIso,
      scanEndIso,
      timeZone,
      timeZoneOffsetMinutes,
    );
  } catch {
    return json({ error: "Failed to fetch profile" }, 500);
  }

  // ── Aggregate into the modal's shape. Two parallel passes:
  //   - period-scoped: totals/by_provider/best_day/favorite_model/active_days/streak/daily_trend
  //   - 365d heatmap: per-day token totals
  const heatmapByDay = new Map<string, number>();
  // Per-day model breakdown for the hover tooltip. Same shape the dashboard
  // ActivityHeatmap consumes (cell.models = { [model_name]: tokens }).
  const heatmapModelsByDay = new Map<string, Map<string, number>>();
  const periodByDay = new Map<string, number>();
  const periodByDayCost = new Map<string, number>();
  const periodByProvider = new Map<string, { tokens: number; cost: number }>();
  const periodByModel = new Map<string, number>();
  const modelBreakdown = new Map<string, Record<string, number | string>>();
  let periodTotalTokens = 0;
  let periodTotalCost = 0;

  for (const row of groupedRows) {
    const day = String(row.bucket || "");
    if (!day) continue;
    const tokens = Number(row.total_tokens) || 0;
    const cost = computeRowCost(row);
    if (day >= heatmapStartDay && day < heatmapEndDay) {
      heatmapByDay.set(day, (heatmapByDay.get(day) || 0) + tokens);
      if (row.model && tokens > 0) {
        let dayModels = heatmapModelsByDay.get(day);
        if (!dayModels) {
          dayModels = new Map();
          heatmapModelsByDay.set(day, dayModels);
        }
        dayModels.set(row.model, (dayModels.get(row.model) || 0) + tokens);
      }
    }
    if (day >= periodBounds.from_day && day < periodEndDay) {
      periodByDay.set(day, (periodByDay.get(day) || 0) + tokens);
      periodByDayCost.set(day, (periodByDayCost.get(day) || 0) + cost);
      const src = canonicalSource(row.source);
      const provider = periodByProvider.get(src) || { tokens: 0, cost: 0 };
      provider.tokens += tokens;
      provider.cost += cost;
      periodByProvider.set(src, provider);
      if (row.model) periodByModel.set(row.model, (periodByModel.get(row.model) || 0) + tokens);
      if (row.model) {
        const detail = modelBreakdown.get(row.model) || { model_name: row.model,
          total_tokens: 0, estimated_cost_usd: 0, input_tokens: 0, output_tokens: 0,
          cached_input_tokens: 0, cache_creation_input_tokens: 0, reasoning_output_tokens: 0 };
        detail.total_tokens = Number(detail.total_tokens) + tokens;
        detail.estimated_cost_usd = Number(detail.estimated_cost_usd) + cost;
        for (const key of ["input_tokens", "output_tokens", "cached_input_tokens", "cache_creation_input_tokens", "reasoning_output_tokens"] as const) {
          detail[key] = Number(detail[key]) + (Number(row[key]) || 0);
        }
        modelBreakdown.set(row.model, detail);
      }
      periodTotalTokens += tokens;
      periodTotalCost += cost;
    }
  }

  // best_day in period. A grouped zero row is not activity and must not turn
  // an otherwise empty profile into a synthetic "best" day.
  let bestDay: { date: string; total_tokens: number; estimated_cost_usd: number } | null = null;
  for (const [day, tokens] of periodByDay.entries()) {
    if (tokens <= 0) continue;
    if (!bestDay || tokens > bestDay.total_tokens) {
      bestDay = { date: day, total_tokens: tokens, estimated_cost_usd: periodByDayCost.get(day) || 0 };
    }
  }

  // favorite_model
  let favoriteModel: { model_name: string; total_tokens: number } | null = null;
  for (const [model, tokens] of periodByModel.entries()) {
    if (!favoriteModel || tokens > favoriteModel.total_tokens) {
      favoriteModel = { model_name: model, total_tokens: tokens };
    }
  }

  // streak (over period — set of active day strings)
  const activeDaySet = new Set(
    Array.from(periodByDay.entries())
      .filter(([, tokens]) => tokens > 0)
      .map(([day]) => day),
  );
  const streak = computeStreak(activeDaySet, todayDay);

  // daily_trend (period, dense — include 0 days so frontend can chart cleanly)
  const dailyTrend: Array<{ date: string; total_tokens: number }> = [];
  for (let cur = new Date(`${periodBounds.from_day}T00:00:00Z`); cur < new Date(`${periodEndDay}T00:00:00Z`); cur.setUTCDate(cur.getUTCDate() + 1)) {
    const day = cur.toISOString().slice(0, 10);
    dailyTrend.push({ date: day, total_tokens: periodByDay.get(day) || 0 });
  }
  // heatmap (365d dense). `models` powers the dashboard ActivityHeatmap's
  // per-cell model breakdown tooltip. Days with no activity get no models
  // key (the heatmap component already handles that gracefully).
  const heatmap: Array<{ date: string; total_tokens: number; models?: Record<string, number> }> = [];
  for (let cur = new Date(`${heatmapStartDay}T00:00:00Z`); cur < new Date(`${heatmapEndDay}T00:00:00Z`); cur.setUTCDate(cur.getUTCDate() + 1)) {
    const day = cur.toISOString().slice(0, 10);
    const cell: { date: string; total_tokens: number; models?: Record<string, number> } = {
      date: day,
      total_tokens: heatmapByDay.get(day) || 0,
    };
    const dayModels = heatmapModelsByDay.get(day);
    if (dayModels && dayModels.size > 0) {
      cell.models = Object.fromEntries(dayModels);
    }
    heatmap.push(cell);
  }

  // by_provider sorted desc with percent
  const byProvider = Array.from(periodByProvider.entries())
    .map(([source, v]) => ({
      source,
      total_tokens: v.tokens,
      estimated_cost_usd: v.cost,
      percent: periodTotalTokens > 0 ? v.tokens / periodTotalTokens : 0,
    }))
    .sort((a, b) => b.total_tokens - a.total_tokens);

  const activeDays = activeDaySet.size;
  const periodDayCount = dailyTrend.length || 1;
  const avgPerDayUsd = periodTotalCost / periodDayCount;

  const isAnonymous = Boolean(settings.leaderboard_anonymous);
  const displayName = isAnonymous
    ? "Anonymous"
    : (profile.display_name || snap?.display_name || "");
  const avatarUrl = isAnonymous ? null : (profile.avatar_url || snap?.avatar_url || null);
  const githubUrl = !isAnonymous && settings.show_github_url ? (settings.github_url || null) : null;

  return json({
    user: {
      user_id: userId,
      display_name: displayName,
      avatar_url: avatarUrl,
      github_url: githubUrl,
      is_anonymous: isAnonymous,
      pro_active: !isAnonymous && proBadges[userId] === true,
      rank: snap?.rank ?? null,
    },
    period: {
      kind: period,
      from: periodBounds.from_day,
      to: periodBounds.to_day,
      time_zone: timeZone,
      time_zone_offset_minutes: timeZoneOffsetMinutes,
      generated_at: snap?.generated_at || new Date().toISOString(),
    },
    totals: {
      // Only the two headline totals use the ranked lifetime snapshot. Activity,
      // daily averages and breakdowns remain bounded by the returned period.
      source: period === "total" ? "leaderboard_snapshot" : "activity_window",
      total_tokens: period === "total" ? (snap?.total_tokens == null ? null : Number(snap.total_tokens)) : periodTotalTokens,
      estimated_cost_usd: period === "total" ? (snap?.estimated_cost_usd == null ? null : Number(snap.estimated_cost_usd)) : periodTotalCost,
      active_days: activeDays,
      avg_per_day_usd: avgPerDayUsd,
    },
    streak,
    best_day: bestDay,
    models: {
      count: periodByModel.size,
      favorite: favoriteModel,
      breakdown: [...modelBreakdown.values()].sort((a, b) => Number(b.total_tokens) - Number(a.total_tokens)),
    },
    by_provider: byProvider,
    heatmap,
    daily_trend: dailyTrend,
    badges,
    badges_include_unearned: isSelf,
  });
}

export { computeRowCost, fetchDailyGroupedRows, windowBoundsForPeriod };
