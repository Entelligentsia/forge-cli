// Shared screen rendering utilities — windowList, formatOverride, search helpers, and themed helpers.
// Split from screens.ts (Phase 1). Phase 3: theming applied to all visible strings.

import type { ConfigTuiState } from "../state/model.js";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, Key, matchesKey } from "@earendil-works/pi-tui";
import { authBadge, muted, rule as themedRule, error as themedError, truncateLines } from "../theme.js";

/** Themed horizontal rule spanning the full width. */
export function rule(width: number, theme: Theme): string {
  return themedRule(width, theme);
}

/**
 * Compute a windowed slice of `items` around `cursor` so that long lists fit
 * inside `maxRows`. Returns the visible items, their absolute start index,
 * and scroll indicator counts. Default window: 10 rows.
 */
export function windowList<T>(
  items: T[],
  cursor: number,
  maxRows = 10,
): { visible: T[]; start: number; aboveCount: number; belowCount: number } {
  if (items.length <= maxRows) {
    return { visible: items, start: 0, aboveCount: 0, belowCount: 0 };
  }
  // Keep cursor in the middle when possible.
  const half = Math.floor(maxRows / 2);
  let start = Math.max(0, cursor - half);
  if (start + maxRows > items.length) start = items.length - maxRows;
  return {
    visible: items.slice(start, start + maxRows),
    start,
    aboveCount: start,
    belowCount: items.length - start - maxRows,
  };
}

export function authBadgeFor(state: ConfigTuiState, provider: string, theme: Theme): string {
  return authBadge(state.authenticatedProviders.includes(provider), theme);
}

export function authStatusLine(state: ConfigTuiState, theme: Theme): string {
  // If auth discovery failed entirely, surface the error.
  if (state.authError) {
    return themedError(`  Auth error   ${state.authError}`, theme);
  }
  // Stable ordering: alphabetical by provider name.
  const providers = [...new Set([
    ...state.authenticatedProviders,
    ...state.availableModels.map((m) => m.provider),
  ])].sort();
  if (providers.length === 0) return muted("  Auth status   (no providers detected)", theme);
  const cells = providers.map((p) => `${p} ${authBadgeFor(state, p, theme)}`);
  return muted(`  Auth status   ${cells.join("   ")}`, theme);
}

export function resolvedSummary(state: ConfigTuiState, theme: Theme): string {
  const personas = listResolvedPersonasInner(state);
  if (personas.length === 0) {
    return muted("  Resolved      all personas inherit pi current model", theme);
  }
  const routable = personas.filter((p) =>
    state.availableModels.some((m) => m.provider === p.provider && m.id === p.model),
  ).length;
  const total = personas.length;
  return muted(`  Resolved      ${total} persona-model assignment${total === 1 ? "" : "s"} · ${routable} routable`, theme);
}

function listResolvedPersonasInner(state: ConfigTuiState) {
  const out = new Map<string, { persona: string; provider: string; model: string; source: string }>();
  const projectMap = state.buffer.project["persona-models"] ?? {};
  const globalMap = state.buffer.global["persona-models"] ?? {};
  for (const [persona, entry] of Object.entries(globalMap)) {
    out.set(persona, { persona, provider: entry.provider, model: entry.model, source: "L1" });
  }
  for (const [persona, entry] of Object.entries(projectMap)) {
    out.set(persona, { persona, provider: entry.provider, model: entry.model, source: "L2" });
  }
  return [...out.values()].sort((a, b) => a.persona.localeCompare(b.persona));
}

export function formatOverride(override: string | { provider: string; model: string } | undefined): string {
  if (override === undefined) return "(none)";
  if (typeof override === "string") return `"${override}"`;
  return `{${override.provider}:${override.model}}`;
}

/** Render the four-rule cascade footer in plain English.
 *  This is the "How models get picked" section from Screen 3. */
export function cascadeFooter(width: number, theme: Theme): string[] {
  const m = (text: string) => theme.fg("muted", text);
  const a = (text: string) => theme.fg("accent", text);
  return [
    "",
    a("How models get picked"),
    theme.fg("border", "─".repeat(Math.max(1, width))),
    m("Each step's persona looks for an override at four levels (most specific wins):"),
    m(" 1. A model set just for this step             ") + a("(Step override)"),
    m(" 2. A model set just for this persona          ") + a("(Per-persona override)"),
    m(" 3. The tier baseline you set above            ") + a("(Heavy / Standard / Light)"),
    m(" 4. Whatever model pi is currently running on  ") + m("(falls back automatically)"),
  ];
}

/** Render a tier badge like "Heavy", "Standard", "Light" in themed color. */
export function tierBadge(tier: "heavy" | "standard" | "light", theme: Theme): string {
  const labels: Record<string, string> = { heavy: "Heavy", standard: "Standard", light: "Light" };
  return theme.fg("accent", labels[tier] ?? tier);
}

/** Width-safe final guard: truncate every line to the given terminal width. */
export function safeLines(lines: string[], width: number): string[] {
  return truncateLines(lines, width);
}

// ── Search / filter helpers ──────────────────────────────────────────────────

/**
 * Filter a list of items using fuzzy search.
 * When `query` is empty, returns items unfiltered (original order).
 * When non-empty, returns items matching the fuzzy query (best matches first).
 */
export function filterWithSearch<T>(
  items: T[],
  query: string,
  getText: (item: T) => string,
): T[] {
  if (!query) return items;
  return fuzzyFilter(items, query, getText);
}

/**
 * Render the search/filter input line.
 * Shows a prompt, the current query, a block cursor, and a hint when empty.
 */
export function renderFilterLine(query: string, theme: Theme): string {
  const prompt = theme.fg("accent", "  Filter: ");
  const display = query || "";
  const cursor = theme.fg("accent", "▏");
  const hint = query ? "" : theme.fg("muted", " type to search…");
  return `${prompt}${display}${cursor}${hint}`;
}

/**
 * Render search result count line.
 */
export function renderResultCount(shown: number, total: number, theme: Theme): string {
  if (shown === total) return "";
  return theme.fg("muted", `  Showing ${shown} of ${total}`);
}

/**
 * Determine if a raw key event represents a printable character suitable for
 * appending to a search query. Excludes control sequences, ESC sequences,
 * and other non-printable input.
 */
export function isPrintableInput(data: string): boolean {
  if (data.length === 0) return false;
  if (data.length === 1) {
    const code = data.charCodeAt(0);
    // Printable ASCII: space (0x20) through tilde (0x7e), excluding DEL (0x7f)
    return code >= 0x20 && code <= 0x7e;
  }
  // Multi-byte sequences that don't start with ESC are likely UTF-8 printable chars
  return data.charCodeAt(0) !== 0x1b;
}

/**
 * Process a search key event and return the updated query, or undefined if
 * the key is not search-related.
 *
 * - Printable characters: append to query
 * - Backspace: remove last character
 * - Ctrl+U / Ctrl+W: clear entire query
 *
 * Returns the new query string, or `undefined` if the key isn't a search action.
 */
export function handleSearchKey(currentQuery: string, data: string): string | undefined {
  // Backspace: delete last char
  if (matchesKey(data, Key.backspace)) {
    return currentQuery.length > 0 ? currentQuery.slice(0, -1) : "";
  }
  // Ctrl+U: clear entire query
  if (matchesKey(data, "ctrl+u") || matchesKey(data, "ctrl+w")) {
    return "";
  }
  // Printable character: append to query
  if (isPrintableInput(data)) {
    return currentQuery + data;
  }
  // Not a search key
  return undefined;
}