// Forge-owned env-var defaults applied unconditionally at bin startup.
// Exported so the unit test can import without pulling in forge.ts side effects.

export function applyForgeOwnedEnvDefaults(): void {
	// Forge owns the update surface. Pi's bins aren't linked when forgecli is
	// installed globally, so "Run pi update" advice is broken at the OS level.
	// Suppress all three pi update/changelog banners unconditionally.
	process.env.PI_SKIP_VERSION_CHECK = "1";
	process.env.PI_SKIP_PACKAGE_UPDATE_CHECK = "1";
	// forge-cli has its own whats-new TUI widget (whats-new-widget.ts) that
	// covers pi + forge-plugin + forge-cli changelogs in one place.
	process.env.PI_SKIP_CHANGELOG = "1";
}
