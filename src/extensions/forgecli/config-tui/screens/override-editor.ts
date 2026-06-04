// Override-editor screen — pick type → name|provider → model.
// Phase 3: full theming, width safety.
// Search/filter: type to fuzzy-search providers, models, or persona names.

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { resolveModelForPhase } from "../../config/model-resolver.js";
import { CANONICAL_PHASES } from "../state/constants.js";
import type { ConfigTuiState } from "../state/model.js";
import { getActiveView, listResolvedPersonas, uniqueProviders } from "../state/selectors.js";
import { accent, accentBold, dirtyMarker, muted, padRight } from "../theme.js";
import {
	authBadgeFor,
	filterWithSearch,
	handleSearchKey,
	renderFilterLine,
	renderResultCount,
	rule,
	safeLines,
	windowList,
} from "./shared.js";
import type { InputResult, Screen } from "./types.js";

export class OverrideEditorScreen implements Screen {
	render(state: ConfigTuiState, width: number, theme: Theme): string[] {
		const view = getActiveView(state);
		if (view.kind !== "override-editor") {
			return ["(renderOverrideEditor called with wrong active view)"];
		}
		const phase = CANONICAL_PHASES.find((p) => p.role === view.phaseRole);
		const phaseLabel = phase ? `${view.phaseRole} (${phase.personaNoun})` : view.phaseRole;
		const lines: string[] = [];
		lines.push(accentBold(`forge config › per-phase overrides › ${view.pipeline} › ${phaseLabel}`, theme));
		lines.push(rule(width, theme));

		if (view.step === "pick-type") {
			lines.push(accent("  Override type:", theme));
			const options = [
				"Use a persona-model by name (recommended)",
				"Inline {provider, model} pair (one-off)",
				"Clear override (fall through to persona)",
			];
			options.forEach((opt, i) => {
				const cur = i === view.cursor ? theme.fg("accent", "▸") : " ";
				lines.push(`  ${cur} ${i + 1}. ${opt}`);
			});
			lines.push("");
			lines.push(muted("  ↑/↓ select   enter advance   1-3 shortcuts   esc back", theme));
		} else if (view.step === "pick-name") {
			lines.push(accent("  Pick persona-model to use for this phase:", theme));
			const personas = listResolvedPersonas(state);
			if (personas.length === 0) {
				lines.push(muted("  (no persona-models defined — set some up via Personas first)", theme));
				lines.push("");
				lines.push(muted("  esc back", theme));
				return safeLines(lines, width);
			}
			const filtered = filterWithSearch(
				personas,
				view.searchQuery,
				(p) => `${p.persona} ${p.provider}:${p.model} ${p.provider}/${p.model}`,
			);
			const personaResolved = phase
				? resolveModelForPhase(view.pipeline, view.phaseRole, phase.personaNoun, {
						...state.buffer.global,
						...state.buffer.project,
						_global: state.buffer.global,
						_project: state.buffer.project,
					})
				: undefined;
			const personaResolvedStr = personaResolved?.model
				? `${personaResolved.model.provider}:${personaResolved.model.model}`
				: undefined;
			lines.push(renderFilterLine(view.searchQuery, theme));
			if (filtered.length === 0) {
				lines.push(muted("  No matching persona-models.", theme));
			} else {
				const win = windowList(filtered, view.cursor);
				if (win.aboveCount > 0) lines.push(muted(`    ↑ ${win.aboveCount} more above`, theme));
				win.visible.forEach((p, i) => {
					const absoluteIdx = win.start + i;
					const cur = absoluteIdx === view.cursor ? theme.fg("accent", "▸") : " ";
					const modelStr = `${p.provider}:${p.model}`;
					const avail = state.availableModels.some((m) => m.provider === p.provider && m.id === p.model)
						? theme.fg("success", "✓")
						: theme.fg("error", "✗");
					const isNoOp = personaResolvedStr === modelStr;
					const noOpHint = isNoOp ? muted("  (same as persona default — no effect)", theme) : "";
					lines.push(`  ${cur} ${padRight(p.persona, 12)} ${padRight(modelStr, 36)} ${avail}${noOpHint}`);
				});
				if (win.belowCount > 0) lines.push(muted(`    ↓ ${win.belowCount} more below`, theme));
			}
			const countLine = renderResultCount(filtered.length, personas.length, theme);
			if (countLine) lines.push(countLine);
			lines.push("");
			lines.push(muted("  ↑↓ navigate   enter select   type to filter   esc back/clear", theme));
		} else if (view.step === "pick-provider") {
			lines.push(accent("  Inline override — Step 1 of 2 — pick provider", theme));
			lines.push("");

			const providers = uniqueProviders(state);
			const filtered = filterWithSearch(providers, view.searchQuery, (p) => p);
			lines.push(renderFilterLine(view.searchQuery, theme));
			if (filtered.length === 0) {
				lines.push(muted("  No matching providers.", theme));
			} else {
				const win = windowList(filtered, view.cursor);
				if (win.aboveCount > 0) lines.push(muted(`    ↑ ${win.aboveCount} more above`, theme));
				win.visible.forEach((p, i) => {
					const absoluteIdx = win.start + i;
					const cur = absoluteIdx === view.cursor ? theme.fg("accent", "▸") : " ";
					const auth = authBadgeFor(state, p, theme);
					lines.push(`  ${cur} ${padRight(p, 56)}${auth}`);
				});
				if (win.belowCount > 0) lines.push(muted(`    ↓ ${win.belowCount} more below`, theme));
			}
			const countLine = renderResultCount(filtered.length, providers.length, theme);
			if (countLine) lines.push(countLine);
			lines.push("");
			lines.push(muted("  ↑↓ navigate   enter select   type to filter   esc back/clear", theme));
		} else if (view.step === "pick-model") {
			lines.push(accent(`  Inline override — Step 2 of 2 — pick model (provider: ${view.provider ?? "?"})`, theme));
			lines.push("");

			const models = state.availableModels.filter((m) => m.provider === view.provider);
			const filtered = filterWithSearch(models, view.searchQuery, (m) => `${m.id} ${m.provider}/${m.id}`);
			lines.push(renderFilterLine(view.searchQuery, theme));
			if (filtered.length === 0) {
				lines.push(muted("  No matching models.", theme));
				if (models.length === 0) {
					lines.push(muted(`  (Run \`pi /login ${view.provider}\` then return.)`, theme));
				}
			} else {
				const win = windowList(filtered, view.cursor);
				if (win.aboveCount > 0) lines.push(muted(`    ↑ ${win.aboveCount} more above`, theme));
				win.visible.forEach((m, i) => {
					const absoluteIdx = win.start + i;
					const cur = absoluteIdx === view.cursor ? theme.fg("accent", "▸") : " ";
					lines.push(`  ${cur} ${m.id}`);
				});
				if (win.belowCount > 0) lines.push(muted(`    ↓ ${win.belowCount} more below`, theme));
			}
			const countLine = renderResultCount(filtered.length, models.length, theme);
			if (countLine) lines.push(countLine);
			lines.push("");
			lines.push(muted("  ↑↓ navigate   enter select   type to filter   esc back/clear", theme));
		}

		if (state.dirty) lines.push(`  ${dirtyMarker(theme)}`);
		return safeLines(lines, width);
	}

	handleInput(data: string, state: ConfigTuiState): InputResult {
		const view = getActiveView(state);
		if (view.kind !== "override-editor") return { kind: "no-op" };

		if (view.step === "pick-type") {
			return this.handlePickTypeInput(data, state, view);
		}
		if (view.step === "pick-name") {
			return this.handlePickNameInput(data, state, view);
		}
		if (view.step === "pick-provider") {
			return this.handlePickProviderInput(data, state, view);
		}
		if (view.step === "pick-model") {
			return this.handlePickModelInput(data, state, view);
		}
		return { kind: "no-op" };
	}

	private handlePickTypeInput(
		data: string,
		_state: ConfigTuiState,
		view: Extract<import("../state/model.js").View, { kind: "override-editor" }>,
	): InputResult {
		if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
			return { kind: "dispatch", action: { kind: "cursor-move", delta: -1 } };
		}
		if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
			if (view.cursor < 2) return { kind: "dispatch", action: { kind: "cursor-move", delta: 1 } };
			return { kind: "consumed" };
		}
		const advance = (idx: number): InputResult => {
			if (idx === 0) {
				return { kind: "dispatch", action: { kind: "set-override-step", step: "pick-name" } };
			}
			if (idx === 1) {
				return { kind: "dispatch", action: { kind: "set-override-step", step: "pick-provider" } };
			}
			// idx === 2: clear override
			return {
				kind: "dispatch",
				action: {
					kind: "clear-phase-override",
					pipeline: view.pipeline,
					phaseRole: view.phaseRole,
				},
			};
		};
		if (matchesKey(data, Key.enter)) {
			return advance(view.cursor);
		}
		if (matchesKey(data, "1")) return advance(0);
		if (matchesKey(data, "2")) return advance(1);
		if (matchesKey(data, "3")) return advance(2);
		return { kind: "no-op" };
	}

	private handlePickNameInput(
		data: string,
		state: ConfigTuiState,
		view: Extract<import("../state/model.js").View, { kind: "override-editor" }>,
	): InputResult {
		const personas = listResolvedPersonas(state);
		const filtered = filterWithSearch(
			personas,
			view.searchQuery,
			(p) => `${p.persona} ${p.provider}:${p.model} ${p.provider}/${p.model}`,
		);

		// Search input: backspace, ctrl+u/w, printable chars
		const searchResult = handleSearchKey(view.searchQuery, data);
		if (searchResult !== undefined) {
			return { kind: "dispatch", action: { kind: "set-search", query: searchResult } };
		}

		// Escape: clear filter if present, otherwise go back
		if (matchesKey(data, Key.escape)) {
			if (view.searchQuery) {
				return { kind: "dispatch", action: { kind: "set-search", query: "" } };
			}
			return { kind: "no-op" }; // Let the component handle pop-view
		}

		if (matchesKey(data, Key.up)) {
			return { kind: "dispatch", action: { kind: "cursor-move", delta: -1 } };
		}
		if (matchesKey(data, Key.down)) {
			if (view.cursor < filtered.length - 1) return { kind: "dispatch", action: { kind: "cursor-move", delta: 1 } };
			return { kind: "consumed" };
		}
		if (matchesKey(data, Key.enter)) {
			const target = filtered[view.cursor];
			if (target) {
				return { kind: "dispatch", action: { kind: "commit-override-name", name: target.persona } };
			}
			return { kind: "consumed" };
		}
		return { kind: "no-op" };
	}

	private handlePickProviderInput(
		data: string,
		state: ConfigTuiState,
		view: Extract<import("../state/model.js").View, { kind: "override-editor" }>,
	): InputResult {
		const providers = uniqueProviders(state);
		const filtered = filterWithSearch(providers, view.searchQuery, (p) => p);

		// Search input: backspace, ctrl+u/w, printable chars
		const searchResult = handleSearchKey(view.searchQuery, data);
		if (searchResult !== undefined) {
			return { kind: "dispatch", action: { kind: "set-search", query: searchResult } };
		}

		// Escape: clear filter if present, otherwise go back
		if (matchesKey(data, Key.escape)) {
			if (view.searchQuery) {
				return { kind: "dispatch", action: { kind: "set-search", query: "" } };
			}
			return { kind: "no-op" }; // Let the component handle pop-view
		}

		if (matchesKey(data, Key.up)) {
			return { kind: "dispatch", action: { kind: "cursor-move", delta: -1 } };
		}
		if (matchesKey(data, Key.down)) {
			if (view.cursor < filtered.length - 1) return { kind: "dispatch", action: { kind: "cursor-move", delta: 1 } };
			return { kind: "consumed" };
		}
		if (matchesKey(data, Key.enter)) {
			const provider = filtered[view.cursor];
			if (provider) return { kind: "dispatch", action: { kind: "set-override-provider", provider } };
			return { kind: "consumed" };
		}
		return { kind: "no-op" };
	}

	private handlePickModelInput(
		data: string,
		state: ConfigTuiState,
		view: Extract<import("../state/model.js").View, { kind: "override-editor" }>,
	): InputResult {
		const models = state.availableModels.filter((m) => m.provider === view.provider);
		const filtered = filterWithSearch(models, view.searchQuery, (m) => `${m.id} ${m.provider}/${m.id}`);

		// Search input: backspace, ctrl+u/w, printable chars
		const searchResult = handleSearchKey(view.searchQuery, data);
		if (searchResult !== undefined) {
			return { kind: "dispatch", action: { kind: "set-search", query: searchResult } };
		}

		// Escape: clear filter if present, otherwise go back
		if (matchesKey(data, Key.escape)) {
			if (view.searchQuery) {
				return { kind: "dispatch", action: { kind: "set-search", query: "" } };
			}
			return { kind: "no-op" }; // Let the component handle pop-view
		}

		if (matchesKey(data, Key.up)) {
			return { kind: "dispatch", action: { kind: "cursor-move", delta: -1 } };
		}
		if (matchesKey(data, Key.down)) {
			if (view.cursor < filtered.length - 1) return { kind: "dispatch", action: { kind: "cursor-move", delta: 1 } };
			return { kind: "consumed" };
		}
		if (matchesKey(data, Key.enter)) {
			const target = filtered[view.cursor];
			if (target && view.provider) {
				return {
					kind: "dispatch",
					action: {
						kind: "commit-override-inline",
						provider: view.provider,
						model: target.id,
					},
				};
			}
			return { kind: "consumed" };
		}
		return { kind: "no-op" };
	}
}
