import { defineConfig } from "vitest/config";

// Explicit test discovery for forge-cli (FORGE-S25-T02, finding ST-6).
//
// Vitest's default glob would pick up test/poc/spike-r{3,4,5,6}/run.spec.ts
// automatically. Those are spike artefacts, not part of the project test
// surface. This config narrows discovery to the genuine test trees AND adds
// an explicit exclude — defence in depth.
//
// Policy (see forge-cli/CLAUDE.md § Test-suite policy):
//   - Genuine specs live under test/*.test.ts, test/bin, and
//     test/extensions/forgecli subtrees.
//   - Spikes live under test/poc/<name>/ while active, then move to
//     test/.archive/spikes/<name>/ (excluded here).
//   - The e2e gate (test/e2e/smoke.sh) is driven by `npm run test:e2e`,
//     not vitest.
//   - Adding a new test category requires extending test.include below.
export default defineConfig({
	test: {
		environment: "node",
		// Sandbox ~/.pi/forge-cli for every test file — see test/setup/forge-cli-home.ts.
		setupFiles: ["test/setup/forge-cli-home.ts"],
		include: [
			"test/*.test.ts",
			"test/bin/**/*.test.ts",
			"test/extensions/forgecli/**/*.test.ts",
		],
		exclude: [
			"test/poc/**",
			"test/.archive/**",
			"test/e2e/**",
			"test/fixtures/**",
			"node_modules/**",
			"dist/**",
		],
	},
});
