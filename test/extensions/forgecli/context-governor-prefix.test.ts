// Tests for project-config-aware fact extraction and factory wiring —
// FORGE-BUG-043 PR 2 (the CART-prefix defect).
//
// Coverage:
//   extractForgeFacts prefix parameter:
//     Test 1: default prefix extracts FORGE- IDs and ignores CART- IDs
//             (documents the historical default — the defect's mechanism)
//     Test 2: prefix "CART" extracts CART- IDs and ignores FORGE- IDs
//     Test 3: bug-form IDs extracted under a custom prefix
//   extractForgeFacts engineeringPath parameter:
//     Test 4: custom engineering dir captured in fileRefs
//   buildForgeCompactionFactory config loading:
//     Test 5: factory with cwd whose .forge/config.json sets prefix CART →
//             compaction summary carries CART store IDs
//     Test 6: factory without cwd → historical FORGE default applies

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildForgeCompactionFactory,
	extractForgeFacts,
} from "../../../src/extensions/forgecli/context-governor-compaction.js";

const tmpDirs: string[] = [];

function makeProjectWithConfig(config: unknown): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "governor-prefix-test-"));
	tmpDirs.push(dir);
	fs.mkdirSync(path.join(dir, ".forge"), { recursive: true });
	fs.writeFileSync(path.join(dir, ".forge", "config.json"), JSON.stringify(config), "utf8");
	return dir;
}

afterEach(() => {
	for (const dir of tmpDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

function makeMsg(text: string) {
	return { role: "assistant", content: [{ type: "text", text }] };
}

/** Register the factory's handler on a stub pi and fire it once. */
function fireCompaction(
	factory: ReturnType<typeof buildForgeCompactionFactory>,
	messages: unknown[],
): string {
	let handler: ((event: unknown) => unknown) | undefined;
	const pi = {
		on(event: string, h: (event: unknown) => unknown) {
			if (event === "session_before_compact") handler = h;
		},
	};
	factory(pi as never);
	expect(handler).toBeDefined();
	const result = handler?.({
		preparation: {
			firstKeptEntryId: "entry-1",
			tokensBefore: 1000,
			messagesToSummarize: messages,
		},
	}) as { compaction?: { summary?: string } } | undefined;
	return result?.compaction?.summary ?? "";
}

describe("extractForgeFacts: prefix parameter (FORGE-BUG-043)", () => {
	const mixedText =
		"Working CART-S02-T03 after FORGE-S30-T09; bug CART-BUG-007 relates to FORGE-BUG-042.";

	it("Test 1: default prefix extracts FORGE- IDs and ignores CART- IDs", () => {
		const facts = extractForgeFacts([makeMsg(mixedText)]);
		expect(facts.storeIds).toContain("FORGE-S30-T09");
		expect(facts.storeIds).toContain("FORGE-BUG-042");
		expect(facts.storeIds.some((id) => id.startsWith("CART-"))).toBe(false);
	});

	it("Test 2: prefix CART extracts CART- IDs and ignores FORGE- IDs", () => {
		const facts = extractForgeFacts([makeMsg(mixedText)], { prefix: "CART" });
		expect(facts.storeIds).toContain("CART-S02-T03");
		expect(facts.storeIds).toContain("CART-BUG-007");
		expect(facts.storeIds.some((id) => id.startsWith("FORGE-"))).toBe(false);
	});

	it("Test 3: sprint-only and sprint+task forms extracted under a custom prefix", () => {
		const facts = extractForgeFacts([makeMsg("HLO-S01 then HLO-S01-T05 done")], {
			prefix: "HLO",
		});
		expect(facts.storeIds).toContain("HLO-S01-T05");
		expect(facts.storeIds).toContain("HLO-S01");
	});
});

describe("extractForgeFacts: engineeringPath parameter", () => {
	it("Test 4: custom engineering dir captured in fileRefs", () => {
		const text = "see eng/sprints/CART-S02/notes.txt and engineering/old/ref.txt";
		const facts = extractForgeFacts([makeMsg(text)], { engineeringPath: "eng" });
		expect(facts.fileRefs).toContain("eng/sprints/CART-S02/notes.txt");
		// the default "engineering/" prefix alternative is replaced, not added —
		// (the .txt path only matched via the directory alternative)
		expect(facts.fileRefs).not.toContain("engineering/old/ref.txt");
	});
});

describe("buildForgeCompactionFactory: project-config loading", () => {
	it("Test 5: cwd with prefix CART in .forge/config.json → CART IDs in summary", () => {
		const cwd = makeProjectWithConfig({ project: { prefix: "CART" } });
		const factory = buildForgeCompactionFactory({ cwd });
		const summary = fireCompaction(factory, [
			makeMsg("Implemented CART-S02-T03; superseded FORGE-S30-T09."),
		]);
		expect(summary).toContain("CART-S02-T03");
		expect(summary).not.toContain("FORGE-S30-T09");
	});

	it("Test 6: factory without cwd → historical FORGE default applies", () => {
		const factory = buildForgeCompactionFactory({});
		const summary = fireCompaction(factory, [
			makeMsg("Implemented CART-S02-T03; superseded FORGE-S30-T09."),
		]);
		expect(summary).toContain("FORGE-S30-T09");
		expect(summary).not.toContain("CART-S02-T03");
	});
});
