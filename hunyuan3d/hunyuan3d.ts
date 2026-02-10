/**
 * Hunyuan3D Extension — Generate 3D models (GLB) from text or image
 *
 * Uses Tencent Cloud Hunyuan 3D API (v3.0/3.1) with TC3-HMAC-SHA256 signing.
 * Zero npm dependencies — uses Node.js built-in crypto and fetch.
 *
 * Prerequisites:
 *   1. Tencent Cloud account (https://www.tencentcloud.com)
 *   2. Activate Hunyuan service → get 200 free credits
 *   3. Create API Key → set environment variables:
 *      export TENCENT_SECRET_ID="<your-secret-id>"
 *      export TENCENT_SECRET_KEY="<your-secret-key>"
 *
 * Environment variables:
 *   TENCENT_SECRET_ID   - (required) API SecretId
 *   TENCENT_SECRET_KEY  - (required) API SecretKey
 *   HUNYUAN3D_REGION    - API region (default: ap-singapore)
 *   HUNYUAN3D_MODEL     - Default model version: "3.0" | "3.1" (default: "3.0")
 *   HUNYUAN3D_OUTPUT_DIR - Default output dir relative to cwd (default: assets/3d)
 */

import { createHmac, createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

// ─── Constants ───────────────────────────────────────────────────────────────

const SERVICE = "hunyuan";
const HOST = "hunyuan.intl.tencentcloudapi.com";
const ENDPOINT = `https://${HOST}`;
const API_VERSION = "2023-09-01";
const ALGORITHM = "TC3-HMAC-SHA256";
const CONTENT_TYPE = "application/json; charset=utf-8";

const SUBMIT_ACTION = "SubmitHunyuanTo3DProJob";
const QUERY_ACTION = "QueryHunyuanTo3DProJob";

const DEFAULT_REGION = "ap-singapore";
const DEFAULT_MODEL = "3.0";
const DEFAULT_OUTPUT_DIR = "assets/3d";

const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_ATTEMPTS = 120; // 120 × 5s = 10 minutes
const MAX_IMAGE_SIZE = 6 * 1024 * 1024; // 6MB

const GENERATE_TYPES = ["Normal", "LowPoly", "Geometry", "Sketch"] as const;
const MODEL_VERSIONS = ["3.0", "3.1"] as const;

// ─── Types ───────────────────────────────────────────────────────────────────

interface SubmitJobResponse {
	Response: {
		JobId?: string;
		RequestId: string;
		Error?: { Code: string; Message: string };
	};
}

interface ResultFile3D {
	FileType: string;
	Url: string;
}

interface QueryJobResponse {
	Response: {
		Status?: string;
		ResultFile3Ds?: ResultFile3D[];
		RequestId: string;
		Error?: { Code: string; Message: string };
	};
}

interface Generate3DDetails {
	jobId?: string;
	status?: string;
	elapsed?: number;
	outputPath?: string;
	fileSize?: number;
	model?: string;
	generateType?: string;
	faceCount?: number;
	enablePBR?: boolean;
	inputMode?: "text" | "image" | "imageUrl";
	prompt?: string;
	allFiles?: ResultFile3D[];
	error?: string;
}

// ─── TC3-HMAC-SHA256 Signing ─────────────────────────────────────────────────

function sha256Hex(data: string): string {
	return createHash("sha256").update(data).digest("hex");
}

function hmacSha256(key: string | Buffer, data: string): Buffer {
	return createHmac("sha256", key).update(data).digest();
}

function hmacSha256Hex(key: string | Buffer, data: string): string {
	return createHmac("sha256", key).update(data).digest("hex");
}

function getUtcDate(timestamp: number): string {
	const d = new Date(timestamp * 1000);
	const year = d.getUTCFullYear();
	const month = String(d.getUTCMonth() + 1).padStart(2, "0");
	const day = String(d.getUTCDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function buildSignedHeaders(
	secretId: string,
	secretKey: string,
	action: string,
	payload: string,
	region: string,
	timestamp: number,
): Record<string, string> {
	const date = getUtcDate(timestamp);

	// Step 1: CanonicalRequest
	const hashedPayload = sha256Hex(payload);
	const canonicalHeaders = `content-type:${CONTENT_TYPE}\nhost:${HOST}\n`;
	const signedHeaders = "content-type;host";
	const canonicalRequest = [
		"POST",
		"/",
		"", // empty query string for POST
		canonicalHeaders,
		signedHeaders,
		hashedPayload,
	].join("\n");

	// Step 2: StringToSign
	const credentialScope = `${date}/${SERVICE}/tc3_request`;
	const hashedCanonicalRequest = sha256Hex(canonicalRequest);
	const stringToSign = [ALGORITHM, String(timestamp), credentialScope, hashedCanonicalRequest].join("\n");

	// Step 3: Signature
	const secretDate = hmacSha256(`TC3${secretKey}`, date);
	const secretService = hmacSha256(secretDate, SERVICE);
	const secretSigning = hmacSha256(secretService, "tc3_request");
	const signature = hmacSha256Hex(secretSigning, stringToSign);

	// Step 4: Authorization
	const authorization = `${ALGORITHM} Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

	return {
		Authorization: authorization,
		"Content-Type": CONTENT_TYPE,
		Host: HOST,
		"X-TC-Action": action,
		"X-TC-Timestamp": String(timestamp),
		"X-TC-Version": API_VERSION,
		"X-TC-Region": region,
	};
}

// ─── Tencent Cloud API Client ────────────────────────────────────────────────

function getCredentials(): { secretId: string; secretKey: string } {
	const secretId = process.env.TENCENT_SECRET_ID;
	const secretKey = process.env.TENCENT_SECRET_KEY;
	if (!secretId || !secretKey) {
		throw new Error(
			"Missing Tencent Cloud credentials. Set TENCENT_SECRET_ID and TENCENT_SECRET_KEY environment variables.\n" +
				"Get your keys at: https://console.tencentcloud.com/cam/capi",
		);
	}
	return { secretId, secretKey };
}

async function callApi<T>(action: string, params: Record<string, unknown>, region: string, signal?: AbortSignal): Promise<T> {
	const { secretId, secretKey } = getCredentials();
	const payload = JSON.stringify(params);
	const timestamp = Math.floor(Date.now() / 1000);
	const headers = buildSignedHeaders(secretId, secretKey, action, payload, region, timestamp);

	const response = await fetch(ENDPOINT, {
		method: "POST",
		headers,
		body: payload,
		signal,
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Tencent Cloud API error (HTTP ${response.status}): ${text}`);
	}

	return (await response.json()) as T;
}

async function submitJob(
	params: {
		model?: string;
		prompt?: string;
		imageBase64?: string;
		imageUrl?: string;
		enablePBR?: boolean;
		faceCount?: number;
		generateType?: string;
	},
	region: string,
	signal?: AbortSignal,
): Promise<string> {
	const body: Record<string, unknown> = {};
	if (params.model) body.Model = params.model;
	if (params.prompt) body.Prompt = params.prompt;
	if (params.imageBase64) body.ImageBase64 = params.imageBase64;
	if (params.imageUrl) body.ImageUrl = params.imageUrl;
	if (params.enablePBR !== undefined) body.EnablePBR = params.enablePBR;
	if (params.faceCount !== undefined) body.FaceCount = params.faceCount;
	if (params.generateType) body.GenerateType = params.generateType;

	const result = await callApi<SubmitJobResponse>(SUBMIT_ACTION, body, region, signal);

	if (result.Response.Error) {
		throw new Error(`API error [${result.Response.Error.Code}]: ${result.Response.Error.Message}`);
	}
	if (!result.Response.JobId) {
		throw new Error("API returned no JobId. Response: " + JSON.stringify(result.Response));
	}

	return result.Response.JobId;
}

async function queryJob(
	jobId: string,
	region: string,
	signal?: AbortSignal,
): Promise<{ status: string; resultFiles?: ResultFile3D[]; error?: string }> {
	const result = await callApi<QueryJobResponse>(QUERY_ACTION, { JobId: jobId }, region, signal);

	if (result.Response.Error) {
		throw new Error(`API error [${result.Response.Error.Code}]: ${result.Response.Error.Message}`);
	}

	return {
		status: result.Response.Status || "UNKNOWN",
		resultFiles: result.Response.ResultFile3Ds,
	};
}

// ─── Polling ─────────────────────────────────────────────────────────────────

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(new Error("Aborted"));
			},
			{ once: true },
		);
	});
}

async function pollUntilDone(
	jobId: string,
	region: string,
	signal: AbortSignal | undefined,
	onProgress: (msg: string, elapsed: number) => void,
): Promise<ResultFile3D[]> {
	const startTime = Date.now();

	for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
		if (signal?.aborted) throw new Error("Cancelled by user");

		const elapsed = Math.round((Date.now() - startTime) / 1000);
		const result = await queryJob(jobId, region, signal);

		switch (result.status) {
			case "DONE":
				if (!result.resultFiles || result.resultFiles.length === 0) {
					throw new Error("Job completed but no output files returned");
				}
				return result.resultFiles;

			case "FAIL":
				throw new Error(`3D generation failed: ${result.error || "Unknown error"}`);

			case "WAIT":
				onProgress(`Waiting in queue... (${elapsed}s)`, elapsed);
				break;

			case "RUN":
				onProgress(`Generating 3D model... (${elapsed}s)`, elapsed);
				break;

			default:
				onProgress(`Status: ${result.status} (${elapsed}s)`, elapsed);
		}

		await sleep(POLL_INTERVAL_MS, signal);
	}

	throw new Error(`Generation timed out after ${MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS / 1000} seconds`);
}

// ─── File Operations ─────────────────────────────────────────────────────────

async function downloadFile(url: string, outputPath: string, signal?: AbortSignal): Promise<number> {
	const response = await fetch(url, { signal });
	if (!response.ok) {
		throw new Error(`Failed to download file (HTTP ${response.status})`);
	}

	const buffer = Buffer.from(await response.arrayBuffer());
	const dir = resolve(outputPath, "..");
	await mkdir(dir, { recursive: true });
	await writeFile(outputPath, buffer);
	return buffer.byteLength;
}

function resolveOutputPath(cwd: string, outputPath?: string): string {
	if (outputPath) {
		return resolve(cwd, outputPath);
	}

	const dir = resolve(cwd, process.env.HUNYUAN3D_OUTPUT_DIR || DEFAULT_OUTPUT_DIR);
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const id = randomUUID().slice(0, 8);
	return join(dir, `model-${timestamp}-${id}.glb`);
}

async function readImageAsBase64(imagePath: string, cwd: string): Promise<string> {
	const fullPath = resolve(cwd, imagePath);

	try {
		const stats = await stat(fullPath);
		if (stats.size > MAX_IMAGE_SIZE) {
			throw new Error(`Image too large (${formatBytes(stats.size)}). Maximum size is ${formatBytes(MAX_IMAGE_SIZE)}`);
		}
	} catch (err: any) {
		if (err.code === "ENOENT") {
			throw new Error(`Image file not found: ${fullPath}`);
		}
		throw err;
	}

	const buffer = await readFile(fullPath);
	return buffer.toString("base64");
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	const m = Math.floor(seconds / 60);
	const s = seconds % 60;
	return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

// ─── Extension Entry Point ───────────────────────────────────────────────────

export default function hunyuan3dExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "generate_3d",
		label: "Generate 3D",
		description: `Generate a 3D model (GLB file) from a text description or reference image using Tencent Hunyuan3D (v3.0/3.1). The generated GLB file can be loaded in Three.js, React Three Fiber, Unity, Unreal Engine, Blender, etc.

Input modes (provide exactly one):
- Text-to-3D: Set "prompt" with a description of the 3D object
- Image-to-3D: Set "imagePath" (local file) or "imageUrl" (remote URL) pointing to a reference image

Tips for best results:
- For text: describe a single object with clear shape and material details
- For image: use a clean/solid background, single centered object, no overlaid text
- Use enablePBR=true for realistic materials and lighting in web/game engines
- Use generateType="LowPoly" for stylized or gaming assets with fewer polygons
- Reduce faceCount (e.g. 100000) for lighter web assets, increase (e.g. 1000000) for detailed models

Output: GLB file saved to the project directory (default: assets/3d/).
Requires TENCENT_SECRET_ID and TENCENT_SECRET_KEY environment variables.`,

		parameters: Type.Object({
			prompt: Type.Optional(
				Type.String({ description: "Text description of the 3D object to generate (for text-to-3D mode)" }),
			),
			imagePath: Type.Optional(
				Type.String({ description: "Local path to a reference image (for image-to-3D mode)" }),
			),
			imageUrl: Type.Optional(
				Type.String({ description: "URL of a reference image (for image-to-3D mode)" }),
			),
			outputPath: Type.Optional(
				Type.String({ description: "Output file path for the GLB file (default: assets/3d/{timestamp}.glb)" }),
			),
			enablePBR: Type.Optional(
				Type.Boolean({ description: "Enable PBR (Physically Based Rendering) materials. Default: false" }),
			),
			faceCount: Type.Optional(
				Type.Integer({
					description: "Number of polygon faces (40000-1500000). Default: 500000. Use lower for web, higher for detail.",
					minimum: 40000,
					maximum: 1500000,
				}),
			),
			generateType: Type.Optional(
				StringEnum(GENERATE_TYPES, {
					description: "Generation style: Normal (realistic), LowPoly (stylized), Geometry (wireframe), Sketch (sketch-based)",
				}),
			),
			model: Type.Optional(
				StringEnum(MODEL_VERSIONS, { description: "Hunyuan3D model version. Default: 3.0" }),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const startTime = Date.now();
			const details: Generate3DDetails = {};

			try {
				// ── Validate input ──
				const hasPrompt = !!params.prompt;
				const hasImage = !!params.imagePath;
				const hasImageUrl = !!params.imageUrl;
				const inputCount = [hasPrompt, hasImage, hasImageUrl].filter(Boolean).length;

				if (inputCount === 0) {
					return {
						content: [{ type: "text", text: "Error: Provide either 'prompt' (text-to-3D), 'imagePath' (local image), or 'imageUrl' (remote image)." }],
						isError: true,
						details,
					};
				}
				if (inputCount > 1) {
					return {
						content: [{ type: "text", text: "Error: Provide only one of 'prompt', 'imagePath', or 'imageUrl'." }],
						isError: true,
						details,
					};
				}

				// ── Resolve config ──
				const region = process.env.HUNYUAN3D_REGION || DEFAULT_REGION;
				const modelVersion = params.model || process.env.HUNYUAN3D_MODEL || DEFAULT_MODEL;
				const generateType = params.generateType || "Normal";
				const outputPath = resolveOutputPath(ctx.cwd, params.outputPath);

				details.model = modelVersion;
				details.generateType = generateType;
				details.faceCount = params.faceCount;
				details.enablePBR = params.enablePBR;
				details.prompt = params.prompt;

				// ── Prepare API params ──
				const apiParams: {
					model?: string;
					prompt?: string;
					imageBase64?: string;
					imageUrl?: string;
					enablePBR?: boolean;
					faceCount?: number;
					generateType?: string;
				} = {
					model: modelVersion,
					generateType,
				};

				if (params.enablePBR !== undefined) apiParams.enablePBR = params.enablePBR;
				if (params.faceCount !== undefined) apiParams.faceCount = params.faceCount;

				if (hasPrompt) {
					apiParams.prompt = params.prompt;
					details.inputMode = "text";
				} else if (hasImage) {
					onUpdate?.({
						content: [{ type: "text", text: "Reading image file..." }],
						details,
					});
					apiParams.imageBase64 = await readImageAsBase64(params.imagePath!, ctx.cwd);
					details.inputMode = "image";
				} else if (hasImageUrl) {
					apiParams.imageUrl = params.imageUrl;
					details.inputMode = "imageUrl";
				}

				// ── Submit job ──
				onUpdate?.({
					content: [{ type: "text", text: "Submitting job to Hunyuan3D..." }],
					details,
				});

				const jobId = await submitJob(apiParams, region, signal);
				details.jobId = jobId;

				onUpdate?.({
					content: [{ type: "text", text: `Job submitted (${jobId}). Waiting for generation...` }],
					details,
				});

				// ── Poll until done ──
				const resultFiles = await pollUntilDone(jobId, region, signal, (msg, elapsed) => {
					details.status = msg;
					details.elapsed = elapsed;
					onUpdate?.({
						content: [{ type: "text", text: msg }],
						details,
					});
				});

				details.allFiles = resultFiles;

				// ── Find GLB file (prefer by FileType, then by URL extension, fallback to first) ──
				const glbFile =
					resultFiles.find((f) => f.FileType?.toLowerCase() === "glb") ||
					resultFiles.find((f) => f.Url?.toLowerCase().includes(".glb")) ||
					resultFiles[0];
				if (!glbFile?.Url) {
					throw new Error("No downloadable 3D file in results");
				}

				// ── Download ──
				onUpdate?.({
					content: [{ type: "text", text: "Downloading 3D model..." }],
					details,
				});

				const fileSize = await downloadFile(glbFile.Url, outputPath, signal);
				const elapsed = Math.round((Date.now() - startTime) / 1000);

				details.outputPath = outputPath;
				details.fileSize = fileSize;
				details.elapsed = elapsed;
				details.status = "DONE";

				// ── Build result text ──
				const summary = [
					`Generated 3D model saved to: ${outputPath}`,
					`File size: ${formatBytes(fileSize)}`,
					`Generation time: ${formatDuration(elapsed)}`,
					`Model: Hunyuan3D v${modelVersion} (${generateType})`,
				];
				if (params.enablePBR) summary.push("PBR materials: enabled");
				if (params.faceCount) summary.push(`Face count: ${params.faceCount.toLocaleString()}`);
				if (resultFiles.length > 1) {
					summary.push(`\nAll output files:`);
					for (const f of resultFiles) {
						summary.push(`  - ${f.FileType}: ${f.Url}`);
					}
				}

				return {
					content: [{ type: "text", text: summary.join("\n") }],
					details,
				};
			} catch (err: any) {
				const elapsed = Math.round((Date.now() - startTime) / 1000);
				details.elapsed = elapsed;
				details.status = "FAIL";
				details.error = err.message || String(err);

				return {
					content: [{ type: "text", text: `Error generating 3D model: ${details.error}` }],
					isError: true,
					details,
				};
			}
		},

		// ── Custom TUI Rendering ──

		renderCall(args: Record<string, unknown>, theme: Theme) {
			let text = theme.fg("toolTitle", theme.bold("🧊 generate_3d "));

			if (args.prompt) {
				const prompt = String(args.prompt);
				const truncated = prompt.length > 60 ? prompt.slice(0, 57) + "..." : prompt;
				text += theme.fg("accent", `"${truncated}"`);
			} else if (args.imagePath) {
				text += theme.fg("accent", `from ${basename(String(args.imagePath))}`);
			} else if (args.imageUrl) {
				const url = String(args.imageUrl);
				const short = url.length > 50 ? url.slice(0, 47) + "..." : url;
				text += theme.fg("accent", `from URL ${short}`);
			}

			const meta: string[] = [];
			if (args.generateType && args.generateType !== "Normal") meta.push(String(args.generateType));
			if (args.enablePBR) meta.push("PBR");
			if (args.model) meta.push(`v${args.model}`);
			if (args.faceCount) meta.push(`${(Number(args.faceCount) / 1000).toFixed(0)}K faces`);

			if (meta.length > 0) {
				text += theme.fg("muted", ` (${meta.join(", ")})`);
			}

			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as Generate3DDetails | undefined;

			// Streaming / in-progress
			if (isPartial) {
				const status = details?.status || "Starting...";
				const elapsed = details?.elapsed ? ` (${formatDuration(details.elapsed)})` : "";
				return new Text(theme.fg("warning", `⏳ ${status}${elapsed}`), 0, 0);
			}

			// Error
			if (result.isError || details?.status === "FAIL") {
				const msg = details?.error || (result.content[0]?.type === "text" ? result.content[0].text : "Unknown error");
				return new Text(theme.fg("error", `✗ ${msg}`), 0, 0);
			}

			// Success
			if (details?.outputPath) {
				const fileName = basename(details.outputPath);
				const size = details.fileSize ? formatBytes(details.fileSize) : "";
				const duration = details.elapsed ? formatDuration(details.elapsed) : "";

				let text = theme.fg("success", "✓ ") + theme.fg("text", fileName);
				if (size) text += theme.fg("muted", ` (${size})`);
				if (duration) text += theme.fg("dim", ` in ${duration}`);

				if (expanded) {
					text += "\n" + theme.fg("dim", `  Path: ${details.outputPath}`);
					if (details.jobId) text += "\n" + theme.fg("dim", `  Job: ${details.jobId}`);
					if (details.model) text += "\n" + theme.fg("dim", `  Model: Hunyuan3D v${details.model}`);
					if (details.generateType) text += "\n" + theme.fg("dim", `  Type: ${details.generateType}`);
					if (details.enablePBR) text += "\n" + theme.fg("dim", `  PBR: enabled`);
					if (details.faceCount) text += "\n" + theme.fg("dim", `  Faces: ${details.faceCount.toLocaleString()}`);
					if (details.inputMode === "text" && details.prompt) {
						const p = details.prompt.length > 80 ? details.prompt.slice(0, 77) + "..." : details.prompt;
						text += "\n" + theme.fg("dim", `  Prompt: "${p}"`);
					}
					if (details.allFiles && details.allFiles.length > 1) {
						text += "\n" + theme.fg("dim", `  All outputs:`);
						for (const f of details.allFiles) {
							text += "\n" + theme.fg("dim", `    ${f.FileType}: ${f.Url}`);
						}
					}
				}

				return new Text(text, 0, 0);
			}

			// Fallback
			const content = result.content[0];
			return new Text(content?.type === "text" ? content.text : "Done", 0, 0);
		},
	});
}
