// Forge-owned env-var defaults applied unconditionally at bin startup.
// Exported so the unit test can import without pulling in forge.ts side effects.

export function applyForgeOwnedEnvDefaults(): void {
	// Forge owns the update banner. Pi's bins aren't linked when forgecli is
	// installed globally, so "Run pi update" / "Run pi update" advice is broken.
	// Suppress both unconditionally.
	process.env.PI_SKIP_VERSION_CHECK = "1";
	process.env.PI_SKIP_PACKAGE_UPDATE_CHECK = "1";
}
