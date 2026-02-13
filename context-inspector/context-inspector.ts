/**
 * Context Inspector — shows actual context usage + estimated overhead.
 *
 * Widget below editor:
 * - Actual context pressure from ctx.getContextUsage()
 * - Estimated overhead from active extension tools + injected skills section
 *
 * /ctx command:
 * - Toggle extension tools and skills
 * - Persist tool/skill defaults across restarts
 * - Show per-item token estimates (provider-aware approximation)
 *
 * Notes:
 * - Estimates are approximate (chars/4 heuristic), not exact tokenizer counts.
 * - Tool estimation follows the selected model API payload shape as closely as possible.
 * - setActiveTools() affects the next model call; the current streaming turn already
 *   has a tools snapshot.
 * - If an extension overrides a built-in tool name (e.g. "read"), tool origin is
 *   not exposed by the Extension API, so it is treated as built-in.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@mariozechner/pi-coding-agent";
import { getSettingsListTheme } from "@mariozechner/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text, truncateToWidth } from "@mariozechner/pi-tui";

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Core built-ins currently shipped by pi. Used as primary source for classification.
 * Prompt parsing is only used as a secondary fallback for forward compatibility.
 */
const KNOWN_BUILTIN_TOOLS = new Set<string>(["read", "bash", "edit", "write", "grep", "find", "ls"]);
const TOOL_PREFS_VERSION = 1;
const TOOL_PREFS_FILENAME = "context-inspector-tools.json";

interface ToolPrefsFile {
	version: number;
	updatedAt: number;
	toolPrefs: Record<string, boolean>;
	skillPrefs: Record<string, boolean>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function tokensOf(text: string): number {
	return Math.ceil(text.length / 4);
}

function compact(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

function formatPercent(percent: number): string {
	return percent >= 100 ? percent.toFixed(0) : percent.toFixed(1);
}

function expandHomePath(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

function getAgentDirPath(): string {
	const fromEnv = process.env.PI_CODING_AGENT_DIR?.trim();
	if (fromEnv && fromEnv.length > 0) return resolve(expandHomePath(fromEnv));
	return join(homedir(), ".pi", "agent");
}

const TOOL_PREFS_PATH = join(getAgentDirPath(), TOOL_PREFS_FILENAME);

function formatPathForDisplay(path: string): string {
	const home = homedir();
	if (path === home) return "~";
	if (path.startsWith(`${home}/`)) return `~/${path.slice(home.length + 1)}`;
	return path;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function emptyToolPrefsFile(): ToolPrefsFile {
	return {
		version: TOOL_PREFS_VERSION,
		updatedAt: Date.now(),
		toolPrefs: {},
		skillPrefs: {},
	};
}

function parseToolPrefsFile(value: unknown): ToolPrefsFile | undefined {
	const root = asRecord(value);
	const toolPrefsRaw = asRecord(root.toolPrefs);
	const skillPrefsRaw = asRecord(root.skillPrefs);

	const toolPrefs: Record<string, boolean> = {};
	for (const [name, enabled] of Object.entries(toolPrefsRaw)) {
		if (typeof enabled === "boolean") toolPrefs[name] = enabled;
	}

	const skillPrefs: Record<string, boolean> = {};
	for (const [name, enabled] of Object.entries(skillPrefsRaw)) {
		if (typeof enabled === "boolean") skillPrefs[name] = enabled;
	}

	return {
		version: typeof root.version === "number" ? root.version : TOOL_PREFS_VERSION,
		updatedAt: typeof root.updatedAt === "number" ? root.updatedAt : Date.now(),
		toolPrefs,
		skillPrefs,
	};
}

function backupBrokenPrefsFile(): string | undefined {
	const backupPath = `${TOOL_PREFS_PATH}.broken.${Date.now()}`;
	try {
		renameSync(TOOL_PREFS_PATH, backupPath);
		return backupPath;
	} catch {
		return undefined;
	}
}

function loadToolPrefsFile(): { data: ToolPrefsFile; warning?: string } {
	const fallback = emptyToolPrefsFile();
	if (!existsSync(TOOL_PREFS_PATH)) return { data: fallback };

	let raw: string;
	try {
		raw = readFileSync(TOOL_PREFS_PATH, "utf8");
	} catch (error) {
		return {
			data: fallback,
			warning: `Context Inspector: failed to read ${formatPathForDisplay(TOOL_PREFS_PATH)} (${errorMessage(error)}).`,
		};
	}

	try {
		const parsed = parseToolPrefsFile(JSON.parse(raw));
		if (parsed) return { data: parsed };
	} catch (error) {
		const backupPath = backupBrokenPrefsFile();
		if (backupPath) {
			return {
				data: fallback,
				warning: `Context Inspector: invalid prefs file moved to ${formatPathForDisplay(backupPath)} (${errorMessage(error)}).`,
			};
		}
		return {
			data: fallback,
			warning: `Context Inspector: invalid prefs at ${formatPathForDisplay(TOOL_PREFS_PATH)} (${errorMessage(error)}).`,
		};
	}

	return { data: fallback };
}

function saveToolPrefsFile(data: ToolPrefsFile): { ok: true } | { ok: false; error: string } {
	const nextData: ToolPrefsFile = {
		version: TOOL_PREFS_VERSION,
		updatedAt: Date.now(),
		toolPrefs: { ...data.toolPrefs },
		skillPrefs: { ...data.skillPrefs },
	};

	const tempPath = `${TOOL_PREFS_PATH}.tmp.${process.pid}.${Date.now()}`;
	try {
		mkdirSync(dirname(TOOL_PREFS_PATH), { recursive: true });
		writeFileSync(tempPath, `${JSON.stringify(nextData, null, 2)}\n`, "utf8");
		renameSync(tempPath, TOOL_PREFS_PATH);
		data.version = nextData.version;
		data.updatedAt = nextData.updatedAt;
		return { ok: true };
	} catch (error) {
		try {
			if (existsSync(tempPath)) unlinkSync(tempPath);
		} catch {
			// Ignore cleanup errors.
		}
		return {
			ok: false,
			error: `failed writing ${formatPathForDisplay(TOOL_PREFS_PATH)} (${errorMessage(error)})`,
		};
	}
}

function asRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return value as Record<string, unknown>;
}

function schemaOf(tool: ToolInfo): Record<string, unknown> {
	return asRecord(tool.parameters ?? {});
}

function isOpenAIResponsesFamily(api: string | undefined): boolean {
	return api === "openai-responses" || api === "azure-openai-responses" || api === "openai-codex-responses";
}

function isGoogleFamily(api: string | undefined): boolean {
	return api === "google-generative-ai" || api === "google-gemini-cli" || api === "google-vertex";
}

function useGoogleLegacyParameters(api: string | undefined, modelId: string | undefined): boolean {
	return api === "google-gemini-cli" && !!modelId?.startsWith("claude-");
}

/**
 * Serialize one tool definition approximately in the same shape used by the target API.
 */
function serializeToolForApi(tool: ToolInfo, api: string | undefined, modelId: string | undefined): unknown {
	const schema = schemaOf(tool);

	switch (api) {
		case "anthropic-messages": {
			const properties = asRecord(schema.properties);
			const required = Array.isArray(schema.required)
				? schema.required.filter((v): v is string => typeof v === "string")
				: [];
			return {
				name: tool.name,
				description: tool.description,
				input_schema: {
					type: "object",
					properties,
					required,
				},
			};
		}

		case "openai-completions":
			return {
				type: "function",
				function: {
					name: tool.name,
					description: tool.description,
					parameters: schema,
					strict: false,
				},
			};

		case "bedrock-converse-stream":
			return {
				toolSpec: {
					name: tool.name,
					description: tool.description,
					inputSchema: { json: schema },
				},
			};

		default: {
			if (isOpenAIResponsesFamily(api)) {
				return {
					type: "function",
					name: tool.name,
					description: tool.description,
					parameters: schema,
					strict: false,
				};
			}

			if (isGoogleFamily(api)) {
				const useParameters = useGoogleLegacyParameters(api, modelId);
				return {
					name: tool.name,
					description: tool.description,
					...(useParameters ? { parameters: schema } : { parametersJsonSchema: schema }),
				};
			}

			// Generic fallback
			return {
				name: tool.name,
				description: tool.description,
				parameters: schema,
			};
		}
	}
}

/**
 * Serialize the active tool set in API-level wrapper shape.
 */
function serializeToolsForApi(tools: ToolInfo[], api: string | undefined, modelId: string | undefined): unknown {
	if (tools.length === 0) return [];

	if (isGoogleFamily(api)) {
		return [{
			functionDeclarations: tools.map((t) => serializeToolForApi(t, api, modelId)),
		}];
	}

	if (api === "bedrock-converse-stream") {
		return {
			tools: tools.map((t) => serializeToolForApi(t, api, modelId)),
		};
	}

	return tools.map((t) => serializeToolForApi(t, api, modelId));
}

/** Approximate token cost of one tool definition for the current API. */
function toolTokens(tool: ToolInfo, api: string | undefined, modelId: string | undefined): number {
	return tokensOf(JSON.stringify(serializeToolForApi(tool, api, modelId)));
}

/** Approximate token cost of active tools payload as sent to provider. */
function toolsPayloadTokens(tools: ToolInfo[], api: string | undefined, modelId: string | undefined): number {
	if (tools.length === 0) return 0;
	return tokensOf(JSON.stringify(serializeToolsForApi(tools, api, modelId)));
}

/**
 * Parse built-in tool names from system prompt "Available tools:" section.
 * Secondary fallback only; primary classification uses KNOWN_BUILTIN_TOOLS.
 */
function parseBuiltinNamesFromPrompt(prompt: string): Set<string> {
	const section = prompt.match(/Available tools:\n([\s\S]*?)(?:\n\n|\nIn addition)/);
	if (!section) return new Set();

	const names = new Set<string>();
	const re = /^- (\w+):/gm;
	let m: RegExpExecArray | null;
	while ((m = re.exec(section[1])) !== null) {
		names.add(m[1]);
	}
	return names;
}

function getBuiltinNames(prompt: string): Set<string> {
	const names = new Set<string>(KNOWN_BUILTIN_TOOLS);
	for (const name of parseBuiltinNamesFromPrompt(prompt)) {
		names.add(name);
	}
	return names;
}

interface SkillInfo {
	name: string;
	tokens: number;
}

interface SkillsResult {
	skills: SkillInfo[];
	sectionTokens: number;
}

/**
 * Parse skills from system prompt XML section.
 * Returns:
 * - per-skill token estimates (<skill> blocks)
 * - total section token estimate (preamble + <available_skills> wrappers + blocks)
 *
 * Skills are injected only when "read" is active (pi core behavior).
 */
interface ParsedSkillsSection {
	fullSection: string;
	prefix: string;
	suffix: string;
	blocks: Array<{ name: string; raw: string }>;
}

function parseSkillsSection(prompt: string): ParsedSkillsSection | undefined {
	const section = prompt.match(/\nThe following skills[\s\S]*?<available_skills>([\s\S]*?)<\/available_skills>/);
	if (!section) return undefined;

	const fullSection = section[0];
	const openTag = "<available_skills>";
	const closeTag = "</available_skills>";
	const openIdx = fullSection.indexOf(openTag);
	const closeIdx = fullSection.lastIndexOf(closeTag);
	if (openIdx === -1 || closeIdx === -1 || closeIdx < openIdx) return undefined;

	const xmlBody = section[1];
	const blocks: Array<{ name: string; raw: string }> = [];
	const re = /<skill>\s*<name>(.*?)<\/name>\s*<description>[\s\S]*?<\/description>\s*<location>[\s\S]*?<\/location>\s*<\/skill>/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(xmlBody)) !== null) {
		blocks.push({ name: m[1], raw: m[0] });
	}

	return {
		fullSection,
		prefix: fullSection.slice(0, openIdx + openTag.length),
		suffix: fullSection.slice(closeIdx),
		blocks,
	};
}

function parseSkills(prompt: string): SkillsResult {
	const section = parseSkillsSection(prompt);
	if (!section) return { skills: [], sectionTokens: 0 };

	const skills = section.blocks.map((b) => ({ name: b.name, tokens: tokensOf(b.raw) }));
	return { skills, sectionTokens: tokensOf(section.fullSection) };
}

/**
 * Use the slash-command registry as canonical skill discovery source.
 * This avoids prompt-state bleed when effective system prompts are modified per turn.
 */
function getSkillNamesFromCommands(pi: ExtensionAPI): string[] {
	const names: string[] = [];
	const seen = new Set<string>();

	for (const command of pi.getCommands()) {
		const source = (command as { source?: string }).source;
		const commandName = command.name;
		const isSkillCommand = source === "skill" || commandName.startsWith("skill:");
		if (!isSkillCommand) continue;

		const skillName = commandName.startsWith("skill:") ? commandName.slice(6) : commandName;
		if (!skillName || seen.has(skillName)) continue;
		seen.add(skillName);
		names.push(skillName);
	}

	return names;
}

interface BuildSkillCatalogOptions {
	commandSkillNames: string[];
	parsedSkills: SkillInfo[];
	fallbackSkills: SkillInfo[];
}

function buildSkillCatalog(options: BuildSkillCatalogOptions): SkillInfo[] {
	const tokenByName = new Map<string, number>();
	for (const skill of options.fallbackSkills) tokenByName.set(skill.name, skill.tokens);
	for (const skill of options.parsedSkills) tokenByName.set(skill.name, skill.tokens);

	const names: string[] = [];
	const seen = new Set<string>();
	const addName = (name: string) => {
		if (!name || seen.has(name)) return;
		seen.add(name);
		names.push(name);
	};

	if (options.commandSkillNames.length > 0) {
		for (const name of options.commandSkillNames) addName(name);
	} else {
		for (const skill of options.parsedSkills) addName(skill.name);
		for (const skill of options.fallbackSkills) addName(skill.name);
	}

	return names.map((name) => ({ name, tokens: tokenByName.get(name) ?? 0 }));
}

function updateKnownSkillsCache(existing: SkillInfo[], latest: SkillInfo[], commandSkillNames: string[]): SkillInfo[] {
	const tokenByName = new Map<string, number>();
	for (const skill of existing) tokenByName.set(skill.name, skill.tokens);
	for (const skill of latest) tokenByName.set(skill.name, skill.tokens);

	if (commandSkillNames.length > 0) {
		return commandSkillNames.map((name) => ({ name, tokens: tokenByName.get(name) ?? 0 }));
	}

	const names: string[] = [];
	const seen = new Set<string>();
	for (const skill of latest) {
		if (seen.has(skill.name)) continue;
		seen.add(skill.name);
		names.push(skill.name);
	}
	for (const skill of existing) {
		if (seen.has(skill.name)) continue;
		seen.add(skill.name);
		names.push(skill.name);
	}

	return names.map((name) => ({ name, tokens: tokenByName.get(name) ?? 0 }));
}

function isSkillEnabled(skillName: string, skillPrefs: Record<string, boolean>): boolean {
	return skillPrefs[skillName] !== false;
}

function filterSkillsInPrompt(prompt: string, skillPrefs: Record<string, boolean>): string {
	const section = parseSkillsSection(prompt);
	if (!section) return prompt;

	const kept = section.blocks.filter((b) => isSkillEnabled(b.name, skillPrefs));
	if (kept.length === section.blocks.length) return prompt;
	if (kept.length === 0) return prompt.replace(section.fullSection, "");

	const rebuiltSection = `${section.prefix}\n${kept.map((b) => b.raw).join("\n")}\n${section.suffix}`;
	return prompt.replace(section.fullSection, rebuiltSection);
}

interface InspectorSnapshot {
	modelApi: string | undefined;
	actualUsage: ReturnType<ExtensionContext["getContextUsage"]>;
	activeToolNames: Set<string>;
	extensionTools: ToolInfo[];
	activeExtensionTools: ToolInfo[];
	inactiveExtensionTools: ToolInfo[];
	toolTokenByName: Map<string, number>;
	skills: SkillInfo[];
	activeSkills: SkillInfo[];
	inactiveSkills: SkillInfo[];
	skillSectionTokens: number;
	estimatedToolsPayloadTokens: number;
	estimatedOverheadTokens: number;
}

function collectSnapshot(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	options?: {
		skillPrefs?: Record<string, boolean>;
		skillCatalogPrompt?: string;
		skillFallback?: SkillInfo[];
		commandSkillNames?: string[];
	},
): InspectorSnapshot {
	const allTools = pi.getAllTools();
	const activeToolNames = new Set(pi.getActiveTools());
	const systemPrompt = ctx.getSystemPrompt();
	const builtinNames = getBuiltinNames(systemPrompt);
	const modelApi = ctx.model?.api;
	const modelId = ctx.model?.id;
	const skillPrefs = options?.skillPrefs ?? {};
	const skillCatalogPrompt = options?.skillCatalogPrompt ?? systemPrompt;
	const commandSkillNames = options?.commandSkillNames ?? [];

	const extensionTools = allTools.filter((t) => !builtinNames.has(t.name));
	const activeExtensionTools = extensionTools.filter((t) => activeToolNames.has(t.name));
	const inactiveExtensionTools = extensionTools.filter((t) => !activeToolNames.has(t.name));

	const toolTokenByName = new Map<string, number>();
	for (const tool of extensionTools) {
		toolTokenByName.set(tool.name, toolTokens(tool, modelApi, modelId));
	}

	const estimatedToolsPayloadTokens = toolsPayloadTokens(activeExtensionTools, modelApi, modelId);
	const parsedCatalogSkills = parseSkills(skillCatalogPrompt).skills;
	const skills = buildSkillCatalog({
		commandSkillNames,
		parsedSkills: parsedCatalogSkills,
		fallbackSkills: options?.skillFallback ?? [],
	});
	const activeSkills = skills.filter((s) => isSkillEnabled(s.name, skillPrefs));
	const inactiveSkills = skills.filter((s) => !isSkillEnabled(s.name, skillPrefs));
	const estimatedSkillPrompt = filterSkillsInPrompt(systemPrompt, skillPrefs);
	const { sectionTokens: skillSectionTokens } = parseSkills(estimatedSkillPrompt);
	const estimatedOverheadTokens = estimatedToolsPayloadTokens + skillSectionTokens;

	return {
		modelApi,
		actualUsage: ctx.getContextUsage(),
		activeToolNames,
		extensionTools,
		activeExtensionTools,
		inactiveExtensionTools,
		toolTokenByName,
		skills,
		activeSkills,
		inactiveSkills,
		skillSectionTokens,
		estimatedToolsPayloadTokens,
		estimatedOverheadTokens,
	};
}

// ── Extension ─────────────────────────────────────────────────────────────────

export default function contextInspector(pi: ExtensionAPI) {
	const WIDGET_KEY = "ctx-inspector";
	const prefsPathDisplay = formatPathForDisplay(TOOL_PREFS_PATH);
	let widgetVisible = true;
	let toolPrefs = emptyToolPrefsFile();
	let prefsLoaded = false;
	let prefsWarning: string | undefined;
	let lastUnfilteredSystemPrompt: string | undefined;
	let knownSkills: SkillInfo[] = [];

	function ensurePrefsLoaded(ctx?: ExtensionContext): void {
		if (prefsLoaded) return;
		const loaded = loadToolPrefsFile();
		toolPrefs = loaded.data;
		prefsLoaded = true;
		prefsWarning = loaded.warning;
		if (prefsWarning && ctx?.hasUI) {
			ctx.ui.notify(prefsWarning, "warning");
		}
	}

	function persistPrefs(ctx: ExtensionContext): void {
		const result = saveToolPrefsFile(toolPrefs);
		if (!result.ok && ctx.hasUI) {
			ctx.ui.notify(`Context Inspector: ${result.error}`, "warning");
		}
	}

	function persistToolPref(toolName: string, active: boolean, ctx: ExtensionContext): void {
		ensurePrefsLoaded(ctx);
		toolPrefs.toolPrefs[toolName] = active;
		persistPrefs(ctx);
	}

	function persistSkillPref(skillName: string, active: boolean, ctx: ExtensionContext): void {
		ensurePrefsLoaded(ctx);
		toolPrefs.skillPrefs[skillName] = active;
		persistPrefs(ctx);
	}

	function applyPersistedToolPrefs(ctx: ExtensionContext): void {
		ensurePrefsLoaded(ctx);

		const allTools = pi.getAllTools();
		const activeTools = new Set(pi.getActiveTools());
		const builtinNames = getBuiltinNames(ctx.getSystemPrompt());
		const extensionTools = allTools.filter((t) => !builtinNames.has(t.name));
		const extensionToolNames = new Set(extensionTools.map((t) => t.name));

		let changedPrefs = false;
		for (const name of Object.keys(toolPrefs.toolPrefs)) {
			if (!extensionToolNames.has(name)) {
				delete toolPrefs.toolPrefs[name];
				changedPrefs = true;
			}
		}

		let changedActiveTools = false;
		for (const tool of extensionTools) {
			const pref = toolPrefs.toolPrefs[tool.name];
			if (pref === true && !activeTools.has(tool.name)) {
				activeTools.add(tool.name);
				changedActiveTools = true;
			}
			if (pref === false && activeTools.has(tool.name)) {
				activeTools.delete(tool.name);
				changedActiveTools = true;
			}
		}

		if (changedActiveTools) {
			pi.setActiveTools(Array.from(activeTools));
		}
		if (changedPrefs) {
			persistPrefs(ctx);
		}
	}

	function getSnapshot(ctx: ExtensionContext): InspectorSnapshot {
		ensurePrefsLoaded();
		const skillCatalogPrompt = lastUnfilteredSystemPrompt ?? ctx.getSystemPrompt();
		const commandSkillNames = getSkillNamesFromCommands(pi);
		const snap = collectSnapshot(pi, ctx, {
			skillPrefs: toolPrefs.skillPrefs,
			skillCatalogPrompt,
			skillFallback: knownSkills,
			commandSkillNames,
		});
		if (snap.skills.length > 0 || commandSkillNames.length > 0) {
			knownSkills = updateKnownSkillsCache(knownSkills, snap.skills, commandSkillNames);
		}
		return snap;
	}

	// ── Widget ────────────────────────────────────────────────────────────────

	function refresh(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		if (!widgetVisible) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}

		ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => {
			const snap = getSnapshot(ctx);

			const accent = (s: string) => theme.fg("accent", s);
			const dim = (s: string) => theme.fg("dim", s);
			const muted = (s: string) => theme.fg("muted", s);
			const ok = (s: string) => theme.fg("success", s);

			const activeToolParts = snap.activeExtensionTools.map((t) => {
				const tk = snap.toolTokenByName.get(t.name) ?? 0;
				return `${accent(t.name)}${dim(`(~${compact(tk)}t)`)}`;
			});
			const inactiveToolParts = snap.inactiveExtensionTools.map((t) => dim(theme.strikethrough(t.name)));

			const activeSkillParts = snap.activeSkills.map((s) => `${ok(s.name)}${dim(`(~${compact(s.tokens)}t)`)}`);
			const inactiveSkillParts = snap.inactiveSkills.map((s) => dim(theme.strikethrough(s.name)));

			return {
				render(width: number): string[] {
					const lines: string[] = [];
					const maxW = width - 2;

					// Line 1: actual usage (authoritative usage + trailing estimate from pi)
					const usageLine = [` ${theme.bold("🧠")} ${muted("actual")}`];
					if (snap.actualUsage) {
						usageLine.push(accent(`${compact(snap.actualUsage.tokens)}t/${compact(snap.actualUsage.contextWindow)}t`));
						usageLine.push(dim(`(${formatPercent(snap.actualUsage.percent)}%)`));
					} else {
						usageLine.push(dim("n/a"));
					}
					lines.push(truncateToWidth(usageLine.join(" "), maxW));

					// Line 2: extension tools estimate
					const toolLine = [` ${theme.bold("⚡")} ${muted("ext tools")}`];
					if (activeToolParts.length > 0) toolLine.push(activeToolParts.join(" "));
					if (inactiveToolParts.length > 0) toolLine.push(inactiveToolParts.join(" "));
					if (snap.extensionTools.length > 0) {
						toolLine.push(dim(`≈ ${compact(snap.estimatedToolsPayloadTokens)}t`));
					} else {
						toolLine.push(dim("none"));
					}
					lines.push(truncateToWidth(toolLine.join(" "), maxW));

					// Line 3: skills estimate
					const skillLine = [` ${theme.bold("📚")} ${muted("skills")}`];
					if (activeSkillParts.length > 0) skillLine.push(activeSkillParts.join(" "));
					if (inactiveSkillParts.length > 0) skillLine.push(inactiveSkillParts.join(" "));
					if (snap.skills.length === 0) skillLine.push(dim("none"));
					if (snap.skills.length > 0) skillLine.push(dim(`≈ ${compact(snap.skillSectionTokens)}t`));
					lines.push(truncateToWidth(skillLine.join(" "), maxW));

					// Line 4: overhead summary + hint
					const apiLabel = snap.modelApi ?? "fallback-generic";
					lines.push(truncateToWidth(
						` ${dim(`estimated overhead: ~${compact(snap.estimatedOverheadTokens)}t (${apiLabel})`)}${dim("  │  /ctx manage  │  Ctrl+Shift+I hide")}`,
						maxW,
					));

					return lines;
				},
				invalidate() {},
				dispose() {},
			};
		}, { placement: "belowEditor" });
	}

	// ── Events ────────────────────────────────────────────────────────────────

	pi.on("session_start", async (_e, ctx) => {
		// Do not read ctx.getSystemPrompt() here: it may still hold the previous turn's
		// before_agent_start modifications (including filtered skills).
		lastUnfilteredSystemPrompt = undefined;
		applyPersistedToolPrefs(ctx);
		refresh(ctx);
	});
	pi.on("turn_end", async (_e, ctx) => refresh(ctx));
	pi.on("session_compact", async (_e, ctx) => refresh(ctx));
	pi.on("session_tree", async (_e, ctx) => refresh(ctx));
	pi.on("session_switch", async (_e, ctx) => {
		// Same caveat as session_start: avoid treating effective prompt as canonical catalog.
		lastUnfilteredSystemPrompt = undefined;
		applyPersistedToolPrefs(ctx);
		refresh(ctx);
	});
	pi.on("session_fork", async (_e, ctx) => refresh(ctx));
	pi.on("model_select", async (_e, ctx) => refresh(ctx));

	pi.on("before_agent_start", async (event, _ctx) => {
		ensurePrefsLoaded();
		lastUnfilteredSystemPrompt = event.systemPrompt;
		const filteredPrompt = filterSkillsInPrompt(event.systemPrompt, toolPrefs.skillPrefs);
		if (filteredPrompt !== event.systemPrompt) {
			return { systemPrompt: filteredPrompt };
		}
	});

	pi.on("input", async (event, ctx) => {
		if (!event.text.startsWith("/skill:")) return { action: "continue" };
		ensurePrefsLoaded();

		const spaceIndex = event.text.indexOf(" ");
		const skillName = spaceIndex === -1 ? event.text.slice(7) : event.text.slice(7, spaceIndex);
		if (!skillName) return { action: "continue" };
		if (isSkillEnabled(skillName, toolPrefs.skillPrefs)) return { action: "continue" };

		if (ctx.hasUI) {
			ctx.ui.notify(`Skill \"${skillName}\" is disabled in /ctx. Enable it before use.`, "warning");
		}
		return { action: "handled" };
	});

	// ── Toggle shortcut ───────────────────────────────────────────────────────

	pi.registerShortcut("ctrl+shift+i", {
		description: "Toggle context inspector widget",
		handler: async (ctx) => {
			widgetVisible = !widgetVisible;
			refresh(ctx);
		},
	});

	pi.registerCommand("ctx:toggle", {
		description: "Toggle context inspector widget",
		handler: async (_args, ctx) => {
			widgetVisible = !widgetVisible;
			refresh(ctx);
		},
	});

	// ── /ctx — interactive manage ─────────────────────────────────────────────

	pi.registerCommand("ctx", {
		description: "Manage extension tools/skills and inspect actual usage + estimated overhead",
		handler: async (_args, ctx) => {
			ensurePrefsLoaded(ctx);
			const snap = getSnapshot(ctx);

			const items: SettingItem[] = [];

			// Extension tools (toggleable)
			for (const tool of snap.extensionTools) {
				const tk = snap.toolTokenByName.get(tool.name) ?? 0;
				items.push({
					id: `tool:${tool.name}`,
					label: `⚡ ${tool.name}  (~${compact(tk)}t est)`,
					currentValue: snap.activeToolNames.has(tool.name) ? "active" : "off",
					values: ["active", "off"],
				});
			}

			// Skills (toggleable)
			for (const skill of snap.skills) {
				items.push({
					id: `skill:${skill.name}`,
					label: `📚 ${skill.name}  (~${compact(skill.tokens)}t est, XML/meta)`,
					currentValue: isSkillEnabled(skill.name, toolPrefs.skillPrefs) ? "active" : "off",
					values: ["active", "off"],
				});
			}

			if (items.length === 0) {
				ctx.ui.notify("No extension tools or skills loaded.", "info");
				return;
			}

			const actualUsageText = snap.actualUsage
				? `${compact(snap.actualUsage.tokens)}t / ${compact(snap.actualUsage.contextWindow)}t (${formatPercent(snap.actualUsage.percent)}%)`
				: "n/a";
			const estimatedText = `~${compact(snap.estimatedOverheadTokens)}t (tools ~${compact(snap.estimatedToolsPayloadTokens)}t + skills ~${compact(snap.skillSectionTokens)}t)`;

			await ctx.ui.custom((tui, theme, _kb, done) => {
				const container = new Container();
				container.addChild(new Text(
					theme.fg("accent", theme.bold(" Context Inspector")) + "\n" +
					theme.fg("dim", ` Actual context usage: ${actualUsageText}`) + "\n" +
					theme.fg("dim", ` Estimated overhead: ${estimatedText}`) + "\n" +
					theme.fg("dim", ` API estimator: ${snap.modelApi ?? "fallback-generic"} (approx)`) + "\n" +
					theme.fg("dim", ` Tool/skill defaults: persisted at ${prefsPathDisplay}`) + "\n" +
					(prefsWarning ? theme.fg("warning", ` ${prefsWarning}`) + "\n" : ""),
					1,
					0,
				));

				const settingsList = new SettingsList(
					items,
					Math.min(items.length + 2, 20),
					getSettingsListTheme(),
					(id, newValue) => {
						if (id.startsWith("tool:")) {
							const toolName = id.slice(5);
							const currentActive = new Set(pi.getActiveTools());
							if (newValue === "active") currentActive.add(toolName);
							else currentActive.delete(toolName);

							// Affects the next model call; current streaming turn keeps its tool snapshot.
							pi.setActiveTools(Array.from(currentActive));
							persistToolPref(toolName, newValue === "active", ctx);
							refresh(ctx);
							return;
						}

						if (id.startsWith("skill:")) {
							const skillName = id.slice(6);
							persistSkillPref(skillName, newValue === "active", ctx);
							refresh(ctx);
						}
					},
					() => done(undefined),
				);
				container.addChild(settingsList);

				container.addChild(new Text(
					theme.fg("dim", " ↑↓ navigate • ←→ toggle • Esc close") + "\n" +
					theme.fg("dim", " Tool/skill toggles apply on the next model call and persist across restarts."),
					1,
					0,
				));

				return {
					render: (w: number) => container.render(w),
					invalidate: () => container.invalidate(),
					handleInput: (data: string) => {
						settingsList.handleInput?.(data);
						tui.requestRender();
					},
				};
			});
		},
	});
}
