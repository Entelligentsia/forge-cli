// Shared key-binding constants for config-TUI screens.
// Phase 2: centralises key names used across screen modules.
//
// All key-matching goes through pi-tui's `matchesKey` for terminal
// escape-sequence compatibility; this file provides the semantic aliases
// that screens use to avoid scattering raw string literals.

export const KEY_BINDINGS = {
  /** Navigate up / previous item */
  NAV_UP: "k" as const,
  /** Navigate down / next item */
  NAV_DOWN: "j" as const,
  /** Confirm / open */
  CONFIRM: "1" as const,
  /** Quit the TUI */
  QUIT: "q" as const,
  /** Confirm quit (y) */
  QUIT_CONFIRM: "y" as const,
  /** Cancel quit / go back (n) */
  QUIT_CANCEL: "n" as const,
  /** New persona */
  NEW: "n" as const,
  /** Delete */
  DELETE: "d" as const,
  /** Select project layer */
  LAYER_PROJECT: "p" as const,
  /** Select global layer */
  LAYER_GLOBAL: "g" as const,
  /** Show resolved */
  RESOLVED: "r" as const,
  /** Space key (for clearing overrides) */
  SPACE: " " as const,
} as const;