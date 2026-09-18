/**
 * Fake-broker self-test for pi-auth-broker (zero deps, assert-based).
 *
 * Serves a fake omp auth-broker HTTP API on a random port:
 *   GET  /v1/healthz
 *   GET  /v1/snapshot          (If-None-Match → 304; ?wait=ms long-poll)
 *   POST /v1/credential/:id/refresh  (150ms latency; counter exposed)
 *
 * Then exercises the real extension modules against it:
 *   1. config resolution (env precedence)
 *   2. snapshot + ETag 304
 *   3. login picks the right credential (single + multi-account select)
 *   4. refreshToken returns the "__remote__" sentinel (AC-1)
 *   5. concurrent refresh() → exactly 1 broker POST (client single-flight)
 *   6. matchBrokerCredential fallback order
 *   7. provisionCredential writes auth.json under lock (HOME redirected)
 *   8. long-poll loop observes a generation bump
 *   9. 401-recovery data path: refresh + provision composition
 *
 * Run: node test/fake-broker.mts
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createJiti } = require("/usr/lib/node_modules/pi/node_modules/jiti/lib/jiti.cjs");

const REPO = new URL("..", import.meta.url).pathname;
const jiti = createJiti(import.meta.url, {
	moduleCache: false,
	alias: {
		"@earendil-works/pi-coding-agent": "/usr/lib/node_modules/pi/packages/coding-agent/dist/index.js",
		"@earendil-works/pi-ai": "/usr/lib/node_modules/pi/node_modules/@earendil-works/pi-ai/dist/compat.js",
	},
});

const { BrokerClient, resolveConfig } = await jiti.import(`${REPO}broker.ts`);
const {
	REMOTE_REFRESH_SENTINEL,
	buildOauthAdapter,
	matchBrokerCredential,
	provisionCredential,
	toOAuthCredentials,
} = await jiti.import(`${REPO}auth.ts`);

// ---------------------------------------------------------------------------
// Fake broker state
// ---------------------------------------------------------------------------

const TEST_TOKEN = "test-broker-token";
const START = Date.now();

interface FakeCred {
	id: number;
	provider: string;
	access: string;
	expires: number;
	email: string;
	accountId: string;
}

const credentials: FakeCred[] = [
	{ id: 8, provider: "anthropic", access: "sk-ant-oat01-test-anthropic", expires: START + 3600_000, email: "thomas@example.com", accountId: "acc-8" },
	{ id: 1, provider: "openai-codex", access: "test.jwt.one", expires: START + 3600_000, email: "a@example.com", accountId: "acc-1" },
	{ id: 4, provider: "openai-codex", access: "test.jwt.four", expires: START + 3600_000, email: "b@example.com", accountId: "acc-4" },
];
let generation = 1;
let refreshCount = 0;

const entryJson = (c: FakeCred) => ({
	id: c.id,
	provider: c.provider,
	credential: { type: "oauth", access: c.access, refresh: "__remote__", expires: c.expires, email: c.email, accountId: c.accountId },
	identityKey: `${c.provider}:${c.email}`,
	rotatesInMs: c.expires - Date.now(),
});

const snapshotBody = () =>
	JSON.stringify({
		generation,
		serverNowMs: Date.now(),
		refresher: { enabled: true, intervalMs: 60000, skewMs: 300000 },
		credentials: credentials.map(entryJson),
	});

// In-flight long-polls; each waiter re-evaluates (generation moved → 200, else 304).
const waiters: Array<() => void> = [];

function bumpGeneration() {
	generation++;
	for (const wake of waiters.splice(0)) wake();
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const server: Server = createServer((req, res) => {
	const url = new URL(req.url ?? "/", "http://localhost");
	const send = (status: number, body: string, headers: Record<string, string> = {}) => {
		res.writeHead(status, { "content-type": "application/json", ...headers });
		res.end(body);
	};

	if (req.headers.authorization !== `Bearer ${TEST_TOKEN}` && url.pathname !== "/v1/healthz") {
		return send(401, JSON.stringify({ error: "unauthorized" }));
	}

	if (req.method === "GET" && url.pathname === "/v1/healthz") {
		return send(200, JSON.stringify({ ok: true, version: "18.2.2-fake" }));
	}

	if (req.method === "GET" && url.pathname === "/v1/snapshot") {
		const etag = `"${generation}"`;
		const ifNoneMatch = req.headers["if-none-match"];
		if (ifNoneMatch === etag) {
			const waitMs = Number(url.searchParams.get("wait") ?? 0);
			if (waitMs > 0) {
				// Long-poll: hold until generation bumps (waiter re-checks) or wait elapses.
				const timer = setTimeout(() => send(304, ""), waitMs);
				waiters.push(() => {
					clearTimeout(timer);
					// Generation moved since the client's ETag was captured → full snapshot.
					send(200, snapshotBody(), { etag });
				});
				return;
			}
			return send(304, "");
		}
		return send(200, snapshotBody(), { etag });
	}

	const refreshMatch = url.pathname.match(/^\/v1\/credential\/(\d+)\/refresh$/);
	if (req.method === "POST" && refreshMatch) {
		const id = Number(refreshMatch[1]);
		setTimeout(() => {
			refreshCount++;
			const cred = credentials.find((c) => c.id === id);
			if (!cred) return send(404, JSON.stringify({ error: `No credential with id=${id}` }));
			cred.access = `${cred.access}-r${refreshCount}`; // rotate
			cred.expires = Date.now() + 3600_000;
			bumpGeneration();
			send(200, JSON.stringify({ entry: entryJson(cred) }));
		}, 150);
		return;
	}

	send(404, JSON.stringify({ error: `no route ${req.method} ${url.pathname}` }));
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as { port: number }).port;
	const url = `http://127.0.0.1:${port}`;

	// --- 1. config resolution: env precedence ---
	const cfg = resolveConfig({ OMP_AUTH_BROKER_URL: url, OMP_AUTH_BROKER_TOKEN: TEST_TOKEN } as NodeJS.ProcessEnv);
	assert.ok(cfg, "resolveConfig from env");
	assert.equal(cfg.url, url);

	const broker = new BrokerClient(cfg);
	assert.equal((await broker.healthz()).version, "18.2.2-fake");

	// --- 2. snapshot + ETag ---
	const snap1 = await broker.snapshotRequest();
	assert.ok(snap1, "snapshot fetch");
	assert.equal(snap1.generation, 1);
	assert.equal(snap1.credentials.length, 3);
	assert.equal(await broker.snapshotRequest({ etag: `"${snap1.generation}"` }), undefined, "etag match → 304 → undefined");

	// --- 3. login picks the right credential ---
	const anthropicAdapter = buildOauthAdapter(broker, "anthropic", "Anthropic (fake)");
	const noSelectCallbacks = {
		onAuth: () => {},
		onDeviceCode: () => {},
		onPrompt: async () => "",
		onProgress: () => {},
	};
	const cred = await anthropicAdapter.login(noSelectCallbacks);
	assert.equal(cred.access, "sk-ant-oat01-test-anthropic");
	assert.equal(cred.refresh, REMOTE_REFRESH_SENTINEL, "AC-1: refresh is sentinel");
	assert.equal((cred as { brokerId?: number }).brokerId, 8);

	// --- 3b. multi-account select picks the chosen one ---
	const codexAdapter = buildOauthAdapter(broker, "openai-codex", "Codex (fake)");
	let selectPrompt: { message: string; options: { id: string; label: string }[] } | undefined;
	const cred4 = await codexAdapter.login({
		...noSelectCallbacks,
		onSelect: async (prompt: { message: string; options: { id: string; label: string }[] }) => {
			selectPrompt = prompt;
			return "4";
		},
	});
	assert.ok(selectPrompt, "onSelect invoked for multi-account");
	assert.equal(selectPrompt.options.length, 2);
	assert.equal((cred4 as { brokerId?: number }).brokerId, 4, "selected credential 4");

	// --- 4. refreshToken delegates to broker, keeps sentinel ---
	const refreshed = await anthropicAdapter.refreshToken(cred, new AbortController().signal);
	assert.notEqual(refreshed.access, cred.access, "access rotated");
	assert.equal(refreshed.refresh, REMOTE_REFRESH_SENTINEL, "AC-1: sentinel after refresh");

	// --- 5. concurrent refreshes → single broker POST ---
	await Promise.all([broker.refresh(8), broker.refresh(8)]);
	const before = refreshCount;
	assert.equal(before, 2, "previous groups used one refresh each (login + refreshToken dedup)");
	await Promise.all([broker.refresh(8), broker.refresh(8), broker.refresh(8)]);
	assert.equal(refreshCount, before + 1, "three concurrent refreshes → 1 broker POST");

	// --- 6. matchBrokerCredential fallback order ---
	assert.equal(matchBrokerCredential(broker, "openai-codex", { brokerId: 4 })?.id, 4);
	assert.equal(matchBrokerCredential(broker, "openai-codex", { accountId: "acc-1" })?.id, 1);
	assert.equal(matchBrokerCredential(broker, "openai-codex", { email: "b@example.com" })?.id, 4);
	assert.equal(matchBrokerCredential(broker, "openai-codex", { brokerId: 999 })?.id, 1, "unknown brokerId → first candidate");
	assert.equal(matchBrokerCredential(broker, "perplexity", undefined), undefined, "unmanaged provider → undefined");

	// --- 7. provisionCredential writes auth.json under lock (HOME redirected) ---
	const realHome = process.env.HOME;
	const fakeHome = mkdtempSync(join(tmpdir(), "pi-auth-broker-test-"));
	process.env.HOME = fakeHome; // auth.ts resolves homedir() lazily per call on POSIX
	try {
		const m8 = matchBrokerCredential(broker, "anthropic", { brokerId: 8 })!;
		provisionCredential("anthropic", toOAuthCredentials(m8));
		const authJson = JSON.parse(readFileSync(join(fakeHome, ".pi/agent/auth.json"), "utf-8"));
		assert.equal(authJson.anthropic.type, "oauth");
		assert.equal(authJson.anthropic.refresh, REMOTE_REFRESH_SENTINEL, "AC-1: auth.json holds sentinel only");
		assert.equal(authJson.anthropic.brokerId, 8);

		provisionCredential("openai-codex", toOAuthCredentials(matchBrokerCredential(broker, "openai-codex", { accountId: "acc-1" })!));
		const authJson2 = JSON.parse(readFileSync(join(fakeHome, ".pi/agent/auth.json"), "utf-8"));
		assert.equal(authJson2["openai-codex"].brokerId, 1);
		assert.equal(authJson2.anthropic.brokerId, 8, "prior write survived second locked write");
		assert.ok(!existsSync(join(fakeHome, ".pi/agent/auth.json.lock")), "lock dir removed after write");

		// --- 9. 401-recovery data path: refresh + provision composition ---
		const recovered = await broker.refresh(8);
		provisionCredential("anthropic", toOAuthCredentials(recovered));
		const authJson3 = JSON.parse(readFileSync(join(fakeHome, ".pi/agent/auth.json"), "utf-8"));
		assert.ok(authJson3.anthropic.access.includes("-r"), "401 path wrote rotated token into auth.json");
	} finally {
		process.env.HOME = realHome;
		rmSync(fakeHome, { recursive: true, force: true });
	}

	// --- 8. long-poll loop observes generation bump ---
	const startGeneration = broker.snapshot!.generation;
	const seen: number[] = [];
	const loop = broker.pollLoop((s: { generation: number }) => seen.push(s.generation));
	await sleep(150); // initial poll
	assert.deepEqual(seen, [startGeneration], `initial poll yields generation ${startGeneration}`);
	await broker.refresh(8); // bumps generation
	await sleep(400); // loop held in long-poll wakes with 200
	assert.ok(seen.includes(startGeneration + 1), `poll loop saw new generation (seen: ${seen.join(",")})`);
	loop.abort();

	server.close();
	console.log("✓ all fake-broker assertions passed (9 groups)");
}

main().catch((error) => {
	console.error("✗ test failed:", error);
	server.close();
	process.exit(1);
});
