# pi-auth-broker

[![Install with pi](https://img.shields.io/badge/pi-extension-7c3aed)](https://github.com/its-a-unixsystem/pi-auth-broker)

A [pi](https://www.npmjs.com/package/@mariozechner/pi) extension that delegates OAuth
credential lifecycle for `anthropic` and `openai-codex` to the local
[`omp auth-broker`](https://github.com/ingenire/omp) daemon — so multiple pi/omp
clients share tokens with zero refresh races, and the client never holds a real
refresh token.

Install: `pi install git:github.com/its-a-unixsystem/pi-auth-broker`

```
┌──── pi ────┐        ┌──────────────────┐       ┌─────────────┐
│ auth.json  │◄───────│  pi-auth-broker  │──────►│ omp         │
│ (sentinel) │ login/ │  (this extension)│  HTTP │ auth-broker │
└────────────┘ refresh└──────────────────┘       │ (127.0.0.1) │
                                                └─────────────┘
```

## How it works

- **Provider takeover, not header hacks.** Registers broker-backed OAuth adapters
  over the builtin `anthropic` / `openai-codex` providers via `pi.registerProvider`.
  pi's own auth pipeline does the heavy lifting: `/login` invokes our adapter,
  and pi's lock-safe refresh calls our `refreshToken` when a token nears expiry
  (< 5 min), then re-persists auth.json itself.
- **Client never holds refresh tokens.** The broker's snapshot redacts them as
  `"__remote__"`. All rotation is delegated via `POST /v1/credential/:id/refresh`.
  auth.json contains only the sentinel.
- **Proactive freshness.** The broker self-refreshes (60 s interval, 5 min skew);
  pi's own double-checked-lock refresh covers the last 5 minutes; and a long-poll
  loop (`GET /v1/snapshot?wait=30000` + ETag) keeps the extension's view current.
- **401 recovery.** On a 401, the extension refreshes via the broker, rewrites
  auth.json, and re-queues the prompt once per turn — on both response hooks
  (openai-codex) and errored-message events (anthropic, whose SDK throws before
  response hooks fire).
- **Single-flight by construction.** Concurrent refreshes collapse into one
  broker POST per credential (client-side in-flight map; the broker's refresh
  leases are the authority across processes).

## Setup

Requires: [pi](https://www.npmjs.com/package/@mariozechner/pi) ≥ 0.85, a running
`omp auth-broker` on 127.0.0.1:8765, at least one credential logged in
(`omp auth-broker login anthropic`).

Configuration resolves in this order (first hit wins):

1. `OMP_AUTH_BROKER_URL` / `OMP_AUTH_BROKER_TOKEN` env vars
2. `~/.omp/auth-broker.token` (URL defaults to `http://127.0.0.1:8765`)
3. `~/.pi/agent/auth-broker.token`
4. `~/.pi/agent/settings.json` → `auth.broker.{url,token}`

No configuration → the extension stays inert and builtin auth is unaffected.

### Install

```bash
# From GitHub (persisted to ~/.pi/agent/settings.json):
pi install git:github.com/its-a-unixsystem/pi-auth-broker

# Try it once, without installing:
pi -e git:github.com/its-a-unixsystem/pi-auth-broker

# Or a local dev checkout:
pi install /path/to/pi-auth-broker
```

No `npm install` needed — zero runtime dependencies (Node stdlib only),
TypeScript is loaded by pi's jiti runtime, and `pi` / `@earendil-works/pi-ai`
are peer-provided by the running pi process.

## Usage

```
/login anthropic        # pick a broker account if several (uses onSelect picker)
/login openai-codex
/omp-auth status        # broker health, generation, per-credential expiry, active flags
/omp-auth refresh       # force-refresh all provisioned providers via broker
/omp-auth refresh anthropic
```

Then just use `anthropic/…` or `openai-codex/…` models normally.

### What `/login` does with this extension active

**No new token is created.** With the extension loaded, `/login <provider>` never
runs an OAuth flow, opens a browser, or contacts OpenAI/Anthropic. It is reduced
purely to *account selection*:

```
/login openai-codex
  → GET /v1/snapshot from the broker
  → account picker (only shown when the broker holds several credentials)
  → chosen credential copied into auth.json
```

Tokens are created exactly once, centrally, at the broker:

```bash
omp auth-broker login openai-codex   # browser flow runs here; token lives in the broker
```

Any pi instance then just picks an account via `/login`.

Notes on `/omp-auth status` output:

- `[active]` is per-provider, not per-account — pi stores exactly one credential
  per provider, so with two broker accounts both show `[active]` while only the
  selected one is stored. Switch accounts by running `/login` again and picking
  the other entry.
- `not managed` entries are broker credentials this extension has no pi provider
  wired up for (see recipe below).

To return to pi's native OAuth (local refresh token, no broker): remove the
extension (`pi remove git:github.com/its-a-unixsystem/pi-auth-broker` or
`pi remove npm:pi-auth-broker`), restart pi, and `/login` again.

### Using other broker credentials

**nanogpt (api_key) — auth wiring shipped, catalog is yours.** When the broker
snapshot holds a `nanogpt` api_key credential, the extension registers the
provider with the broker's key (baseUrl `https://nano-gpt.com/api/v1`, OpenAI
chat-completions). No models are hardcoded — list the ones you use in
`~/.pi/agent/models.json` and pi merges them into the provider natively:

```json
{
  "providers": {
    "nanogpt": {
      "api": "openai-completions",
      "baseUrl": "https://nano-gpt.com/api/v1",
      "models": [
        {
          "id": "z-ai/glm-5.3-flash",
          "name": "GLM 5.3 Flash",
          "input": ["text"],
          "contextWindow": 128000,
          "maxTokens": 16384,
          "cost": { "input": 0.1, "output": 0.4, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  }
}
```

- Model ids come from `GET https://nano-gpt.com/api/v1/models` (≈600 entries).
- Keep `baseUrl` and `api` exactly as above (pi validates models.json entries on
  their own, before the extension's auth wiring is applied). The `apiKey` is
  the one thing you never set — the extension injects the broker's key.
- `cost`/`contextWindow`/`maxTokens` are your guesses; set them per model when
  you care about the usage display.
- API keys don't rotate through the OAuth refresh path: after
  `omp auth-broker login nanogpt`, restart pi so the extension re-registers
  with the new key.
- Without a nanogpt credential in the broker, the provider isn't registered
  and models.json nanogpt entries stay unconfigured.

`/omp-auth status` shows nanogpt as `(api-key)` once wired.

**OAuth entries** (perplexity, devin) would follow the builtin pattern —
`buildOauthAdapter(...)` plus a `PROVIDERS` entry in `index.ts` — but also
need a full provider definition (models, API mapping, baseUrl), which pi only
ships builtins for. PRs welcome.

## Files

| File | Role |
|---|---|
| `index.ts` | Extension entry: config, provider registration, long-poll watcher, 401 recovery, `/omp-auth` |
| `broker.ts` | `BrokerClient`: snapshot/long-poll/refresh, config resolution chain |
| `auth.ts` | OAuth adapters, sentinel credential mapping, lockfile-safe auth.json writes (0600) |
| `test/fake-broker.mts` | Self-contained fake broker + 9 assertion groups |

## Testing

```bash
node test/fake-broker.mts          # fake broker: login, sentinel, single-flight, locking, poll
~/node_modules/.bin/tsc -p tsconfig.json   # typecheck (needs typescript + @types/node available)
```

The fake-broker test covers: config env precedence, ETag/304 semantics, login
credential selection (incl. multi-account), sentinel round-trips, concurrent
refresh → 1 broker POST, credential matching fallbacks, lockfile-guarded auth.json
writes, long-poll generation bumps, and the 401 data path.

## Deliberately out of scope

- SSE push (long-poll chosen instead)
- Encrypted offline snapshot cache (memory only)
- `POST /v1/credential/:id/block`
- OAuth providers beyond pi's builtins (perplexity, devin) — would need full provider+model definitions. nanogpt is wired (see above); PRs welcome.

See `PRD.md` for the original requirements and `PLAN.md` for design decisions.

## Gallery listing (pi.dev/packages)

The [package gallery](https://pi.dev/packages) indexes **npm** packages
carrying the `pi-package` keyword — git-only repos are not listed. This repo
is npm-ready (`files`, `peerDependencies`, keyword all set):

```bash
npm login
npm publish            # from the repo root
```

Once published as `npm:pi-auth-broker`, it appears on the gallery and installs
with `pi install npm:pi-auth-broker`. Keep the `pi-package` keyword on every
release or the listing drops.
