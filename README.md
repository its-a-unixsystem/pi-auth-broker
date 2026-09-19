# pi-auth-broker

[![Install with pi](https://img.shields.io/badge/pi-extension-7c3aed)](https://github.com/its-a-unixsystem/pi-auth-broker)

Reuse the OAuth credentials your [`omp auth-broker`](https://github.com/can1357/oh-my-pi/blob/main/docs/auth-broker-gateway.md)
daemon already holds. This [pi](https://www.npmjs.com/package/@mariozechner/pi)
extension is a thin client for that existing vault: it makes pi's `anthropic`
and `openai-codex` providers authenticate with broker-served tokens, so all
your pi and omp sessions share one credential pool with zero refresh races —
and pi never stores a real refresh token.

You log in **once, at the broker** (`omp auth-broker login anthropic`); every
pi instance then just picks an account. No second vault, no duplicated OAuth
flows, no new tokens.

Install: `pi install git:github.com/its-a-unixsystem/pi-auth-broker`

```text
┌──── pi ────┐        ┌──────────────────┐       ┌─────────────┐
│ auth.json  │◄───────│  pi-auth-broker  │──────►│ omp         │
│ (sentinel) │ login/ │  (this extension)│  HTTP │ auth-broker │
└────────────┘ refresh└──────────────────┘       │ (127.0.0.1) │
                                                └─────────────┘
```

## The auth-broker (not part of this project)

The daemon lives in [omp](https://github.com/can1357/oh-my-pi) ("oh-my-pi") —
there is no independent auth-broker project. `omp auth-broker serve` holds the
canonical SQLite credential vault, refreshes OAuth tokens in the background,
and exposes a small documented HTTP API under `/v1` (snapshot, refresh, health)
protected by a bearer token. Any client can speak that protocol; this extension
is simply the pi client for it — the same role omp's own remote clients play.

Reference: [docs/auth-broker-gateway.md](https://github.com/can1357/oh-my-pi/blob/main/docs/auth-broker-gateway.md)

Typical broker lifecycle (unchanged by this extension):

```bash
omp auth-broker serve                  # daemon on 127.0.0.1:8765
omp auth-broker login anthropic        # credentials are created HERE, once
omp auth-broker token                  # bearer token for clients
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

Requires: [pi](https://www.npmjs.com/package/@mariozechner/pi) ≥ 0.85, an
`omp auth-broker` already running (default `127.0.0.1:8765`) with at least one
credential logged in — i.e. the setup you already have for omp. This extension
adds no infrastructure; it only reads from what the broker already serves.

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

### Other broker credentials

The extension manages pi's builtin OAuth providers (`anthropic`,
`openai-codex`). Other broker entries (perplexity, devin, nanogpt, …) are
deliberately out of scope — wiring them means registering a full custom
provider (models, API mapping, baseUrl) in addition to auth, which is a
per-provider project of its own. `/omp-auth status` lists them as
`not managed`.

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
- Providers beyond pi's builtins — deliberately out of scope (see "Other broker credentials")

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
