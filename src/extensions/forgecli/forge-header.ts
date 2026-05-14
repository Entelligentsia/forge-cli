// forge-header.ts — branded header component with animated startup loader.
//
// Renders an animated "kindling forge" spinner during session_start, then
// transitions to the full ANSI-Shadow logo + keybinding hints once startup
// tasks are complete. The caller calls setStartupDone() to trigger the swap.

import { Container, Loader, Spacer, Text, type TUI } from "@entelligentsia/pi-tui";
import { keyHint, keyText, rawKeyHint } from "@entelligentsia/pi-coding-agent";
import type { AppKeybinding, Theme } from "@entelligentsia/pi-coding-agent";
import type { Component } from "@entelligentsia/pi-tui";

const SPINNER_FRAMES = ["⠋", "⠙", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const LOGO_SEP_WIDTH = 46;

const LOGO_LINES = [
	"███████╗  ██████╗ ██████╗   ██████╗ ███████╗",
	"██╔════╝ ██╔═══██╗██╔══██╗ ██╔════╝ ██╔════╝",
	"█████╗   ██║   ██║██████╔╝ ██║  ███╗█████╗  ",
	"██╔══╝   ██║   ██║██╔══██╗ ██║   ██║██╔══╝  ",
	"██║      ╚██████╔╝██║  ██║ ╚██████╔╝███████╗",
	"╚═╝       ╚═════╝ ╚═╝  ╚═╝  ╚═════╝ ╚══════╝",
];

class ExpandableText extends Text {
	constructor(
		private readonly getCollapsedText: () => string,
		private readonly getExpandedText: () => string,
		expanded = false,
		paddingX = 0,
		paddingY = 0,
	) {
		super(expanded ? getExpandedText() : getCollapsedText(), paddingX, paddingY);
	}

	setExpanded(expanded: boolean): void {
		this.setText(expanded ? this.getExpandedText() : this.getCollapsedText());
	}
}

export interface ForgeHeader extends Component {
	dispose?(): void;
	setStartupDone(): void;
}

class ForgeHeaderContainer extends Container implements ForgeHeader {
	private readonly tui: TUI;
	private readonly loader: Loader;
	private readonly builtInHeader: ExpandableText;
	private done = false;

	constructor(
		tui: TUI,
		theme: Theme,
		versions: { cliVersion: string; bundledForgeVersion: string; piVersion: string },
	) {
		super();
		this.tui = tui;

		// ── Loading state ──────────────────────────────────────────────────────
		this.loader = new Loader(
			tui,
			(s) => theme.bold(theme.fg("accent", s)),
			(s) => "  " + theme.fg("muted", s),
			"kindling forge",
			{ frames: SPINNER_FRAMES, intervalMs: 80 },
		);

		// ── Static state ───────────────────────────────────────────────────────
		const asciiLogo = LOGO_LINES.map((line) => theme.bold(theme.fg("accent", line))).join("\n");
		const sep = theme.fg("dim", "─".repeat(LOGO_SEP_WIDTH));
		const versionLine =
			"  " +
			theme.bold(theme.fg("accent", "Forge")) +
			" " +
			theme.fg("dim", `v${versions.cliVersion}`) +
			"  " +
			theme.fg("dim", `(forgecli v${versions.cliVersion}, forge-plugin v${versions.bundledForgeVersion}, pi v${versions.piVersion})`);

		const logoBlock = `${asciiLogo}\n${sep}\n${versionLine}`;

		const hint = (keybinding: AppKeybinding, description: string) => keyHint(keybinding, description);
		const dot = theme.fg("muted", " · ");

		const expandedInstructions = [
			hint("app.interrupt", "to interrupt"),
			hint("app.clear", "to clear"),
			rawKeyHint(`${keyText("app.clear")} twice`, "to exit"),
			hint("app.exit", "to exit (empty)"),
			hint("app.suspend", "to suspend"),
			keyHint("tui.editor.deleteToLineEnd", "to delete to end"),
			hint("app.thinking.cycle", "to cycle thinking level"),
			rawKeyHint(
				`${keyText("app.model.cycleForward")}/${keyText("app.model.cycleBackward")}`,
				"to cycle models",
			),
			hint("app.model.select", "to select model"),
			hint("app.tools.expand", "to expand tools"),
			hint("app.thinking.toggle", "to expand thinking"),
			hint("app.editor.external", "for external editor"),
			rawKeyHint("/", "for commands"),
			rawKeyHint("!", "to run bash"),
			rawKeyHint("!!", "to run bash (no context)"),
			hint("app.message.followUp", "to queue follow-up"),
			hint("app.message.dequeue", "to edit all queued messages"),
			hint("app.clipboard.pasteImage", "to paste image"),
			rawKeyHint("drop files", "to attach"),
		].join("\n");

		const compactInstructions = [
			hint("app.interrupt", "interrupt"),
			rawKeyHint(`${keyText("app.clear")}/${keyText("app.exit")}`, "clear/exit"),
			rawKeyHint("/", "commands"),
			rawKeyHint("!", "bash"),
			hint("app.tools.expand", "more"),
		].join(dot);

		const compactOnboarding = theme.fg(
			"dim",
			`Press ${keyText("app.tools.expand")} to show full startup help and loaded resources.`,
		);
		const onboarding = theme.fg(
			"dim",
			"Pi can explain its own features and look up its docs. Ask it how to use or extend Pi.",
		);

		this.builtInHeader = new ExpandableText(
			() => `${logoBlock}\n${compactInstructions}\n${compactOnboarding}\n\n${onboarding}`,
			() => `${logoBlock}\n${expandedInstructions}\n\n${onboarding}`,
			false,
			1,
			0,
		);

		this.addChild(new Spacer(1));
		this.addChild(this.loader);
		this.addChild(new Spacer(1));
		this.loader.start();
	}

	setStartupDone(): void {
		if (this.done) return;
		this.done = true;

		this.loader.stop();
		this.clear();
		this.addChild(new Spacer(1));
		this.addChild(this.builtInHeader);
		this.addChild(new Spacer(1));
		this.tui.requestRender();
	}

	dispose(): void {
		this.loader.stop();
	}
}

export function createForgeHeader(versions: {
	cliVersion: string;
	bundledForgeVersion: string;
	piVersion: string;
}) {
	return (tui: TUI, theme: Theme): ForgeHeader => {
		return new ForgeHeaderContainer(tui, theme, versions);
	};
}
