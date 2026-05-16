# CLI reference

## Flags

```
forge --version              Print version triplet (forgecli, forge, pi)
forge --help                 Show forge + pi help
forge --no-update-check      Skip update check
forge --non-interactive      Bypass all Y/N gates with defaults (CI/scripted use)
forge --registry <path>      Override model registry
```

Pi flags (`-p`, `--cwd`, `--session`, `--model`, `--tools`, `--thinking`, …) are forwarded verbatim. Run `forge --help` for the full pi flag list.

## Bin aliases

`forge`, `forgecli`, and `4ge` are three names for the same binary. Pick the one your fingers prefer.

## What `/forge:init` does (in detail)

1. **Collect** — 5 parallel discovery scans → `.forge/config.json`
2. **Discover** — KB doc generation + `.forge/project-context.json`
3. **Materialize** — substitute placeholders → fully functional workflows
4. **Register** — versioning, manifest, cache, store entries

Outputs land in `.forge/{personas,skills,workflows,templates,config.json,project-context.json}` and the configured KB folder (default `engineering/`).

`/forge:init` is idempotent and resumable via `.forge/init-progress.json`. Re-running picks up where the previous run stopped.

## Slash-command surface

See the [README](../README.md#commands) for a categorized list.

For each command's full markdown source (the prompt that gets dispatched), look under the bundled forge plugin:

```
~/.nvm/versions/node/<node>/lib/node_modules/@entelligentsia/forgecli/dist/forge-payload/commands/
```

Or the per-project sprint workflow commands at:

```
<project>/.forge/workflows/
```
