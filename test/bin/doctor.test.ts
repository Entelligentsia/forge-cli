// Unit tests for forge doctor.
//
// The probe itself reads ambient state (`~/.pi/agent/auth.json`, env vars,
// models.json) — exercising those branches in a unit test requires either
// mocking pi's exports or running with a temp HOME. We do the latter via
// `PI_CODING_AGENT_DIR` so the probe sees a known-empty agent dir and we
// can assert the "no credentials" branch deterministically.
//
// Argv parsing for doctor lives in argv.test.ts.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatDoctorReport, parseDoctorArgs, runDoctorProbe } from "../../src/bin/doctor.js";

const VERSIONS = { forgeCli: "0.0.0-test", forgePlugin: "0.0.0-test", pi: "0.0.0-test" };

describe("parseDoctorArgs", () => {
	it("no args → json=false", () => {
		const r = parseDoctorArgs([]);
		expect(r).toEqual({ json: false });
	});

	it("--json → json=true", () => {
		const r = parseDoctorArgs(["--json"]);
		expect(r).toEqual({ json: true });
	});

	it("unknown arg → error", () => {
		const r = parseDoctorArgs(["--what"]);
		expect("error" in r && r.error).toMatch(/unknown argument --what/);
	});
});

describe("runDoctorProbe — empty agent dir", () => {
	let tmpAgentDir: string;
	let prevAgentDir: string | undefined;
	let prevEnvKeys: { name: string; value: string | undefined }[] = [];

	beforeEach(() => {
		tmpAgentDir = mkdtempSync(join(tmpdir(), "forge-doctor-"));
		mkdirSync(tmpAgentDir, { recursive: true });
		writeFileSync(join(tmpAgentDir, "auth.json"), "{}");

		prevAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = tmpAgentDir;

		// Strip every provider env var pi knows about so the probe sees a
		// genuinely empty environment regardless of the developer's shell.
		const providerEnvKeys = [
			"ANTHROPIC_API_KEY",
			"OPENAI_API_KEY",
			"DEEPSEEK_API_KEY",
			"GEMINI_API_KEY",
			"MISTRAL_API_KEY",
			"GROQ_API_KEY",
			"CEREBRAS_API_KEY",
			"CLOUDFLARE_API_KEY",
			"XAI_API_KEY",
			"OPENROUTER_API_KEY",
			"AI_GATEWAY_API_KEY",
			"ZAI_API_KEY",
			"OPENCODE_API_KEY",
			"HF_TOKEN",
			"FIREWORKS_API_KEY",
			"TOGETHER_API_KEY",
			"KIMI_API_KEY",
			"MINIMAX_API_KEY",
			"MINIMAX_CN_API_KEY",
			"XIAOMI_API_KEY",
			"XIAOMI_TOKEN_PLAN_CN_API_KEY",
			"XIAOMI_TOKEN_PLAN_AMS_API_KEY",
			"XIAOMI_TOKEN_PLAN_SGP_API_KEY",
			"AZURE_OPENAI_API_KEY",
		];
		prevEnvKeys = providerEnvKeys.map((name) => ({ name, value: process.env[name] }));
		for (const { name } of prevEnvKeys) delete process.env[name];
	});

	afterEach(() => {
		if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prevAgentDir;

		for (const { name, value } of prevEnvKeys) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}

		rmSync(tmpAgentDir, { recursive: true, force: true });
	});

	it("reports no credentials and emits guidance referencing pi /login", async () => {
		const report = await runDoctorProbe(VERSIONS);
		expect(report.auth.stored).toEqual([]);
		expect(report.auth.configured).toEqual([]);
		expect(report.models.available).toBe(0);
		expect(report.status).toBe("no-credentials");
		expect(report.guidance).toBeDefined();
		expect(report.guidance!).toMatch(/\/login/);
	});

	it("formatDoctorReport renders human-readable summary with status line", async () => {
		const report = await runDoctorProbe(VERSIONS);
		const text = formatDoctorReport(report);
		expect(text).toMatch(/forge doctor/);
		expect(text).toMatch(/Status: NO-CREDENTIALS/);
		expect(text).toMatch(/\/login/);
	});

	it("propagates version triplet into the report", async () => {
		const report = await runDoctorProbe(VERSIONS);
		expect(report.forgeCli).toBe("0.0.0-test");
		expect(report.forgePlugin).toBe("0.0.0-test");
		expect(report.pi).toBe("0.0.0-test");
	});
});
