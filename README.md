<div align="center">

<img src="https://raw.githubusercontent.com/Entelligentsia/forge-cli/main/.github/hero.png" alt="forge-cli — engineering software" width="100%"/>

<br>

[![npm](https://img.shields.io/npm/v/@entelligentsia/forgecli?style=flat-square&color=000&label=npm)](https://www.npmjs.com/package/@entelligentsia/forgecli)
[![node](https://img.shields.io/badge/node-%E2%89%A520-000?style=flat-square)](#)
[![license](https://img.shields.io/badge/license-MIT-000?style=flat-square)](#)
[![forge plugin](https://img.shields.io/badge/forge--plugin-v0.43.16-000?style=flat-square&labelColor=fafafa)](https://github.com/Entelligentsia/forge)
[![pi runtime](https://img.shields.io/badge/runtime-pi--coding--agent-000?style=flat-square)](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)

</div>

> **engineering software** — a coding harness for agents.
> Three aliases: `forge` · `forgecli` · `4ge`.

forge-cli generates a project-specific engineering knowledge base, sprint workflows, agent personas, and an SDLC pipeline — then drives them from your terminal on the [pi-coding-agent] runtime. Model-agnostic. No editor lock-in.

## Why

- **Structured SDLC, in any terminal.** Plan → implement → review → validate → commit chains, gated by your own personas and audience rules.
- **Project memory that compounds.** Every sprint sharpens the knowledge base; the next one starts smarter.
- **Bring your own model.** Anthropic, OpenAI, ollama, openrouter — anything pi resolves.

## Install

```sh
npm install -g @entelligentsia/forgecli
```

Node 20 or higher.

## Quick start

```sh
cd your-project
forge                  # launch (forge, forgecli, and 4ge are the same binary)
> /forge:init          # 4 phases, ~45s, idempotent
```

That's it. Your `.forge/` is populated and your first sprint is ready.

## Try it on the playground

Don't want to point forge-cli at your real codebase first? Clone the testbench and run a full SDLC cycle on a sample project in ~15 min:

```sh
git clone https://github.com/Entelligentsia/forge-testbench
cd forge-testbench/hello   # smallest project — Python · Click · 21 lines
forge
> /forge:init
```

Three more stacks live in the testbench — TypeScript ([cartographer]), Go ([emberglow]), Python+NumPy ([spectral]). Walkthrough on the [testbench README](https://github.com/Entelligentsia/forge-testbench).

## What `/forge:init` does

```
①  collect      5 parallel discovery scans         → .forge/config.json
②  discover     KB docs + project-context          → .forge/project-context.json
③  materialize  substitute placeholders            → .forge/{personas,workflows,…}
④  register     manifest + cache + store entries   → .forge/store/, .forge/cache/
```

Idempotent and resumable. Re-running picks up at the last checkpoint via `.forge/init-progress.json`.

## Commands

```
SETUP    /forge:init          Bootstrap Forge SDLC into the project
         /forge:regenerate    Refresh generated workflows + KB
         /forge:update        Check for + apply forge-cli updates
         /forge:remove        Tear down the Forge install

RUN      /forge:run-task      Execute one task pipeline end-to-end
         /forge:run-sprint    Orchestrate every task in a sprint
         /forge:fix-bug       Triage + fix flow

CHAIN    /forge:plan          plan
         /forge:implement     implement
         /forge:review-plan   review the plan
         /forge:review-code   review the code
         /forge:approve       architect approval
         /forge:validate      8-gate validator
         /forge:commit        commit

ASK      /forge:health        KB freshness + store integrity
         /forge:status        Sprint + task status
         /forge:ask <q>       Ask the Tomoshibi concierge
         /forge:config        Inspect or change project config
```

→ [Full reference](docs/cli-reference.md) · [Non-interactive mode](docs/non-interactive.md) · [Hook safety net](docs/hook-safety-net.md) · [Custom tools](docs/custom-tools.md) · [Publishing](docs/publishing.md)

## Where to go next

- **[docs/](docs/)** — CLI flags, non-interactive mode, hook dispatcher, custom tools, publishing
- **[CHANGELOG.md](CHANGELOG.md)** — release history
- **[Playground](https://github.com/Entelligentsia/forge-testbench)** — try on four sample projects

## Roadmap

| Up next                                            | Status              |
|----------------------------------------------------|---------------------|
| 4ge brand wordmark in CLI banner + 3 themes        | Shipped (0.7.7)     |
| Slim README + docs/ split                          | Shipped (0.7.7)     |
| Subagent audience relaxed to advisory              | Shipped (0.7.6)     |
| Bundled plugin command markdowns                   | Shipped (0.7.6)     |
| `/forge:run-task`, `run-sprint`, `fix-bug`         | Shipped (0.7.5)     |
| Atomic chain shims (`/forge:plan` … `commit`) ×6   | Shipped (0.7.5)     |
| Port admin commands (`migrate`, `calibrate`, …)    | Roadmap             |

→ Full roadmap + history: [CHANGELOG.md](CHANGELOG.md)

## Links

- npm — [`@entelligentsia/forgecli`](https://www.npmjs.com/package/@entelligentsia/forgecli)
- GitHub — [Entelligentsia/forge-cli](https://github.com/Entelligentsia/forge-cli)
- Plugin source — [Entelligentsia/forge](https://github.com/Entelligentsia/forge)
- Pi runtime — [@earendil-works/pi-coding-agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
- Playground — [Entelligentsia/forge-testbench](https://github.com/Entelligentsia/forge-testbench)

## License

MIT © Entelligentsia

[pi-coding-agent]: https://www.npmjs.com/package/@earendil-works/pi-coding-agent
[cartographer]: https://github.com/Entelligentsia/forge-testbench/tree/main/cartographer
[emberglow]: https://github.com/Entelligentsia/forge-testbench/tree/main/emberglow
[spectral]: https://github.com/Entelligentsia/forge-testbench/tree/main/spectral

<!--
  Release ledger — full history lives in CHANGELOG.md.
  This comment satisfies the README↔CHANGELOG verifier (every version since
  0.1.0 must textually appear in README) while keeping the visible README slim.
  Remove this block once the verifier is updated to follow CHANGELOG.md links.

  Shipped: 0.2.0 · 0.2.1 · 0.3.0 · 0.4.0 ·
  0.5.0 · 0.5.1 · 0.5.2 · 0.5.3 · 0.5.4 · 0.5.5 · 0.5.6 · 0.5.7 ·
  0.6.1 · 0.6.2 · 0.6.3 · 0.6.4 · 0.6.5 · 0.6.6 ·
  0.7.0 · 0.7.1 · 0.7.2 · 0.7.3 · 0.7.4 · 0.7.5 · 0.7.6 · 0.7.7
-->

