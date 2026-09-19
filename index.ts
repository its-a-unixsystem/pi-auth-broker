/**
 * pi-auth-broker — pi extension entry.
 *
 * Registers broker-backed OAuth adapters over the builtin `anthropic` and
 * `openai-codex` providers. pi's own auth pipeline does the heavy lifting:
 * `/login` invokes our adapter, `resolveStoredOAuth` refreshes through us
 * under the credential-store lock when tokens near expiry, and auth.json
 * persistence is pi-owned. We add a long-poll watcher and 401 recovery.
 *
 * Load with:  pi -e ./index.ts   (or drop into ~/.pi/agent/extensions/)
 */

import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { BrokerClient, BrokerError, resolveConfig, type BrokerCredential } from "./broker.ts";
import {
	buildOauthAdapter,
	matchBrokerCredential,
	provisionCredential,
	toOAuthCredentials,
} from "./auth.ts";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";

const formatDuration = (ms: number): string => {
	if (ms <= 0) return "expired";
	// 8.64e15 ms = 100k days — brokers use this as "never expires".
	if (ms > 365 * 24 * 3600_000) return "never";
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
};

/** Broker provider key → pi provider id + display name (user decision: builtin providers only). */
const PROVIDERS: Record<string, { pi: string; display: string }> = {
	anthropic: { pi: "anthropic", display: "Anthropic (Claude Pro/Max, via auth-broker)" },
	"openai-codex": { pi: "openai-codex", display: "OpenAI (ChatGPT Plus/Pro, via auth-broker)" },
};

/** Providers we manage, keyed by pi provider id (the 401 handler needs reverse lookup). */
const MANAGED = new Map<string, { brokerProvider: string; display: string }>(
	Object.entries(PROVIDERS).map(([brokerProvider, v]) => [v.pi, { brokerProvider, display: v.display }]),
);

export default function (pi: ExtensionAPI) {
	const config = resolveConfig();

	if (!config || !config.token) {
		// Inert: no broker configured or tokenless. Built-in auth stays in charge.
		pi.on("session_start", (_event, ctx) => {
			ctx.ui.notify(
				config
					? "omp-auth-broker: URL set but no token found (env, ~/.omp/auth-broker.token, or settings auth.broker.token). Extension inactive."
					: "omp-auth-broker: no configuration found. Extension inactive.",
				"info",
			);
		});
		return;
	}

	const broker = new BrokerClient(config);

	// --- Provider registration (load phase; applied before first request) ---
	for (const [brokerProvider, { pi: piProvider, display }] of Object.entries(PROVIDERS)) {
		const oauth = buildOauthAdapter(broker, brokerProvider, display);
		pi.registerProvider(piProvider, {
			oauth: {
				name: oauth.name,
				isSubscription: oauth.isSubscription,
				login: (callbacks) => oauth.login(callbacks),
				refreshToken: (credentials, signal) => oauth.refreshToken(credentials, signal),
				getApiKey: (credentials) => oauth.getApiKey(credentials),
			},
		});
	}

	// --- Long-poll watcher (starts on session_start, aborts on session_shutdown) ---
	let pollHandle: { abort: () => void } | undefined;

	pi.on("session_start", async (_event, ctx) => {
		// Prime the snapshot so the first request does not depend on poll timing.
		try {
			const snap = await broker.snapshotRequest();
			if (snap) {
				notifyNewProviders(ctx, snap.credentials);
			}
		} catch (error) {
			ctx.ui.notify(`omp-auth-broker: broker unreachable at ${broker.url} — ${errorMessage(error)}`, "warning");
		}
		pollHandle = broker.pollLoop(
			(snap) => notifyNewProviders(ctx, snap.credentials),
			(error) => ctx.ui.notify(`omp-auth-broker poll error: ${errorMessage(error)}`, "warning"),
		);
	});

	pi.on("session_shutdown", () => {
		pollHandle?.abort();
	});

	function notifyNewProviders(ctx: Pick<ExtensionContext, "ui">, credentials: BrokerCredential[]) {
		for (const c of credentials) {
			const known = PROVIDERS[c.provider];
			if (!known) continue;
			const stored = readStoredCredential(known.pi);
			if (!stored) {
				ctx.ui.notify(
					`omp-auth-broker: ${known.display} credential available (account ${c.credential.email ?? c.credential.accountId ?? c.id}). Use /login ${known.pi} to activate.`,
					"info",
				);
			}
		}
	}

	// --- 401 recovery: refresh via broker, re-provision, re-queue the prompt once ---
	// Two entry points, one recovery routine:
	//   • after_provider_response 401 — openai-codex (pi-ai calls onResponse on every status)
	//   • message_end with stopReason "error" — anthropic (the SDK throws
	//     AuthenticationError before pi's onResponse hook runs, so the 401 only
	//     surfaces as an errored assistant message with a 401-shaped errorMessage)
	let retryUsedThisTurn = false;
	let recovering = false;
	pi.on("turn_start", () => {
		retryUsedThisTurn = false;
	});

	pi.on("after_provider_response", async (event, ctx) => {
		if (event.status !== 401 || retryUsedThisTurn) return;
		await recoverFrom401(ctx);
	});

	pi.on("message_end", async (event, ctx) => {
		if (retryUsedThisTurn || recovering) return;
		const message = event.message;
		if (message.role !== "assistant" || message.stopReason !== "error") return;
		const errorMessageText = message.errorMessage ?? "";
		// Anthropic SDK surfaces auth failures as “401 {…authentication_error…}”.
		if (!/\b401\b|invalid[_ ]api[_ ]key|authentication_error/i.test(errorMessageText)) return;
		await recoverFrom401(ctx);
	});

	async function recoverFrom401(ctx: Pick<ExtensionContext, "sessionManager" | "ui">) {
		if (retryUsedThisTurn) return;
		// Which managed provider fired? Only these two are broker-backed.
		for (const [piProvider, { brokerProvider }] of MANAGED) {
			const stored = readStoredCredential(piProvider);
			if (!stored || stored.type !== "oauth") continue;

			retryUsedThisTurn = true;
			recovering = true;
			try {
				const entry = matchBrokerCredential(broker, brokerProvider, stored as { brokerId?: number; accountId?: string; email?: string });
				if (!entry) throw new BrokerError(`no ${brokerProvider} credential in broker`);
				const refreshed = await broker.refresh(entry.id);
				provisionCredential(piProvider, toOAuthCredentials(refreshed));
				ctx.ui.notify(`omp-auth-broker: 401 from ${piProvider} — refreshed via broker, retrying once.`, "warning");

				const lastUser = lastUserMessage(ctx);
				if (lastUser) pi.sendUserMessage(lastUser, { deliverAs: "followUp" });
			} catch (error) {
				ctx.ui.notify(`omp-auth-broker: 401 recovery failed — ${errorMessage(error)}`, "error");
			} finally {
				recovering = false;
			}
			return;
		}
	}

	function lastUserMessage(ctx: Pick<ExtensionContext, "sessionManager">): string | undefined {
		const entries = [...ctx.sessionManager.getEntries()].reverse();
		for (const entry of entries) {
			if (entry.type !== "message" || entry.message?.role !== "user") continue;
			const content = entry.message.content;
			if (typeof content === "string") return content;
			if (Array.isArray(content)) {
				const text = content
					.filter((part): part is { type: "text"; text: string } => part.type === "text")
					.map((part) => part.text)
					.join("\n");
				if (text.trim()) return text;
			}
		}
		return undefined;
	}

	// --- /omp-auth command surface (PRD AC-6) ---
	pi.registerCommand("omp-auth", {
		description: "auth-broker status and refresh (status | refresh [provider])",
		getArgumentCompletions: (prefix: string) => {
			const words = ["status", "refresh", ...Object.keys(PROVIDERS)];
			const filtered = words.filter((w) => w.startsWith(prefix));
			return filtered.length > 0 ? filtered.map((w) => ({ value: w, label: w })) : null;
		},
		handler: async (args, ctx) => {
			const [cmd, providerArg] = args.trim().split(/\s+/).filter(Boolean);
			if (cmd === "refresh") {
				await handleRefresh(ctx, providerArg);
			} else if (!cmd || cmd === "status") {
				await handleStatus(ctx);
			} else {
				ctx.ui.notify(`omp-auth: unknown subcommand "${cmd}". Use: status | refresh [provider]`, "error");
			}
		},
	});

	async function handleStatus(ctx: Pick<ExtensionContext, "ui">) {
		try {
			const health = await broker.healthz();
			const snap = broker.snapshot ?? (await broker.snapshotRequest());
			const lines: string[] = [];
			lines.push(`broker: ${broker.url} (v${health.version ?? "?"}, generation ${snap?.generation ?? "?"})`);
			if (snap?.refresher?.enabled) {
				lines.push(`self-refresh: every ${snap.refresher.intervalMs ?? "?"}ms (skew ${snap.refresher.skewMs ?? "?"}ms)`);
			}
			for (const c of snap?.credentials ?? []) {
				const known = PROVIDERS[c.provider];
				const account = c.credential.email ?? c.credential.accountId ?? "?";
				const expiresIn =
					// Guard against second-precision epochs (pre-2001 in ms) or missing values.
					typeof c.credential.expires === "number" && c.credential.expires > 1e12 && snap
						? formatDuration(c.credential.expires - snap.serverNowMs)
						: "?";
				const scope = known ? "" : " (not managed)";
				const active = known && readStoredCredential(known.pi) ? " [active]" : "";
				lines.push(`  #${c.id} ${c.provider}${scope}: ${account}, expires in ${expiresIn}${active}`);
			}
			if (!snap?.credentials.length) lines.push("  (no credentials)");
			ctx.ui.notify(lines.join("\n"), "info");
		} catch (error) {
			ctx.ui.notify(`omp-auth: broker unreachable — ${errorMessage(error)}`, "error");
		}
	}

	async function handleRefresh(ctx: Pick<ExtensionCommandContext, "ui">, providerArg?: string) {
		const targets: string[] = [];
		if (providerArg) {
			const byBrokerKey = PROVIDERS[providerArg] ? providerArg : undefined;
			const byPi = byBrokerKey ?? Object.entries(PROVIDERS).find(([, v]) => v.pi === providerArg)?.[0];
			if (!byPi) {
				ctx.ui.notify(`omp-auth: unknown provider "${providerArg}" (managed: ${Object.keys(PROVIDERS).join(", ")})`, "error");
				return;
			}
			targets.push(byPi);
		} else {
			targets.push(...Object.keys(PROVIDERS));
		}

		const refreshed: string[] = [];
		const failures: string[] = [];
		for (const brokerProvider of targets) {
			const piProvider = PROVIDERS[brokerProvider].pi;
			const stored = readStoredCredential(piProvider);
			const entry = matchBrokerCredential(broker, brokerProvider, stored as { brokerId?: number; accountId?: string; email?: string });
			if (!entry) {
				failures.push(`${brokerProvider}: no broker credential`);
				continue;
			}
			try {
				const result = await broker.refresh(entry.id);
				provisionCredential(piProvider, toOAuthCredentials(result));
				refreshed.push(`${brokerProvider} (#${entry.id})`);
			} catch (error) {
				failures.push(`${brokerProvider}: ${errorMessage(error)}`);
			}
		}

		const lines: string[] = [];
		if (refreshed.length) lines.push(`refreshed via broker: ${refreshed.join(", ")}`);
		if (failures.length) lines.push(`failed: ${failures.join("; ")}`);
		ctx.ui.notify(lines.join("\n") || "nothing to refresh", refreshed.length && !failures.length ? "info" : "warning");
	}

	function errorMessage(error: unknown): string {
		if (error instanceof BrokerError) return error.message;
		return error instanceof Error ? error.message : String(error);
	}
}
