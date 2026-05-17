// forge doctor — preflight onboarding check.
//
// Reproduces pi's own startup auth/model probe using the exported APIs
// (runMigrations, AuthStorage, ModelRegistry, SettingsManager) so the
// user sees the same view forge will see when it later spawns pi
// non-interactively. Quotes pi's canonical guidance strings verbatim so
// the message matches what `pi -p` would print on a no-model exit.
//
// Iron-Law boundary: doctor PROBES via pi exports and FORWARDS to pi's
// `/login` / docs. It must not reimplement login, model resolution, or
// auth migration.

import {
	AuthStorage,
	formatNoModelsAvailableMessage,
	getAgentDir,
	getProviderLoginHelp,
	ModelRegistry,
	runMigrations,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

export interface DoctorReport {
	forgeCli: string;
	forgePlugin: string;
	pi: string;
	cwd: string;
	agentDir: string;
	auth: {
		stored: string[];
		configured: string[];
	};
	models: {
		total: number;
		available: number;
		samples: { provider: string; id: string }[];
	};
	settings: {
		defaultProvider: string | undefined;
		defaultModel: string | undefined;
	};
	migrations: {
		performed: string[];
		deprecationWarnings: string[];
	};
	status: "ready" | "no-credentials" | "no-models";
	guidance?: string;
}

export interface DoctorVersions {
	forgeCli: string;
	forgePlugin: string;
	pi: string;
}

/**
 * Run the doctor probe. Returns a structured report.
 *
 * Side effects: runs pi's `runMigrations(cwd)` — this is the same call pi
 * makes at startup, so doctor produces the same view pi would see. Without
 * it, users who only ever set `ANTHROPIC_API_KEY` would appear as having
 * no stored credentials, even though pi itself would migrate them on first
 * launch.
 */
export async function runDoctorProbe(versions: DoctorVersions, cwd: string = process.cwd()): Promise<DoctorReport> {
	const { migratedAuthProviders, deprecationWarnings } = runMigrations(cwd);

	const authStorage = AuthStorage.create();
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const modelRegistry = ModelRegistry.create(authStorage);

	const stored = authStorage.list();
	const all = modelRegistry.getAll();
	const available = modelRegistry.getAvailable();
	const configuredProviders = Array.from(new Set(available.map((m) => m.provider))).sort();

	const status: DoctorReport["status"] =
		available.length > 0 ? "ready" : stored.length > 0 ? "no-models" : "no-credentials";

	const report: DoctorReport = {
		forgeCli: versions.forgeCli,
		forgePlugin: versions.forgePlugin,
		pi: versions.pi,
		cwd,
		agentDir,
		auth: {
			stored,
			configured: configuredProviders,
		},
		models: {
			total: all.length,
			available: available.length,
			samples: available.slice(0, 5).map((m) => ({ provider: m.provider, id: m.id })),
		},
		settings: {
			defaultProvider: settingsManager.getDefaultProvider(),
			defaultModel: settingsManager.getDefaultModel(),
		},
		migrations: {
			performed: migratedAuthProviders,
			deprecationWarnings,
		},
		status,
	};

	if (status !== "ready") {
		report.guidance =
			status === "no-credentials"
				? `${formatNoModelsAvailableMessage()}\n\nRun \`pi\` once, log in with \`/login\`, then re-run forge.`
				: `${getProviderLoginHelp()}\n\nStored providers found (${stored.join(", ")}), but no usable model. Open \`pi\` and pick a model with \`/model\`.`;
	}

	return report;
}

/** Format a doctor report for human reading. */
export function formatDoctorReport(r: DoctorReport): string {
	const lines: string[] = [];
	lines.push("forge doctor");
	lines.push("============");
	lines.push(`forge-cli@${r.forgeCli}  forge-plugin@${r.forgePlugin}  pi@${r.pi}`);
	lines.push("");
	lines.push(`cwd: ${r.cwd}`);
	lines.push(`pi agent dir: ${r.agentDir}`);
	lines.push("");

	lines.push("Auth:");
	if (r.auth.stored.length === 0) {
		lines.push("  (no providers in auth.json)");
	} else {
		for (const p of r.auth.stored) lines.push(`  ✓ ${p} (stored)`);
	}
	const envOnly = r.auth.configured.filter((p) => !r.auth.stored.includes(p));
	for (const p of envOnly) lines.push(`  ✓ ${p} (environment / runtime)`);
	lines.push("");

	lines.push(`Models: ${r.models.available}/${r.models.total} have auth configured`);
	for (const m of r.models.samples) lines.push(`  • ${m.provider}/${m.id}`);
	if (r.models.available > r.models.samples.length) {
		lines.push(`  … ${r.models.available - r.models.samples.length} more`);
	}
	lines.push("");

	lines.push("Settings:");
	lines.push(`  default provider: ${r.settings.defaultProvider ?? "(unset)"}`);
	lines.push(`  default model:    ${r.settings.defaultModel ?? "(unset)"}`);
	lines.push("");

	if (r.migrations.performed.length > 0) {
		lines.push(`Migrations performed: ${r.migrations.performed.join(", ")}`);
	}
	if (r.migrations.deprecationWarnings.length > 0) {
		lines.push("Deprecation warnings:");
		for (const w of r.migrations.deprecationWarnings) lines.push(`  ⚠ ${w}`);
	}
	if (r.migrations.performed.length > 0 || r.migrations.deprecationWarnings.length > 0) {
		lines.push("");
	}

	lines.push(`Status: ${r.status.toUpperCase()}`);
	if (r.guidance) {
		lines.push("");
		lines.push(r.guidance);
	}
	return lines.join("\n");
}

export interface DoctorOptions {
	json: boolean;
}

export function parseDoctorArgs(args: readonly string[]): DoctorOptions | { error: string } {
	let json = false;
	for (const arg of args) {
		if (arg === "--json") {
			json = true;
			continue;
		}
		return { error: `forge doctor: unknown argument ${arg}. Supported: --json` };
	}
	return { json };
}

/**
 * Entry point invoked from `bin/forge.ts`. Returns the process exit code.
 *
 * Exit code: 0 when status === "ready", else 1 — matches pi's own
 * non-interactive `formatNoModelsAvailableMessage` exit semantics.
 */
export async function runDoctor(args: readonly string[], versions: DoctorVersions): Promise<number> {
	const parsed = parseDoctorArgs(args);
	if ("error" in parsed) {
		process.stderr.write(`${parsed.error}\n`);
		return 1;
	}

	const report = await runDoctorProbe(versions);

	if (parsed.json) {
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	} else {
		process.stdout.write(`${formatDoctorReport(report)}\n`);
	}
	return report.status === "ready" ? 0 : 1;
}
