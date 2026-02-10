/**
 * Context Inspector — shows extension tools & skills with per-item token cost.
 *
 * Widget below editor: live view of active extension tools + loaded skills.
 * /ctx command: interactive toggle to enable/disable extension tools.
 * Ctrl+Shift+I: toggle widget visibility.
 */

import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@mariozechner/pi-coding-agent";
import { estimateTokens, getSettingsListTheme } from "@mariozechner/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text, truncateToWidth } from "@mariozechner/pi-tui";

// ── Helpers ───────────────────────────────────────────────────────────────────

const BUILTIN = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

function tokensOf(text: string): number {
	return Math.ceil(text.length / 4);
}

function toolTokens(t: ToolInfo): number {
	const s = t.parameters as { properties?: Record<string, unknown>; required?: string[] };
	return tokensOf(JSON.stringify({
		name: t.name, description: t.description,
		input_schema: { type: "object", properties: s?.properties ?? {}, required: s?.required ?? [] },
	}));
}

function compact(n: number): string {
	if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
	if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
	return String(n);
}

interface SkillInfo { name: string; tokens: number }

function parseSkills(prompt: string): SkillInfo[] {
	const skills: SkillInfo[] = [];
	const section = prompt.match(
		/\nThe following skills[\s\S]*?<available_skills>([\s\S]*?)<\/available_skills>/,
	);
	if (!section) return skills;
	const re = /<skill>\s*<name>(.*?)<\/name>\s*<description>([\s\S]*?)<\/description>\s*<location>(.*?)<\/location>\s*<\/skill>/g;
	let m;
	while ((m = re.exec(section[0])) !== null) {
		skills.push({ name: m[1], tokens: tokensOf(m[0]) });
	}
	return skills;
}

// ── Extension ─────────────────────────────────────────────────────────────────

export default function contextInspector(pi: ExtensionAPI) {
	const WIDGET_KEY = "ctx-inspector";
	let widgetVisible = true;

	// ── Widget ────────────────────────────────────────────────────────────────

	function refresh(ctx: ExtensionContext) {
		if (!widgetVisible) { ctx.ui.setWidget(WIDGET_KEY, undefined); return; }

		ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => {
			const allTools = pi.getAllTools();
			const active = new Set(pi.getActiveTools());
			const skills = parseSkills(ctx.getSystemPrompt());

			const extTools = allTools.filter((t) => !BUILTIN.has(t.name));
			const activeExt = extTools.filter((t) => active.has(t.name));
			const inactiveExt = extTools.filter((t) => !active.has(t.name));

			const accent = (s: string) => theme.fg("accent", s);
			const dim = (s: string) => theme.fg("dim", s);
			const muted = (s: string) => theme.fg("muted", s);
			const ok = (s: string) => theme.fg("success", s);
			const warn = (s: string) => theme.fg("warning", s);

			let extTotal = 0;
			const extParts = activeExt.map((t) => {
				const tk = toolTokens(t);
				extTotal += tk;
				return accent(t.name) + dim(`(${compact(tk)})`);
			});
			const inactiveParts = inactiveExt.map((t) => dim(theme.strikethrough(t.name)));

			let skillTotal = 0;
			const skillParts = skills.map((s) => {
				skillTotal += s.tokens;
				return ok(s.name) + dim(`(${compact(s.tokens)})`);
			});

			const total = extTotal + skillTotal;

			return {
				render(width: number): string[] {
					const lines: string[] = [];
					const maxW = width - 2;

					// Line 1: extension tools
					const toolLine = [` ${theme.bold("⚡")} ${muted("tools")}`];
					if (extParts.length > 0) toolLine.push(extParts.join(" "));
					if (inactiveParts.length > 0) toolLine.push(inactiveParts.join(" "));
					if (extTools.length > 0) toolLine.push(dim(`= ${compact(extTotal)}t`));
					else toolLine.push(dim("none"));
					lines.push(truncateToWidth(toolLine.join(" "), maxW));

					// Line 2: skills
					const skillLine = [` ${theme.bold("📚")} ${muted("skills")}`];
					if (skillParts.length > 0) skillLine.push(skillParts.join(" "));
					else skillLine.push(dim("none"));
					if (skills.length > 0) skillLine.push(dim(`= ${compact(skillTotal)}t`));
					lines.push(truncateToWidth(skillLine.join(" "), maxW));

					// Line 3: total + hint
					lines.push(truncateToWidth(
						` ${dim(`total: ~${compact(total)}t overhead`)}${dim("  │  /ctx manage  │  Ctrl+Shift+I hide")}`,
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

	pi.on("session_start", async (_e, ctx) => refresh(ctx));
	pi.on("turn_end", async (_e, ctx) => refresh(ctx));
	pi.on("session_compact", async (_e, ctx) => refresh(ctx));
	pi.on("session_tree", async (_e, ctx) => refresh(ctx));
	pi.on("session_switch", async (_e, ctx) => refresh(ctx));
	pi.on("session_fork", async (_e, ctx) => refresh(ctx));
	pi.on("model_select", async (_e, ctx) => refresh(ctx));

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
		description: "Manage extension tools & skills (toggle on/off, see tokens)",
		handler: async (_args, ctx) => {
			const allTools = pi.getAllTools();
			const activeSet = new Set(pi.getActiveTools());
			const skills = parseSkills(ctx.getSystemPrompt());

			const extTools = allTools.filter((t) => !BUILTIN.has(t.name));

			// Build settings items
			const items: SettingItem[] = [];

			// Section header: tools
			for (const t of extTools) {
				const tk = toolTokens(t);
				items.push({
					id: `tool:${t.name}`,
					label: `⚡ ${t.name}  (~${compact(tk)} tokens)`,
					currentValue: activeSet.has(t.name) ? "active" : "off",
					values: ["active", "off"],
				});
			}

			// Section header: skills (info only — cannot toggle at runtime)
			for (const s of skills) {
				items.push({
					id: `skill:${s.name}`,
					label: `📚 ${s.name}  (~${compact(s.tokens)} tokens, description only)`,
					currentValue: "loaded",
					values: ["loaded"],
				});
			}

			if (items.length === 0) {
				ctx.ui.notify("No extension tools or skills loaded.", "info");
				return;
			}

			await ctx.ui.custom((_tui, theme, _kb, done) => {
				const container = new Container();
				container.addChild(new Text(
					theme.fg("accent", theme.bold(" Context Inspector")) + "\n" +
					theme.fg("dim", " Toggle extension tools on/off. Skills are read-only (loaded at startup).") + "\n",
					1, 0,
				));

				const settingsList = new SettingsList(
					items,
					Math.min(items.length + 2, 20),
					getSettingsListTheme(),
					(id, newValue) => {
						if (!id.startsWith("tool:")) return; // skills are read-only
						const toolName = id.slice(5);
						const currentActive = new Set(pi.getActiveTools());
						if (newValue === "active") {
							currentActive.add(toolName);
						} else {
							currentActive.delete(toolName);
						}
						pi.setActiveTools(Array.from(currentActive));
						refresh(ctx); // update widget
					},
					() => done(undefined),
				);
				container.addChild(settingsList);

				container.addChild(new Text(
					theme.fg("dim", " ↑↓ navigate • ←→ toggle • Esc close"),
					1, 0,
				));

				return {
					render: (w: number) => container.render(w),
					invalidate: () => container.invalidate(),
					handleInput: (data: string) => settingsList.handleInput?.(data),
				};
			});
		},
	});
}
