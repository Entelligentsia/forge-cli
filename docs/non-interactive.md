# Non-interactive mode

For CI, scripts, or any context where the model cannot answer Y/N prompts:

```sh
# Using the flag
forge --non-interactive

# Using the environment variable
FORGE_YES=1 forge
```

Both activate the same bypass. When active, every Y/N gate in `/forge:init` resolves to its documented default:

| Gate                                          | Default resolution                            |
|-----------------------------------------------|-----------------------------------------------|
| Resume previous init?                         | No — delete checkpoint, start fresh           |
| Pre-flight phase selector (Phase 1–4 prompt)  | Skip prompt — proceed from Phase 1            |
| Knowledge base folder name                    | Use default `engineering/`                    |
| Create CLAUDE.md?                             | Yes — create with KB links                    |

## `forge_ask_user` behavior under non-interactive mode

The `forge_ask_user` custom tool (see [custom-tools.md](custom-tools.md)) returns the supplied `default` without rendering any TUI. Fallback defaults when no explicit `default` is provided:

- `confirm` → `"Y"`
- `choice` → `options[0]`
- `text` → `""`
