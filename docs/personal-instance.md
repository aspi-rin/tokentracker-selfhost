# Personal instance

The personal edition keeps local collection, authenticated multi-device synchronization and an optional public usage page. The owner explicitly enables publication in Settings → Account. Turning it off withdraws the page immediately. Anonymous mode hides the nickname, avatar and GitHub link.

## Installation and upgrade

Use the existing InsForge self-hosted platform and backups. This change keeps the existing installation ledger and appends `14-personal-pricing`; it creates one private price-catalog table and a server-only compare-and-set function. Earlier installation steps and their checksums are unchanged. Existing usage, account settings, device identities, historical financial records and installed user skills remain on disk.

1. Make a consistent backup and preserve all deployed function sources and the previous static directory.
2. Build/install the private schema using `node scripts/self-host/install.cjs --sql /absolute/path/install.sql` and the existing deployment procedure. Apply only the registered pending step. Keep the existing public-profile v2 migration.
3. Set `TOKENTRACKER_OWNER_ID` to the existing owner's exact account UUID. Resolve it from the authenticated owner or the server account registry; keep the existing account. This binds the root public page, snapshot refresh and legacy list to that owner. Other accounts retain private data access only through their own verified identity.
4. Keep `TOKENTRACKER_PUBLIC_PROFILES_ENABLED=1`, the existing signing/authentication configuration and the private refresh secret. Keep new-user registration disabled at the authentication service and gateway. The dashboard has no registration entry.
5. Build the 21 functions with `node scripts/self-host/build-functions.cjs OUTPUT --public-profiles`. Generated functions force `TOKENTRACKER_SELF_HOSTED=1` internally. The runtime dependency is the pinned InsForge SDK; payment SDKs and merchant keys are absent.
6. Add the exact application routes `tokentracker-devices`, `tokentracker-pricing` and `tokentracker-public-home` to the existing gateway allowlist. Keep database/admin/RPC access closed. The refresh function remains private. GET prices and public home are public; device operations and price writes verify the user's signed JWT themselves. Price writes additionally require the configured owner UUID.
7. Build the dashboard with the same-origin `VITE_INSFORGE_BASE_URL`, public `VITE_INSFORGE_ANON_KEY` and `VITE_TOKENTRACKER_PUBLIC_PROFILES=1`. Replace the static directory atomically, rather than merging it with old marketing assets. Keep SPA fallback for `/device`, `/dashboard`, `/settings`, `/u/:id` and other app routes.
8. Verify sign-in, token refresh, device authorization, ingestion/deduplication, pause/resume, private totals, public/anonymous/withdrawn profile states, and backup recovery before switching clients.

The existing five-minute private snapshot task also checks the price feed; upstream prices refresh at most daily. An upstream outage keeps the last published catalog and still permits public snapshot generation. A manual refresh reports failure while retaining the prior catalog.

## Price catalog

`src/lib/pricing/core.js` is the shared pure calculation engine. `curated-overrides.json` contains reviewed model rules; the catalog combines those rules with normalized LiteLLM prices. Local and server calculations use the same matching, cache, reasoning and speed-tier logic. Unrecognized models keep an explicit unpriced status and zero estimated cost.

Settings → Sync & devices shows the source, update time and content version. The owner can refresh the feed there. Each local collector caches the catalog for its configured instance, rechecks it every five minutes and keeps its last valid copy offline. A different instance gets a separate cache. Local data and raw tokens remain unchanged when prices change; estimates are recalculated. Older clients without this implementation keep their previous local rates, and the new settings page warns when a local catalog version is unavailable or different.

For a reviewed model override without a code deployment:

1. Edit a copy of the curated JSON with the same schema. Keep rates in dollars per million tokens.
2. Generate a checked catalog: `node scripts/self-host/build-pricing-catalog.cjs catalog.json reviewed-overrides.json`. This fetches the fixed LiteLLM source, validates its numeric fields and hashes canonical JSON. The digest survives PostgreSQL JSONB key reordering.
3. Read the current catalog with GET `/functions/tokentracker-pricing` and keep its `version` as `expectedVersion`.
4. Using the owner's authenticated session, POST `{ "expectedVersion": "CURRENT_VERSION", "catalog": CATALOG_OBJECT }` to that endpoint. The handler validates the entire catalog; stale updates return 409. Anonymous, forged and other-account credentials are rejected. Keep access tokens out of source files, reports and command logs.
5. Verify the returned version, private estimates and the next public snapshot. The prior catalog can be republished with the same owner operation and the current expected version.

The LiteLLM feed is a community-maintained estimate source. Reviewed overrides take precedence. Provider invoices and subscription charges remain separate from these estimated token costs.

## Compatibility and retained data

The legacy billing endpoint remains a small device compatibility adapter: account/device reads and device pause/resume keep their existing response shapes. Checkout, trial, gifts and subscription actions return 410. Historical database objects remain for data preservation and installed migration checksums; the personal function builder never deploys merchant webhooks. Legacy hosted development fixtures are outside this edition's runtime.

`/leaderboard` redirects to the personal page. The legacy list API remains available to older clients and is scoped to `TOKENTRACKER_OWNER_ID` when configured. `/cloud`, `/self-host`, `/devices` and old checkout URLs resolve to Sync & devices after authentication. Removed skills and pet-configuration URLs return to the dashboard; their local management APIs return 410. User-owned skill folders and saved configuration are preserved.

## Native builds

Build macOS with the existing XcodeGen/Xcode project. Windows keeps its .NET/WebView2 build, and Linux keeps its Tauri build. Bot is fixed in the native menu/status bar; desktop-pet startup and control surfaces are disabled. `node scripts/gen-bot-tray.cjs` generates Windows contrast variants and the Linux tray image from the existing Bot frame data. Quota/widget entries remain in platform builds.

Personal macOS and Windows update checks target `aspi-rin/tokentracker-selfhost`. They cannot replace this edition with an upstream binary. Until releases exist in that repository and are accessible to the client, install reviewed personal builds manually. Building source, publishing an installer and deploying the service are separate operations.

## Rollback

Restore the prior function sources and static directory from the pre-change backup, and return clients to the previous reviewed build. Keep the new catalog table and installation record; the prior version ignores them. Preserve `TOKENTRACKER_OWNER_ID` and registration restrictions. Restore the entire database only as part of the existing tested recovery procedure, with a consistent backup and matching server configuration.
