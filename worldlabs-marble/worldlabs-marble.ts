/**
 * World Labs Marble Extension — Generate 3D worlds from text or image
 *
 * Uses World Labs Marble API to create explorable 3D environments.
 * Zero npm dependencies — uses Node.js built-in fetch and fs.
 *
 * Output per world (directory):
 *   - panorama.png       — 360° equirectangular (2560×1280), use as Three.js env map
 *   - collider-mesh.glb  — Mesh (100-200K tris), load with GLTFLoader
 *   - splat-full.spz     — Gaussian splat 2M, render with Spark (sparkjs.dev)
 *   - splat-500k.spz     — Gaussian splat 500K
 *   - splat-100k.spz     — Gaussian splat 100K
 *   - thumbnail.png      — Preview image
 *   - world.json         — Metadata, world_id, marble URL, coordinate system note
 *
 * Prerequisites:
 *   1. World Labs Platform account (https://platform.worldlabs.ai)
 *   2. Purchase API credits at platform.worldlabs.ai/billing ($5 min = 6,250 credits)
 *      ⚠️ API credits are SEPARATE from Marble web app credits — they cannot be shared.
 *   3. Generate API key at platform.worldlabs.ai/api-keys
 *   4. Set environment variable:
 *      export WLT_API_KEY="wlt_..."
 *
 * Environment variables:
 *   WLT_API_KEY          - (required) World Labs API key
 *   WORLDLABS_OUTPUT_DIR - Default output dir relative to cwd (default: assets/worlds)
 */

import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { join, resolve, basename, extname } from "node:path";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

// ─── Constants ───────────────────────────────────────────────────────────────

const API_BASE = "https://api.worldlabs.ai/marble/v1";
const DEFAULT_OUTPUT_DIR = "assets/worlds";
const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_ATTEMPTS = 120; // 120 × 5s = 10 minutes
const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20MB for base64 inline
const MODEL_MAP = {
	mini: "Marble 0.1-mini",
	plus: "Marble 0.1-plus",
} as const;

// ─── Types ───────────────────────────────────────────────────────────────────

interface WorldAssets {
	caption?: string;
	thumbnail_url?: string;
	imagery?: { pano_url?: string };
	mesh?: { collider_mesh_url?: string };
	splats?: { spz_urls?: Record<string, string> };
}

interface WorldData {
	id?: string;
	world_id?: string;
	display_name?: string;
	world_marble_url?: string;
	assets?: WorldAssets;
	model?: string;
	world_prompt?: Record<string, unknown>;
	created_at?: string;
	updated_at?: string;
}

interface OperationResponse {
	operation_id: string;
	done: boolean;
	error?: { code?: number; message?: string } | null;
	metadata?: {
		progress?: { status?: string; description?: string };
		world_id?: string;
	} | null;
	response?: WorldData | null;
}

interface GenerateWorldDetails {
	operationId?: string;
	worldId?: string;
	marbleUrl?: string;
	status?: string;
	elapsed?: number;
	outputDir?: string;
	model?: string;
	inputMode?: "text" | "image-url" | "image-local";
	prompt?: string;
	downloadedFiles?: Record<string, string>;
	fileSizes?: Record<string, number>;
	caption?: string;
	error?: string;
}

// ─── API Client ──────────────────────────────────────────────────────────────

function getApiKey(): string {
	const key = process.env.WLT_API_KEY;
	if (!key) {
		throw new Error(
			"Missing World Labs API key. Set WLT_API_KEY environment variable.\n" +
				"Get your key at: https://platform.worldlabs.ai/api-keys\n" +
				"Purchase API credits at: https://platform.worldlabs.ai/billing\n" +
				"⚠️ API credits are separate from Marble web app (marble.worldlabs.ai) credits.",
		);
	}
	return key;
}

async function apiFetch<T>(path: string, options: RequestInit = {}, signal?: AbortSignal): Promise<T> {
	const apiKey = getApiKey();
	const url = `${API_BASE}/${path}`;

	const response = await fetch(url, {
		...options,
		headers: {
			"WLT-Api-Key": apiKey,
			"Content-Type": "application/json",
			...options.headers,
		},
		signal,
	});

	const body = await response.json();

	if (!response.ok) {
		const msg = (body as any)?.message || (body as any)?.detail || JSON.stringify(body);
		throw new Error(`API error (HTTP ${response.status}): ${msg}`);
	}

	return body as T;
}

// ─── World Prompt Builder ────────────────────────────────────────────────────

async function buildWorldPrompt(
	params: {
		prompt?: string;
		imagePath?: string;
		imageUrl?: string;
		textGuide?: string;
		isPano?: boolean;
	},
	cwd: string,
): Promise<Record<string, unknown>> {
	// Text-to-world
	if (params.prompt) {
		return {
			type: "text",
			text_prompt: params.prompt,
			disable_recaption: false,
		};
	}

	// Image-to-world from URL
	if (params.imageUrl) {
		return {
			type: "image",
			image_prompt: {
				source: "uri",
				uri: params.imageUrl,
			},
			text_prompt: params.textGuide || null,
			is_pano: params.isPano || false,
			disable_recaption: false,
		};
	}

	// Image-to-world from local file (base64 inline)
	if (params.imagePath) {
		const fullPath = resolve(cwd, params.imagePath);

		// Validate file exists and size
		try {
			const stats = await stat(fullPath);
			if (stats.size > MAX_IMAGE_SIZE) {
				throw new Error(
					`Image too large (${formatBytes(stats.size)}). Maximum for inline encoding: ${formatBytes(MAX_IMAGE_SIZE)}.`,
				);
			}
		} catch (err: any) {
			if (err.code === "ENOENT") {
				throw new Error(`Image file not found: ${fullPath}`);
			}
			throw err;
		}

		const buffer = await readFile(fullPath);
		const ext = extname(fullPath).slice(1).toLowerCase() || "jpg";

		return {
			type: "image",
			image_prompt: {
				source: "data_base64",
				data_base64: buffer.toString("base64"),
				extension: ext,
			},
			text_prompt: params.textGuide || null,
			is_pano: params.isPano || false,
			disable_recaption: false,
		};
	}

	throw new Error("No input provided");
}

// ─── Generate + Poll ─────────────────────────────────────────────────────────

async function submitGeneration(
	worldPrompt: Record<string, unknown>,
	model: string,
	displayName?: string,
	seed?: number,
	signal?: AbortSignal,
): Promise<string> {
	const body: Record<string, unknown> = {
		world_prompt: worldPrompt,
		model,
	};
	if (displayName) body.display_name = displayName;
	if (seed !== undefined && seed >= 0) body.seed = seed;

	const result = await apiFetch<OperationResponse>("worlds:generate", {
		method: "POST",
		body: JSON.stringify(body),
	}, signal);

	if (!result.operation_id) {
		throw new Error("API returned no operation_id: " + JSON.stringify(result));
	}

	return result.operation_id;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(new Error("Cancelled"));
			},
			{ once: true },
		);
	});
}

async function pollOperation(
	operationId: string,
	signal: AbortSignal | undefined,
	onProgress: (msg: string, elapsed: number, worldId?: string) => void,
): Promise<OperationResponse> {
	const startTime = Date.now();

	for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
		if (signal?.aborted) throw new Error("Cancelled");

		const op = await apiFetch<OperationResponse>(`operations/${operationId}`, {}, signal);

		if (op.done) {
			if (op.error) {
				const code = op.error.code || "unknown";
				const msg = op.error.message || "Unknown error";
				throw new Error(`Generation failed [${code}]: ${msg}`);
			}
			return op;
		}

		const elapsed = Math.round((Date.now() - startTime) / 1000);
		const progress = op.metadata?.progress;
		const desc = progress?.description || "Generating world...";
		const worldId = op.metadata?.world_id;
		onProgress(desc, elapsed, worldId);

		await sleep(POLL_INTERVAL_MS, signal);
	}

	throw new Error("Generation timed out after 10 minutes");
}

// ─── Fetch Full World ────────────────────────────────────────────────────────

function extractWorldId(op: OperationResponse): string {
	const resp = op.response;
	const worldId = resp?.world_id || resp?.id || op.metadata?.world_id;
	if (!worldId) throw new Error("No world_id found in response");
	return worldId;
}

async function fetchFullWorld(worldId: string, signal?: AbortSignal): Promise<WorldData> {
	const result = await apiFetch<Record<string, unknown>>(`worlds/${worldId}`, {}, signal);
	// API may wrap in { world: {...} } or return directly
	if (result.world && typeof result.world === "object") {
		return result.world as WorldData;
	}
	// If response itself looks like a world (has id or assets)
	if (result.id || result.assets) {
		return result as unknown as WorldData;
	}
	return result as unknown as WorldData;
}

// ─── Download Assets ─────────────────────────────────────────────────────────

async function downloadFile(url: string, outputPath: string, signal?: AbortSignal): Promise<number> {
	const response = await fetch(url, { signal });
	if (!response.ok) {
		throw new Error(`Download failed (HTTP ${response.status}): ${url}`);
	}
	const buffer = Buffer.from(await response.arrayBuffer());
	await writeFile(outputPath, buffer);
	return buffer.byteLength;
}

interface DownloadTask {
	name: string;
	url: string;
	file: string;
}

async function downloadAssets(
	assets: WorldAssets,
	outputDir: string,
	signal?: AbortSignal,
): Promise<{ files: Record<string, string>; sizes: Record<string, number> }> {
	await mkdir(outputDir, { recursive: true });

	const tasks: DownloadTask[] = [];

	// Panorama
	if (assets.imagery?.pano_url) {
		tasks.push({ name: "panorama", url: assets.imagery.pano_url, file: "panorama.png" });
	}

	// Collider mesh
	if (assets.mesh?.collider_mesh_url) {
		tasks.push({ name: "mesh", url: assets.mesh.collider_mesh_url, file: "collider-mesh.glb" });
	}

	// Splats (3 resolutions)
	const spz = assets.splats?.spz_urls;
	if (spz) {
		if (spz.full_res) tasks.push({ name: "splat-full", url: spz.full_res, file: "splat-full.spz" });
		if (spz["500k"]) tasks.push({ name: "splat-500k", url: spz["500k"], file: "splat-500k.spz" });
		if (spz["100k"]) tasks.push({ name: "splat-100k", url: spz["100k"], file: "splat-100k.spz" });
	}

	// Thumbnail
	if (assets.thumbnail_url) {
		tasks.push({ name: "thumbnail", url: assets.thumbnail_url, file: "thumbnail.png" });
	}

	const files: Record<string, string> = {};
	const sizes: Record<string, number> = {};

	// Download all in parallel, tolerate individual failures
	const results = await Promise.allSettled(
		tasks.map(async (task) => {
			const filePath = join(outputDir, task.file);
			const size = await downloadFile(task.url, filePath, signal);
			return { name: task.name, file: task.file, size };
		}),
	);

	for (const result of results) {
		if (result.status === "fulfilled") {
			files[result.value.name] = result.value.file;
			sizes[result.value.name] = result.value.size;
		}
		// Failed downloads silently skipped — reported in output
	}

	return { files, sizes };
}

// ─── Write Metadata ──────────────────────────────────────────────────────────

async function writeWorldJson(
	outputDir: string,
	worldId: string,
	world: WorldData,
	downloadedFiles: Record<string, string>,
): Promise<void> {
	const metadata = {
		world_id: worldId,
		marble_url: world.world_marble_url || `https://marble.worldlabs.ai/world/${worldId}`,
		caption: world.assets?.caption || null,
		model: world.model || null,
		display_name: world.display_name || null,
		prompt: world.world_prompt || null,
		assets: {
			panorama: downloadedFiles.panorama || null,
			collider_mesh: downloadedFiles.mesh || null,
			splats: {
				full: downloadedFiles["splat-full"] || null,
				"500k": downloadedFiles["splat-500k"] || null,
				"100k": downloadedFiles["splat-100k"] || null,
			},
			thumbnail: downloadedFiles.thumbnail || null,
		},
		coordinate_system: "opencv",
		coordinate_note:
			"OpenCV coords (+x left, +y down, +z forward). For Three.js (OpenGL), apply mesh.scale.set(1, -1, -1).",
		generated_at: new Date().toISOString(),
	};

	await writeFile(join(outputDir, "world.json"), JSON.stringify(metadata, null, 2));
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDuration(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	const m = Math.floor(seconds / 60);
	const s = seconds % 60;
	return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function resolveOutputDir(cwd: string, outputDir?: string, displayName?: string): string {
	if (outputDir) return resolve(cwd, outputDir);

	const baseDir = resolve(cwd, process.env.WORLDLABS_OUTPUT_DIR || DEFAULT_OUTPUT_DIR);
	const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

	let slug = date;
	if (displayName) {
		const clean = displayName
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 40);
		if (clean) slug = `${date}-${clean}`;
	}

	// Append short random suffix to avoid collisions
	const suffix = Math.random().toString(36).slice(2, 6);
	return join(baseDir, `${slug}-${suffix}`);
}

function estimateCredits(model: string, inputType: "text" | "image" | "image-pano"): number {
	const isPlus = model === MODEL_MAP.plus;
	const worldGen = isPlus ? 1500 : 150;
	const panoGen = inputType === "image-pano" ? 0 : 80;
	return worldGen + panoGen;
}

// ─── Extension Entry Point ───────────────────────────────────────────────────

export default function worldLabsMarbleExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "generate_world",
		label: "Generate World",
		description: `Generate a 3D world (environment) from a text description or reference image using World Labs Marble API. Creates explorable 3D environments with multiple output assets.

Input modes (provide exactly one):
- Text-to-world: Set "prompt" with a description of the environment
- Image-to-world: Set "imagePath" (local file) or "imageUrl" (remote URL) pointing to a reference image

Tips for best results:
- Describe the environment/scene, not individual objects (e.g., "a cozy library" not "a bookshelf")
- Use "mini" model for fast iteration (30-45s), "plus" for production quality (~5min)
- Set isPano=true if your input image is already a 360° panorama (saves credits)
- Use textGuide with image input to steer the generation

Output: Directory with panorama (env map), collider mesh (GLB), Gaussian splats (SPZ), and metadata.
⚠️ Coordinate system: OpenCV. For Three.js, apply mesh.scale.set(1, -1, -1) to the collider mesh.
⚠️ API credits required — purchase at platform.worldlabs.ai (separate from Marble web credits).
Requires WLT_API_KEY environment variable.`,

		parameters: Type.Object({
			prompt: Type.Optional(
				Type.String({ description: "Text description of the world to generate (for text-to-world mode)" }),
			),
			imagePath: Type.Optional(
				Type.String({ description: "Local path to a reference image (for image-to-world mode)" }),
			),
			imageUrl: Type.Optional(
				Type.String({ description: "URL of a reference image (for image-to-world mode)" }),
			),
			textGuide: Type.Optional(
				Type.String({ description: "Additional text guidance when using image input. Auto-generated from image if omitted." }),
			),
			model: Type.Optional(
				StringEnum(["mini", "plus"] as const, {
					description: "Model: mini (draft, ~230 credits, 30-45s) or plus (standard, ~1580 credits, ~5min). Default: mini",
				}),
			),
			isPano: Type.Optional(
				Type.Boolean({ description: "Set true if the input image is already a 360° panorama. Default: false" }),
			),
			outputDir: Type.Optional(
				Type.String({ description: "Output directory for world assets. Default: assets/worlds/{date}-{name}/" }),
			),
			displayName: Type.Optional(
				Type.String({ description: "Display name for the world" }),
			),
			seed: Type.Optional(
				Type.Integer({ description: "Random seed for reproducible generation (>= 0)", minimum: 0 }),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const startTime = Date.now();
			const details: GenerateWorldDetails = {};

			try {
				// ── Validate input ──────────────────────────────────────────
				const hasPrompt = !!params.prompt;
				const hasImagePath = !!params.imagePath;
				const hasImageUrl = !!params.imageUrl;
				const inputCount = [hasPrompt, hasImagePath, hasImageUrl].filter(Boolean).length;

				if (inputCount === 0) {
					return {
						content: [{ type: "text", text: "Error: Provide either 'prompt' (text-to-world), 'imagePath' (local image), or 'imageUrl' (remote image)." }],
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

				// ── Resolve config ──────────────────────────────────────────
				const modelKey = params.model || "mini";
				const modelName = MODEL_MAP[modelKey];
				details.model = modelKey;

				if (hasPrompt) {
					details.inputMode = "text";
					details.prompt = params.prompt;
				} else if (hasImageUrl) {
					details.inputMode = "image-url";
					details.prompt = params.imageUrl;
				} else {
					details.inputMode = "image-local";
					details.prompt = params.imagePath;
				}

				// ── Build world prompt ──────────────────────────────────────
				onUpdate?.({
					content: [{ type: "text", text: hasImagePath ? "Reading image file..." : "Preparing request..." }],
					details: { ...details },
				});

				const worldPrompt = await buildWorldPrompt(
					{
						prompt: params.prompt,
						imagePath: params.imagePath,
						imageUrl: params.imageUrl,
						textGuide: params.textGuide,
						isPano: params.isPano,
					},
					ctx.cwd,
				);

				// ── Submit generation ───────────────────────────────────────
				onUpdate?.({
					content: [{ type: "text", text: "Submitting world generation..." }],
					details: { ...details },
				});

				const operationId = await submitGeneration(
					worldPrompt,
					modelName,
					params.displayName,
					params.seed,
					signal,
				);
				details.operationId = operationId;

				onUpdate?.({
					content: [{ type: "text", text: `Submitted (${operationId.slice(0, 8)}...). Generating world...` }],
					details: { ...details },
				});

				// ── Poll until done ─────────────────────────────────────────
				const operation = await pollOperation(operationId, signal, (desc, elapsed, worldId) => {
					details.status = desc;
					details.elapsed = elapsed;
					if (worldId) details.worldId = worldId;
					onUpdate?.({
						content: [{ type: "text", text: `${desc} (${elapsed}s)` }],
						details: { ...details },
					});
				});

				// ── Extract world ID ────────────────────────────────────────
				const worldId = extractWorldId(operation);
				details.worldId = worldId;

				// ── Fetch full world data ───────────────────────────────────
				onUpdate?.({
					content: [{ type: "text", text: "Fetching world details..." }],
					details: { ...details },
				});

				let fullWorld: WorldData;
				try {
					fullWorld = await fetchFullWorld(worldId, signal);
				} catch {
					// Fallback to operation response if GET /worlds fails
					fullWorld = operation.response || {} as WorldData;
				}

				// Merge: prefer fullWorld data, fallback to operation response
				const opResp = operation.response || {} as WorldData;
				const marbleUrl =
					fullWorld?.world_marble_url ||
					opResp?.world_marble_url ||
					`https://marble.worldlabs.ai/world/${worldId}`;
				details.marbleUrl = marbleUrl;

				const assets = fullWorld?.assets || opResp?.assets;
				if (!assets) {
					throw new Error("No assets found in response. World ID: " + worldId);
				}

				details.caption = assets.caption || undefined;

				// ── Resolve output dir ──────────────────────────────────────
				const outputDir = resolveOutputDir(
					ctx.cwd,
					params.outputDir,
					params.displayName || fullWorld?.display_name || opResp?.display_name,
				);
				details.outputDir = outputDir;

				// ── Download assets ─────────────────────────────────────────
				onUpdate?.({
					content: [{ type: "text", text: "Downloading world assets..." }],
					details: { ...details },
				});

				const { files, sizes } = await downloadAssets(assets, outputDir, signal);
				details.downloadedFiles = files;
				details.fileSizes = sizes;

				// ── Write world.json ────────────────────────────────────────
				await writeWorldJson(outputDir, worldId, fullWorld || opResp, files);

				// ── Build result ────────────────────────────────────────────
				const elapsed = Math.round((Date.now() - startTime) / 1000);
				details.elapsed = elapsed;
				details.status = "done";

				const inputType = params.isPano ? "image-pano" : (hasPrompt ? "text" : "image");
				const credits = estimateCredits(modelName, inputType);

				const fileCount = Object.keys(files).length;
				const totalSize = Object.values(sizes).reduce((a, b) => a + b, 0);

				const summary: string[] = [];
				const displayNameStr = params.displayName || fullWorld?.display_name || opResp?.display_name || "World";
				summary.push(`Generated 3D world: ${displayNameStr}`);
				summary.push(`Output: ${outputDir}`);
				summary.push(`Model: ${modelName} | Credits: ~${credits} | Time: ${formatDuration(elapsed)}`);
				summary.push(`View online: ${marbleUrl}`);
				summary.push("");

				summary.push(`Downloaded ${fileCount} assets (${formatBytes(totalSize)}):`);
				if (files.panorama) summary.push(`  panorama.png      — 360° environment map (2560×1280) [${formatBytes(sizes.panorama || 0)}]`);
				if (files.mesh) summary.push(`  collider-mesh.glb — 3D mesh for Three.js (100-200K tris) [${formatBytes(sizes.mesh || 0)}]`);
				if (files["splat-full"]) summary.push(`  splat-full.spz    — Gaussian splat 2M [${formatBytes(sizes["splat-full"] || 0)}]`);
				if (files["splat-500k"]) summary.push(`  splat-500k.spz    — Gaussian splat 500K [${formatBytes(sizes["splat-500k"] || 0)}]`);
				if (files["splat-100k"]) summary.push(`  splat-100k.spz    — Gaussian splat 100K [${formatBytes(sizes["splat-100k"] || 0)}]`);
				if (files.thumbnail) summary.push(`  thumbnail.png     — Preview [${formatBytes(sizes.thumbnail || 0)}]`);
				summary.push(`  world.json        — Metadata`);

				summary.push("");
				summary.push("⚠️ Coordinate system: OpenCV. For Three.js, apply mesh.scale.set(1, -1, -1)");
				summary.push("");
				summary.push("Three.js usage:");
				summary.push("  Mesh: new GLTFLoader().load('collider-mesh.glb')");
				summary.push("  Env:  scene.background = new TextureLoader().load('panorama.png')");
				summary.push("  Splat: use Spark (sparkjs.dev) for Gaussian splat rendering");

				if (assets.caption) {
					summary.push("");
					summary.push(`Caption: ${assets.caption}`);
				}

				return {
					content: [{ type: "text", text: summary.join("\n") }],
					details,
				};
			} catch (err: any) {
				const elapsed = Math.round((Date.now() - startTime) / 1000);
				details.elapsed = elapsed;
				details.status = "error";
				details.error = err.message || String(err);

				return {
					content: [{ type: "text", text: `Error generating world: ${details.error}` }],
					isError: true,
					details,
				};
			}
		},

		// ── Custom TUI Rendering ────────────────────────────────────────────

		renderCall(args: Record<string, unknown>, theme: Theme) {
			let text = theme.fg("toolTitle", theme.bold("🌍 generate_world "));

			if (args.prompt) {
				const prompt = String(args.prompt);
				const truncated = prompt.length > 55 ? prompt.slice(0, 52) + "..." : prompt;
				text += theme.fg("accent", `"${truncated}"`);
			} else if (args.imagePath) {
				text += theme.fg("accent", `from ${basename(String(args.imagePath))}`);
			} else if (args.imageUrl) {
				const url = String(args.imageUrl);
				const short = url.length > 45 ? url.slice(0, 42) + "..." : url;
				text += theme.fg("accent", `from URL ${short}`);
			}

			const meta: string[] = [];
			const model = args.model || "mini";
			meta.push(String(model));
			if (args.isPano) meta.push("pano");
			if (args.seed !== undefined) meta.push(`seed:${args.seed}`);

			text += theme.fg("muted", ` (${meta.join(", ")})`);

			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as GenerateWorldDetails | undefined;

			// Streaming / in-progress
			if (isPartial) {
				const status = details?.status || "Starting...";
				const elapsed = details?.elapsed ? ` (${formatDuration(details.elapsed)})` : "";
				return new Text(theme.fg("warning", `⏳ ${status}${elapsed}`), 0, 0);
			}

			// Error
			if (result.isError || details?.status === "error") {
				const msg = details?.error || (result.content[0]?.type === "text" ? result.content[0].text : "Unknown error");
				const short = msg.length > 100 ? msg.slice(0, 97) + "..." : msg;
				return new Text(theme.fg("error", `✗ ${short}`), 0, 0);
			}

			// Success
			if (details?.outputDir && details.downloadedFiles) {
				const dirName = basename(details.outputDir);
				const fileCount = Object.keys(details.downloadedFiles).length;
				const duration = details.elapsed ? formatDuration(details.elapsed) : "";
				const totalSize = details.fileSizes
					? Object.values(details.fileSizes).reduce((a, b) => a + b, 0)
					: 0;

				let text = theme.fg("success", "✓ ") + theme.fg("text", `${dirName}/`);
				text += theme.fg("muted", ` — ${fileCount} assets`);
				if (totalSize > 0) text += theme.fg("muted", ` (${formatBytes(totalSize)})`);
				if (duration) text += theme.fg("dim", ` in ${duration}`);

				if (expanded) {
					text += "\n" + theme.fg("dim", `  Path: ${details.outputDir}`);
					if (details.model) {
						const modelLabel = details.model === "plus" ? "Marble 0.1-plus" : "Marble 0.1-mini";
						text += "\n" + theme.fg("dim", `  Model: ${modelLabel}`);
					}
					if (details.marbleUrl) text += "\n" + theme.fg("dim", `  View: ${details.marbleUrl}`);
					if (details.worldId) text += "\n" + theme.fg("dim", `  World: ${details.worldId}`);

					// List files
					const files = details.downloadedFiles;
					const sizes = details.fileSizes || {};
					const fileList = Object.entries(files)
						.map(([name, file]) => {
							const size = sizes[name] ? ` (${formatBytes(sizes[name])})` : "";
							return `${file}${size}`;
						})
						.join(", ");
					if (fileList) text += "\n" + theme.fg("dim", `  Files: ${fileList}`);

					if (details.caption) {
						const cap = details.caption.length > 80 ? details.caption.slice(0, 77) + "..." : details.caption;
						text += "\n" + theme.fg("dim", `  Caption: "${cap}"`);
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
