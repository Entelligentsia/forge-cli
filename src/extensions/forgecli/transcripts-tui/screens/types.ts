// Screen interface + InputResult discriminated union — same contract as
// config-tui/screens/types.ts, parameterized to the browse-TUI action type.

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { BrowseAction, BrowseState } from "../state/model.js";

export type InputResult =
	| { kind: "consumed" } // Key handled, re-render needed
	| { kind: "no-op" } // Key not relevant
	| { kind: "dispatch"; action: BrowseAction } // Emit a state action
	| { kind: "dispatch-seq"; actions: BrowseAction[] } // Emit multiple actions in order
	| { kind: "quit" } // Request quit
	| { kind: "error"; message: string }; // Surface an error message

export interface Screen {
	render(state: BrowseState, width: number, theme: Theme): string[];
	handleInput(data: string, state: BrowseState): InputResult;
}
