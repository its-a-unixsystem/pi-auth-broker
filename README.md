# pi-auth-broker

A [pi](https://www.npmjs.com/package/@mariozechner/pi) extension that delegates OAuth
credential lifecycle for `anthropic` and `openai-codex` to the local
[`omp auth-broker`](https://github.com/ingenire/omp) daemon — so multiple pi/omp
clients share tokens with zero refresh races, and the client never holds a real
refresh token.

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
# From the repo:
pi -e /path/to/pi-auth-broker/index.ts

# Or permanently:
ln -s /path/to/pi-auth-broker ~/.pi/agent/extensions/pi-auth-broker
```

No `npm install` needed — TypeScript is loaded by pi's jiti runtime, and the
extension uses only Node stdlib.

## Usage

```
/login anthropic        # pick a broker account if several (uses onSelect picker)
/login openai-codex
/omp-auth status        # broker health, generation, per-credential expiry, active flags
/omp-auth refresh       # force-refresh all provisioned providers via broker
/omp-auth refresh anthropic
```

Then just use `anthropic/…` or `openai-codex/…` models normally.

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
- Providers beyond pi's builtins (perplexity/devin/nanogpt etc.)

See `PRD.md` for the original requirements and `PLAN.md` for design decisions.
