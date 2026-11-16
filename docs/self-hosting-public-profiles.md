# Optional public leaderboard and profiles

This addon publishes aggregate usage for accounts that explicitly enable their public profile. The default is private. It preserves the free `self_hosted` policy and the private synchronization tables, credentials and access controls.

## Install

Start from the registered clean self-host installation at `93632c64`. Take a consistent database/secret/function backup first. Generate the addon SQL and the 18-function manifest from the reviewed source:

```sh
node scripts/self-host/install-public.cjs /private/install-public.sql
node scripts/self-host/build-functions.cjs /private/functions --public-profiles
```

Apply `install-public.sql` using the platform's transactional migration interface or `psql -v ON_ERROR_STOP=1`. The generated file includes its own transaction; a caller that already owns a transaction can use `buildSql({transactional:false})`. Reapplying the identical addon preserves data. An installed checksum mismatch or unregistered existing public tables causes an error. Keep the original private installer and its ledger unchanged.

Deploy the four added functions from `functions.json`. The other 14 files are included to bind the complete generated manifest; their application behavior remains the private synchronization flow. Set these **server-only** values in the function runtime:

```text
TOKENTRACKER_PUBLIC_PROFILES_ENABLED=1
TOKENTRACKER_PUBLIC_REFRESH_SECRET=<new random secret of at least 32 characters>
```

Keep the existing database/auth signing keys and internal service key. The generated public handlers return 503 whenever the feature flag is absent. The refresh handler additionally requires its dedicated Bearer secret. Keep that secret on the server.

Build the dashboard with explicit public client configuration:

```sh
VITE_INSFORGE_BASE_URL=https://tokens.aspi-rin.top \
VITE_INSFORGE_ANON_KEY=<this instance's public anonymous key> \
VITE_TOKENTRACKER_PUBLIC_PROFILES=1 npm --prefix dashboard run build
```

Serve the static output with SPA fallback for `/dashboard`, `/device`, `/leaderboard`, `/u/<user-id>` and existing application routes. Keep auth refresh responses and application functions out of shared caches. Configure the platform's auth callback allowlist and `TOKENTRACKER_DASHBOARD_URL` for the public origin while preserving required private/native callbacks.

## Exact gateway paths

Public read functions (GET/OPTIONS):

- `/functions/tokentracker-leaderboard`
- `/functions/tokentracker-leaderboard-profile`

Owner-authenticated preference function (GET/POST/OPTIONS):

- `/functions/tokentracker-public-visibility`

Existing synchronization function paths:

- `/functions/tokentracker-device-flow-authorize`
- `/functions/tokentracker-device-flow-grant`
- `/functions/tokentracker-device-flow-poll`
- `/functions/tokentracker-device-token-issue`
- `/functions/tokentracker-device-rename`
- `/functions/tokentracker-ingest`
- `/functions/tokentracker-account-summary`
- `/functions/tokentracker-account-daily`
- `/functions/tokentracker-account-hourly`
- `/functions/tokentracker-account-monthly`
- `/functions/tokentracker-account-heatmap`
- `/functions/tokentracker-account-model-breakdown`
- `/functions/tokentracker-account-devices`
- `/functions/tokentracker-billing`

Password-auth client paths used by SDK 1.4.5 (preserve required query strings such as `client_type=mobile`):

| Method | Exact path |
| --- | --- |
| GET | `/api/auth/public-config` |
| POST | `/api/auth/users` |
| POST | `/api/auth/sessions` |
| GET | `/api/auth/sessions/current` |
| POST | `/api/auth/refresh` |
| POST | `/api/auth/logout` |

Add email verification/reset or OAuth paths only when that feature is configured and separately verified. Management, SQL, database REST and secrets APIs remain outside this public allowlist. Default-deny unknown `/api/` and `/functions/` paths, including the refresh job below. Preserve method controls, request-size limits and rate limits at the gateway.

## Refresh and privacy behavior

Invoke `/functions/tokentracker-self-host-leaderboard-refresh` over the private loopback API, using POST, the public `apikey` header, and `Authorization: Bearer <dedicated refresh secret>`. Run once after installation and then every five minutes. A 300-second request deadline is suitable for this small instance. Serialize scheduled invocations; a failed job retains the last successfully published period and should be logged as a failure.

A private curl config file avoids putting the secret in command arguments. Create it on the server with mode 0600, substitute its actual loopback API port, and retain it beside the server secrets:

```text
url = "http://127.0.0.1:7130/functions/tokentracker-self-host-leaderboard-refresh"
request = "POST"
header = "Content-Type: application/json"
header = "apikey: <public anonymous key>"
header = "Authorization: Bearer <dedicated refresh secret>"
data = "{}"
fail-with-body
silent
show-error
max-time = 300
```

Invoke `curl --config /private/public-refresh.curl`. Log the exit status and the aggregate-only response; protect the config file and omit it from client packages and public reports.

The refresher enumerates consenting accounts and uses the existing private daily aggregation and pricing logic. Snapshot insertion rechecks consent under the same database lock as opt-out. Disabling publication deletes that account's snapshots immediately. Readers also check current consent, so residual privileged/stale rows stay hidden. Public reads use `no-store`; already downloaded copies remain with their recipients.

Public profiles include token/cost totals, provider/model breakdowns, activity history and device count. All-time headline totals come from the lifetime snapshot; activity details cover the existing trailing 365-day window. Names come from explicit user settings, with `Anonymous` as fallback. Anonymous mode hides the display name and GitHub link while retaining aggregate usage and its profile identifier. The optional official likes, embed-SVG and community statistics integrations are hidden in this self-host build.

## Verify and recover

Use two new synthetic accounts. Verify private defaults, independent device uploads, explicit opt-in, list/profile reads, anonymous identity, opt-out, rejection of stale/delayed publication, and private table/RPC denial. Verify real JWT expiry/signatures, native/browser refresh, the public gateway's management denials, job authentication, and restoration from the prechange backup.

For a quick rollback, remove the three added public gateway routes, stop the refresh job and disable the runtime flag. Restore the previous static site and device dashboard URL. Preserve the addon tables and ledger during rollback; they hold user choices. A full database restore requires the consistent prechange backup and coordination with any new usage uploaded since that backup.
