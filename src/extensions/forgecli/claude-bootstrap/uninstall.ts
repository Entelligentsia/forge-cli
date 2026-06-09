// claude-bootstrap/uninstall.ts — deterministic reverse of bootstrapClaudeProject.
//
// `4ge uninstall claude [dir]` removes what `4ge init claude` scaffolded:
// the vendored Forge scaffold (tools, hooks, schemas, commands, forge-root
// content, agents/skills, workflow drivers, bootstrap manifest), un-merges the
// Forge hooks from .claude/settings.json, and un-appends the Forge block from
// .gitignore. Pure fs; zero LLM tokens, zero network.
//
// Safety contract:
//   - PRESERVES user data by default: .forge/config.json, .forge/store/** (the
//     SDLC store — sprints/tasks/bugs/events), and the KB folder are NEVER
//     touched unless `purge` is set.
//   - REFUSES to act when no .forge/.bootstrap-manifest.json is present — that
//     manifest is the proof a project was forge-bootstrapped. Without it we will
//     not delete anything (avoids nuking a hand-built .claude/ or .forge/).
//   - settings.json and .gitignore are EDITED (un-merge / un-append), never
//     blindly deleted — they may carry non-Forge content.
//   - Idempotent: a second run finds nothing to remove and reports cleanly.

import * as fs from "node:fs";
import * as path from "node:path";

// ── Public types ──────────────────────────────────────────────────────────────

export interface UninstallOptions {
	/** Target project root (absolute path). */
	dir: string;
	/** Absolute path to the dist/forge-payload/ directory (to re-derive vendored names). */
	payloadRoot: string;
	/**
	 * When true, ALSO remove user data: .forge/config.json and .forge/store/**,
	 * then the now-empty .forge/ itself. The KB folder is never auto-removed.
	 */
	purge: boolean;
}

export interface UninstallResult {
	ok: boolean;
	/** True if a .forge/.bootstrap-manifest.json was found (a forge-bootstrapped project). */
	bootstrapped: boolean;
	/** Paths removed this run (files and dirs). */
	removed: string[];
	/** User-data paths deliberately preserved (only meaningful when purge=false). */
	kept: string[];
	/** Non-fatal issues encountered. */
	warnings: string[];
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Sentinel identifying Forge hook commands in settings.json (mirrors settings-merge). */
const FORGE_HOOK_SENTINEL = ".forge/tools/";

/** Exact block appended to .gitignore by bootstrap (mirrors bootstrap.ts). */
const GITIGNORE_APPEND_BLOCK =
	"\n# Forge — transient agent event logs (one file per phase, do not commit)\n.forge/store/events/\n";

// ── Private helpers ───────────────────────────────────────────────────────────

/** Remove a file or directory if it exists; record the path. Never throws. */
function rmIfExists(target: string, removed: string[], warnings: string[]): void {
	if (!fs.existsSync(target)) return;
	try {
		fs.rmSync(target, { recursive: true, force: true });
		removed.push(target);
	} catch (err: unknown) {
		const e = err as { message?: string };
		warnings.push(`could not remove ${target}: ${e.message ?? String(err)}`);
	}
}

/** Remove a directory only if it exists and is empty. Records if removed. */
function rmDirIfEmpty(dirPath: string, removed: string[]): void {
	if (!fs.existsSync(dirPath)) return;
	try {
		if (fs.readdirSync(dirPath).length === 0) {
			fs.rmdirSync(dirPath);
			removed.push(dirPath);
		}
	} catch {
		// non-fatal — leave it
	}
}

/** List immediate entry names in a payload subdir, or [] if absent. */
function payloadEntryNames(payloadRoot: string, sub: string): string[] {
	const src = path.join(payloadRoot, sub);
	if (!fs.existsSync(src)) return [];
	try {
		return fs.readdirSync(src);
	} catch {
		return [];
	}
}

/**
 * Un-merge Forge hooks from .claude/settings.json.
 * Removes hook entries whose command targets `.forge/tools/…`, drops groups and
 * event-type keys that become empty, and deletes the file only if it is left
 * with no keys at all (i.e. Forge created it). Never touches malformed JSON.
 */
function removeForgeHooks(settingsPath: string, removed: string[], warnings: string[]): void {
	if (!fs.existsSync(settingsPath)) return;

	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
	} catch (err: unknown) {
		const e = err as { message?: string };
		warnings.push(`settings.json not valid JSON — left untouched: ${e.message ?? String(err)}`);
		return;
	}

	const hooks = parsed.hooks as Record<string, unknown> | undefined;
	if (!hooks || typeof hooks !== "object") return;

	let changed = false;
	for (const [eventType, groupsRaw] of Object.entries(hooks)) {
		if (!Array.isArray(groupsRaw)) continue;
		const keptGroups: unknown[] = [];
		for (const group of groupsRaw) {
			const g = group as { hooks?: Array<{ command?: string }> };
			if (Array.isArray(g.hooks)) {
				const keptHooks = g.hooks.filter(
					(h) => !(typeof h.command === "string" && h.command.includes(FORGE_HOOK_SENTINEL)),
				);
				if (keptHooks.length !== g.hooks.length) changed = true;
				if (keptHooks.length === 0) continue; // drop emptied group
				keptGroups.push({ ...g, hooks: keptHooks });
			} else {
				keptGroups.push(group);
			}
		}
		if (keptGroups.length === 0) {
			delete hooks[eventType];
			changed = true;
		} else {
			hooks[eventType] = keptGroups;
		}
	}

	if (!changed) return;

	// Drop an emptied hooks key, then delete the file if nothing else remains.
	if (Object.keys(hooks).length === 0) delete parsed.hooks;

	if (Object.keys(parsed).length === 0) {
		rmIfExists(settingsPath, removed, warnings);
		return;
	}

	try {
		fs.writeFileSync(settingsPath, JSON.stringify(parsed, null, 2) + "\n", "utf8");
		removed.push(`${settingsPath} (Forge hooks un-merged)`);
	} catch (err: unknown) {
		const e = err as { message?: string };
		warnings.push(`could not rewrite ${settingsPath}: ${e.message ?? String(err)}`);
	}
}

/** Remove the exact Forge block appended to .gitignore by bootstrap. */
function removeGitignoreBlock(gitignorePath: string, removed: string[], warnings: string[]): void {
	if (!fs.existsSync(gitignorePath)) return;
	let content: string;
	try {
		content = fs.readFileSync(gitignorePath, "utf8");
	} catch {
		return;
	}
	if (!content.includes(GITIGNORE_APPEND_BLOCK)) return;
	try {
		fs.writeFileSync(gitignorePath, content.replace(GITIGNORE_APPEND_BLOCK, ""), "utf8");
		removed.push(`${gitignorePath} (Forge block un-appended)`);
	} catch (err: unknown) {
		const e = err as { message?: string };
		warnings.push(`could not rewrite ${gitignorePath}: ${e.message ?? String(err)}`);
	}
}

// ── Main export ───────────────────────────────────────────────────────────────

export function uninstallClaudeProject(opts: UninstallOptions): UninstallResult {
	const { dir, payloadRoot, purge } = opts;
	const removed: string[] = [];
	const kept: string[] = [];
	const warnings: string[] = [];

	// ── Step 0: Require the bootstrap manifest (proof of a forge bootstrap) ───
	const manifestPath = path.join(dir, ".forge", ".bootstrap-manifest.json");
	if (!fs.existsSync(manifestPath)) {
		warnings.push(
			`Not a forge-bootstrapped project: ${path.join(".forge", ".bootstrap-manifest.json")} not found in ${dir}. ` +
				"Refusing to remove anything (run `4ge init claude` first, or remove files by hand).",
		);
		return { ok: false, bootstrapped: false, removed, kept, warnings };
	}

	const forgeDir = path.join(dir, ".forge");
	const claudeDir = path.join(dir, ".claude");

	// ── Step 1: Remove Forge-owned .forge/ scaffold (preserve config + store) ──
	for (const sub of ["tools", "schemas", "init", ".base-pack", "meta", ".claude-plugin", "cache"]) {
		rmIfExists(path.join(forgeDir, sub), removed, warnings);
	}
	rmIfExists(manifestPath, removed, warnings);

	// ── Step 2: Remove Forge command surface ──────────────────────────────────
	rmIfExists(path.join(claudeDir, "commands", "forge"), removed, warnings);
	rmDirIfEmpty(path.join(claudeDir, "commands"), removed);

	// ── Step 3: Remove workflow drivers (.claude/workflows is forge-exclusive) ─
	rmIfExists(path.join(claudeDir, "workflows"), removed, warnings);

	// ── Step 4: Remove vendored agents/skills — only the ones bootstrap added ──
	// Re-derive the exact entry names from the payload so user-authored agents
	// or skills sharing the directory are preserved.
	for (const asset of ["agents", "skills"]) {
		const assetDir = path.join(claudeDir, asset);
		if (!fs.existsSync(assetDir)) continue;
		for (const name of payloadEntryNames(payloadRoot, asset)) {
			rmIfExists(path.join(assetDir, name), removed, warnings);
		}
		rmDirIfEmpty(assetDir, removed);
	}

	// ── Step 5: Un-merge settings hooks + un-append .gitignore (edit, not delete)
	removeForgeHooks(path.join(claudeDir, "settings.json"), removed, warnings);
	removeGitignoreBlock(path.join(dir, ".gitignore"), removed, warnings);

	// ── Step 6: User data — preserve by default, remove only on --purge ───────
	const configPath = path.join(forgeDir, "config.json");
	const storePath = path.join(forgeDir, "store");
	if (purge) {
		rmIfExists(storePath, removed, warnings);
		rmIfExists(configPath, removed, warnings);
		// The KB folder (paths.engineering) is intentionally NOT auto-removed even
		// under --purge: it is the user's generated documentation, not scaffold.
		warnings.push("--purge removed .forge/store and .forge/config.json. The KB folder was left intact (remove it by hand if intended).");
	} else {
		if (fs.existsSync(configPath)) kept.push(configPath);
		if (fs.existsSync(storePath)) kept.push(storePath);
	}

	// ── Step 7: Tidy empty parents ────────────────────────────────────────────
	rmDirIfEmpty(forgeDir, removed);
	rmDirIfEmpty(claudeDir, removed);

	return { ok: true, bootstrapped: true, removed, kept, warnings };
}
