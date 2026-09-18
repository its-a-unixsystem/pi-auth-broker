# Product Requirements Document: Pi OMP Auth Broker Extension (`pi-auth-broker`)

**Document Status:** Draft  
**Owner:** Thomas  
**Date:** September 18, 2026  
**Target Repository / Directory:** `~/src/pi-auth-broker`

---

## 1. Executive Summary

### Problem Statement
Multiple AI coding agents and local tools sharing OAuth credentials (e.g., Anthropic, OpenAI Codex, Google Gemini CLI) face token invalidation race conditions when multiple clients simultaneously attempt to refresh tokens using single-use OAuth refresh tokens.

### Proposed Solution
`pi-auth-broker` is a native TypeScript extension for `pi` that delegates all OAuth credential lifecycle management to an external `omp auth-broker` server. The extension fetches sanitized credential snapshots containing ephemeral access tokens while ensuring that refresh tokens remain exclusively managed by the canonical broker host via remote refresh coordination (`POST /v1/credential/:id/refresh`).

### Success Criteria
1. **Zero Refresh Collisions:** 100% elimination of OAuth `invalid_grant` errors caused by multi-client refresh race conditions across concurrent sessions or hosts.
2. **Seamless Failover & Auto-Refresh:** Provider calls automatically detect token expiration (`401 Unauthorized` or TTL expiration < 5 minutes) and transparently request a broker-side refresh within ≤ 1500 ms without interrupting active agent conversations.
3. **Zero Secret Persistence:** `0` refresh tokens and zero unencrypted long-lived secrets stored on the client laptop file system outside memory or encrypted volatile caches.
4. **Instant Startup Time:** Session startup latency overhead introduced by credential snapshot fetching/revalidation is ≤ 250 ms (using encrypted local snapshot cache).

---

## 2. User Experience & Functionality

### User Personas
- **Developer / Power User:** Runs `pi` across multiple machines/containers, shares API allowances or enterprise OAuth accounts across setups, and wants credentials to "just work" without manual re-login cycles.
- **Enterprise Operator / SecOps:** Needs central governance of corporate LLM OAuth tokens, ability to audit token usage, and capability to revoke access centrally without touching individual developer machines.

### User Stories
- **US-1:** As a developer running `pi`, I want my agent to use active OAuth access tokens managed by my central auth broker so that I don't have to repeatedly re-authenticate on every new terminal, VM, or laptop.
- **US-2:** As a developer, I want `pi` to transparently refresh access tokens through the broker when they expire mid-turn so that long agent coding sessions never abort unexpectedly due to expired credentials.
- **US-3:** As a user, I want a `/omp-auth status` command in `pi` to inspect broker connectivity, current credential expiry states, and recent synchronization health.
- **US-4:** As a security-conscious engineer, I want the client extension to never possess or persist OAuth refresh tokens to disk, guaranteeing that single-use refresh tokens cannot be compromised or raced by client-side writes.

### Acceptance Criteria
- **AC-1 (Zero Local Refresh Writing):** The extension must never issue local OAuth token exchanges or persist OAuth refresh tokens. All refresh tokens received from `/v1/snapshot` must be sentinel-redacted (`REMOTE_REFRESH_SENTINEL`).
- **AC-2 (Auto-Discovery & Fallback):** Reads configuration from environment variables (`OMP_AUTH_BROKER_URL`, `OMP_AUTH_BROKER_TOKEN`) or configuration files (`~/.omp/auth-broker.token`, `config.yml`).
- **AC-3 (Dynamic Credential Resolution):** On startup, queries `GET /v1/snapshot` to discover available provider credentials and registers/overrides corresponding provider auth handlers via `pi.registerProvider()`.
- **AC-4 (Proactive & Reactive Refresh):**
  - Proactive: Refreshes credentials where `expires - Date.now() < 300_000` (5 minutes).
  - Reactive: Intercepts `401 Unauthorized` responses during `after_provider_response` or provider execution, dispatches `POST /v1/credential/:id/refresh` to the broker, and retries the turn once.
- **AC-5 (Encrypted Offline Snapshot Cache):** If the broker is temporarily unreachable on boot, reads encrypted cached snapshot (`~/.pi/cache/omp-broker-snapshot.enc`) using AES-256-GCM keyed by `SHA-256(OMP_AUTH_BROKER_TOKEN)`.
- **AC-6 (Interactive TUI Commands):** Registers custom commands `/omp-auth status` (shows broker health and credential listing) and `/omp-auth refresh` (forces immediate broker refresh).

### Non-Goals
- **Direct OAuth Login Flow Hosting:** The extension will NOT implement local OAuth redirect server listeners (e.g. listening on port 54545). Login flows remain owned by `omp auth-broker login` CLI.
- **Replacing `omp auth-gateway`:** While this extension provides direct broker-backed credential resolution, it is not a proxy server and does not re-encode wire protocols for external non-Pi clients.
- **Multi-Tenant User Management:** Managing user accounts, teams, or RBAC within the broker is out of scope.

---

## 3. System Architecture & Technical Specifications

### High-Level Component Flow

```
┌────────────────────────────────────────────────────────┐
│ pi Process                                             │
│                                                        │
│  ┌──────────────────────────────────────────────────┐  │
│  │ pi-auth-broker Extension                         │  │
│  │  - Reads OMP_AUTH_BROKER_URL & TOKEN             │  │
│  │  - Syncs via GET /v1/snapshot (ETag / SSE)       │  │
│  │  - Holds In-Memory Redacted Access Tokens        │  │
│  └──────────────┬──────────────────┬────────────────┘  │
│                 │                  │                   │
│   (1) Register  │                  │ (3) Call Provider │
│       Auth Hook │                  │     with Bearer   │
│                 ▼                  ▼     Access Token  │
│  ┌───────────────────────┐   ┌──────────────────────┐  │
│  │ pi Model Registry     │   │ Upstream LLM APIs    │  │
│  │ (Anthropic, OpenAI,   │   │ (api.anthropic.com,  │  │
│  │  Gemini, etc.)        │   │  api.openai.com)     │  │
│  └───────────────────────┘   └──────────────────────┘  │
└─────────────────┬──────────────────────────────────────┘
                  │
                  │ (2) Remote Refresh on 401 or Pre-Expiry
                  │     POST /v1/credential/:id/refresh
                  ▼
┌────────────────────────────────────────────────────────┐
│ Remote OMP Auth Broker Host                            │
│                                                        │
│  ┌──────────────────────────────────────────────────┐  │
│  │ omp auth-broker serve                            │  │
│  │  - Single canonical writer of refresh tokens     │  │
│  │  - Local SQLite agent.db                         │  │
│  │  - Background scheduled token rotation           │  │
│  └──────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────┘
```

### Integration Points & Endpoints

| Protocol Action | Target Endpoint | Description |
|---|---|---|
| **Health Check** | `GET /v1/healthz` | Checks connection without authentication requirement. |
| **Pull Snapshot** | `GET /v1/snapshot` | Retrieves credential dictionary (access tokens + metadata; refresh token masked). Supports `If-None-Match` + `wait=<ms>`. |
| **Snapshot Stream** | `GET /v1/snapshot/stream` | Server-Sent Events (SSE) feed for realtime token updates and credential revocations. |
| **Remote Refresh** | `POST /v1/credential/:id/refresh` | Requests broker to execute upstream OAuth refresh and return updated access token. |
| **Report Block/Rate-Limit** | `POST /v1/credential/:id/block` | Informs broker of quota / 429 status so other clients route around blocked tokens. |

### Configuration Resolution Order
1. Environment variables: `OMP_AUTH_BROKER_URL`, `OMP_AUTH_BROKER_TOKEN`.
2. File token resolution: `<config-dir>/auth-broker.token` (defaulting to `~/.omp/auth-broker.token` or `~/.pi/agent/auth-broker.token`).
3. Settings file: `auth.broker.url` and `auth.broker.token` in `settings.json` or `.pi/config.json`.

---

## 4. Security & Error Handling

### Security Considerations
1. **Refresh Token Isolation:** The extension strictly enforces that `refresh` properties in credentials contain `REMOTE_REFRESH_SENTINEL`. The client code has no logical path to persist, parse, or write refresh tokens.
2. **Memory-Only Credential Cache:** Decrypted access tokens reside in volatile JavaScript memory.
3. **Encrypted Snapshot Disk Cache:** If local caching is enabled, snapshots written to disk are encrypted via AES-256-GCM using a key derived from `HMAC-SHA256(OMP_AUTH_BROKER_TOKEN, "snapshot-cache")`. File permissions are restricted to `0600`.
4. **Timing-Safe Token Header Injection:** Bearer token headers sent to the broker use constant-time comparisons when validating handshakes.

### Failure Modes & Mitigations
- **Broker Host Offline at Boot:**
  - Fallback to fresh cached snapshot if `age < 1 hour`.
  - Display non-blocking notification to user: `OMP Broker offline; running on cached credentials`.
- **Token Expired & Broker Unreachable:**
  - Fast-fail with an actionable error message suggesting checking Tailscale connection or running `omp auth-broker status`.
- **429 Rate Limiting from Upstream Provider:**
  - Send `POST /v1/credential/:id/block` to broker so other clients back off from that credential.
  - Transparently switch to secondary account if another credential exists for that provider in the snapshot.

---

## 5. Implementation Roadmap & Milestones

### Phase 1: Minimal Viable Extension (MVP - 3 Days)
- Scaffold extension package in `~/src/pi-auth-broker`.
- Implement `AuthBrokerClient`:
  - Fetching `/v1/snapshot` with bearer authorization.
  - Basic in-memory store mapping provider names (`anthropic`, `openai-codex`, etc.) to active access tokens.
- Register provider authentication overrides in `pi` via `pi.registerProvider(...)` or `before_provider_headers`.
- Support `POST /v1/credential/:id/refresh` on pre-expiration.

### Phase 2: Reactive Error Handling & Snapshot Streaming (2 Days)
- Add `after_provider_response` hook to detect `401 Unauthorized` responses and initiate atomic single-flight refresh.
- Integrate SSE connection (`GET /v1/snapshot/stream`) or conditional long-polling (`wait=30000`) for near-zero latency token updates.
- Implement rate-limit reporting (`POST /v1/credential/:id/block`).

### Phase 3: TUI Integration & Hardening (2 Days)
- Register commands `/omp-auth status` and `/omp-auth refresh`.
- Implement AES-256-GCM encrypted local snapshot cache with TTL management.
- Complete integration tests mocking `omp auth-broker` HTTP endpoints.

---

## 6. Verification & Test Strategy

1. **Unit Tests (Vitest / Node Test Runner):**
   - Mock HTTP server simulating `/v1/snapshot` responses and refresh responses.
   - Verify that refresh requests coalesce into a single in-flight promise (single-flight deduplication) when multiple concurrent calls occur.
2. **Integration Verification:**
   - Run a test `omp auth-broker serve` daemon on `127.0.0.1:8765`.
   - Start `pi` with `-e ~/src/pi-auth-broker/index.ts`.
   - Execute an LLM query, force expiration of the token mock, and verify zero conversational interruption during automatic renewal.
