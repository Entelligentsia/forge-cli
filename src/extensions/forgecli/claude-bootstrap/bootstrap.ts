// claude-bootstrap/bootstrap.ts — deterministic Claude Code project bootstrap (FORGE-S31-T02 + T03)
//
// Scaffolds a Claude Code project from the bundled forge-payload in seconds.
// Zero LLM tokens, zero network access, pure fs operations.
//
// Grep-negative ACs (enforced by test):
//   - No fetch/https/network imports
//   - No writes to .forge/store/
//   - No sendUserMessage, no ctx.ui.*
//
// Idempotency contract:
//   - Running against a fully-bootstrapped dir → all paths exist → all skipped →
//     dir tree byte-identical to previous run.
//   - Running against a partial bootstrap → only missing files/dirs created.
//   - .forge/config.json, .forge/store/**, KB folder are NEVER touched.

import * as child_process from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { applySelect, installEntries, loadManifest } from "../lib/payload-manifest.js";
import { mergeForgeHooks } from "./settings-merge.js";

// ── Public types ──────────────────────────────────────────────────────────────

export interface BootstrapOptions {
	/** Target project root (absolute path). */
	dir: string;
	/** Absolute path to the dist/forge-payload/ directory. */
	payloadRoot: string;
}

/** Preflight check results (Step 9). */
export interface BootstrapPreflight {
	/** True if the claude binary was found on PATH and responded to --version. */
	claudeAvailable: boolean;
	/**
	 * Always false in T03 — no reliable offline check for workflow-tool support.
	 * Confirmed at runtime on first /forge:init.
	 */
	workflowToolChecked: boolean;
	/** Non-fatal preflight warnings. */
	warnings: string[];
}

export interface BootstrapResult {
	ok: boolean;
	/** Paths created this run (dirs and files). */
	created: string[];
	/** Paths already present and unchanged (idempotent skip). */
	skipped: string[];
	/** Non-fatal issues encountered. */
	warnings: string[];
	/** Preflight check results (Step 9, FORGE-S31-T03). */
	preflight: BootstrapPreflight;
}

// ── Private helpers ───────────────────────────────────────────────────────────

// ── Gitignore patterns (mirrors phase4-register.ts) ──────────────────────────

const GITIGNORE_FORGE_PATTERNS = [".forge/store/events/", ".forge/store/events", ".forge/store/", ".forge/"];
const GITIGNORE_APPEND_BLOCK =
	"\n# Forge — transient agent event logs (one file per phase, do not commit)\n.forge/store/events/\n";

/**
 * Idempotent .gitignore update. Pure function — returns outcome string.
 * Does not create .gitignore if absent.
 */
function updateGitignorePure(gitignorePath: string): "appended" | "already-present" | "absent" | "error" {
	if (!fs.existsSync(gitignorePath)) return "absent";

	let content: string;
	try {
		content = fs.readFileSync(gitignorePath, "utf8");
	} catch {
		return "error";
	}

	const lines = content.split("\n");
	const alreadyIgnored = lines.some((line) => {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) return false;
		return GITIGNORE_FORGE_PATTERNS.some((pat) => trimmed.includes(pat));
	});

	if (alreadyIgnored) return "already-present";

	try {
		fs.appendFileSync(gitignorePath, GITIGNORE_APPEND_BLOCK, "utf8");
		return "appended";
	} catch {
		return "error";
	}
}

/**
 * Preflight check for claude binary reachability (Step 9).
 * Non-fatal — returns result rather than throwing.
 */
function runPreflight(): BootstrapPreflight {
	const preflight: BootstrapPreflight = {
		claudeAvailable: false,
		workflowToolChecked: false,
		warnings: [],
	};

	try {
		child_process.execFileSync("claude", ["--version"], { timeout: 5000, stdio: "pipe" });
		preflight.claudeAvailable = true;
	} catch {
		preflight.claudeAvailable = false;
		preflight.warnings.push(
			"Claude Code not found on PATH — install Claude Code (https://code.claude.com) " +
				"and ensure 'claude' is on your PATH before opening the project.",
		);
	}

	// workflowToolChecked is always false — no reliable offline check exists.
	// Confirmed at runtime on first /forge:init.
	preflight.workflowToolChecked = false;

	return preflight;
}

/** Read the bundled forge version from .claude-plugin/plugin.json */
function readPayloadVersion(payloadRoot: string): string {
	try {
		const pluginPath = path.join(payloadRoot, ".claude-plugin", "plugin.json");
		const raw = fs.readFileSync(pluginPath, "utf8");
		const plugin = JSON.parse(raw) as { version?: string };
		return typeof plugin.version === "string" ? plugin.version : "0.0.0";
	} catch {
		return "0.0.0";
	}
}

/** Compute SHA-256 of a file, or empty string if unreadable. */
function fileSha256(filePath: string): string {
	try {
		const content = fs.readFileSync(filePath);
		return crypto.createHash("sha256").update(content).digest("hex");
	} catch {
		return "";
	}
}

/**
 * Ensure a directory exists. Returns "created" if it was new, "skipped" if it
 * already existed, or throws on permission error.
 */
function ensureDir(dirPath: string): "created" | "skipped" {
	if (fs.existsSync(dirPath)) {
		return "skipped";
	}
	fs.mkdirSync(dirPath, { recursive: true });
	return "created";
}

/**
 * Copy a file from src to dst.
 * If dst is byte-identical to src → "skipped".
 * Otherwise → overwrite and return "created".
 */
function copyFile(src: string, dst: string): "created" | "skipped" {
	if (fs.existsSync(dst) && fileSha256(src) === fileSha256(dst)) {
		return "skipped";
	}
	fs.copyFileSync(src, dst);
	return "created";
}

/**
 * Write a JSON file. If dst already contains the same content → "skipped".
 * Otherwise → overwrite and return "created".
 */
function writeJsonFile(dst: string, content: unknown): "created" | "skipped" {
	const serialized = JSON.stringify(content, null, 2) + "\n";
	if (fs.existsSync(dst)) {
		try {
			const existing = fs.readFileSync(dst, "utf8");
			if (existing === serialized) return "skipped";
		} catch {
			// fall through to overwrite
		}
	}
	fs.writeFileSync(dst, serialized, "utf8");
	return "created";
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Bootstrap a Claude Code project from the bundled forge-payload.
 *
 * This function is deterministic and idempotent:
 * - Running against a fresh dir scaffolds everything.
 * - Running against a partially-bootstrapped dir repairs only missing items.
 * - Running against a fully-bootstrapped dir is a no-op (byte-identical).
 *
 * .forge/config.json and .forge/store/** are never touched.
 */
export function bootstrapClaudeProject(opts: BootstrapOptions): BootstrapResult {
	const { dir, payloadRoot } = opts;
	const created: string[] = [];
	const skipped: string[] = [];
	const warnings: string[] = [];
	const preflight: BootstrapPreflight = { claudeAvailable: false, workflowToolChecked: false, warnings: [] };

	// ── Step 1: Validate payload root ─────────────────────────────────────────
	const storeCli = path.join(payloadRoot, "tools", "store-cli.cjs");
	if (!fs.existsSync(storeCli)) {
		warnings.push(
			`Payload validation failed: store-cli.cjs missing from ${path.join(payloadRoot, "tools")}. ` +
				"Run 'npm run build' to populate dist/forge-payload/tools/.",
		);
		return { ok: false, created, skipped, warnings, preflight };
	}

	// ── Step 2: Scaffold .forge/ skeleton + store dirs ────────────────────────
	const dirsToScaffold = [
		path.join(dir, ".forge"),
		path.join(dir, ".forge", "store", "sprints"),
		path.join(dir, ".forge", "store", "tasks"),
		path.join(dir, ".forge", "store", "bugs"),
		path.join(dir, ".forge", "store", "events"),
		path.join(dir, ".forge", "cache"),
		path.join(dir, ".forge", "schemas"),
		path.join(dir, ".forge", "tools"),
		path.join(dir, ".claude", "commands", "forge"),
		path.join(dir, ".claude", "workflows"),
	];

	try {
		for (const d of dirsToScaffold) {
			const outcome = ensureDir(d);
			if (outcome === "created") {
				created.push(d);
				// Write .gitkeep into store dirs only
				if (d.includes(path.join(".forge", "store"))) {
					const gitkeep = path.join(d, ".gitkeep");
					if (!fs.existsSync(gitkeep)) {
						fs.writeFileSync(gitkeep, "", "utf8");
						created.push(gitkeep);
					}
				}
			} else {
				skipped.push(d);
			}
		}
	} catch (err: unknown) {
		const e = err as { message?: string };
		warnings.push(
			`Failed to scaffold directory structure in ${dir}: ${e.message ?? String(err)}. ` +
				"Check directory permissions.",
		);
		return { ok: false, created, skipped, warnings, preflight };
	}

	const toolsDest = path.join(dir, ".forge", "tools");

	// ── Step 3: Manifest-driven vendor loop (single source of truth) ──────────
	// Every vendored payload artifact is declared in payload-manifest.json
	// (FORGE-S32-T03). bootstrap copies payloadRoot/<entry.bundle> →
	// dir/<entry.install>, applying entry.select for dir entries. The manifest
	// is the curated set, so there is NO second consumer-side allowlist or
	// skip-list — a file that must NOT be vendored is marked bundleOnly in the
	// manifest (FORGE-BUG-044/045: transitions, migrations.json, integrity.json),
	// excluded here by installEntries(). The manifest entry ORDER encodes the
	// commands-union precedence: the loser `commands/` entry precedes the winner
	// `.base-pack/commands/`, and the later copy overwrites on a name collision,
	// so the .base-pack variant wins exactly as the legacy Step 4a/4b ordering did.
	try {
		const manifest = loadManifest(payloadRoot);
		for (const entry of installEntries(manifest)) {
			const installRoot = path.join(dir, entry.install as string);
			if (entry.kind === "file") {
				const src = path.join(payloadRoot, entry.bundle);
				if (!fs.existsSync(src)) {
					warnings.push(`payload entry ${entry.source} missing from bundle at ${src} — not vendored.`);
					continue;
				}
				const dirOutcome = ensureDir(installRoot);
				if (dirOutcome === "created") created.push(installRoot);
				const destPath = path.join(installRoot, path.basename(entry.bundle));
				const outcome = copyFile(src, destPath);
				if (outcome === "created") created.push(destPath);
				else skipped.push(destPath);
				continue;
			}
			// dir entry — select bundled files and copy preserving relative paths.
			const bundleDir = path.join(payloadRoot, entry.bundle);
			if (!fs.existsSync(bundleDir)) {
				warnings.push(`payload entry ${entry.source} missing from bundle at ${bundleDir} — not vendored.`);
				continue;
			}
			const dirOutcome = ensureDir(installRoot);
			if (dirOutcome === "created") created.push(installRoot);
			else skipped.push(installRoot);
			for (const rel of applySelect(bundleDir, entry.select)) {
				const destPath = path.join(installRoot, rel);
				ensureDir(path.dirname(destPath));
				const outcome = copyFile(path.join(bundleDir, rel), destPath);
				if (outcome === "created") created.push(destPath);
				else skipped.push(destPath);
			}
		}
	} catch (err: unknown) {
		const e = err as { message?: string };
		warnings.push(`vendor-payload non-fatal: ${e.message ?? String(err)}`);
	}

	// ── Step 3b: .forge-tools-version marker (not a payload entry) ─────────────
	// Written by bootstrap, not declared in the manifest — records the bundled
	// forge version so project-orientation.ts can detect a stale vendored toolset.
	try {
		const payloadVersion = readPayloadVersion(payloadRoot);
		const markerPath = path.join(toolsDest, ".forge-tools-version");
		const markerOutcome = writeJsonFile(markerPath, { version: payloadVersion });
		if (markerOutcome === "created") created.push(markerPath);
		else skipped.push(markerPath);
	} catch (err: unknown) {
		const e = err as { message?: string };
		warnings.push(`tools-version-marker non-fatal: ${e.message ?? String(err)}`);
	}

	// ── Step 6: Write bootstrap manifest ──────────────────────────────────────
	const manifestPath = path.join(dir, ".forge", ".bootstrap-manifest.json");
	const payloadVersion = readPayloadVersion(payloadRoot);

	// Compute payload integrity hash
	let payloadIntegrityHash = "";
	try {
		const integrityPath = path.join(payloadRoot, "integrity.json");
		if (fs.existsSync(integrityPath)) {
			payloadIntegrityHash = crypto.createHash("sha256").update(fs.readFileSync(integrityPath)).digest("hex");
		}
	} catch {
		// non-fatal
	}

	try {
		// Preserve existing bootstrappedAt if manifest already exists (idempotency: stable hash)
		let bootstrappedAt = new Date().toISOString();
		if (fs.existsSync(manifestPath)) {
			try {
				const existing = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
					bootstrappedAt?: string;
					payloadVersion?: string;
				};
				// If payload version matches, keep existing timestamp for hash stability
				if (existing.bootstrappedAt && existing.payloadVersion === payloadVersion) {
					bootstrappedAt = existing.bootstrappedAt;
				}
			} catch {
				// fall through to overwrite with current timestamp
			}
		}
		const manifest = {
			bootstrappedAt,
			payloadVersion,
			payloadIntegrityHash,
			steps: [
				"scaffold",
				"vendor-tools",
				"vendor-hooks",
				"vendor-schemas",
				"vendor-commands",
				"vendor-forge-root",
				"vendor-claude-assets",
				"install-workflows",
			],
		};
		const manifestOutcome = writeJsonFile(manifestPath, manifest);
		if (manifestOutcome === "created") created.push(manifestPath);
		else skipped.push(manifestPath);
	} catch (err: unknown) {
		const e = err as { message?: string };
		warnings.push(`manifest write non-fatal: ${e.message ?? String(err)}`);
	}

	// ── Step 7: Settings hooks wiring ─────────────────────────────────────────
	const settingsPath = path.join(dir, ".claude", "settings.json");
	try {
		const mergeResult = mergeForgeHooks(settingsPath);
		if (mergeResult.outcome === "created" || mergeResult.outcome === "merged") {
			created.push(settingsPath);
		} else if (mergeResult.outcome === "already-present") {
			skipped.push(settingsPath);
		} else if (mergeResult.outcome === "error") {
			warnings.push(`settings-merge non-fatal: ${mergeResult.warning ?? "unknown error"}`);
		}
	} catch (err: unknown) {
		const e = err as { message?: string };
		warnings.push(`settings-merge non-fatal: ${e.message ?? String(err)}`);
	}

	// ── Step 8: .gitignore append ─────────────────────────────────────────────
	const gitignorePath = path.join(dir, ".gitignore");
	try {
		const gitignoreOutcome = updateGitignorePure(gitignorePath);
		if (gitignoreOutcome === "appended") {
			created.push(gitignorePath);
		} else if (gitignoreOutcome === "already-present" || gitignoreOutcome === "absent") {
			// absent = no .gitignore, skipped silently; already-present = idempotent skip
		} else if (gitignoreOutcome === "error") {
			warnings.push("gitignore-update non-fatal: could not update .gitignore — update manually.");
		}
	} catch (err: unknown) {
		const e = err as { message?: string };
		warnings.push(`gitignore-update non-fatal: ${e.message ?? String(err)}`);
	}

	// ── Step 9: Preflight check ───────────────────────────────────────────────
	const preflightResult = runPreflight();
	preflight.claudeAvailable = preflightResult.claudeAvailable;
	preflight.workflowToolChecked = preflightResult.workflowToolChecked;
	preflight.warnings = preflightResult.warnings;
	// Propagate preflight warnings to top-level warnings (non-fatal)
	for (const w of preflightResult.warnings) {
		warnings.push(w);
	}

	return { ok: true, created, skipped, warnings, preflight };
}
