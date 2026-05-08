# forgecli

**Status:** Stage 1 scaffold (FORGE-S15-T01). No runtime logic yet.

`forgecli` is the TypeScript port of the Forge SDLC plugin, packaged as a `pi-coding-agent` extension. It will eventually expose the same workflows, personas, and tools that live in the Claude Code Forge plugin (`forge/`), but on the pi runtime.

## Layout

```
forge-cli/
├── package.json              ← name "forgecli", ESM, peer dep on @earendil-works/pi-coding-agent ^0.73.0
├── tsconfig.json             ← strict, NodeNext, ES2022, outDir dist/
├── biome.json                ← mirrors pi-mono conventions
├── src/
│   ├── extensions/forgecli/
│   │   ├── index.ts          ← extension entrypoint (no-op stub)
│   │   ├── forge-tools.ts    ← tool registration shim
│   │   ├── forge-commands.ts ← command registration shim
│   │   ├── hook-dispatcher.ts← hook routing shim
│   │   ├── forge-root.ts     ← .forge/config.json resolver stub
│   │   └── subagent/         ← T02 vendors pi-mono subagent module here
│   └── bin/forgecli.ts       ← CLI entry stub (real impl in T03)
├── agents/                   ← reserved for generated agents
├── prompts/                  ← reserved for generated prompts
├── skills/                   ← reserved for skill defs
└── test/poc/                 ← spike tests for T04–T09
```

## Reference

- `architectural-review.md` (sibling of this README) — design decisions and constraints.
- `forge-cli-feasibility.txt` — feasibility study and PoC notes.
- `.claude/skills/forge-cli-engineer/SKILL.md` — implementer skill (boundary rules, git protocol).

## Next steps

| Task | What lands |
|---|---|
| FORGE-S15-T02 | Vendor subagent module from pi-mono |
| FORGE-S15-T03 | No-op extension entrypoint + `pi -e` smoke load |
| FORGE-S15-T04–T09 | Spike R1–R6 PoCs |
| FORGE-S15-T10 | Stage 2 gate |

## Build / verify (Stage 1)

```bash
cd forge-cli
npm install
npx tsc --noEmit
```

No runtime entrypoint is wired up yet — `npm run lint` and `npx tsc --noEmit` are the only meaningful verifications at this stage.
