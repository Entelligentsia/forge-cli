import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { keyHint, keyText, rawKeyHint } from "@earendil-works/pi-coding-agent";
import type { AppKeybinding, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

// Re-implement ExpandableText since it's not exported
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

export function createForgeHeader(versions: { cliVersion: string; bundledForgeVersion: string; piVersion: string }) {
	return (_tui: unknown, theme: Theme): Component & { dispose?(): void } => {
		const container = new Container();

		const asciiLogo = [
			"  ___ ___  ___  ___ ___ ",
			" | __/ _ \\| _ \\/ __| __|",
			" | _| (_) |   / (_ | _| ",
			" |_| \\___/|_|_\\___|___| "
		].map(line => theme.bold(theme.fg("accent", line))).join("\n");

		const logo = asciiLogo + "\n\n" + theme.bold(theme.fg("accent", "Forge")) + theme.fg("dim", ` v${versions.cliVersion}`);
		const subVersions = theme.fg("dim", `(forgecli v${versions.cliVersion}, forge-plugin v${versions.bundledForgeVersion}, pi v${versions.piVersion})`);

		// Build startup instructions using keybinding hint helpers
		const hint = (keybinding: AppKeybinding, description: string) => keyHint(keybinding, description);

		const expandedInstructions = [
			hint("app.interrupt", "to interrupt"),
			hint("app.clear", "to clear"),
			rawKeyHint(`${keyText("app.clear")} twice`, "to exit"),
			hint("app.exit", "to exit (empty)"),
			hint("app.suspend", "to suspend"),
			keyHint("tui.editor.deleteToLineEnd", "to delete to end"),
			hint("app.thinking.cycle", "to cycle thinking level"),
			rawKeyHint(`${keyText("app.model.cycleForward")}/${keyText("app.model.cycleBackward")}`, "to cycle models"),
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
		].join(theme.fg("muted", " · "));

		const compactOnboarding = theme.fg(
			"dim",
			`Press ${keyText("app.tools.expand")} to show full startup help and loaded resources.`,
		);
		
		const onboarding = theme.fg(
			"dim",
			`Pi can explain its own features and look up its docs. Ask it how to use or extend Pi.`,
		);

		const builtInHeader = new ExpandableText(
			() => `${logo} ${subVersions}\n${compactInstructions}\n${compactOnboarding}\n\n${onboarding}`,
			() => `${logo} ${subVersions}\n${expandedInstructions}\n\n${onboarding}`,
			false, // Assume collapsed by default initially
			1,
			0,
		);

		container.addChild(new Spacer(1));
		container.addChild(builtInHeader);
		container.addChild(new Spacer(1));

		return container;
	};
}
