/**
 * optimize_3d — Optimize 3D models (GLB/glTF) for web delivery
 *
 * Uses gltf-transform to run a production-grade optimization pipeline:
 *   1. Cleanup: dedup, prune, flatten (lossless)
 *   2. Mesh: join, weld, reorder, instance (lossless)
 *   3. Vertex: quantize 16-bit + Draco Edgebreaker (near-lossless)
 *   4. Texture: resize + WebP compression via sharp (big win, ~95% reduction)
 *   5. [Optional] Simplify: reduce polygon count (lossy)
 *
 * Typical result: 42MB raw GLB → 2-5MB optimized, visually near-identical.
 *
 * Usage:
 *   optimize_3d(input: "model.glb")                           → model-optimized.glb
 *   optimize_3d(input: "model.glb", textureSize: 2048)        → higher detail textures
 *   optimize_3d(input: "model.glb", simplify: true)           → also reduce polygons
 */

import { stat, writeFile, mkdir } from "node:fs/promises";
import { resolve, basename, dirname, join as pathJoin } from "node:path";

import { NodeIO, Document } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import {
	dedup,
	prune,
	flatten,
	join,
	weld,
	reorder,
	instance,
	quantize,
	draco,
	textureCompress,
	simplify,
} from "@gltf-transform/functions";
import { MeshoptEncoder, MeshoptSimplifier } from "meshoptimizer";
import draco3d from "draco3dgltf";
import sharp from "sharp";

import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

// ─── Types ───────────────────────────────────────────────────────────────────

interface OptimizeDetails {
	inputPath?: string;
	outputPath?: string;
	inputSize?: number;
	outputSize?: number;
	reduction?: string;
	textureSize?: number;
	textureFormat?: string;
	compression?: string;
	simplified?: boolean;
	maxFaces?: number;
	faces?: { before: number; after: number };
	elapsed?: number;
	phase?: string;
	error?: string;
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

function reductionPercent(before: number, after: number): string {
	if (before === 0) return "0%";
	return ((1 - after / before) * 100).toFixed(1) + "%";
}

function resolveOutputPath(inputPath: string, outputParam?: string): string {
	if (outputParam) return outputParam;
	const dir = dirname(inputPath);
	const name = basename(inputPath).replace(/\.(glb|gltf)$/i, "");
	return pathJoin(dir, `${name}-optimized.glb`);
}

function getTotalFaces(document: Document): number {
	let total = 0;
	for (const mesh of document.getRoot().listMeshes()) {
		for (const prim of mesh.listPrimitives()) {
			const indices = prim.getIndices();
			if (indices) {
				total += indices.getCount() / 3;
			} else {
				// Non-indexed geometry: count vertices / 3
				const pos = prim.getAttribute("POSITION");
				if (pos) total += pos.getCount() / 3;
			}
		}
	}
	return Math.round(total);
}

// ─── Pipeline ────────────────────────────────────────────────────────────────

interface PipelineOptions {
	textureSize: number;
	doSimplify: boolean;
	maxFaces: number;
}

async function optimizeGlb(
	inputPath: string,
	outputPath: string,
	options: PipelineOptions,
	signal: AbortSignal | undefined,
	onProgress: (phase: string) => void,
): Promise<{
	inputSize: number;
	outputSize: number;
	facesBefore: number;
	facesAfter: number;
}> {
	// ── Init encoders ──
	onProgress("Initializing encoders...");
	await MeshoptEncoder.ready;
	const [dracoEncoder, dracoDecoder] = await Promise.all([
		draco3d.createEncoderModule(),
		draco3d.createDecoderModule(),
	]);

	if (signal?.aborted) throw new Error("Cancelled");

	// ── Setup IO ──
	const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
		"draco3d.encoder": dracoEncoder,
		"draco3d.decoder": dracoDecoder,
	});

	// ── Read ──
	onProgress("Reading GLB file...");
	const document = await io.read(inputPath);
	const inputStat = await stat(inputPath);
	const inputSize = inputStat.size;

	if (signal?.aborted) throw new Error("Cancelled");

	// Count faces before
	const facesBefore = getTotalFaces(document);

	// ── Build transforms ──
	const transforms: ReturnType<typeof dedup>[] = [];

	// Phase 1: Cleanup (lossless)
	onProgress("Phase 1/4: Cleanup (dedup, prune, flatten)...");
	transforms.push(dedup(), prune(), flatten());

	// Phase 2: Mesh optimization (lossless)
	onProgress("Phase 2/4: Mesh optimization (join, weld, reorder, instance)...");
	transforms.push(
		join(),
		weld(),
		reorder({ encoder: MeshoptEncoder }),
		instance(),
	);

	// Phase 3: Vertex compression
	onProgress("Phase 3/4: Vertex compression (quantize + Draco)...");
	transforms.push(
		quantize(),
		draco({ method: "edgebreaker" }),
	);

	// Phase 4: Texture compression (biggest win)
	const texSize = options.textureSize;
	onProgress(`Phase 4/4: Texture compression (WebP, ${texSize}×${texSize})...`);
	transforms.push(
		textureCompress({
			encoder: sharp,
			targetFormat: "webp",
			resize: [texSize, texSize],
		}),
	);

	// Optional: Mesh simplification
	if (options.doSimplify) {
		await MeshoptSimplifier.ready;
		const targetRatio = facesBefore > 0 ? Math.min(options.maxFaces / facesBefore, 1) : 1;
		onProgress(`Simplifying mesh (target: ${options.maxFaces.toLocaleString()} faces)...`);
		transforms.push(
			simplify({ simplifier: MeshoptSimplifier, ratio: targetRatio }),
		);
	}

	// ── Execute ──
	onProgress("Running optimization pipeline...");
	await document.transform(...transforms);

	if (signal?.aborted) throw new Error("Cancelled");

	// Count faces after
	const facesAfter = getTotalFaces(document);

	// ── Write ──
	onProgress("Writing optimized GLB...");
	const glb = await io.writeBinary(document);
	await mkdir(dirname(outputPath), { recursive: true });
	await writeFile(outputPath, Buffer.from(glb));

	return {
		inputSize,
		outputSize: glb.byteLength,
		facesBefore,
		facesAfter,
	};
}

// ─── Extension Entry Point ───────────────────────────────────────────────────

export default function optimize3dExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "optimize_3d",
		label: "Optimize 3D",
		description: `Optimize a 3D model (GLB/glTF) for web delivery. Dramatically reduces file size while preserving visual quality.

Pipeline: mesh cleanup → vertex quantization → Draco compression → texture WebP compression.
Typical result: 42MB → 2-5MB (-90%+), visually near-identical.

Parameters:
- input (required): Path to GLB/glTF file
- output (optional): Output path. Default: {input}-optimized.glb
- textureSize (optional): Max texture resolution. Default: 1024. Use 2048 for hero assets, 512 for background objects.
- simplify (optional): Enable polygon reduction. Default: false. Only when smaller file size is needed.
- maxFaces (optional): Target face count when simplify=true. Default: 50000.

The output GLB works with Three.js (needs DRACOLoader for Draco-compressed meshes), React Three Fiber, Babylon.js, Unity, Unreal Engine, Blender, etc.`,

		parameters: Type.Object({
			input: Type.String({
				description: "Path to input GLB/glTF file",
			}),
			output: Type.Optional(
				Type.String({
					description: "Output path (default: {input}-optimized.glb)",
				}),
			),
			textureSize: Type.Optional(
				Type.Integer({
					description: "Max texture resolution. Default: 1024. Use 2048 for detail, 512 for lightweight.",
					minimum: 256,
					maximum: 4096,
				}),
			),
			simplify: Type.Optional(
				Type.Boolean({
					description: "Enable mesh simplification (reduce polygon count). Default: false",
				}),
			),
			maxFaces: Type.Optional(
				Type.Integer({
					description: "Target face count when simplify=true. Default: 50000",
					minimum: 1000,
					maximum: 1500000,
				}),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const startTime = Date.now();
			const details: OptimizeDetails = {};

			try {
				// ── Validate input ──
				const inputPath = resolve(ctx.cwd, params.input.replace(/^@/, ""));
				details.inputPath = inputPath;

				try {
					const s = await stat(inputPath);
					if (!s.isFile()) throw new Error("Not a file");
				} catch (err: any) {
					if (err.code === "ENOENT") {
						return {
							content: [{ type: "text", text: `Error: File not found: ${inputPath}` }],
							isError: true,
							details,
						};
					}
					throw err;
				}

				if (!/\.(glb|gltf)$/i.test(inputPath)) {
					return {
						content: [{ type: "text", text: `Error: Expected .glb or .gltf file, got: ${basename(inputPath)}` }],
						isError: true,
						details,
					};
				}

				// ── Resolve options ──
				const outputPath = resolve(ctx.cwd, resolveOutputPath(inputPath, params.output));
				const textureSize = params.textureSize ?? 1024;
				const doSimplify = params.simplify ?? false;
				const maxFaces = params.maxFaces ?? 50000;

				details.outputPath = outputPath;
				details.textureSize = textureSize;
				details.textureFormat = "webp";
				details.compression = "draco";
				details.simplified = doSimplify;
				if (doSimplify) details.maxFaces = maxFaces;

				// ── Run pipeline ──
				const result = await optimizeGlb(
					inputPath,
					outputPath,
					{ textureSize, doSimplify, maxFaces },
					signal,
					(phase) => {
						details.phase = phase;
						details.elapsed = Math.round((Date.now() - startTime) / 1000);
						onUpdate?.({
							content: [{ type: "text", text: phase }],
							details: { ...details },
						});
					},
				);

				// ── Build result ──
				const elapsed = Math.round((Date.now() - startTime) / 1000);
				const reduction = reductionPercent(result.inputSize, result.outputSize);

				details.inputSize = result.inputSize;
				details.outputSize = result.outputSize;
				details.reduction = reduction;
				details.elapsed = elapsed;
				details.phase = "done";
				details.faces = { before: result.facesBefore, after: result.facesAfter };

				const summary = [
					`Optimized 3D model saved to: ${outputPath}`,
					``,
					`Original: ${formatBytes(result.inputSize)} → Optimized: ${formatBytes(result.outputSize)} (-${reduction})`,
					`Faces: ${result.facesBefore.toLocaleString()} → ${result.facesAfter.toLocaleString()}${result.facesBefore !== result.facesAfter ? ` (-${reductionPercent(result.facesBefore, result.facesAfter)})` : " (unchanged)"}`,
					`Textures: WebP, max ${textureSize}×${textureSize}`,
					`Compression: Draco (Edgebreaker)`,
					`Time: ${formatDuration(elapsed)}`,
				];
				if (doSimplify) {
					summary.push(`Simplification: enabled (target ${maxFaces.toLocaleString()} faces)`);
				}

				return {
					content: [{ type: "text", text: summary.join("\n") }],
					details,
				};
			} catch (err: any) {
				const elapsed = Math.round((Date.now() - startTime) / 1000);
				details.elapsed = elapsed;
				details.phase = "error";
				details.error = err.message || String(err);

				return {
					content: [{ type: "text", text: `Error optimizing 3D model: ${details.error}` }],
					isError: true,
					details,
				};
			}
		},

		// ── Custom TUI Rendering ──

		renderCall(args: Record<string, unknown>, theme: Theme) {
			let text = theme.fg("toolTitle", theme.bold("🗜️ optimize_3d "));

			if (args.input) {
				text += theme.fg("accent", `"${basename(String(args.input))}"`);
			}

			const meta: string[] = [];
			const texSize = args.textureSize ?? 1024;
			meta.push(`${texSize}px`);
			meta.push("WebP");
			meta.push("Draco");
			if (args.simplify) {
				meta.push(`simplify→${((args.maxFaces as number) ?? 50000).toLocaleString()}`);
			}

			text += theme.fg("muted", ` (${meta.join(", ")})`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as OptimizeDetails | undefined;

			// Streaming / in-progress
			if (isPartial) {
				const phase = details?.phase || "Starting...";
				const elapsed = details?.elapsed ? ` (${formatDuration(details.elapsed)})` : "";
				return new Text(theme.fg("warning", `⏳ ${phase}${elapsed}`), 0, 0);
			}

			// Error
			if (result.isError || details?.phase === "error") {
				const msg = details?.error || (result.content[0]?.type === "text" ? result.content[0].text : "Unknown error");
				return new Text(theme.fg("error", `✗ ${msg}`), 0, 0);
			}

			// Success
			if (details?.outputPath && details.inputSize && details.outputSize) {
				const fileName = basename(details.outputPath);
				const inputStr = formatBytes(details.inputSize);
				const outputStr = formatBytes(details.outputSize);
				const duration = details.elapsed ? formatDuration(details.elapsed) : "";

				let text = theme.fg("success", "✓ ") + theme.fg("text", fileName);
				text += theme.fg("muted", ` ${inputStr} → ${outputStr}`);
				if (details.reduction) text += theme.fg("success", ` (-${details.reduction})`);
				if (duration) text += theme.fg("dim", ` in ${duration}`);

				if (expanded) {
					text += "\n" + theme.fg("dim", `  Path: ${details.outputPath}`);
					text += "\n" + theme.fg("dim", `  Textures: ${details.textureFormat?.toUpperCase()}, max ${details.textureSize}×${details.textureSize}`);
					text += "\n" + theme.fg("dim", `  Compression: ${details.compression}`);
					if (details.faces) {
						const facesStr = details.faces.before !== details.faces.after
							? `${details.faces.before.toLocaleString()} → ${details.faces.after.toLocaleString()}`
							: `${details.faces.before.toLocaleString()} (unchanged)`;
						text += "\n" + theme.fg("dim", `  Faces: ${facesStr}`);
					}
					if (details.simplified) {
						text += "\n" + theme.fg("dim", `  Simplified: yes (target ${details.maxFaces?.toLocaleString()} faces)`);
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
