## @entelligentsia/forgecli

Forge SDLC on the [pi-coding-agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) runtime. Three bin aliases: `forge`, `forgecli`, `4ge`.

Bundled Forge plugin: **v0.40.3**.
Bundled pi runtime: pinned in `package.json`.

## Install

```sh
npm install -g @entelligentsia/forgecli
```

Requires Node 20+.

## Quick start

```sh
cd your-project
forge                # launch interactive session (forge | forgecli | 4ge)
> /forge:init        # bootstrap Forge SDLC — 4 phases, ~45s
```

`/forge:init` is idempotent and resumable via `.forge/init-progress.json`. Re-running picks up where the previous run stopped.

## What `/forge:init` does

1. **Collect** — 5 parallel discovery scans → `.forge/config.json`
2. **Discover** — KB doc generation + `.forge/project-context.json`
3. **Materialize** — substitute placeholders → fully functional workflows
4. **Register** — versioning, manifest, cache, store entries

Outputs land in `.forge/{personas,skills,workflows,templates,config.json,project-context.json}` and the configured KB folder (default `engineering/`).

## CLI flags

```
forge --version              Print version triplet (forgecli, forge, pi)
forge --help                 Show forge + pi help
forge --no-update-check      Skip update check
forge --non-interactive      Bypass all Y/N gates with defaults (CI/scripted use)
forge --registry <path>      Override model registry
```

Pi flags (`-p`, `--cwd`, `--session`, `--model`, `--tools`, `--thinking`, …) are forwarded verbatim. Run `forge --help` for the full list.

## Non-interactive mode

For CI, scripts, or any context where the model cannot answer Y/N prompts:

```sh
# Using the flag
forge --non-interactive

# Using the environment variable
FORGE_YES=1 forge
```

Both activate the same bypass. When active, every Y/N gate in `/forge:init` resolves to its documented default:

| Gate | Default resolution |
|------|--------------------|
| Resume previous init? | No — delete checkpoint, start fresh |
| Pre-flight phase selector (Phase 1–4 prompt) | Skip prompt — proceed from Phase 1 |
| Knowledge base folder name | Use default `engineering/` |
| Create CLAUDE.md? | Yes — create with KB links |

## Roadmap

| Command                   | Status              |
|---------------------------|---------------------|
| `/forge:init`             | Shipped (0.2.0)     |
| Other `/forge:*` commands | Roadmap             |

Track via [issues](https://github.com/Entelligentsia/forge-cli/issues).

## Links

- Source: <https://github.com/Entelligentsia/forge-cli>
- Issues: <https://github.com/Entelligentsia/forge-cli/issues>
- Forge plugin (Claude Code): <https://github.com/Entelligentsia/forge>
- Changelog: [CHANGELOG.md](./CHANGELOG.md)

## License

MIT — see [LICENSE](./LICENSE).
