/**
 * pi-auth-broker — OAuth adapters and auth.json provisioning.
 *
 * The adapter slots into pi's provider composition: pi's own
 * `resolveStoredOAuth` calls `refreshToken` under the credential-store lock
 * when expiry approaches and persists the result itself; `login` is invoked
 * by `/login <provider>`. Our refresh token is always the "__remote__"
 * sentinel — the real one lives only inside the broker.
 */

import { dirname } from "node:path";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BrokerClient, BrokerCredential } from "./broker.ts";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Marker stored in auth.json instead of a real refresh token (PRD AC-1). */
export const REMOTE_REFRESH_SENTINEL = "__remote__";

/** Stale lockfile age before we break it (matches pi's proper-lockfile stale option). */
const LOCK_STALE_MS = 30_000;

// ---------------------------------------------------------------------------
// auth.json provisioning (proper-lockfile-compatible directory lock)
// ---------------------------------------------------------------------------

export function authJsonPath(): string {
	return join(homedir(), ".pi", "agent", "auth.json");
}

function tryMkdir(path: string): boolean {
	try {
		mkdirSync(path);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "EEXIST") return false;
		throw error;
	}
}

/** Break a lock dir that is older than LOCK_STALE_MS (owner died without cleanup). */
function breakStaleLock(lockPath: string): boolean {
	try {
		const stats = statSync(lockPath);
		if (Date.now() - stats.mtimeMs > LOCK_STALE_MS) {
			rmSync(lockPath, { recursive: true, force: true });
			return true; // caller should retry the mkdir once
		}
		return false;
	} catch {
		return true; // lock vanished between EEXIST and stat — dir is free, retry
	}
}

/**
 * Serialize a mutation of auth.json using pi's proper-lockfile protocol:
 * an `auth.json.lock` *directory* guards the read-modify-write. concurrent
 * pi processes use the same lock, so writes interleave safely.
 */
export function withAuthLock<T>(fn: (current: Record<string, unknown>) => T): T {
	const authPath = authJsonPath();
	const lockPath = `${authPath}.lock`;

	// ~/.pi/agent always exists for a pi user, but provisioning may run before
	// the first login creates auth.json itself.
	mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 });

	let acquired = tryMkdir(lockPath);
	if (!acquired && breakStaleLock(lockPath)) acquired = tryMkdir(lockPath);
	if (!acquired) throw new Error(`auth.json is locked by another process (${lockPath})`);

	try {
		const current: Record<string, unknown> = existsSync(authPath)
			? JSON.parse(readFileSync(authPath, "utf-8"))
			: {};
		const result = fn(current);
		// Contract: returning a value persists the mutated `current`; returning
		// undefined leaves the file untouched (pure read).
		if (result !== undefined) writeFileSync(authPath, JSON.stringify(current, null, 2), { mode: 0o600 });
		return result;
	} finally {
		rmSync(lockPath, { recursive: true, force: true });
	}
}

/** Write/update one provider credential in auth.json (0600, lock-guarded). */
export function provisionCredential(providerId: string, credential: OAuthCredentials & { type: "oauth" }): void {
	withAuthLock((current) => {
		current[providerId] = credential;
		return credential;
	});
}

// ---------------------------------------------------------------------------
// Credential mapping: broker entry ↔ pi OAuthCredentials
// ---------------------------------------------------------------------------

export function toOAuthCredentials(entry: BrokerCredential): OAuthCredentials & { type: "oauth"; brokerId: number } {
	return {
		type: "oauth",
		access: entry.credential.access,
		refresh: entry.credential.refresh ?? REMOTE_REFRESH_SENTINEL,
		expires: entry.credential.expires ?? 0,
		accountId: entry.credential.accountId,
		email: entry.credential.email,
		brokerId: entry.id,
	};
}

/** Find the broker credential matching a stored pi credential, or the best fallback. */
export function matchBrokerCredential(
	broker: BrokerClient,
	provider: string,
	stored: { brokerId?: number; accountId?: string; email?: string } | undefined,
): BrokerCredential | undefined {
	const candidates = broker.credentialsFor(provider);
	if (candidates.length === 0) return undefined;

	if (typeof stored?.brokerId === "number") {
		const byId = candidates.find((c) => c.id === stored.brokerId);
		if (byId) return byId;
	}
	if (stored?.accountId) {
		const byAccount = candidates.find((c) => c.credential.accountId === stored.accountId);
		if (byAccount) return byAccount;
	}
	if (stored?.email) {
		const byEmail = candidates.find((c) => c.credential.email === stored.email);
		if (byEmail) return byEmail;
	}
	return candidates[0];
}

// ---------------------------------------------------------------------------
// OAuth adapter (extension compatibility surface)
// ---------------------------------------------------------------------------

export interface OauthAdapter {
	name: string;
	isSubscription: boolean;
	login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
	refreshToken(credentials: OAuthCredentials, signal: AbortSignal): Promise<OAuthCredentials>;
	getApiKey(credentials: OAuthCredentials): string;
}

/**
 * Build the extension-OAuth adapter for one pi provider backed by the broker.
 * pi's `adaptOAuth` wraps it: `login` → `/login <provider>`, `refreshToken` →
 * pi's double-checked-lock refresh, `getApiKey` → request auth.
 */
export function buildOauthAdapter(broker: BrokerClient, brokerProvider: string, display: string): OauthAdapter {
	return {
		name: display,
		isSubscription: true,

		async login(callbacks) {
			callbacks.onProgress?.(`Contacting auth broker at ${broker.url}...`);
			// Ensure a snapshot exists even if the long-poll loop hasn't produced one yet.
			if (!broker.snapshot) await broker.snapshotRequest();
			const candidates = broker.credentialsFor(brokerProvider);
			if (candidates.length === 0) {
				throw new Error(
					`auth-broker has no ${brokerProvider} credential. Run: omp auth-broker login ${brokerProvider}`,
				);
			}
			let chosen = candidates[0];
			if (candidates.length > 1) {
				const options = candidates.map((c) => ({
					id: String(c.id),
					label: c.credential.email ?? c.credential.accountId ?? `credential #${c.id}`,
				}));
				const selected = await callbacks.onSelect({ message: `Select ${display} account`, options });
				if (selected !== undefined) {
					const found = candidates.find((c) => String(c.id) === selected);
					if (found) chosen = found;
				}
			}
			return toOAuthCredentials(chosen);
		},

		async refreshToken(credentials, signal) {
			const stored = credentials as { brokerId?: number; accountId?: string; email?: string };
			// Fresh snapshot first: the broker may have rotated since we last looked.
			try {
				await broker.snapshotRequest({ signal });
			} catch {
				// Fall through and match against the cached snapshot.
			}
			const entry = matchBrokerCredential(broker, brokerProvider, stored);
			if (!entry) {
				throw new Error(`auth-broker no longer has a ${brokerProvider} credential (was ${stored?.brokerId})`);
			}
			const refreshed = await broker.refresh(entry.id, signal);
			return toOAuthCredentials(refreshed);
		},

		getApiKey(credentials) {
			return credentials.access;
		},
	};
}
