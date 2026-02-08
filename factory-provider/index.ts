/**
 * Factory AI Provider Extension for Pi
 *
 * Provides access to Factory's subscription models through Factory's LLM proxy:
 * - Anthropic: Claude Opus 4.5/4.6, Sonnet 4.5, Haiku 4.5
 * - OpenAI: GPT-5.1, GPT-5.1-Codex, GPT-5.2, GPT-5.2-Codex
 * - xAI: Grok 4, Grok Code Fast
 *
 * Authentication:
 *   /login factory → opens browser for WorkOS device flow login
 *   Token auto-refreshes via refresh_token — no manual paste needed.
 */

import {
	type Api,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type OAuthCredentials,
	type OAuthLoginCallbacks,
	type SimpleStreamOptions,
	streamSimpleAnthropic,
	streamSimpleOpenAIResponses,
} from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import crypto from "node:crypto";

// =============================================================================
// Constants
// =============================================================================

const FACTORY_API = "https://api.factory.ai";
const FACTORY_PREFIX = "You are Droid, an AI software engineering agent built by Factory.";

// WorkOS Device Authorization (reverse-engineered from droid CLI v0.57.9)
const WORKOS_CLIENT_ID = "client_01HNM792M5G5G1A2THWPXKFMXB";
const WORKOS_DEVICE_AUTH_URL = "https://api.workos.com/user_management/authorize/device";
const WORKOS_AUTHENTICATE_URL = "https://api.workos.com/user_management/authenticate";

type Backend = "anthropic" | "openai";

interface FactoryModel {
	id: string;
	name: string;
	backend: Backend;
	apiProvider: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
}

// =============================================================================
// Models
// =============================================================================

const MODELS: FactoryModel[] = [
	// Anthropic (via /api/llm/a)
	{ id: "claude-opus-4-6", name: "Claude Opus 4.6 (Factory)", backend: "anthropic", apiProvider: "anthropic", reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 32000 },
	{ id: "claude-opus-4-5-20251101", name: "Claude Opus 4.5 (Factory)", backend: "anthropic", apiProvider: "anthropic", reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 32000 },
	{ id: "claude-sonnet-4-5-20250929", name: "Claude Sonnet 4.5 (Factory)", backend: "anthropic", apiProvider: "anthropic", reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 16384 },
	{ id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5 (Factory)", backend: "anthropic", apiProvider: "anthropic", reasoning: false, input: ["text", "image"], contextWindow: 200000, maxTokens: 8192 },

	// OpenAI (via /api/llm/o)
	{ id: "gpt-5.1", name: "GPT-5.1 (Factory)", backend: "openai", apiProvider: "openai", reasoning: true, input: ["text", "image"], contextWindow: 128000, maxTokens: 16384 },
	{ id: "gpt-5.1-codex", name: "GPT-5.1 Codex (Factory)", backend: "openai", apiProvider: "openai", reasoning: true, input: ["text", "image"], contextWindow: 128000, maxTokens: 16384 },
	{ id: "gpt-5.1-codex-max", name: "GPT-5.1 Codex Max (Factory)", backend: "openai", apiProvider: "openai", reasoning: true, input: ["text", "image"], contextWindow: 128000, maxTokens: 32000 },
	{ id: "gpt-5.2", name: "GPT-5.2 (Factory)", backend: "openai", apiProvider: "openai", reasoning: true, input: ["text", "image"], contextWindow: 128000, maxTokens: 16384 },
	{ id: "gpt-5.2-codex", name: "GPT-5.2 Codex (Factory)", backend: "openai", apiProvider: "openai", reasoning: true, input: ["text", "image"], contextWindow: 128000, maxTokens: 16384 },

	// xAI / Grok (via /api/llm/o, OpenAI-compatible)
	{ id: "grok-4-0709", name: "Grok 4 (Factory)", backend: "openai", apiProvider: "xai", reasoning: true, input: ["text", "image"], contextWindow: 128000, maxTokens: 16384 },
	{ id: "grok-code-fast-1", name: "Grok Code Fast (Factory)", backend: "openai", apiProvider: "xai", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 16384 },
];

const MODEL_MAP = new Map(MODELS.map((m) => [m.id, m]));
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

// =============================================================================
// Factory Session Management
// =============================================================================

let currentSessionId: string | null = null;
let sessionReady = false;

async function factoryPost(path: string, body: Record<string, unknown>, token: string) {
	const response = await fetch(`${FACTORY_API}${path}`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			"X-Factory-Client": "cli",
		},
		body: JSON.stringify(body),
	});
	return { status: response.status, data: await response.json() };
}

async function ensureSession(token: string): Promise<string | null> {
	if (sessionReady && currentSessionId) return currentSessionId;

	const sessionId = crypto.randomUUID();

	const createResp = await factoryPost("/api/sessions/create", {
		id: sessionId,
		isStarted: false,
		machineConnectionType: "tui",
		title: "Pi Session",
		version: 2,
	}, token);

	if (createResp.status !== 200) return null;

	await factoryPost(`/api/sessions/${sessionId}/droid-status`, {
		droidProcessId: process.pid,
		droidStatus: "running",
	}, token);

	currentSessionId = sessionId;
	sessionReady = true;
	return sessionId;
}

async function registerMessage(sessionId: string, token: string, text: string) {
	await factoryPost(`/api/sessions/${sessionId}/message/create`, {
		message: {
			id: crypto.randomUUID(),
			role: "user",
			content: [{ type: "text", text: text.substring(0, 200) }],
			parentId: "root",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		},
	}, token);
}

// =============================================================================
// System Prompt Patching
// =============================================================================

function patchSystemPrompt(context: Context): Context {
	if (!context.systemPrompt) {
		return { ...context, systemPrompt: FACTORY_PREFIX };
	}
	if (context.systemPrompt.startsWith(FACTORY_PREFIX)) {
		return context;
	}
	return { ...context, systemPrompt: FACTORY_PREFIX + "\n\n" + context.systemPrompt };
}

function extractUserText(context: Context): string {
	const msgs = context.messages || [];
	for (let i = msgs.length - 1; i >= 0; i--) {
		const msg = msgs[i];
		if (msg.role === "user") {
			for (const block of msg.content) {
				if (block.type === "text") return block.text.substring(0, 200);
			}
		}
	}
	return "...";
}

// =============================================================================
// Streaming
// =============================================================================

function streamFactory(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		try {
			const token = options?.apiKey;
			if (!token) throw new Error("No Factory token. Run /login factory");

			const cfg = MODEL_MAP.get(model.id);
			if (!cfg) throw new Error(`Unknown Factory model: ${model.id}`);

			const sessionId = await ensureSession(token);
			if (!sessionId) throw new Error("Failed to create Factory session");

			await registerMessage(sessionId, token, extractUserText(context));

			const patchedContext = patchSystemPrompt(context);

			const baseHeaders = {
				Authorization: `Bearer ${token}`,
				"X-Factory-Client": "cli",
				"x-api-provider": cfg.apiProvider,
				"x-session-id": sessionId,
				"x-assistant-message-id": crypto.randomUUID(),
			};

			let innerStream: AssistantMessageEventStream;

			if (cfg.backend === "anthropic") {
				const factoryModel = { ...model, baseUrl: `${FACTORY_API}/api/llm/a` };
				const factoryOptions: SimpleStreamOptions = {
					...options,
					apiKey: "placeholder",
					headers: { ...options?.headers, ...baseHeaders, "x-api-key": "placeholder" },
				};
				innerStream = streamSimpleAnthropic(
					factoryModel as Model<"anthropic-messages">,
					patchedContext,
					factoryOptions,
				);
			} else {
				const factoryModel = { ...model, baseUrl: `${FACTORY_API}/api/llm/o/v1` };
				const factoryOptions: SimpleStreamOptions = {
					...options,
					apiKey: "placeholder",
					headers: { ...options?.headers, ...baseHeaders },
				};
				innerStream = streamSimpleOpenAIResponses(
					factoryModel as Model<"openai-responses">,
					patchedContext,
					factoryOptions,
				);
			}

			for await (const event of innerStream) {
				if (event.type === "error" && event.error?.errorMessage?.includes("403")) {
					sessionReady = false;
					currentSessionId = null;
				}
				stream.push(event);
			}
			stream.end();
		} catch (error) {
			sessionReady = false;
			currentSessionId = null;
			stream.push({
				type: "error",
				reason: "error",
				error: {
					role: "assistant",
					content: [],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "error",
					errorMessage: error instanceof Error ? error.message : String(error),
					timestamp: Date.now(),
				},
			});
			stream.end();
		}
	})();

	return stream;
}

// =============================================================================
// OAuth — WorkOS Device Authorization Flow
// =============================================================================

type DeviceCodeResponse = {
	device_code: string;
	user_code: string;
	verification_uri: string;
	verification_uri_complete: string;
	expires_in: number;
	interval: number;
};

type AuthenticateResponse = {
	access_token: string;
	refresh_token: string;
	user?: { email?: string };
};

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) { reject(new Error("Login cancelled")); return; }
		const timeout = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => { clearTimeout(timeout); reject(new Error("Login cancelled")); }, { once: true });
	});
}

function parseJwtExpiry(token: string): number {
	try {
		const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
		if (payload.exp) return payload.exp * 1000 - 5 * 60 * 1000; // 5 min buffer
	} catch { /* ignore */ }
	return Date.now() + 7 * 24 * 60 * 60 * 1000; // fallback 7 days
}

async function loginFactory(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	callbacks.onProgress?.("Requesting device code...");

	// Step 1: Request device code from WorkOS
	const deviceResp = await fetch(WORKOS_DEVICE_AUTH_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ client_id: WORKOS_CLIENT_ID }),
	});

	if (!deviceResp.ok) {
		throw new Error(`Failed to start device flow: ${deviceResp.status} ${await deviceResp.text()}`);
	}

	const device: DeviceCodeResponse = await deviceResp.json();

	// Step 2: Direct user to verify in browser
	callbacks.onAuth({
		url: device.verification_uri_complete,
		instructions: `Enter code: ${device.user_code}`,
	});

	// Step 3: Poll for token
	callbacks.onProgress?.("Waiting for browser login...");
	const deadline = Date.now() + device.expires_in * 1000;
	let intervalMs = Math.max(1000, device.interval * 1000);

	while (Date.now() < deadline) {
		if (callbacks.signal?.aborted) throw new Error("Login cancelled");

		await abortableSleep(intervalMs, callbacks.signal);

		const tokenResp = await fetch(WORKOS_AUTHENTICATE_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				client_id: WORKOS_CLIENT_ID,
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				device_code: device.device_code,
			}),
		});

		const data = await tokenResp.json();

		if (data.error === "authorization_pending") continue;
		if (data.error === "slow_down") { intervalMs += 5000; continue; }
		if (data.error) throw new Error(`Login failed: ${data.error} — ${data.error_description || ""}`);

		if (data.access_token) {
			const result = data as AuthenticateResponse;
			callbacks.onProgress?.("Login successful!");

			// Verify token works with Factory API
			const verify = await fetch(`${FACTORY_API}/api/feature-flags`, {
				headers: { Authorization: `Bearer ${result.access_token}` },
			});
			if (!verify.ok) {
				throw new Error(`Token verification failed (${verify.status}). Your Factory account may not have API access.`);
			}

			return {
				refresh: result.refresh_token,
				access: result.access_token,
				expires: parseJwtExpiry(result.access_token),
			};
		}
	}

	throw new Error("Login timed out. Please try again.");
}

async function refreshFactory(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	const resp = await fetch(WORKOS_AUTHENTICATE_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			client_id: WORKOS_CLIENT_ID,
			grant_type: "refresh_token",
			refresh_token: credentials.refresh,
		}),
	});

	if (!resp.ok) {
		const text = await resp.text();
		throw new Error(`Factory token refresh failed: ${resp.status} ${text}`);
	}

	const data = await resp.json();

	if (data.error) {
		throw new Error(`Factory token refresh failed: ${data.error} — ${data.error_description || ""}`);
	}

	// Reset session on token refresh (new JWT = old session may be invalid)
	sessionReady = false;
	currentSessionId = null;

	return {
		refresh: data.refresh_token || credentials.refresh,
		access: data.access_token,
		expires: parseJwtExpiry(data.access_token),
	};
}

// =============================================================================
// Extension Entry Point
// =============================================================================

export default function (pi: ExtensionAPI) {
	pi.registerProvider("factory", {
		baseUrl: FACTORY_API,
		api: "factory-api" as Api,
		models: MODELS.map(({ id, name, reasoning, input, contextWindow, maxTokens }) => ({
			id,
			name,
			reasoning,
			input,
			cost: ZERO_COST,
			contextWindow,
			maxTokens,
		})),
		oauth: {
			name: "Factory AI",
			login: loginFactory,
			refreshToken: refreshFactory,
			getApiKey: (cred) => cred.access,
		},
		streamSimple: streamFactory,
	});
}
