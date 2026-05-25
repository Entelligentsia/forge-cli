// Screen interface + InputResult discriminated union.
// Phase 2: each screen module implements Screen; the orchestrator delegates
// render and handleInput to the active screen.

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ConfigTuiAction, ConfigTuiState } from "../state/model.js";

export type InputResult =
	| { kind: "consumed" } // Key handled, re-render needed
	| { kind: "no-op" } // Key not relevant
	| { kind: "dispatch"; action: ConfigTuiAction } // Emit a state action
	| { kind: "dispatch-seq"; actions: ConfigTuiAction[] } // Emit multiple state actions in order
	| { kind: "pop" } // Navigate back
	| { kind: "quit" } // Request quit
	| { kind: "error"; message: string }; // Surface an error message

export interface Screen {
	render(state: ConfigTuiState, width: number, theme: Theme): string[];
	handleInput(data: string, state: ConfigTuiState): InputResult;
}
