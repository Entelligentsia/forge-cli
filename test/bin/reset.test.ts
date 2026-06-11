// Unit tests for `4ge reset` bin subcommand (FEAT-009 — halt-recovery).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	inferKind,
	parseResetArgs,
	runReset,
} from "../../src/bin/reset.js";

describe("inferKind()", () => {
	it("classifies bug ids by the -BUG- segment", () => {
		expect(inferKind("FORGE-BUG-046")).toBe("bug");
		expect(inferKind("FORGE-S32-T03")).toBe("task");
		expect(inferKind("ACME-bug-12")).toBe("bug");
	});
});

describe("parseResetArgs()", () => {
	it("parses id + --to and infers kind", () => {
		expect(parseResetArgs(["FORGE-S32-T03", "--to", "implement"])).toEqual({
			id: "FORGE-S32-T03",
			toPhase: "implement",
			kind: "task",
		});
		expect(parseResetArgs(["FORGE-BUG-046", "--to", "triage"])).toEqual({
			id: "FORGE-BUG-046",
			toPhase: "triage",
			kind: "bug",
		});
	});

	it("honours an explicit --kind override", () => {
		expect(parseResetArgs(["X-1", "--to", "implement", "--kind", "bug"])).toEqual({
			id: "X-1",
			toPhase: "implement",
			kind: "bug",
		});
	});

	it("errors on missing id, missing --to, bad --kind, and unknown flags", () => {
		expect("error" in parseResetArgs(["--to", "implement"])).toBe(true);
		expect("error" in parseResetArgs(["FORGE-S32-T03"])).toBe(true);
		expect("error" in parseResetArgs(["FORGE-S32-T03", "--to", "implement", "--kind", "sprint"])).toBe(true);
		expect("error" in parseResetArgs(["FORGE-S32-T03", "--to", "implement", "--wat"])).toBe(true);
	});
});

describe("runReset()", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-reset-bin-"));
		// a Forge project must have .forge/tools/store-cli.cjs
		fs.mkdirSync(path.join(tmpDir, ".forge", "tools"), { recursive: true });
		fs.writeFileSync(path.join(tmpDir, ".forge", "tools", "store-cli.cjs"), "// stub", "utf8");
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	const sinks = () => {
		const out: string[] = [];
		const err: string[] = [];
		return { out, err, print: (s: string) => out.push(s), printErr: (s: string) => err.push(s) };
	};

	it("invokes reset with inferred kind and prints the resume hint on success", () => {
		const s = sinks();
		const seen: unknown[] = [];
		const code = runReset(["FORGE-S32-T03", "--to", "implement"], {
			cwd: tmpDir,
			print: s.print,
			printErr: s.printErr,
			reset: (params) => {
				seen.push(params);
				return { ok: true, role: "implement", phaseIndex: 2, preStatus: "plan-approved" };
			},
		});
		expect(code).toBe(0);
		expect(seen[0]).toMatchObject({ kind: "task", id: "FORGE-S32-T03", toPhase: "implement" });
		expect(s.out.join("\n")).toContain("rewound to 'implement'");
		expect(s.out.join("\n")).toContain("/forge:run-task FORGE-S32-T03");
	});

	it("uses the fix-bug resume hint for bugs", () => {
		const s = sinks();
		const code = runReset(["FORGE-BUG-046", "--to", "triage"], {
			cwd: tmpDir,
			print: s.print,
			printErr: s.printErr,
			reset: () => ({ ok: true, role: "triage", phaseIndex: 0, preStatus: "reported" }),
		});
		expect(code).toBe(0);
		expect(s.out.join("\n")).toContain("/forge:fix-bug FORGE-BUG-046");
	});

	it("returns 1 and reports detail when the reset fails", () => {
		const s = sinks();
		const code = runReset(["FORGE-S32-T03", "--to", "implement"], {
			cwd: tmpDir,
			print: s.print,
			printErr: s.printErr,
			reset: () => ({ ok: false, detail: "illegal transition" }),
		});
		expect(code).toBe(1);
		expect(s.err.join("\n")).toContain("illegal transition");
	});

	it("returns 1 when not in a Forge project (no store-cli)", () => {
		const s = sinks();
		const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-reset-empty-"));
		try {
			const code = runReset(["FORGE-S32-T03", "--to", "implement"], {
				cwd: emptyDir,
				print: s.print,
				printErr: s.printErr,
				reset: () => ({ ok: true }),
			});
			expect(code).toBe(1);
			expect(s.err.join("\n")).toContain("no Forge project");
		} finally {
			fs.rmSync(emptyDir, { recursive: true, force: true });
		}
	});
});
