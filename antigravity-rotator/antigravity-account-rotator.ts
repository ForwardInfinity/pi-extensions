/**
 * Antigravity Account Rotator Extension for Pi
 *
 * Automatically rotates between multiple Google Antigravity OAuth accounts
 * when rate limit / quota errors are detected.
 *
 * How it works:
 *   1. On `turn_end`, if the assistant message has a rate limit / quota error,
 *      the extension swaps OAuth credentials to the next available account.
 *   2. Pi's built-in retry mechanism then uses the new credentials transparently.
 *   3. The retry succeeds with the new account — no user intervention needed.
 *
 * Note: Antigravity provider has its own internal retry (3 attempts) BEFORE
 * the error reaches Pi's agent-session retry (another 3 attempts). By the time
 * our turn_end handler fires, the error has already survived ~6 retries,
 * so it's very likely a genuine quota exhaustion.
 *
 * Commands:
 *   /ag add [label]    - Add a new Google account via OAuth
 *   /ag list           - Show all accounts and their status
 *   /ag identify       - Fetch email for accounts missing it
 *   /ag rotate         - Manually rotate to next available account
 *   /ag remove <index> - Remove an account by index
 *   /ag reset          - Reset all exhaustion markers
 *   /ag sync           - Sync credentials from current auth.json
 *   /ag help           - Show help
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	OAuthCredential,
} from "@mariozechner/pi-coding-agent";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { AutocompleteItem } from "@mariozechner/pi-tui";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
	chmodSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes, createHash } from "node:crypto";

// =============================================================================
// Types
// =============================================================================

interface Account {
	label: string;
	email?: string;
	googleId?: string;
	refresh: string;
	access: string;
	expires: number;
	projectId: string;
	addedAt: number;
	exhaustedAt: number | null;
}

interface AccountsConfig {
	accounts: Account[];
	currentIndex: number;
}

// =============================================================================
// Constants
// =============================================================================

const PROVIDER = "google-antigravity";

const AGENT_DIR =
	process.env.PI_CODING_AGENT_DIR ||
	join(process.env.HOME!, ".pi", "agent");
const ACCOUNTS_FILE = join(AGENT_DIR, "antigravity-accounts.json");

// Antigravity OAuth credentials (decoded from Pi's source)
const CLIENT_ID = atob(
	"MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ=="
);
const CLIENT_SECRET = atob(
	"R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY="
);
const REDIRECT_URI = "http://localhost:51121/oauth-callback";
const SCOPES = [
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
	"https://www.googleapis.com/auth/cclog",
	"https://www.googleapis.com/auth/experimentsandconfigs",
];
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v1/userinfo?alt=json";
const DEFAULT_PROJECT_ID = "rising-fact-p41fc";

// Match rate limit / quota errors from Antigravity.
// By the time turn_end fires, the provider's internal retry (3x) AND Pi's
// agent-session retry have both failed, so this is a real quota issue.
const RATE_LIMIT_PATTERN =
	/rate.?limit|resource.?exhausted|too many requests|429|quota.?will.?reset|Cloud Code Assist API error.*429/i;

// Exhausted accounts become available again after this cooldown
const COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

// Local callback server port (same as Pi's built-in)
const CALLBACK_PORT = 51121;

// =============================================================================
// Account Storage
// =============================================================================

function loadAccounts(): AccountsConfig {
	if (!existsSync(ACCOUNTS_FILE)) {
		return { accounts: [], currentIndex: 0 };
	}
	try {
		const raw = JSON.parse(readFileSync(ACCOUNTS_FILE, "utf-8"));
		return {
			accounts: Array.isArray(raw.accounts) ? raw.accounts : [],
			currentIndex:
				typeof raw.currentIndex === "number" ? raw.currentIndex : 0,
		};
	} catch {
		return { accounts: [], currentIndex: 0 };
	}
}

function saveAccounts(cfg: AccountsConfig): void {
	const dir = dirname(ACCOUNTS_FILE);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
	}
	writeFileSync(ACCOUNTS_FILE, JSON.stringify(cfg, null, 2), "utf-8");
	try {
		chmodSync(ACCOUNTS_FILE, 0o600);
	} catch {
		/* ignore */
	}
}

// =============================================================================
// Google OAuth Helpers
// =============================================================================

async function generatePKCE(): Promise<{
	verifier: string;
	challenge: string;
}> {
	const verifier = randomBytes(32).toString("base64url");
	const challenge = createHash("sha256")
		.update(verifier)
		.digest("base64url");
	return { verifier, challenge };
}

/**
 * Start a local HTTP server to receive the OAuth callback.
 * Google redirects to http://localhost:51121/oauth-callback?code=...&state=...
 */
async function startCallbackServer(): Promise<{
	waitForCode: () => Promise<{ code: string; state: string } | null>;
	close: () => void;
}> {
	const http = await import("node:http");

	return new Promise((resolve, reject) => {
		let result: { code: string; state: string } | null = null;
		let done = false;

		const server = http.createServer((req, res) => {
			const url = new URL(req.url || "", `http://localhost:${CALLBACK_PORT}`);

			if (url.pathname === "/oauth-callback") {
				const code = url.searchParams.get("code");
				const state = url.searchParams.get("state");
				const error = url.searchParams.get("error");

				if (error) {
					res.writeHead(400, { "Content-Type": "text/html" });
					res.end(
						`<html><body><h1>Authentication Failed</h1><p>${error}</p><p>You can close this window.</p></body></html>`
					);
					return;
				}

				if (code && state) {
					res.writeHead(200, { "Content-Type": "text/html" });
					res.end(
						`<html><body><h1>Authentication Successful</h1><p>You can close this window and return to the terminal.</p></body></html>`
					);
					result = { code, state };
				} else {
					res.writeHead(400, { "Content-Type": "text/html" });
					res.end(
						`<html><body><h1>Missing code or state</h1></body></html>`
					);
				}
			} else {
				res.writeHead(404);
				res.end();
			}
		});

		server.on("error", reject);

		server.listen(CALLBACK_PORT, "127.0.0.1", () => {
			resolve({
				waitForCode: async () => {
					const sleep = () =>
						new Promise((r) => setTimeout(r, 200));
					// Wait up to 5 minutes
					for (let i = 0; i < 1500 && !result && !done; i++) {
						await sleep();
					}
					return result;
				},
				close: () => {
					done = true;
					server.close();
				},
			});
		});
	});
}

/** Exchange authorization code for tokens */
async function exchangeCode(
	code: string,
	verifier: string
): Promise<{
	access_token: string;
	refresh_token?: string;
	expires_in: number;
} | null> {
	try {
		const response = await fetch(TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id: CLIENT_ID,
				client_secret: CLIENT_SECRET,
				code,
				grant_type: "authorization_code",
				redirect_uri: REDIRECT_URI,
				code_verifier: verifier,
			}),
		});
		if (!response.ok) return null;
		return (await response.json()) as any;
	} catch {
		return null;
	}
}

/** Refresh access token. Google keeps the same refresh token. */
async function refreshAccessToken(
	refreshToken: string
): Promise<{ access: string; expires: number } | null> {
	try {
		const response = await fetch(TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id: CLIENT_ID,
				client_secret: CLIENT_SECRET,
				refresh_token: refreshToken,
				grant_type: "refresh_token",
			}),
		});
		if (!response.ok) return null;
		const data = (await response.json()) as any;
		return {
			access: data.access_token,
			expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
		};
	} catch {
		return null;
	}
}

/** Fetch user info (email, id) from Google */
async function fetchUserInfo(
	accessToken: string
): Promise<{ email?: string; id?: string } | null> {
	try {
		const response = await fetch(USERINFO_URL, {
			headers: { Authorization: `Bearer ${accessToken}` },
		});
		if (!response.ok) return null;
		return (await response.json()) as any;
	} catch {
		return null;
	}
}

/** Discover or provision Cloud Code Assist project */
async function discoverProject(
	accessToken: string
): Promise<string> {
	const headers = {
		Authorization: `Bearer ${accessToken}`,
		"Content-Type": "application/json",
		"User-Agent": "google-api-nodejs-client/9.15.1",
		"X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
		"Client-Metadata": JSON.stringify({
			ideType: "IDE_UNSPECIFIED",
			platform: "PLATFORM_UNSPECIFIED",
			pluginType: "GEMINI",
		}),
	};

	const endpoints = [
		"https://cloudcode-pa.googleapis.com",
		"https://daily-cloudcode-pa.sandbox.googleapis.com",
	];

	for (const endpoint of endpoints) {
		try {
			const response = await fetch(
				`${endpoint}/v1internal:loadCodeAssist`,
				{
					method: "POST",
					headers,
					body: JSON.stringify({
						metadata: {
							ideType: "IDE_UNSPECIFIED",
							platform: "PLATFORM_UNSPECIFIED",
							pluginType: "GEMINI",
						},
					}),
				}
			);
			if (response.ok) {
				const data = (await response.json()) as any;
				const proj = data.cloudaicompanionProject;
				if (typeof proj === "string" && proj) return proj;
				if (proj && typeof proj === "object" && proj.id) return proj.id;
			}
		} catch {
			// try next endpoint
		}
	}

	return DEFAULT_PROJECT_ID;
}

// =============================================================================
// Full OAuth Login Flow
// =============================================================================

async function antigravityOAuth(
	pi: ExtensionAPI,
	ui: ExtensionContext["ui"]
): Promise<{
	refresh: string;
	access: string;
	expires: number;
	projectId: string;
	email?: string;
	googleId?: string;
} | null> {
	const { verifier, challenge } = await generatePKCE();

	// Start local callback server
	let server: Awaited<ReturnType<typeof startCallbackServer>>;
	try {
		server = await startCallbackServer();
	} catch (err) {
		ui.notify(
			`Failed to start callback server on port ${CALLBACK_PORT}.\n` +
				`Make sure no other Pi instance or program is using it.\n` +
				`Error: ${err instanceof Error ? err.message : err}`,
			"error"
		);
		return null;
	}

	try {
		// Build authorization URL
		const authParams = new URLSearchParams({
			client_id: CLIENT_ID,
			response_type: "code",
			redirect_uri: REDIRECT_URI,
			scope: SCOPES.join(" "),
			code_challenge: challenge,
			code_challenge_method: "S256",
			state: verifier,
			access_type: "offline",
			prompt: "consent",
		});

		const authUrl = `${AUTH_URL}?${authParams.toString()}`;

		// Open browser
		try {
			await pi.exec("xdg-open", [authUrl], { timeout: 5000 });
		} catch {
			ui.notify(`Open this URL manually:\n${authUrl}`, "info");
		}

		ui.notify(
			"Waiting for Google OAuth callback...\n" +
				"Complete the sign-in in your browser.",
			"info"
		);

		// Wait for callback
		const result = await server.waitForCode();

		if (!result) {
			ui.notify("OAuth timed out — no callback received.", "error");
			return null;
		}

		// Verify state
		if (result.state !== verifier) {
			ui.notify("OAuth state mismatch — possible CSRF attack.", "error");
			return null;
		}

		// Exchange code for tokens
		ui.notify("Exchanging code for tokens...", "info");
		const tokenData = await exchangeCode(result.code, verifier);

		if (!tokenData || !tokenData.refresh_token) {
			ui.notify(
				"Token exchange failed or no refresh token received.\nPlease try again.",
				"error"
			);
			return null;
		}

		const access = tokenData.access_token;
		const expires =
			Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000;

		// Fetch user info
		ui.notify("Fetching user info...", "info");
		const userInfo = await fetchUserInfo(access);

		// Discover project
		ui.notify("Discovering Cloud Code project...", "info");
		const projectId = await discoverProject(access);

		return {
			refresh: tokenData.refresh_token,
			access,
			expires,
			projectId,
			email: userInfo?.email,
			googleId: userInfo?.id,
		};
	} finally {
		server.close();
	}
}

// =============================================================================
// Extension Entry Point
// =============================================================================

export default function (pi: ExtensionAPI) {
	let config = loadAccounts();

	// ------------------------------------------------------------------
	// Helpers
	// ------------------------------------------------------------------

	function displayName(acc: Account): string {
		return acc.email ?? acc.label;
	}

	function countAvailable(): number {
		const now = Date.now();
		return config.accounts.filter((a) => {
			if (!a.exhaustedAt) return true;
			return now - a.exhaustedAt > COOLDOWN_MS;
		}).length;
	}

	function findNextAvailable(): {
		account: Account;
		index: number;
	} | null {
		const now = Date.now();
		const len = config.accounts.length;
		for (let offset = 1; offset < len; offset++) {
			const idx = (config.currentIndex + offset) % len;
			const acc = config.accounts[idx];
			if (!acc.exhaustedAt || now - acc.exhaustedAt > COOLDOWN_MS) {
				return { account: acc, index: idx };
			}
		}
		return null;
	}

	/**
	 * Find account by stable identifiers.
	 * Google refresh tokens are stable (don't rotate), so they're reliable for matching.
	 */
	function findAccountIndex(match: {
		googleId?: string;
		email?: string;
		refresh?: string;
	}): number {
		if (match.googleId) {
			const idx = config.accounts.findIndex(
				(a) => a.googleId === match.googleId
			);
			if (idx >= 0) return idx;
		}
		if (match.email) {
			const idx = config.accounts.findIndex(
				(a) => a.email === match.email
			);
			if (idx >= 0) return idx;
		}
		if (match.refresh) {
			const idx = config.accounts.findIndex(
				(a) => a.refresh === match.refresh
			);
			if (idx >= 0) return idx;
		}
		return -1;
	}

	function updateStatus(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;

		if (
			config.accounts.length === 0 ||
			ctx.model?.provider !== PROVIDER
		) {
			ctx.ui.setStatus("ag-rotator", undefined);
			return;
		}

		const avail = countAvailable();
		const current = config.accounts[config.currentIndex];
		const name = current ? displayName(current) : "?";
		ctx.ui.setStatus(
			"ag-rotator",
			`🌀 ${name} (${avail}/${config.accounts.length})`
		);
	}

	/**
	 * Rotate to the next available account.
	 * Writes new credentials (including projectId) into Pi's AuthStorage.
	 */
	function rotateAccount(ctx: ExtensionContext): boolean {
		if (config.accounts.length <= 1) {
			if (ctx.hasUI)
				ctx.ui.notify(
					"⚠️ Need at least 2 accounts for rotation. Use /ag add",
					"warning"
				);
			return false;
		}

		const next = findNextAvailable();
		if (!next) {
			const soonest = config.accounts
				.filter((a) => a.exhaustedAt)
				.map((a) => a.exhaustedAt! + COOLDOWN_MS - Date.now())
				.filter((t) => t > 0)
				.sort((a, b) => a - b)[0];
			const mins = soonest ? Math.ceil(soonest / 60000) : "?";
			if (ctx.hasUI)
				ctx.ui.notify(
					`⚠️ All accounts exhausted! Next available in ~${mins} min.`,
					"error"
				);
			return false;
		}

		config.currentIndex = next.index;

		// Antigravity credentials include projectId
		const credential: OAuthCredential & { projectId: string } = {
			type: "oauth",
			refresh: next.account.refresh,
			access: next.account.access,
			expires: next.account.expires,
			projectId: next.account.projectId,
		};
		ctx.modelRegistry.authStorage.set(PROVIDER, credential);

		saveAccounts(config);

		if (ctx.hasUI)
			ctx.ui.notify(
				`🔄 Rotated to: ${displayName(next.account)}`,
				"info"
			);
		updateStatus(ctx);
		return true;
	}

	/**
	 * Sync credentials from auth.json back into accounts config.
	 * Google refresh tokens are stable, so matching by refresh token works reliably.
	 */
	function syncFromAuth(ctx: ExtensionContext): void {
		const cred = ctx.modelRegistry.authStorage.get(PROVIDER) as any;
		if (!cred || cred.type !== "oauth") return;

		let idx = findAccountIndex({ refresh: cred.refresh });

		// Fallback to currentIndex if no match (shouldn't happen with Google,
		// but handles edge cases like manual auth.json edits)
		if (idx < 0 && config.currentIndex < config.accounts.length) {
			idx = config.currentIndex;
		}

		if (idx >= 0 && idx < config.accounts.length) {
			config.accounts[idx].access = cred.access;
			config.accounts[idx].expires = cred.expires;
			if (cred.projectId) {
				config.accounts[idx].projectId = cred.projectId;
			}
			config.currentIndex = idx;
			saveAccounts(config);
		}
	}

	function autoImportFromAuth(ctx: ExtensionContext): void {
		if (config.accounts.length > 0) return;

		const cred = ctx.modelRegistry.authStorage.get(PROVIDER) as any;
		if (!cred || cred.type !== "oauth" || !cred.refresh) return;

		config.accounts.push({
			label: "Account 1 (auto-imported)",
			refresh: cred.refresh,
			access: cred.access,
			expires: cred.expires,
			projectId: cred.projectId || DEFAULT_PROJECT_ID,
			addedAt: Date.now(),
			exhaustedAt: null,
		});
		config.currentIndex = 0;
		saveAccounts(config);

		if (ctx.hasUI)
			ctx.ui.notify(
				"🌀 Auto-imported current Antigravity credentials as Account 1.\n" +
					"   Run /ag identify to fetch email, then /ag add for more.",
				"info"
			);
	}

	// ------------------------------------------------------------------
	// Event Handlers
	// ------------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		config = loadAccounts();
		autoImportFromAuth(ctx);
		syncFromAuth(ctx);
		updateStatus(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.on("turn_end", async (event, ctx) => {
		if (ctx.model?.provider !== PROVIDER) return;

		const msg = event.message;
		if (msg.role !== "assistant") return;

		const assistantMsg = msg as AssistantMessage;
		if (
			assistantMsg.stopReason !== "error" ||
			!assistantMsg.errorMessage
		)
			return;

		if (!RATE_LIMIT_PATTERN.test(assistantMsg.errorMessage)) return;
		if (config.accounts.length <= 1) return;

		const current = config.accounts[config.currentIndex];
		if (current) {
			current.exhaustedAt = Date.now();
			saveAccounts(config);
		}

		const success = rotateAccount(ctx);
		if (success && ctx.hasUI) {
			ctx.ui.notify(
				"⏳ Pi will retry automatically with the new account...",
				"info"
			);
		}
	});

	// ------------------------------------------------------------------
	// /ag Command
	// ------------------------------------------------------------------

	const SUBCOMMANDS = [
		"add",
		"list",
		"identify",
		"rotate",
		"remove",
		"reset",
		"sync",
		"help",
	];

	pi.registerCommand("ag", {
		description: "Manage Antigravity accounts for quota rotation",

		getArgumentCompletions: (
			prefix: string
		): AutocompleteItem[] | null => {
			const matches = SUBCOMMANDS.filter((s) =>
				s.startsWith(prefix.toLowerCase())
			).map((s) => ({ value: s, label: s }));
			return matches.length > 0 ? matches : null;
		},

		handler: async (args, ctx) => {
			const parts = (args || "").trim().split(/\s+/);
			const sub = parts[0]?.toLowerCase() || "help";

			switch (sub) {
				// ---- /ag add [label] ----
				case "add": {
					const customLabel = parts.slice(1).join(" ") || "";

					if (ctx.hasUI)
						ctx.ui.notify(
							"Starting Antigravity OAuth login...\n" +
								"💡 Make sure you're signed into the desired Google account in your browser first!\n" +
								"   If you have multiple Google accounts, use an incognito window.",
							"info"
						);

					const tokens = await antigravityOAuth(pi, ctx.ui);
					if (!tokens) {
						if (ctx.hasUI)
							ctx.ui.notify("Account add cancelled.", "warning");
						return;
					}

					const label =
						customLabel ||
						tokens.email ||
						`Account ${config.accounts.length + 1}`;

					// Check for duplicate
					const dupIdx = findAccountIndex({
						googleId: tokens.googleId,
						email: tokens.email,
						refresh: tokens.refresh,
					});

					if (dupIdx >= 0) {
						const existing = config.accounts[dupIdx];
						existing.refresh = tokens.refresh;
						existing.access = tokens.access;
						existing.expires = tokens.expires;
						existing.projectId = tokens.projectId;
						existing.email = tokens.email ?? existing.email;
						existing.googleId =
							tokens.googleId ?? existing.googleId;
						existing.label = customLabel || existing.label;
						saveAccounts(config);
						if (ctx.hasUI)
							ctx.ui.notify(
								`🔄 Updated existing: ${displayName(existing)}`,
								"info"
							);
						updateStatus(ctx);
						return;
					}

					config.accounts.push({
						label,
						email: tokens.email,
						googleId: tokens.googleId,
						refresh: tokens.refresh,
						access: tokens.access,
						expires: tokens.expires,
						projectId: tokens.projectId,
						addedAt: Date.now(),
						exhaustedAt: null,
					});
					saveAccounts(config);

					if (ctx.hasUI)
						ctx.ui.notify(
							`✅ Added: ${tokens.email ?? label} (project: ${tokens.projectId}, total: ${config.accounts.length})`,
							"info"
						);
					updateStatus(ctx);
					break;
				}

				// ---- /ag list ----
				case "list": {
					if (config.accounts.length === 0) {
						if (ctx.hasUI)
							ctx.ui.notify(
								"No accounts configured.\nUse /ag add to add one.",
								"info"
							);
						return;
					}

					const now = Date.now();
					const lines = config.accounts.map((acc, i) => {
						const arrow =
							i === config.currentIndex ? " → " : "   ";
						let status: string;
						if (!acc.exhaustedAt) {
							status = "✅ available";
						} else {
							const remaining =
								COOLDOWN_MS - (now - acc.exhaustedAt);
							if (remaining > 0) {
								const mins = Math.ceil(remaining / 60000);
								status = `⏳ exhausted (${mins}m cooldown)`;
							} else {
								status = "✅ available (cooldown expired)";
							}
						}
						const email = acc.email
							? `<${acc.email}>`
							: "(no email — run /ag identify)";
						return `${arrow}[${i}] ${acc.label}  ${email}  [${acc.projectId}]  ${status}`;
					});

					if (ctx.hasUI)
						ctx.ui.notify(
							"Antigravity Accounts:\n" + lines.join("\n"),
							"info"
						);
					break;
				}

				// ---- /ag identify ----
				case "identify": {
					if (config.accounts.length === 0) {
						if (ctx.hasUI)
							ctx.ui.notify("No accounts to identify.", "info");
						return;
					}

					const toIdentify = config.accounts
						.map((acc, index) => ({ acc, index }))
						.filter(({ acc }) => !acc.email);

					if (toIdentify.length === 0) {
						if (ctx.hasUI)
							ctx.ui.notify(
								"All accounts already have email addresses.",
								"info"
							);
						return;
					}

					if (ctx.hasUI)
						ctx.ui.notify(
							`Identifying ${toIdentify.length} account(s)...`,
							"info"
						);

					let identified = 0;
					for (const { acc, index } of toIdentify) {
						// Refresh to get fresh access token
						const refreshed = await refreshAccessToken(acc.refresh);
						if (!refreshed) {
							if (ctx.hasUI)
								ctx.ui.notify(
									`⚠️ Failed to refresh [${index}] ${acc.label} — token may be revoked.`,
									"warning"
								);
							continue;
						}

						// Update tokens
						acc.access = refreshed.access;
						acc.expires = refreshed.expires;

						// If this is the active account, also update auth.json
						if (index === config.currentIndex) {
							ctx.modelRegistry.authStorage.set(PROVIDER, {
								type: "oauth",
								refresh: acc.refresh,
								access: refreshed.access,
								expires: refreshed.expires,
								projectId: acc.projectId,
							} as any);
						}

						// Fetch user info
						const userInfo = await fetchUserInfo(refreshed.access);
						if (userInfo?.email) {
							acc.email = userInfo.email;
							acc.googleId = userInfo.id;

							if (acc.label.startsWith("Account ")) {
								acc.label = userInfo.email;
							}

							identified++;
						} else {
							if (ctx.hasUI)
								ctx.ui.notify(
									`⚠️ Could not fetch email for [${index}] ${acc.label}`,
									"warning"
								);
						}
					}

					saveAccounts(config);
					if (ctx.hasUI)
						ctx.ui.notify(
							`✅ Identified ${identified}/${toIdentify.length} account(s).`,
							"info"
						);
					updateStatus(ctx);
					break;
				}

				// ---- /ag rotate ----
				case "rotate": {
					rotateAccount(ctx);
					break;
				}

				// ---- /ag remove <index> ----
				case "remove": {
					const idx = parseInt(parts[1]);
					if (
						isNaN(idx) ||
						idx < 0 ||
						idx >= config.accounts.length
					) {
						if (ctx.hasUI)
							ctx.ui.notify(
								`Invalid index. Use: /ag remove <0-${config.accounts.length - 1}>`,
								"error"
							);
						return;
					}

					const removed = config.accounts.splice(idx, 1)[0];

					if (config.accounts.length === 0) {
						config.currentIndex = 0;
					} else if (
						config.currentIndex >= config.accounts.length
					) {
						config.currentIndex = config.accounts.length - 1;
					} else if (config.currentIndex > idx) {
						config.currentIndex--;
					}

					saveAccounts(config);
					if (ctx.hasUI)
						ctx.ui.notify(
							`🗑️ Removed: ${displayName(removed)} (${config.accounts.length} remaining)`,
							"info"
						);
					updateStatus(ctx);
					break;
				}

				// ---- /ag reset ----
				case "reset": {
					let count = 0;
					for (const acc of config.accounts) {
						if (acc.exhaustedAt !== null) {
							acc.exhaustedAt = null;
							count++;
						}
					}
					saveAccounts(config);
					if (ctx.hasUI)
						ctx.ui.notify(
							`✅ Reset ${count} account(s) to available.`,
							"info"
						);
					updateStatus(ctx);
					break;
				}

				// ---- /ag sync ----
				case "sync": {
					syncFromAuth(ctx);
					if (ctx.hasUI)
						ctx.ui.notify(
							"✅ Synced credentials from auth.json.",
							"info"
						);
					updateStatus(ctx);
					break;
				}

				// ---- /ag help (default) ----
				default: {
					if (ctx.hasUI)
						ctx.ui.notify(
							"Antigravity Account Rotator\n\n" +
								"  /ag add [label]    Add a Google account (OAuth)\n" +
								"  /ag list           Show all accounts + status\n" +
								"  /ag identify       Fetch emails for accounts missing it\n" +
								"  /ag rotate         Manually rotate to next account\n" +
								"  /ag remove <idx>   Remove account by index\n" +
								"  /ag reset          Reset all exhaustion markers\n" +
								"  /ag sync           Sync tokens from auth.json\n\n" +
								"Auto-rotation triggers on rate limit / quota errors.\n" +
								`Cooldown: ${COOLDOWN_MS / 60000} minutes per exhausted account.\n` +
								`Config: ${ACCOUNTS_FILE}`,
							"info"
						);
					break;
				}
			}
		},
	});
}
