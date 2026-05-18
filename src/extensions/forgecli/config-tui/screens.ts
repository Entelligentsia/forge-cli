// Pure screen renderers for the config TUI. Each function takes
// state + width and returns lines (string[]). No I/O, no terminal escapes,
// no theme-aware styling — those wrap the output at the Component layer.
//
// Plan 16 Slice 4b.

import type { AvailableModel, ConfigTuiState, View } from "./state.js";
import { getActiveView, listResolvedPersonas } from "./state.js";

const RULE = "─";

function rule(width: number): string {
  return RULE.repeat(Math.max(0, width));
}

function padRight(text: string, width: number): string {
  if (text.length >= width) return text;
  return text + " ".repeat(width - text.length);
}

function authBadgeFor(state: ConfigTuiState, provider: string): string {
  return state.authenticatedProviders.includes(provider) ? "✓" : "✗";
}

function authStatusLine(state: ConfigTuiState): string {
  // Stable ordering: alphabetical by provider name.
  const providers = [...new Set([
    ...state.authenticatedProviders,
    ...state.availableModels.map((m) => m.provider),
  ])].sort();
  if (providers.length === 0) return "  Auth status   (no providers detected)";
  const cells = providers.map((p) => `${p} ${authBadgeFor(state, p)}`);
  return `  Auth status   ${cells.join("   ")}`;
}

function resolvedSummary(state: ConfigTuiState): string {
  const personas = listResolvedPersonas(state);
  if (personas.length === 0) {
    return `  Resolved      all personas inherit pi current model`;
  }
  const routable = personas.filter((p) =>
    state.availableModels.some((m) => m.provider === p.provider && m.id === p.model),
  ).length;
  const total = personas.length;
  return `  Resolved      ${total} persona-model assignment${total === 1 ? "" : "s"} · ${routable} routable`;
}

// ── Screen 1 — Top menu ─────────────────────────────────────────────────────

export function renderTopMenu(state: ConfigTuiState, width: number): string[] {
  const view = getActiveView(state);
  const lines: string[] = [];

  // Header strip
  lines.push("forge config");
  lines.push(rule(width));
  lines.push(authStatusLine(state));
  lines.push(resolvedSummary(state));
  lines.push("");

  if (view.kind === "empty-state" || state.isEmpty) {
    // Empty state — both files absent
    lines.push(`  No forge-cli config files found.`);
    lines.push(`    Global:  ~/.pi/agent/forge-cli/config.json`);
    lines.push(`    Project: ${state.cwd}/.pi/forge-cli/config.json`);
    lines.push("");
    lines.push(`  Every Forge persona will run on pi's currently-running model.`);
    lines.push(`  To customise:`);
    lines.push("");
    lines.push(`  ▸ 1. Add a persona-model assignment   (creates a config file)`);
    lines.push(`    2. Show resolved (read-only view)`);
    lines.push(`    q. Quit`);
  } else {
    const personas = listResolvedPersonas(state);
    const globalCount = Object.keys(state.buffer.global["persona-models"] ?? {}).length;
    const projectCount = Object.keys(state.buffer.project["persona-models"] ?? {}).length;
    const pipelineHas = Object.keys(state.buffer.project.pipelines ?? {}).length;

    lines.push(`  ▸ 1. Personas                              ${personas.length} defined  (${globalCount} global · ${projectCount} project)`);
    lines.push(`    2. Per-phase overrides                          ${pipelineHas > 0 ? `${pipelineHas} pipeline${pipelineHas === 1 ? "" : "s"}` : "0 set"}`);
    lines.push(`    3. Show resolved (per pipeline, per phase)`);
    if (state.pipelineCatalogue) {
      lines.push(`    4. Pipelines                              ${state.pipelineCatalogue.length} known  (read from .forge)`);
    }
    lines.push(`    5. Forge plugin config (read-only)`);
    lines.push(`    q. Quit`);
  }

  lines.push("");
  lines.push(`  ↑/↓ select   enter open   ? help`);
  if (state.dirty) lines.push(`  * unsaved`);
  return lines;
}

// ── Screen 7 (variant) — Empty state — handled inline by renderTopMenu ───────
// renderEmptyState is just renderTopMenu with isEmpty=true; kept as a named
// export for callers that want to be explicit.

export function renderEmptyState(state: ConfigTuiState, width: number): string[] {
  // Force the "empty" branch even if buffer subsequently grew.
  const stateForRender: ConfigTuiState = { ...state, isEmpty: true };
  return renderTopMenu(stateForRender, width);
}

// ── Screen 8 — No project ───────────────────────────────────────────────────

export function renderNoProject(state: ConfigTuiState, width: number): string[] {
  const lines: string[] = [];
  lines.push("forge config");
  lines.push(rule(width));
  lines.push(`  No project root found (no .forge/ at cwd).`);
  lines.push("");
  lines.push(`  Editing global config only:`);
  lines.push(`    ~/.pi/agent/forge-cli/config.json`);
  lines.push("");
  const globalCount = Object.keys(state.buffer.global["persona-models"] ?? {}).length;
  lines.push(`  ▸ 1. Personas (global)                              ${globalCount} defined`);
  lines.push(`    2. Show resolved                                  N/A — no pipeline catalogue`);
  lines.push(`    q. Quit`);
  return lines;
}

// ── Screen 2 — Personas list ────────────────────────────────────────────────

export function renderPersonasList(state: ConfigTuiState, width: number): string[] {
  const view = getActiveView(state);
  if (view.kind !== "personas-list") {
    return ["(renderPersonasList called with wrong active view)"];
  }
  const personas = listResolvedPersonas(state);
  const lines: string[] = [];
  lines.push(`forge config › personas`);
  lines.push(rule(width));

  if (personas.length === 0) {
    lines.push(`  (no persona-model assignments)`);
    lines.push(`  n new persona-model assignment   esc back`);
    return lines;
  }

  const personaCol = Math.max(
    7,
    ...personas.map((p) => p.persona.length),
  );
  const modelCol = Math.max(
    16,
    ...personas.map((p) => `${p.provider}:${p.model}`.length),
  );

  lines.push(`  ${padRight("PERSONA", personaCol)}  ${padRight("PROVIDER:MODEL", modelCol)}  SOURCE  AVAIL`);
  personas.forEach((p, i) => {
    const cursor = i === view.cursor ? "▸" : " ";
    const modelStr = `${p.provider}:${p.model}`;
    const avail = state.availableModels.some(
      (m) => m.provider === p.provider && m.id === p.model,
    )
      ? "✓"
      : "✗";
    const sourceCol = p.source.replace(/-(L1|L2)$/, " ($1)");
    lines.push(
      `  ${cursor} ${padRight(p.persona, personaCol)}  ${padRight(modelStr, modelCol)}  ${padRight(sourceCol, 8)} ${avail}`,
    );
  });

  // Catalogue context
  const assignedSet = new Set(personas.map((p) => p.persona));
  const unassignedFromCatalogue = state.personaCatalogue.filter(
    (p) => !assignedSet.has(p),
  );
  if (unassignedFromCatalogue.length > 0) {
    lines.push("");
    lines.push(`  Personas with no assignment (use 'default'):`);
    lines.push(`    ${unassignedFromCatalogue.join(", ")}`);
  }

  const orphans = personas
    .map((p) => p.persona)
    .filter((p) => p !== "default" && !state.personaCatalogue.includes(p));
  if (orphans.length > 0) {
    lines.push("");
    lines.push(`  ⚠ Not in Forge persona catalogue:`);
    lines.push(`    ${orphans.join(", ")}`);
  }

  lines.push("");
  lines.push(`  enter edit   n new   d delete (in current layer)   esc back`);
  if (state.dirty) lines.push(`  * unsaved`);
  return lines;
}

// ── Screen 3a — Persona editor — pick provider ──────────────────────────────

function renderPersonaEditorHeader(persona: string, width: number): string[] {
  const out: string[] = [];
  out.push(`forge config › personas › ${persona}`);
  out.push(rule(width));
  return out;
}

function uniqueProviders(state: ConfigTuiState): string[] {
  const providers = new Set<string>();
  for (const m of state.availableModels) providers.add(m.provider);
  for (const p of state.authenticatedProviders) providers.add(p);
  return [...providers].sort();
}

export function renderPersonaEditor(state: ConfigTuiState, width: number): string[] {
  const view = getActiveView(state);
  if (view.kind !== "persona-editor") {
    return ["(renderPersonaEditor called with wrong active view)"];
  }
  const lines = renderPersonaEditorHeader(view.persona, width);
  const inCatalogue = state.personaCatalogue.includes(view.persona) || view.persona === "default";

  if (view.step === "pick-provider") {
    lines.push(`  Step 1 of 3 — pick provider`);
    if (!inCatalogue) {
      lines.push(`  ⚠ '${view.persona}' is not in the Forge persona catalogue.`);
    }
    lines.push("");
    lines.push(`  Provider                                                  AUTH`);
    for (const p of uniqueProviders(state)) {
      const auth = authBadgeFor(state, p);
      lines.push(`    ${padRight(p, 56)}${auth}`);
    }
    lines.push("");
    lines.push(`  ↑/↓ select   enter advance   esc back`);
  } else if (view.step === "pick-model") {
    lines.push(`  Step 2 of 3 — pick model (provider: ${view.provider ?? "(unknown)"})`);
    lines.push("");
    const models = state.availableModels.filter((m) => m.provider === view.provider);
    if (models.length === 0) {
      lines.push(`  No models available for this provider.`);
      lines.push(`  (Run \`pi /login ${view.provider}\` then return.)`);
    } else {
      for (const m of models) {
        lines.push(`    ${m.id}`);
      }
    }
    lines.push("");
    lines.push(`  ↑/↓ select   enter advance   esc back`);
  } else {
    lines.push(`  Step 3 of 3 — pick write target`);
    lines.push("");
    lines.push(`  ${view.persona} → ${view.provider}:${view.model}`);
    lines.push("");
    lines.push(`  ▸ Project   ${state.cwd}/.pi/forge-cli/config.json`);
    lines.push(`    Global    ~/.pi/agent/forge-cli/config.json`);
    lines.push("");
    lines.push(`  enter confirm and write   esc cancel`);
  }

  if (state.dirty) lines.push(`  * unsaved`);
  return lines;
}

// ── Top-level router ─────────────────────────────────────────────────────────

export function renderActive(state: ConfigTuiState, width: number): string[] {
  const view = getActiveView(state);
  switch (view.kind) {
    case "no-project":
      return renderNoProject(state, width);
    case "empty-state":
      return renderEmptyState(state, width);
    case "top-menu":
      return renderTopMenu(state, width);
    case "personas-list":
      return renderPersonasList(state, width);
    case "persona-editor":
      return renderPersonaEditor(state, width);
    default: {
      const _exhaustive: never = view;
      void _exhaustive;
      return [];
    }
  }
}
