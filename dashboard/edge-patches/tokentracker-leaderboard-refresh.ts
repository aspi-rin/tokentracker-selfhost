import { getModelPricing, getRowPricing, computeRowCost, getModelPricingInfo, ZERO_PRICING, loadPricing } from "./cloud/pricing.ts";
/**
 * InsForge Edge：排行榜快照刷新。
 * 从 tokentracker_hourly 聚合数据，按 period 写入 tokentracker_leaderboard_snapshots。
 * 接受 POST，可选 body: { period: "week"|"month"|"total" }，不传则刷新全部三个。
 */
import { createClient } from "npm:@insforge/sdk";

const SOURCES_WITH_AUTHORITATIVE_COST = new Set(["grok", "cline"]);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function logRefreshEvent(event: Record<string, unknown>) {
  console.log(JSON.stringify({ scope: "leaderboard-refresh", ...event }));
}

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Constant-time compare so a secret/key check can't be probed byte-by-byte via timing.
function timingSafeEqualStr(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}

// Verify legacy HS256 and current RS256 InsForge JWTs; return claims or null.
// NOTE: the PUBLIC anon key is itself a validly-signed JWT (role="anon"), so
// callers must reject role==="anon" to require a real user.
async function verifiedClaimsFromJwt(
  authHeader: string | null,
): Promise<{ sub: string; role: string } | null> {
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
    const sub = typeof payload.sub === "string" && payload.sub
      ? payload.sub
      : (typeof payload.user_id === "string" ? payload.user_id : "");
    const role = typeof payload.role === "string" ? payload.role : "";
    if (!sub) return null;
    return { sub, role };
  } catch {
    return null;
  }
}

// Refresh is a heavy write path. Until 2026-07-04 it was unauthenticated —
// anyone could POST and trigger a full snapshot rebuild, the lever behind the
// 2026-06-21 meltdown. Accept only: the cron/ops shared secret
// (LEADERBOARD_REFRESH_SECRET, sent by the pg_cron schedule), the service-role
// key (manual ops), or a SIGNED-IN user (the dashboard's per-sync week refresh).
// The public anon key is a validly-signed JWT with role="anon" and must NOT pass.
// "public" covers only the read-only anomaly-queue summary, which exposes
// counts and no identities; it must never reach a code path that writes.
type RefreshAuthorization = "privileged" | "signed-in" | "public";

async function authorizeRefresh(req: Request): Promise<RefreshAuthorization | null> {
  const secret = Deno.env.get("LEADERBOARD_REFRESH_SECRET");
  const provided = req.headers.get("x-refresh-secret");
  if (secret && provided && timingSafeEqualStr(provided, secret)) return "privileged";

  const auth = req.headers.get("Authorization");
  const bearer = auth ? auth.replace(/^Bearer\s+/i, "").trim() : "";
  const serviceKey = Deno.env.get("INSFORGE_SERVICE_ROLE_KEY");
  if (bearer && serviceKey && timingSafeEqualStr(bearer, serviceKey)) return "privileged";

  const claims = await verifiedClaimsFromJwt(auth);
  if (claims && claims.role !== "anon" && claims.sub) return "signed-in";

  return null;
}

type Period = "week" | "month" | "total";
const ALL_PERIODS: Period[] = ["week", "month", "total"];
const TOTAL_USER_SHARDS = [
  { from: "00000000-0000-0000-0000-000000000000", to: "20000000-0000-0000-0000-000000000000" },
  { from: "20000000-0000-0000-0000-000000000000", to: "40000000-0000-0000-0000-000000000000" },
  { from: "40000000-0000-0000-0000-000000000000", to: "60000000-0000-0000-0000-000000000000" },
  { from: "60000000-0000-0000-0000-000000000000", to: "80000000-0000-0000-0000-000000000000" },
  { from: "80000000-0000-0000-0000-000000000000", to: "a0000000-0000-0000-0000-000000000000" },
  { from: "a0000000-0000-0000-0000-000000000000", to: "c0000000-0000-0000-0000-000000000000" },
  { from: "c0000000-0000-0000-0000-000000000000", to: "e0000000-0000-0000-0000-000000000000" },
  { from: "e0000000-0000-0000-0000-000000000000", to: null },
] as const;
const RAW_BLOCKED_LEADERBOARD_USER_IDS = Deno.env.get("LEADERBOARD_BLOCKED_USER_IDS");
/**
 * Whether the block list was configured at all. An unset secret and a
 * deliberately emptied one are the same empty Set here, but they mean opposite
 * things to the quarantine audit: with no list, every quarantined account looks
 * like an orphan and the audit would open a public issue claiming a mass
 * false-ban. Keep the distinction so that failure reports as degraded instead.
 */
const BLOCKLIST_CONFIGURED = typeof RAW_BLOCKED_LEADERBOARD_USER_IDS === "string";
const BLOCKED_LEADERBOARD_USER_IDS = new Set(
  (RAW_BLOCKED_LEADERBOARD_USER_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean),
);

/** Per-model pricing (USD per million tokens), synced from local-api.js */



/** source -> snapshot column name */
const SOURCE_COLUMN_MAP: Record<string, string> = {
  codex: "gpt_tokens",
  claude: "claude_tokens",
  gemini: "gemini_tokens",
  cursor: "cursor_tokens",
  opencode: "opencode_tokens",
  openclaw: "openclaw_tokens",
  hermes: "hermes_tokens",
  kiro: "kiro_tokens",
  copilot: "copilot_tokens",
  "pi-github-copilot": "copilot_tokens",
  "pi-copilot": "copilot_tokens",
  "pi-anthropic": "claude_tokens",
  kimi: "kimi_tokens",
};

interface DateRange {
  from_day: string;
  to_day: string;
}

function computeDateRange(period: Period): DateRange {
  const now = new Date();
  if (period === "week") {
    // ISO 8601 Monday-start week (matches dashboard/src/lib/date-range.ts:67
    // `period === "week"` branch, so cloud leaderboard rank and the
    // dashboard's own "Week" tab cover the same 7 days. Previously this used
    // Sunday-start which made leaderboard's week off-by-one vs the dashboard
    // and confused users comparing the two numbers.
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const offset = (d.getUTCDay() + 6) % 7; // days since Monday (Mon=0..Sun=6)
    d.setUTCDate(d.getUTCDate() - offset); // Monday
    const from_day = d.toISOString().slice(0, 10);
    d.setUTCDate(d.getUTCDate() + 6); // Sunday
    const to_day = d.toISOString().slice(0, 10);
    return { from_day, to_day };
  }
  if (period === "month") {
    const from_day = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
    const to_day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0))
      .toISOString()
      .slice(0, 10);
    return { from_day, to_day };
  }
  // total — full lifetime. `from_day` is a static epoch sentinel so snapshot
  // rows always have identical (period, from_day, to_day) and upsert cleanly.
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return { from_day: "1970-01-01", to_day: end.toISOString().slice(0, 10) };
}

interface HourlyRow {
  user_id: string;
  source: string;
  model: string;
  hour_start?: string;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  cache_creation_input_tokens: number;
  reasoning_output_tokens: number;
  total_cost_usd?: number | null;
  pricing_tier?: string;
}

interface CompactLeaderboardUsage {
  format: string;
  user_ids: string[];
  sources: string[];
  model_names: string[];
  pricing_tiers: (string | null)[];
  rows: [number, number, number, number, number, number, number, number, number, number, number | null][];
}

// The database keeps every original token column and pricing dimension. Expand
// the internal wire format before the existing aggregation and pricing loop.
function decodeCompactLeaderboardUsage(payload: CompactLeaderboardUsage): HourlyRow[] {
  if (payload?.format !== "leaderboard-usage-v1"
    || !Array.isArray(payload.user_ids) || !Array.isArray(payload.sources)
    || !Array.isArray(payload.model_names) || !Array.isArray(payload.pricing_tiers)
    || !Array.isArray(payload.rows)) {
    throw new Error("Invalid compact leaderboard payload");
  }
  const dimensions = [payload.user_ids, payload.sources, payload.model_names, payload.pricing_tiers];
  return payload.rows.map((row) => {
    if (!Array.isArray(row) || row.length !== 11
      || [row[0], row[1], row[2], row[3]].some((index, dim) => !Number.isInteger(index)
        || index < 0 || index >= dimensions[dim].length)) {
      throw new Error("Invalid compact leaderboard row");
    }
    const pricingTier = payload.pricing_tiers[row[3]];
    return {
      user_id: payload.user_ids[row[0]],
      source: payload.sources[row[1]],
      model: payload.model_names[row[2]],
      total_tokens: row[4],
      input_tokens: row[5],
      output_tokens: row[6],
      cached_input_tokens: row[7],
      cache_creation_input_tokens: row[8],
      reasoning_output_tokens: row[9],
      ...(pricingTier != null ? { pricing_tier: pricingTier } : {}),
      ...(row[10] != null ? { total_cost_usd: row[10] } : {}),
    };
  });
}

interface UserAgg {
  gpt_tokens: number;
  claude_tokens: number;
  gemini_tokens: number;
  cursor_tokens: number;
  opencode_tokens: number;
  openclaw_tokens: number;
  hermes_tokens: number;
  kiro_tokens: number;
  copilot_tokens: number;
  kimi_tokens: number;
  other_tokens: number;
  total_tokens: number;
  estimated_cost_usd: number;
}

function newUserAgg(): UserAgg {
  return {
    gpt_tokens: 0,
    claude_tokens: 0,
    gemini_tokens: 0,
    cursor_tokens: 0,
    opencode_tokens: 0,
    openclaw_tokens: 0,
    hermes_tokens: 0,
    kiro_tokens: 0,
    copilot_tokens: 0,
    kimi_tokens: 0,
    other_tokens: 0,
    total_tokens: 0,
    estimated_cost_usd: 0,
  };
}

/**
 * GET ?anomalies=1 — counts-only anti-cheat queue health and independent
 * read-back for the GitHub Actions scanner.
 *
 * Returns COUNTS ONLY, never user_ids. Naming a flagged account in a public CI
 * log before human review would accuse users the detector may yet clear. The
 * operator pulls identities from the private flags table directly.
 */
async function anomalyQueueSummaryData(
  client: ReturnType<typeof createClient>,
): Promise<{
  ok: true;
  auto_excluded: number;
  review: number;
  max_peak_tokens: number;
  latest_detected_at: string | null;
  last_scan_completed_at: string | null;
  last_queue_changed_at: string | null;
  last_response_completed_at: string | null;
}> {
  const { data, error } = await client.database
    .from("tokentracker_leaderboard_anomaly_flags")
    .select("status,peak_tokens,detected_at")
    .in("status", ["auto_excluded", "review"]);
  if (error) throw new Error(error.message);
  const rows = (Array.isArray(data) ? data : []) as Array<{
    status: string;
    peak_tokens: number;
    detected_at: string;
  }>;
  const { data: runStateData, error: runStateError } = await client.database
    .from("tokentracker_anticheat_run_state")
    .select("last_completed_at,last_queue_changed_at,last_response_completed_at")
    .eq("id", true)
    .limit(1);
  if (runStateError) throw new Error(runStateError.message);
  const runState = Array.isArray(runStateData) && runStateData.length > 0
    ? runStateData[0] as Record<string, unknown>
    : {};
  const pick = (s: string) => rows.filter((r) => r.status === s);
  return {
    ok: true,
    auto_excluded: pick("auto_excluded").length,
    review: pick("review").length,
    max_peak_tokens: rows.reduce(
      (m, r) => Math.max(m, Number(r.peak_tokens) || 0),
      0,
    ),
    latest_detected_at:
      rows.map((r) => r.detected_at).sort().at(-1) ?? null,
    last_scan_completed_at:
      typeof runState.last_completed_at === "string"
        ? runState.last_completed_at
        : null,
    last_queue_changed_at:
      typeof runState.last_queue_changed_at === "string"
        ? runState.last_queue_changed_at
        : null,
    last_response_completed_at:
      typeof runState.last_response_completed_at === "string"
        ? runState.last_response_completed_at
        : null,
  };
}

async function anomalyQueueSummary(
  client: ReturnType<typeof createClient>,
): Promise<Response> {
  try {
    return json(await anomalyQueueSummaryData(client));
  } catch {
    return json({ error: "Failed to fetch anomaly queue summary" }, 500);
  }
}

/**
 * GET ?quarantine_audit=1 — counts-only moderation self-audit.
 *
 * Answers the question the anomaly detector never asks: "does the data we
 * withheld still match the accounts we actually banned?" On 2026-07-21 a batch
 * quarantine moved rows for 40 users while only 8 reached the block list; the
 * other 32 had 51.1B tokens withheld for five weeks and it surfaced only when
 * one of them opened issue #534. A ban is a decision someone made on purpose,
 * but data quarantined for an account nobody banned is a plain contradiction,
 * so it can be detected without any judgement call.
 *
 * Returns COUNTS ONLY, never user_ids — same reason as the anomaly summary:
 * the caller is a public CI log.
 */
async function quarantineAuditData(
  client: ReturnType<typeof createClient>,
): Promise<{
  ok: true;
  blocklist_configured: boolean;
  orphan_users: number;
  orphan_rows: number;
  orphan_tokens: number;
  oldest_orphan_quarantined_at: string | null;
  blocked_total: number;
  blocked_without_flags: number;
}> {
  // Without a block list every quarantined account is trivially an "orphan".
  // Report the degraded state rather than a fabricated mass-false-ban.
  if (!BLOCKLIST_CONFIGURED) {
    return {
      ok: true,
      blocklist_configured: false,
      orphan_users: 0,
      orphan_rows: 0,
      orphan_tokens: 0,
      oldest_orphan_quarantined_at: null,
      blocked_total: 0,
      blocked_without_flags: 0,
    };
  }
  const { data, error } = await client.database.rpc(
    "leaderboard_quarantine_audit",
    { p_blocked: [...BLOCKED_LEADERBOARD_USER_IDS] },
  );
  if (error) throw new Error(error.message);
  const row = (Array.isArray(data) && data.length > 0
    ? data[0]
    : {}) as Record<string, unknown>;
  const num = (value: unknown) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  };
  return {
    ok: true,
    blocklist_configured: true,
    orphan_users: num(row.orphan_users),
    orphan_rows: num(row.orphan_rows),
    orphan_tokens: num(row.orphan_tokens),
    oldest_orphan_quarantined_at:
      typeof row.oldest_orphan_quarantined_at === "string"
        ? row.oldest_orphan_quarantined_at
        : null,
    blocked_total: num(row.blocked_total),
    blocked_without_flags: num(row.blocked_without_flags),
  };
}

async function quarantineAudit(
  client: ReturnType<typeof createClient>,
): Promise<Response> {
  try {
    return json(await quarantineAuditData(client));
  } catch {
    return json({ error: "Failed to fetch quarantine audit" }, 500);
  }
}

export default async function (req: Request): Promise<Response> {
  if (req.method === "OPTIONS")
    return new Response(null, { status: 204, headers: corsHeaders });

  const requestParams = new URL(req.url).searchParams;
  const wantsAnomalySummary =
    req.method === "GET" && requestParams.get("anomalies") === "1";
  const wantsQuarantineAudit =
    req.method === "GET" && requestParams.get("quarantine_audit") === "1";
  const wantsPublicRead = wantsAnomalySummary || wantsQuarantineAudit;
  if (req.method !== "POST" && !wantsPublicRead)
    return json({ error: "Method not allowed" }, 405);

  // The read-only summaries are unauthenticated (they expose no identities);
  // everything else still requires the refresh secret / service role / sign-in.
  const authorization = wantsPublicRead ? "public" : await authorizeRefresh(req);
  if (!authorization) return json({ error: "unauthorized" }, 401);
  try { await loadPricing(); } catch { return new Response(JSON.stringify({error:"Pricing catalog unavailable"}), {status:503,headers:{"Content-Type":"application/json"}}); }
  const requestStartedAt = Date.now();

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
    // The protected anomaly RPC performs a bounded multi-day aggregate and
    // can legitimately cross the SDK's older 10s default under load. Keep the
    // timeout below the edge runtime budget while leaving enough headroom for
    // the scan to complete instead of reporting a false automation failure.
    timeout: 25_000,
    ...(anonKey ? { headers: { apikey: anonKey } } : {}),
  });

  if (authorization === "public") {
    return wantsQuarantineAudit
      ? await quarantineAudit(client)
      : await anomalyQueueSummary(client);
  }

  // Parse requested periods
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  if (Object.hasOwn(body, "anti_cheat_reconcile_at")) {
    if (authorization !== "privileged")
      return json({ error: "privileged anti-cheat operation required" }, 403);
    const queueChangedAt = body.anti_cheat_reconcile_at;
    if (
      typeof queueChangedAt !== "string" ||
      !queueChangedAt ||
      !Number.isFinite(Date.parse(queueChangedAt))
    ) {
      return json({ error: "invalid anti-cheat queue timestamp" }, 400);
    }
    const { data, error } = await client.database.rpc(
      "reconcile_anticheat_snapshot_exclusions",
      { p_queue_changed_at: queueChangedAt },
    );
    if (error) return json({ error: error.message }, 500);
    const row = Array.isArray(data) && data.length > 0
      ? data[0] as Record<string, unknown>
      : {};
    if (row.applied !== true) {
      return json({ error: "anti-cheat queue changed during snapshot reconciliation" }, 409);
    }
    return json({
      ok: true,
      reconciled_snapshot_rows: Number(row.deleted_rows) || 0,
      last_response_completed_at:
        typeof row.response_completed_at === "string"
          ? row.response_completed_at
          : queueChangedAt,
    });
  }
  const scanAnomalies = body.scan_anomalies === true;
  const forceRefresh = body.force_refresh === true;
  if ((scanAnomalies || forceRefresh) && authorization !== "privileged")
    return json({ error: "privileged anti-cheat operation required" }, 403);
  if (authorization === "signed-in" && body.period !== "week")
    return json({ error: "signed-in users may only refresh week" }, 403);

  let anomalyScan: {
    inserted_excluded: number;
    inserted_review: number;
    breaker_tripped: boolean;
    queue: Awaited<ReturnType<typeof anomalyQueueSummaryData>>;
  } | null = null;
  if (scanAnomalies) {
    const { data: scanData, error: scanError } = await client.database.rpc(
      "detect_leaderboard_anomalies",
    );
    if (scanError) {
      logRefreshEvent({ event: "anomaly_scan_failed", error: scanError.message });
      return json({ error: scanError.message }, 500);
    }
    const scanRow = Array.isArray(scanData) && scanData.length > 0
      ? scanData[0] as Record<string, unknown>
      : {};
    try {
      anomalyScan = {
        inserted_excluded: Number(scanRow.inserted_excluded) || 0,
        inserted_review: Number(scanRow.inserted_review) || 0,
        breaker_tripped: scanRow.breaker_tripped === true,
        queue: await anomalyQueueSummaryData(client),
      };
    } catch {
      return json({ error: "Failed to summarize anomaly scan" }, 500);
    }
    logRefreshEvent({ event: "anomaly_scan_completed", ...anomalyScan });
  }
  const requestSource =
    typeof body.source === "string" && body.source.trim().length > 0
      ? body.source.trim().slice(0, 80)
      : "unknown";
  let periods: Period[];
  if (body.period && ALL_PERIODS.includes(body.period as Period)) {
    periods = [body.period as Period];
  } else {
    periods = [...ALL_PERIODS];
  }

  const results: Record<string, { upserted: number; skipped?: boolean }> = {};
  const requestId = crypto.randomUUID();

  for (const period of periods) {
    const periodStartedAt = Date.now();
    const { from_day, to_day } = computeDateRange(period);

    // --- Fail-closed throttle + concurrency guard ---
    // Atomic claim on last_attempt_at, which advances on EVERY attempt (success
    // OR failure). The old throttle read snapshots.generated_at, which only
    // advances on success — so once the RPC started timing out it opened
    // permanently and every cron tick re-ran the full refresh concurrently
    // (the 2026-06-21 meltdown). The single-statement claim also serializes
    // concurrent callers (only one wins each 30s window). Fail-OPEN only on a
    // claim-infra error, never on a throttle hit — a lock fault must not be
    // able to freeze refreshes (safe now that the RPC is fast, issue #263).
    try {
      const { data: claimed, error: claimErr } = await client.database.rpc(
        "leaderboard_refresh_try_claim",
        { p_period: period, p_min_interval_s: forceRefresh ? 0 : 30 },
      );
      if (!claimErr && claimed !== true) {
        results[period] = { upserted: 0, skipped: true };
        logRefreshEvent({
          event: "period_skipped",
          request_id: requestId,
          source: requestSource,
          period,
          from_day,
          to_day,
          upserted: 0,
          skipped: true,
          reason: "throttled",
          duration_ms: Date.now() - periodStartedAt,
        });
        continue;
      }
    } catch (_e) {
      // fail-open: proceed with refresh rather than block on a lock fault
    }

    // --- Aggregate via server-side RPC ---
    // leaderboard_usage_grouped does the two-class cross-device aggregation in
    // Postgres — account-level sources (cursor) deduped to ONE canonical whole
    // row per (user, source, model, hour) across all devices; machine-level
    // sources SUMmed across each user's ACTIVE devices — returning one
    // pre-aggregated {user_id, source, model, ...tokens} object per group.
    // Moving the multi-million-row hourly scan out of the edge fixes the
    // total-period failure (the in-edge scan 500'd at ~5s on the schedule and
    // 504'd at the 30s gateway once history grew). Mirrors how the account-*
    // functions delegate to account_usage_grouped.
    const rangeStart = `${from_day}T00:00:00Z`;
    const nextDay = new Date(to_day + "T00:00:00Z");
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    const rangeEnd = nextDay.toISOString();

    // Keep the cluster-aware historical rollup on a closed-day watermark.
    // This is cheap in scheduled total refreshes (normally zero or one day)
    // and avoids depending on the legacy postgres-owned nightly function,
    // whose cross-device semantics predate machine clusters (issue #412).
    if (period === "total") {
      const { error: advanceErr } = await client.database.rpc(
        "leaderboard_rollup_daily_advance_v2",
      );
      if (advanceErr) {
        logRefreshEvent({
          event: "period_error",
          request_id: requestId,
          source: requestSource,
          period,
          from_day,
          to_day,
          stage: "rollup_advance",
          error: advanceErr.message,
          duration_ms: Date.now() - periodStartedAt,
        });
        return json({ error: advanceErr.message }, 500);
      }
    }

    const __t0 = Date.now();
    let groupedData: unknown;
    let rpcErr: { message: string } | null = null;
    if (period === "total") {
      // A single all-time RPC response eventually exceeded the database
      // client's fixed 10s transport budget even after the historical scan was
      // replaced by a compact rollup. Eight disjoint UUID ranges keep every
      // response bounded while retaining model/pricing-tier rows for the one
      // canonical TypeScript pricing implementation below.
      const totalRows: HourlyRow[] = [];
      for (let shardIndex = 0; shardIndex < TOTAL_USER_SHARDS.length; shardIndex += 2) {
        const shardBatch = await Promise.all(
          TOTAL_USER_SHARDS.slice(shardIndex, shardIndex + 2).map(({ from, to }) =>
            client.database.rpc(
              "leaderboard_usage_compact_total_shard",
              { p_to: rangeEnd, p_user_from: from, p_user_to: to },
            )
          ),
        );
        const failedShard = shardBatch.find((result) => result.error);
        if (failedShard?.error) {
          rpcErr = failedShard.error;
          break;
        }
        for (const result of shardBatch) {
          totalRows.push(...decodeCompactLeaderboardUsage(result.data as CompactLeaderboardUsage));
        }
      }
      groupedData = rpcErr ? null : totalRows;
    } else {
      const result = await client.database.rpc(
        "leaderboard_usage_compact",
        { p_from: rangeStart, p_to: rangeEnd },
      );
      rpcErr = result.error;
      groupedData = rpcErr ? null : decodeCompactLeaderboardUsage(result.data as CompactLeaderboardUsage);
    }
    const __tAfterRpc = Date.now();
    if (rpcErr) {
      logRefreshEvent({
        event: "period_error",
        request_id: requestId,
        source: requestSource,
        period,
        from_day,
        to_day,
        stage: "rpc_aggregate",
        error: rpcErr.message,
        duration_ms: Date.now() - periodStartedAt,
      });
      return json({ error: rpcErr.message, stage: "rpc_aggregate" }, 500);
    }
    const grouped = (Array.isArray(groupedData) ? groupedData : []) as HourlyRow[];
    const scannedRows = grouped.length; // pre-aggregated groups (not raw rows)
    const pageCount = 1; // single RPC round-trip

    const aggMap = new Map<string, UserAgg>();
    for (const row of grouped) {
      let agg = aggMap.get(row.user_id);
      if (!agg) {
        agg = newUserAgg();
        aggMap.set(row.user_id, agg);
      }
      const tokens = Number(row.total_tokens) || 0;
      const col = SOURCE_COLUMN_MAP[row.source] ?? "other_tokens";
      (agg as unknown as Record<string, number>)[col] += tokens;
      agg.total_tokens += tokens;
      agg.estimated_cost_usd += computeRowCost(row);
    }
    for (const blockedUserId of BLOCKED_LEADERBOARD_USER_IDS) {
      aggMap.delete(blockedUserId);
    }

    // Soft exclusion from the automated anti-cheat detector
    // (scripts/ops/leaderboard-anomaly-detection.sql, hourly pg_cron). Distinct
    // from the blocklist secret above: those are human-confirmed permanent bans,
    // these are machine-flagged and reversible -- clearing the flag row puts the
    // user back on the leaderboard at the next refresh, and their own dashboard
    // never stops showing their data either way.
    //
    // Fail-OPEN on purpose. A leaderboard that briefly includes an unconfirmed
    // cheat is a smaller failure than one that silently drops real users because
    // a query errored, so a read failure logs and proceeds rather than throwing.
    //
    // Flags are per (user, day) but exclusion is whole-user across every period:
    // one fabricated day makes the user's total untrustworthy, and the detector's
    // lookback window keeps flags recent, so the queue stays short enough that
    // "excluded until a human looks" is not a long sentence.
    try {
      const { data: flagData, error: flagErr } = await client.database
        .from("tokentracker_leaderboard_anomaly_flags")
        .select("user_id")
        .eq("status", "auto_excluded");
      if (flagErr) {
        logRefreshEvent({
          event: "anomaly_flags_read_failed",
          period,
          error: flagErr.message,
        });
      } else {
        const flagged = new Set(
          (Array.isArray(flagData) ? flagData : []).map(
            (r: { user_id: string }) => r.user_id,
          ),
        );
        let removed = 0;
        for (const userId of flagged) {
          if (aggMap.delete(userId)) removed++;
        }
        if (removed > 0) {
          logRefreshEvent({
            event: "anomaly_auto_excluded",
            period,
            excluded_users: removed,
            flagged_total: flagged.size,
          });
        }
      }
    } catch (err) {
      logRefreshEvent({
        event: "anomaly_flags_read_failed",
        period,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (aggMap.size === 0) {
      // The snapshot is a materialized replacement, not an append-only log.
      // If every user disappeared (for example, all were soft-excluded), clear
      // the previous window rather than leaving an old leaderboard visible.
      const { error: deleteErr } = await client.database
        .from("tokentracker_leaderboard_snapshots")
        .delete()
        .eq("period", period)
        .eq("from_day", from_day)
        .eq("to_day", to_day);
      if (deleteErr) {
        logRefreshEvent({
          event: "period_error",
          request_id: requestId,
          source: requestSource,
          period,
          from_day,
          to_day,
          stage: "delete_empty_snapshot",
          error: deleteErr.message,
          duration_ms: Date.now() - periodStartedAt,
        });
        return json({ error: deleteErr.message }, 500);
      }
      results[period] = { upserted: 0 };
      logRefreshEvent({
        event: "period_completed",
        request_id: requestId,
        source: requestSource,
        period,
        from_day,
        to_day,
        scanned_rows: scannedRows,
        pages_fetched: pageCount,
        deduped_buckets: grouped.length,
        aggregated_users: 0,
        upserted: 0,
        skipped: false,
        duration_ms: Date.now() - periodStartedAt,
      });
      continue;
    }

    // Fetch settings, profile and snapshot fallback in one database call.
    // This replaces three waves of concurrent 25-user HTTP batches that could
    // occupy nearly every PostgREST connection during a total refresh.
    const userIds = Array.from(aggMap.keys());
    type UserMetadataRow = {
      user_id: string;
      leaderboard_public: boolean;
      leaderboard_anonymous: boolean;
      github_url: string | null;
      show_github_url: boolean;
      display_name: string | null;
      avatar_url: string | null;
    };
    const { data: metadataRows, error: metadataError } = await client.database.rpc("leaderboard_user_metadata",
      { p_user_ids: userIds },
    );
    if (metadataError) {
      logRefreshEvent({
        event: "user_metadata_fetch_error",
        period,
        error: metadataError.message,
      });
      return json({ error: "Failed to fetch leaderboard user metadata" }, 500);
    }
    const metadataMap = new Map<string, UserMetadataRow>();
    for (const metadata of (Array.isArray(metadataRows) ? metadataRows : []) as UserMetadataRow[]) {
      metadataMap.set(metadata.user_id, metadata);
    }

    const __tAfterFetch = Date.now();

    // --- Rank users by total_tokens DESC ---
    const sorted = Array.from(aggMap.entries()).sort((a, b) => b[1].total_tokens - a[1].total_tokens);

    // Bind the snapshot to its read generation so a completed device reset
    // can reject a delayed writer that aggregated the previous history.
    const generatedAt = new Date(periodStartedAt).toISOString();
    const upsertRows = sorted.map(([userId, agg], idx) => {
      const metadata = metadataMap.get(userId);
      const isPublic = metadata?.leaderboard_public ?? false;
      const isAnonymous = metadata?.leaderboard_anonymous ?? false;
      const displayName = isAnonymous ? "Anonymous" : (metadata?.display_name ?? "Anonymous");
      const avatarUrl = isAnonymous ? null : (metadata?.avatar_url ?? null);
      // Only surface github_url on the public snapshot when the user opted in
      // AND isn't in anonymous mode — anonymous takes precedence over any
      // identifying link.
      const githubUrl = !isAnonymous && metadata?.show_github_url && metadata?.github_url
        ? metadata.github_url
        : null;

      return {
        user_id: userId,
        period,
        from_day,
        to_day,
        rank: idx + 1,
        gpt_tokens: agg.gpt_tokens,
        claude_tokens: agg.claude_tokens,
        gemini_tokens: agg.gemini_tokens,
        cursor_tokens: agg.cursor_tokens,
        opencode_tokens: agg.opencode_tokens,
        openclaw_tokens: agg.openclaw_tokens,
        hermes_tokens: agg.hermes_tokens,
        kiro_tokens: agg.kiro_tokens,
        copilot_tokens: agg.copilot_tokens,
        kimi_tokens: agg.kimi_tokens,
        other_tokens: agg.other_tokens,
        total_tokens: agg.total_tokens,
        estimated_cost_usd: Math.round(agg.estimated_cost_usd * 100) / 100,
        display_name: displayName,
        avatar_url: avatarUrl,
        github_url: githubUrl,
        is_public: isPublic,
        generated_at: generatedAt,
      };
    });

    // Upsert in batches of 200
    for (let i = 0; i < upsertRows.length; i += 200) {
      const batch = upsertRows.slice(i, i + 200);
      const { error: upsertErr } = await client.database
        .from("tokentracker_leaderboard_snapshots")
        .upsert(batch, { onConflict: "user_id,period,from_day,to_day" });

      if (upsertErr) {
        logRefreshEvent({
          event: "period_error",
          request_id: requestId,
          source: requestSource,
          period,
          from_day,
          to_day,
          stage: "upsert_snapshot",
          error: upsertErr.message,
          scanned_rows: scannedRows,
          pages_fetched: pageCount,
          deduped_buckets: grouped.length,
          aggregated_users: aggMap.size,
          duration_ms: Date.now() - periodStartedAt,
        });
        return json({ error: upsertErr.message }, 500);
      }
    }

    // Reconcile the materialized snapshot only after every replacement row is
    // durable. Upsert alone cannot remove users that disappeared from aggMap
    // (blocked accounts, anti-cheat exclusions, or accounts with no remaining
    // usage), which previously left stale ranks visible indefinitely. Using
    // generated_at as the generation marker avoids a delete-before-insert gap:
    // if any upsert fails, the old complete snapshot remains available.
    const { error: staleDeleteErr } = await client.database
      .from("tokentracker_leaderboard_snapshots")
      .delete()
      .eq("period", period)
      .eq("from_day", from_day)
      .eq("to_day", to_day)
      .lt("generated_at", generatedAt);
    if (staleDeleteErr) {
      logRefreshEvent({
        event: "period_error",
        request_id: requestId,
        source: requestSource,
        period,
        from_day,
        to_day,
        stage: "delete_stale_snapshot",
        error: staleDeleteErr.message,
        scanned_rows: scannedRows,
        pages_fetched: pageCount,
        deduped_buckets: grouped.length,
        aggregated_users: aggMap.size,
        duration_ms: Date.now() - periodStartedAt,
      });
      return json({ error: staleDeleteErr.message }, 500);
    }

    results[period] = { upserted: upsertRows.length };
    logRefreshEvent({
      event: "period_completed",
      request_id: requestId,
      source: requestSource,
      period,
      from_day,
      to_day,
      scanned_rows: scannedRows,
      pages_fetched: pageCount,
      deduped_buckets: grouped.length,
      aggregated_users: aggMap.size,
      upserted: upsertRows.length,
      skipped: false,
      // Stage timing — the 'total' period runs the whole-history RPC, whose
      // duration approaches the edge's 30s execution budget; track rpc_ms so a
      // creep toward the ceiling is visible before it starts failing again.
      rpc_ms: __tAfterRpc - __t0,
      fetch_ms: __tAfterFetch - __tAfterRpc,
      duration_ms: Date.now() - periodStartedAt,
    });
  }

  logRefreshEvent({
    event: "request_completed",
    request_id: requestId,
    source: requestSource,
    requested_periods: periods,
    duration_ms: Date.now() - requestStartedAt,
    results,
  });
  return json({ ok: true, results, ...(anomalyScan ? { scan: anomalyScan } : {}) });
}
