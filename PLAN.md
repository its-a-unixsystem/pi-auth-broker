# Implement `pi-auth-broker` (PRD.md)

## Status
Final — all integration points verified against pi 0.85.x dist source and the live broker.

## Context
See `PRD.md`. Build a pi extension that pulls OAuth credentials from the local `omp auth-broker` daemon (127.0.0.1:8765) so multiple pi/omp clients share tokens with zero refresh races. The client extension never holds real refresh tokens — the broker's snapshot redacts them as `"__remote__"`, and all refreshes are delegated via `POST /v1/credential/:id/refresh`. Repo is otherwise empty; zero npm deps (node fetch/crypto/http only).

## The one design decision that matters

**Register broker-backed OAuth adapters over the builtin providers via `pi.registerProvider("anthropic"|"openai-codex", { oauth })`.** Not header injection. Verified reasons:

- `buildBaseCodexHeaders` (pi-ai `openai-codex-responses.js:1272`) force-sets `Authorization: Bearer ${apiKey}` *after* applying `before_provider_headers` overrides — header injection can never work for openai-codex.
- `resolveProviderAuth` (pi-ai `auth/resolve.js`) resolves stored-credential → oauth adapter → `toAuth` → `{apiKey: access}`; everything downstream already does the right thing per provider:
  - **anthropic**: `sk-ant-oat` access → `createClient` picks `authToken` (Bearer) + Claude Code identity headers + oauth beta features. No code needed.
  - **openai-codex**: JWT access → `extractAccountId` parses `chatgpt_account_id` → headers built correctly. No code needed.
- `composeOAuthAuth` (coding-agent `provider-composer.js:258`): extension `oauth` *replaces* the builtin oauth adapter; builtin api-key auth, models, baseUrl all preserved (`applyExtension` passthrough when `models` undefined).
- `resolveStoredOAuth` already gives us free proactive refresh: double-checked-lock under the credential-store lock calls our `refreshToken()` when `expires - now < 5min` (matches PRD AC-4 proactive, 300_000ms) and persists the result to auth.json itself.

So the extension is three small pieces: an OAuth adapter whose login fetches from the broker, a refreshToken that delegates to the broker, and a status/refresh command surface.

## Verified broker API (live probes, omp v18.2.2)
- `GET /v1/healthz` → `{"ok":true,"version"}` (no auth; version observed 18.1.21)
- `GET /v1/snapshot` (bearer) → `{generation, serverNowMs, refresher, credentials:[{id, provider, credential:{type, access, refresh:"__remote__", expires, accountId, email, ...}, identityKey, rotatesInMs}]}`
  - `?wait=ms` long-poll; `If-None-Match: "<generation>"` → 304 when unchanged (verified); 401 without bearer.
- `POST /v1/credential/:id/refresh` → `{entry:{...updated credential...}}` (verified, bumps generation)
- `POST /v1/credential/:id/block` needs `{providerKey, blockScope, blockedUntilMs}` — **skipped** (semantics unprobed, not needed for AC-1..6)
- Broker self-refreshes (`intervalMs: 60000, skewMs: 300000`) → tokens rotate well before expiry, so client-side 5-min-window refresh is a rare safety net, not the hot path.
- Live credentials: anthropic oauth id8 (`sk-ant-oat01-…`, ~442min TTL), openai-codex oauth id1/id4 (JWT, ~6.5-day TTL), plus perplexity/devin/nanogpt (out of scope per user choice).

## Verified pi extension mechanics
- Factory `export default async function (pi: ExtensionAPI)` is awaited before `session_start`; `pi.registerProvider()` during load lands in `pendingProviderRegistrations` and is applied at `createAgentSessionServices` — providers composed before first request. Model catalog = builtins (register with `oauth` only, no `models`).
- `registerProvider` re-registration merges; undefined keys preserved.
- Credential shape is open (`OAuthCredentials` has `[key: string]: unknown`) → store broker credential id as `brokerId` on the credential; extras `accountId`/`email` ride along for status display and matching.
- auth.json is re-read per request via `getFileRevision` (dev:ino:size:mtimeNs:ctimeNs) — external/locked writes are picked up without restart. Writes use proper-lockfile protocol: `mkdir auth.json.lock` (EEXIST + stale >30s → break), write mode 0600, `rmdir` lock. pi's own writes serialize on the same lockfile.
- `after_provider_response` fires in all modes (wired in `createAgentSession`'s agent streamFn, not mode-specific) with `{status, headers}` — 401 detection works everywhere.
- 401 is **not** retryable by pi's agent-level retry (`RETRYABLE_PROVIDER_ERROR_PATTERN` matches only transient text). PRD AC-4 "retry the turn once" is implemented by us: on 401 → single-flight broker refresh → lock-write auth.json → `pi.sendUserMessage(lastUserText, { deliverAs: "followUp" })` (queues after the failing turn ends; supported while streaming) → notify. Guard: max 1 auto-retry per turn.
- `/login anthropic` (pi builtin) invokes our registered `oauth.login(callbacks)`; `callbacks.onSelect({message, options})` gives the account picker when the broker has multiple credentials for a provider (e.g. codex id1/id4). Persistence flows through pi's own lock-safe `modify` — we never write auth.json during login.
- jiti aliases resolve `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` from any extension dir; type-only imports are erased. `AuthStorage` is **not** exported (only `readStoredCredential`), so the lockfile write helper is ours (~25 lines).
- Commands: `pi.registerCommand("omp-auth", { getArgumentCompletions, handler })`, notify via `ctx.ui.notify`.

## User decisions (planning session)
1. Snapshot cache: **memory only** — skip PRD AC-5 encrypted disk cache entirely.
2. Providers: **pi builtins only** — `anthropic`, `openai-codex`. Ignore broker's perplexity/devin/nanogpt creds.
3. Freshness: **long-poll loop** (`GET /v1/snapshot?wait=30000` + `If-None-Match: generation`), start on `session_start`, abort on `session_shutdown`. (SSE endpoint exists but not used — one less moving part.)
4. Testing: **fake-broker script** + manual real-broker checks.

## Approach

```text
~/src/pi-auth-broker/
  index.ts        entry: config → registerProvider ×2 → events → commands
  broker.ts       BrokerClient: config resolution, snapshot/long-poll, refresh (single-flight), healthz
  auth.ts         per-provider OAuth adapter objects (login/refreshToken/getApiKey) + lockfile write helper
  test/fake-broker.ts   fake broker + assertion-driven self-check (node, zero deps)
```

No package.json, no npm install (stdlib only; jiti loads TS directly).

**Config resolution** (PRD AC-2, first hit wins): env `OMP_AUTH_BROKER_URL`/`OMP_AUTH_BROKER_TOKEN` → `~/.omp/auth-broker.token` (URL defaults to `http://127.0.0.1:8765`) → `~/.pi/agent/auth-broker.token` → `~/.pi/agent/settings.json` `auth.broker.{url,token}` (user's file already has this). No broker configured → extension logs one line and stays inert (builtin auth unaffected).

**Provider map**: `{ "anthropic": "anthropic", "openai-codex": "openai-codex" }` (broker provider id → pi provider id).

**OAuth adapter** (per provider):
- `login(callbacks)`: GET snapshot; filter `provider` match; 0 → throw with "run omp auth-broker login <provider>"; 1 → return credential; >1 → `callbacks.onSelect` (label = email/accountId) → return chosen. Credential = `{ type: "oauth", access, refresh: "__remote__", expires, brokerId: c.id, accountId, email }` (sentinel satisfies AC-1).
- `refreshToken(cred, signal)`: find broker credential by `cred.brokerId` (fallback: provider+accountId/email match, else first) → `POST /v1/credential/:id/refresh` → return `{ type: "oauth", ...entry.credential, brokerId }` keeping the sentinel. Broker-side single-flight is the race guarantee; client keeps a one-promise in-flight map as a courtesy.
- `getApiKey(cred)`: `cred.access`.

**Events**:
- `session_start`: start long-poll loop (30s wait + ETag; 3s backoff on error). On generation change: update in-memory snapshot; if a new provider credential appears for a provider we haven't provisioned → `notify`.
- `session_shutdown`: abort loop.
- `after_provider_response` 401 + provider in map: single-flight refresh → lock-write updated credential to auth.json → notify → queue `sendUserMessage(lastUserText, {deliverAs:"followUp"})`, max once per turn (per-session flag reset on `turn_end`).

**Commands** (`/omp-auth`, `getArgumentCompletions` for `status|refresh` + provider ids):
- `/omp-auth status`: broker health (healthz + generation + refresher interval), per-credential listing (provider, email/accountId, rotatesInMs, expires-in), which providers are provisioned (auth.json check via `readStoredCredential`).
- `/omp-auth refresh [provider]`: POST refresh for the matched credential → lock-write auth.json → notify. No arg = all provisioned providers.

**Deliberately skipped** (each maps to a PRD non-goal or user decision): SSE stream, encrypted disk cache (AC-5, user said skip), block endpoint, custom provider registration for unknown providers, multi-tenant anything.

## Files to create
- `index.ts` — extension entry
- `broker.ts` — BrokerClient + config resolution
- `auth.ts` — oauth adapters + auth.json lockfile write helper
- `test/fake-broker.ts` — fake broker + self-test

## Reuse
- pi builtin `/login`, `/logout`, `/model` flows — our `oauth.login` slots into them (persistence, account select, error surfaces all pi-owned).
- pi's double-checked-lock refresh + auth.json persistence (`resolveStoredOAuth`) — we only supply `refreshToken`.
- `readStoredCredential` from `@earendil-works/pi-coding-agent` for the provisioned-check in `/omp-auth status`.
- Anthropic Bearer/authToken detection (`isOAuthToken`) and codex JWT `chatgpt_account_id` extraction — both already in pi-ai; we return `access` and they just work.

## Steps
- [x] 1. `broker.ts`: config resolution + BrokerClient (`healthz`, `snapshot(wait, etag)`, `refresh(id)`, single-flight map, long-poll loop factory returning an abort handle)
- [x] 2. `auth.ts`: lockfile write helper (mkdir `auth.json.lock`, stale>30s break, write 0600, rmdir) + `buildOauthAdapter(providerId)` (login/refreshToken/getApiKey as above)
- [x] 3. `index.ts`: resolve config (inert if none) → `registerProvider("anthropic", {oauth})` + `registerProvider("openai-codex", {oauth})` → events (`session_start` loop, `session_shutdown` abort, `after_provider_response` 401 handler) → `/omp-auth` command
- [x] 4. `test/fake-broker.ts`: node http fake broker (snapshot with ETag/wait, refresh single-flight counter, healthz) + assertions: login picks credential; refreshToken returns sentinel; two concurrent refreshes → 1 broker call; 401 handler writes auth.json and queues resend
- [x] 5. Manual real-broker verification (below)

## Verification
- **Fake**: `node test/fake-broker.ts` → all assertions green, exit 0.
- **Real** (broker already running):
  - `pi -e ./index.ts` → `/omp-auth status` shows generation + anthropic/codex credentials with expires-in.
  - `/login anthropic` → account picker (only one cred) → persisted → `/model` anthropic claude → query succeeds → `~/.pi/agent/auth.json` contains `refresh: "__remote__"`, no real refresh token (AC-1 grep check).
  - `/login openai-codex` → picker shows thomas@ / oksanauebermeier@ → pick → query succeeds.
  - `/omp-auth refresh anthropic` → auth.json mtime bumps, `access` changes, next query OK.
  - Force-expiry test: hand-edit auth.json `expires` to `Date.now()+60_000` → next request triggers our `refreshToken` (broker log/generation bump) and auth.json re-persists — the proactive AC-4 path.
  - Race check: two `pi` instances with same credential, both near-expiry → only one broker `POST /refresh` lands (broker single-flight); both requests succeed.
- **Skip-if-absent**: with no broker running and no config, extension logs one inert line; `/login anthropic` still offers builtin API-key path.
