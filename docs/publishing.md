# Publishing

> Contributor-facing. End users don't need this.

After every `npm publish`, run the post-publish verifier to confirm the registry reflects the new version and `dist-tags.latest` is updated:

```sh
node scripts/verify-publish.cjs --version <VERSION>
```

## Options

```
--version <VERSION>    Required. The version just published.
--package <PKG>        Package name (default: reads from package.json).
--allow-non-latest     Warn instead of fail when dist-tags.latest != VERSION.
--root <path>          Root directory for package.json lookup (default: cwd).
```

## Checks

The script runs two checks:

1. `npm view <PKG>@<VERSION> version` — asserts the trimmed output matches `<VERSION>`.
2. `npm view <PKG> dist-tags --json` — asserts `latest === <VERSION>` (hard fail unless `--allow-non-latest`).

On any npm error or version mismatch the script logs a `[warn] registry check failed` message and exits 1.

## Release flow (full)

1. Implement and test changes (`npm test`, `npx vitest run`)
2. Bump `package.json` version
3. Add a `CHANGELOG.md` entry under the new version
4. Update README Roadmap if a new "Shipped (X.Y.Z)" row applies
5. Run smoke gate: `bash test/e2e/smoke.sh`
6. Commit + push
7. `npm publish` (requires npm 2FA OTP)
8. `node scripts/verify-publish.cjs --version <VERSION>`
