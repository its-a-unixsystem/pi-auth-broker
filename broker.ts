/**
 * pi-auth-broker — broker client.
 *
 * Talks to the local `omp auth-broker` daemon (default 127.0.0.1:8765).
 * Never exchanges refresh tokens: the broker's snapshot redacts them as
 * "__remote__" and all rotation is delegated via POST /v1/credential/:id/refresh.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A credential entry as served by the broker snapshot. */
export interface BrokerCredential {
	/** Broker-assigned stable id, e.g. 8. */
	id: number;
	/** Broker provider key, e.g. "anthropic", "openai-codex". */
	provider: string;
	/** Credential payload; refresh is the "__remote__" sentinel. */
	credential: {
		type: "oauth" | "api_key";
		access: string;
		refresh?: string;
		expires?: number;
		accountId?: string;
		email?: string;
		[key: string]: unknown;
	};
	/** Stable identity hash for matching. */
	identityKey?: string;
	/** Milliseconds until the broker plans to rotate (informational). */
	rotatesInMs?: number;
}

export interface BrokerSnapshot {
	generation: number;
	serverNowMs: number;
	/** Configured self-refresher, if any. */
	refresher?: { enabled: boolean; intervalMs?: number; skewMs?: number };
	credentials: BrokerCredential[];
}

export interface BrokerConfig {
	url: string;
	token: string;
}

export class BrokerError extends Error {
	constructor(
		message: string,
		readonly status?: number,
		readonly cause?: unknown,
	) {
		super(message);
		this.name = "BrokerError";
	}
}

// ---------------------------------------------------------------------------
// Config resolution (PRD AC-2): env → ~/.omp token file → ~/.pi token file → settings.json
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_URL = "http://127.0.0.1:8765";

function readTokenFile(path: string): string | undefined {
	try {
		const value = readFileSync(path, "utf-8").trim();
		return value.length > 0 ? value : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Resolve broker URL + token. First hit wins:
 *   env OMP_AUTH_BROKER_URL / OMP_AUTH_BROKER_TOKEN
 *   → ~/.omp/auth-broker.token
 *   → ~/.pi/agent/auth-broker.token
 *   → ~/.pi/agent/settings.json auth.broker.{url,token}
 * Returns undefined when nothing is configured (extension stays inert).
 */
export function resolveConfig(env: NodeJS.ProcessEnv = process.env): BrokerConfig | undefined {
	const envUrl = env.OMP_AUTH_BROKER_URL?.trim() || undefined;
	const envToken = env.OMP_AUTH_BROKER_TOKEN?.trim() || undefined;
	if (envToken || envUrl) {
		return { url: envUrl ?? DEFAULT_URL, token: envToken ?? "" };
	}

	const ompFile = join(homedir(), ".omp", "auth-broker.token");
	if (existsSync(ompFile)) {
		const token = readTokenFile(ompFile);
		if (token) return { url: DEFAULT_URL, token };
	}

	const piFile = join(homedir(), ".pi", "agent", "auth-broker.token");
	if (existsSync(piFile)) {
		const token = readTokenFile(piFile);
		if (token) return { url: DEFAULT_URL, token };
	}

	// settings.json: auth.broker.{url,token}
	try {
		const settingsPath = join(homedir(), ".pi", "agent", "settings.json");
		if (existsSync(settingsPath)) {
			const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			const broker = settings?.auth?.broker;
			const url = typeof broker?.url === "string" && broker.url.trim() ? broker.url.trim() : undefined;
			const token = typeof broker?.token === "string" && broker.token.trim() ? broker.token.trim() : undefined;
			if (url || token) return { url: url ?? DEFAULT_URL, token: token ?? "" };
		}
	} catch {
		// Malformed settings.json — ignore, other sources already had their chance.
	}

	return undefined;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class BrokerClient {
	readonly url: string;
	readonly token: string;
	/** Latest known snapshot (memory only — no disk cache, per user decision). */
	snapshot: BrokerSnapshot | undefined;

	/** broker-credential-id → in-flight refresh promise (courtesy dedup; broker is the real single-flight). */
	#inFlight = new Map<number, Promise<BrokerCredential>>();

	constructor(config: BrokerConfig) {
		this.url = config.url.replace(/\/+$/, "");
		this.token = config.token;
	}

	async #fetch(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
		const { timeoutMs, ...rest } = init;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs ?? 10_000);
		try {
			return await fetch(`${this.url}${path}`, {
				...rest,
				signal: rest.signal ?? controller.signal,
				headers: {
					authorization: `Bearer ${this.token}`,
					...(rest.headers as Record<string, string> | undefined),
				},
			});
		} catch (error) {
			throw new BrokerError(`auth-broker unreachable at ${this.url}: ${error instanceof Error ? error.message : String(error)}`, undefined, error);
		} finally {
			clearTimeout(timer);
		}
	}

	/** Health check. Returns { ok, version } or throws. */
	async healthz(): Promise<{ ok: boolean; version?: string }> {
		const res = await this.#fetch("/v1/healthz");
		if (!res.ok) throw new BrokerError(`healthz failed: ${res.status}`);
		return (await res.json()) as { ok: boolean; version?: string };
	}

	/**
	 * Fetch the snapshot. `waitMs` enables long-polling; `etag` (previous
	 * generation) yields `undefined` on 304 Not Modified.
	 */
	async snapshotRequest(opts: { waitMs?: number; etag?: string; signal?: AbortSignal } = {}): Promise<BrokerSnapshot | undefined> {
		const params = new URLSearchParams();
		if (opts.waitMs) params.set("wait", String(opts.waitMs));
		const qs = params.size > 0 ? `?${params}` : "";
		const res = await this.#fetch(`/v1/snapshot${qs}`, {
			signal: opts.signal,
			timeoutMs: (opts.waitMs ?? 0) + 10_000,
			headers: opts.etag ? { "if-none-match": opts.etag } : undefined,
		});
		if (res.status === 304) return undefined;
		if (!res.ok) throw new BrokerError(`snapshot failed: ${res.status}`, res.status);
		const body = (await res.json()) as BrokerSnapshot;
		this.snapshot = body;
		return body;
	}

	/** Find credentials for a broker provider key. */
	credentialsFor(provider: string): BrokerCredential[] {
		return (this.snapshot?.credentials ?? []).filter((c) => c.provider === provider);
	}

	/**
	 * Delegate a refresh to the broker. Single-flighted per credential id so a
	 * pi-side refresh storm (parallel requests near expiry) collapses into one
	 * POST; the broker itself is the authoritative race guard.
	 */
	refresh(id: number, signal?: AbortSignal): Promise<BrokerCredential> {
		const existing = this.#inFlight.get(id);
		if (existing) return existing;

		const request = (async () => {
			const res = await this.#fetch(`/v1/credential/${id}/refresh`, {
				method: "POST",
				signal,
				timeoutMs: 30_000,
			});
			if (!res.ok) {
				const text = await res.text().catch(() => "");
				throw new BrokerError(`refresh of credential ${id} failed: ${res.status} ${text.slice(0, 200)}`, res.status);
			}
			const body = (await res.json()) as { entry?: BrokerCredential };
			const entry = body.entry;
			if (!entry?.credential?.access) throw new BrokerError(`refresh of credential ${id} returned no entry`);
			// Fold into the cached snapshot so status/poll see the new generation token.
			// The refresh bumps the server generation; adopt it so the poll loop's
			// ETag stays accurate (otherwise the next poll re-fetches a full snapshot).
			if (this.snapshot) {
				const idx = this.snapshot.credentials.findIndex((c) => c.id === id);
				if (idx >= 0) this.snapshot.credentials[idx] = entry;
				else this.snapshot.credentials.push(entry);
				this.snapshot = { ...this.snapshot, generation: this.snapshot.generation + 1 };
			}
			return entry;
		})();

		this.#inFlight.set(id, request);
		request.catch(() => {}).finally(() => this.#inFlight.delete(id));
		return request;
	}

	/**
	 * Long-poll loop (user decision: long-poll + ETag, no SSE).
	 * Yields each new snapshot; `undefined` on shutdown. Re-polls with 3s
	 * backoff on errors. Returns an abort handle.
	 */
	pollLoop(onSnapshot: (snapshot: BrokerSnapshot) => void, onError?: (error: Error) => void): { abort: () => void } {
		const controller = new AbortController();
		const backoffMs = 3_000;
		let etag: string | undefined;

		void (async () => {
			while (!controller.signal.aborted) {
				try {
					const snap = await this.snapshotRequest({ waitMs: 30_000, etag, signal: controller.signal });
					if (snap) {
						etag = `"${snap.generation}"`;
						onSnapshot(snap);
					} else if (!etag && this.snapshot) {
						// First poll raced to 304 without a known etag — adopt current generation.
						etag = `"${this.snapshot.generation}"`;
					}
				} catch (error) {
					if (controller.signal.aborted) return;
					onError?.(error instanceof Error ? error : new Error(String(error)));
					await new Promise((resolve) => setTimeout(resolve, backoffMs));
				}
			}
		})();

		return { abort: () => controller.abort() };
	}
}
