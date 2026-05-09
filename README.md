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
forge --version            Print version triplet (forgecli, forge, pi)
forge --help               Show forge + pi help
forge --no-update-check    Skip update check
forge --registry <path>    Override model registry
```

Pi flags (`-p`, `--cwd`, `--session`, `--model`, `--tools`, `--thinking`, …) are forwarded verbatim. Run `forge --help` for the full list.

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
