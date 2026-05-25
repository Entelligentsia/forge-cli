// Personas-list screen — renders and handles input for the persona list view.
// Phase 3: full theming, width safety, data-driven actions.

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import type { ConfigLayer } from "../../config-writer.js";
import type { ConfigTuiState, View } from "../state/model.js";
import { getActiveView, listResolvedPersonas, personaSourceLabel } from "../state/selectors.js";
import { accentBold, cursor, dirtyMarker, muted, padRight, warning } from "../theme.js";
import { PERSONA_META } from "../tier-meta.js";
import { authBadgeFor, rule, safeLines } from "./shared.js";
import type { InputResult, Screen } from "./types.js";

export class PersonasListScreen implements Screen {
	render(state: ConfigTuiState, width: number, theme: Theme): string[] {
		const view = getActiveView(state);
		if (view.kind !== "personas-list") {
			return ["(renderPersonasList called with wrong active view)"];
		}
		const personas = listResolvedPersonas(state);
		const lines: string[] = [];
		lines.push(accentBold("forge config › per-persona overrides", theme));
		lines.push(rule(width, theme));
		lines.push(muted("  Change which model runs for a specific persona.", theme));
		lines.push(muted("  Step overrides change the model for one specific step", theme));
		lines.push(muted("  of one pipeline. Most users don't need this.", theme));

		if (personas.length === 0) {
			lines.push(muted("  (no persona-model assignments)", theme));
			lines.push(muted("  n new persona-model assignment   esc back", theme));
			return safeLines(lines, width);
		}

		const personaCol = Math.max(7, ...personas.map((p) => p.persona.length));
		const modelCol = Math.max(16, ...personas.map((p) => `${p.provider}:${p.model}`.length));

		lines.push(
			`  ${muted(padRight("PERSONA", personaCol), theme)}  ${muted(padRight("PROVIDER:MODEL", modelCol), theme)}  ${muted("SOURCE", theme)}  ${muted("AVAIL", theme)}`,
		);
		personas.forEach((p, i) => {
			const cur = cursor(i === view.cursor, theme);
			const meta = PERSONA_META[p.persona];
			const emoji = meta ? `${meta.emoji} ` : "";
			const modelStr = `${p.provider}:${p.model}`;
			const avail = state.availableModels.some((m) => m.provider === p.provider && m.id === p.model)
				? authBadgeFor(state, p.provider, theme)
				: theme.fg("error", "✗");
			const sourceCol = personaSourceLabel(p.persona, p.source);
			lines.push(
				`  ${cur} ${emoji}${padRight(p.persona, personaCol)}  ${padRight(modelStr, modelCol)}  ${sourceCol} ${avail}`,
			);
		});

		// Catalogue context
		const assignedSet = new Set(personas.map((p) => p.persona));
		const unassignedFromCatalogue = state.personaCatalogue.filter((p) => !assignedSet.has(p));
		if (unassignedFromCatalogue.length > 0) {
			lines.push("");
			lines.push(muted("  Personas with no assignment (use 'default'):", theme));
			lines.push(muted(`    ${unassignedFromCatalogue.join(", ")}`, theme));
		}

		const orphans = personas
			.map((p) => p.persona)
			.filter((p) => p !== "default" && !state.personaCatalogue.includes(p));
		if (orphans.length > 0) {
			lines.push("");
			lines.push(warning(`  ⚠ Not in Forge persona catalogue:`, theme));
			lines.push(warning(`    ${orphans.join(", ")}`, theme));
		}

		lines.push("");
		lines.push(muted("  enter edit   n new   d delete (in current layer)   esc back", theme));
		if (state.dirty) lines.push(`  ${dirtyMarker(theme)}`);
		return safeLines(lines, width);
	}

	handleInput(data: string, state: ConfigTuiState): InputResult {
		const view = getActiveView(state);
		if (view.kind !== "personas-list") return { kind: "no-op" };

		if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
			return { kind: "dispatch", action: { kind: "cursor-move", delta: -1 } };
		}
		if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
			const max = Math.max(0, listResolvedPersonas(state).length - 1);
			if (view.cursor < max) return { kind: "dispatch", action: { kind: "cursor-move", delta: 1 } };
			return { kind: "consumed" };
		}
		if (matchesKey(data, Key.enter)) {
			const personas = listResolvedPersonas(state);
			const target = personas[view.cursor];
			if (target) {
				return { kind: "dispatch", action: { kind: "begin-persona-edit", persona: target.persona } };
			}
			return { kind: "consumed" };
		}
		if (matchesKey(data, "n")) {
			return { kind: "dispatch", action: { kind: "push-view", view: { kind: "persona-picker", cursor: 0 } } };
		}
		if (matchesKey(data, "d")) {
			const personas = listResolvedPersonas(state);
			const target = personas[view.cursor];
			if (target) {
				const layer: ConfigLayer = target.source.endsWith("L2") ? "project" : "global";
				return { kind: "dispatch", action: { kind: "delete-persona-entry", layer, persona: target.persona } };
			}
			return { kind: "consumed" };
		}
		return { kind: "no-op" };
	}
}
