<div align="center">

![PublicMachina](docs/assets/publicmachina-network-hero.png)

# PublicMachina

**See what happens next, before it does.**

The first social simulation engine where agents search the real internet before deciding what to say.

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/Node-%3E%3D18-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5+-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)

</div>

PublicMachina builds a parallel social world from your scenario, populates it with agents that have beliefs, memories, and personalities, then lets them react. Before they speak, Tier A and Tier B agents can search the real internet through SearXNG, read recent coverage, and use that context in their next decision. Results are cached in SQLite, replayable under the same cutoff date and seed, and inspectable after the run.

Every run lives in one `.db` file. You can open it with `sqlite3`, generate a report, interview actors, or export evolved agents with their memories and decision traces.

PublicMachina supports three real providers today: **Anthropic**, **OpenAI**, and **Moonshot AI**.

## What can you simulate?

PublicMachina is useful anywhere collective behavior matters and recent information changes how people react.

| Domain | What if... | What PublicMachina shows you |
|---|---|---|
| Markets & finance | **The Fed surprises markets with a larger-than-expected cut** | Traders, macro analysts, journalists, and retail investors search the same coverage, analysis, and public data you would find on Google today. You see whether the dominant narrative becomes "risk-on rally" or "recession alarm." |
| Geopolitics & policy | **A government imposes a sudden tariff on semiconductor imports** | Officials, manufacturers, trade journalists, lobbyists, and investors discover real reporting and policy language before reacting. Second-order effects surface before they hit your memo. |
| Crisis & reputation | **Your company suffers a visible data breach** | Customers, regulators, reporters, employees, competitors, and trolls react to the same precedent cases and breach coverage a real public sphere would find. Run alternate response strategies and compare how fast the backlash stabilizes. |
| Culture & social phenomena | **A false rumor about a public figure starts spreading** | Fact-checkers, fans, mainstream media, trolls, and casual sharers search the source material and the correction race unfolds in rounds you can inspect. |
| Science & public health | **A controversial vaccine announcement lands in a polarized environment** | Health authorities, skeptics, mainstream outlets, parents groups, and medical creators find real trial coverage and skepticism narratives before deciding what to amplify. |
| Fiction & creative | **You want to pressure-test the third act of a screenplay or a lost ending** | Feed the world, characters, and constraints. Agents evolve from the material, interact, and can be interviewed afterward to explain why they took the side they did. |

Grounded runs are the default path, with `--offline` as an explicit opt-out. Every agent decision is auditable. Simulations can be resumed from snapshots and replayed from SQLite artifacts.

## How it's different

| | PublicMachina | MiroFish | OASIS | Concordia |
|---|---|---|---|---|
| Agents search the real internet during simulation | **Yes** | No | No | No |
| Temporal cutoff for counterfactual replay | **Yes** | No | No | No |
| Deterministic replay from seed + cache | **Yes** | No | No | No |
| Single-file audit trail (`.db`) | **Yes** | No | No | No |
| Conversational operator with memory | **Yes** | No | No | No |
| Natural-language design to spec + config | **Yes** | Partial | No | No |

PublicMachina is not trying to simulate a million bots. It is built for high-fidelity rehearsals where every decision must be traceable, replayable, and grounded in what the internet actually says, not just what the model remembers from training.

## Why live internet grounding matters

Every open social simulator in this space operates as a closed world. Agents react to their feed, their memory, and the LLM's training cutoff. Real people do not work like that. A journalist checks the news. A trader looks up fresh reaction coverage. A regulator reads the latest statement before speaking.

PublicMachina closes that gap. Agents search the internet, PublicMachina applies an exact temporal cutoff after retrieval, then stores the results in SQLite so the same scenario can be replayed later under the same information boundary.

That gives you a real counterfactual:

- What if agents only saw reporting from before the announcement?
- What if they had one more day of coverage?
- What if the same event happened under a different response strategy?

## Quick start

```bash
git clone https://github.com/angelgalvisc/publicmachina.git
cd publicmachina && npm install && npm run build
node dist/index.js setup
```

The wizard picks your LLM provider, writes your API key to `.env`, bootstraps the operator workspace, and then drops straight into the conversation.

```text
╔══════════════════════════════════════════╗
║                                          ║
║   ◉ Wake up!                             ║
║   PublicMachina ready to forecast.       ║
║                                          ║
║   The public sphere is now simulated.    ║
║   Alternate realities are standing by.   ║
║                                          ║
╚══════════════════════════════════════════╝
```

Then just talk to it:

> Simulate how crypto Twitter reacts if the SEC approves an Ethereum ETF.  
> 30 actors, 10 rounds. Let journalists and analysts search the web.

PublicMachina can design the scenario, preview the plan, and run it after your confirmation.

The operator also ships with guardrails:

- graceful stop for live runs through `/stop`, `publicmachina stop`, or `Ctrl+C`
- per-session spend caps for the operator
- one active run per workspace by default

For web-grounded search, add a [SearXNG instance](DEPLOYMENT.md). Runs now require grounding by default; use `--offline` only when you explicitly want a non-grounded simulation.

<details>
<summary>Prerequisites and manual configuration</summary>

Requires Node.js >= 18. For search, optionally run SearXNG locally.

```bash
cp .env.example .env
# Add your ANTHROPIC_API_KEY, OPENAI_API_KEY, or MOONSHOT_API_KEY
node dist/index.js doctor
```

Advanced provider settings, workspace policy, and search configuration live in [DEPLOYMENT.md](DEPLOYMENT.md).

</details>

## Why PublicMachina

Most AI demos stop at "look, the agents are talking." PublicMachina is built for the harder question: what happens when those agents react to the same world your users, journalists, traders, voters, or critics are reacting to right now?

If a simulated journalist decides whether to publish a negative story about your company, they should be able to search recent coverage first, just like a real journalist would. If a simulated trader reacts to a policy announcement, they should find the same public analysis and reporting a real trader would find today.

And because every query, result set, cutoff date, round, and actor is persisted, you can audit why a narrative won, why a coalition formed, and why a specific actor changed course.

One file. Open it with `sqlite3`.

## Capabilities

- **Internet-grounded agents**: Tier A and B actors can search SearXNG before deciding, with exact temporal cutoff filtering applied by PublicMachina.
- **Natural-language design**: describe a scenario in plain English and get a validated `simulation.spec.json` plus executable config. The conversational operator adds a second pass that proposes actors and communities from downloaded source documents.
- **Conversational operator**: the default entrypoint is a conversation, not a wall of flags.
- **Replayable alternate realities**: resume interrupted runs from snapshots or replay completed runs from scaffold + decision cache.
- **Deterministic replay**: seedable PRNG, recorded decisions, cached web context, and persisted run scaffolds keep reruns inspectable.
- **3-tier cognition**: use expensive reasoning only where it matters and keep background populations cheap.
- **Run safety**: stop cleanly, keep partial results, cap operator spend, and avoid overlapping runs inside one workspace.
- **Social dynamics**: feed ranking, echo chambers, mutes, blocks, reports, narrative fatigue, and out-of-network exposure.
- **Event injection**: drop in shocks mid-simulation, from policy changes to viral moments.
- **Actor interviews**: ask an agent why it changed its mind after the run ends.
- **Investigative reports**: a ReACT-style agent iteratively queries the simulation, interviews actors, and produces analytical reports.
- **Round evaluator**: independent quality scoring after each round with corrective guidance injected into the next round's prompts (Generator-Evaluator pattern).
- **Resilient execution**: LLM call retries with exponential backoff, idle fallback, JSON repair, and failure diagnostics persisted in SQLite.
- **Portable actors**: export evolved agents with beliefs, memories, and decision traces, then import them into another run.
- **Single-file audit trail**: runs, rounds, posts, search cache, telemetry, and reports all anchor back to SQLite.

## Architecture

```text
Brief ──→ Spec Design ──→ Source Downloads ──→ Cast Design
                                                    │
                                          ┌─────────┴─────────┐
                                          ▼                   ▼
                                    Cast Seeds          Entity Type Hints
                                    Communities               │
                                          │                   │
                                          ▼                   ▼
                              Documents ──→ Ingest ──→ Graph ──→ Profiles
                                                                    │
                                                                    ▼
                                                          Simulation Engine
                                                          ┌─────────────────┐
                                                          │ Activation      │
                                                          │ Feed            │
                                                          │ Search          │
                                                          │ Cognition       │
                                                          │ Propagation     │
                                                          │ Fatigue         │
                                                          │ Events          │
                                                          │ Memory          │
                                                          └─────────────────┘
                                                                │
                                                     ┌──────────┼──────────┐
                                                     ▼          ▼          ▼
                                                  Report    Interview    Export
```

The design layer uses LLM to propose actors and communities from the brief and source documents. The grounding layer (ingest, graph, profiles) uses LLM for ontology extraction and profile generation, but graph construction, entity resolution, community assignment, and the simulation runtime are deterministic and auditable. Everything is persisted in SQLite. More detail lives in [docs/architecture.md](docs/architecture.md).

## CLI reference

| Command | Description |
|---|---|
| `setup` / `init` | Guided provider, workspace, and model setup |
| `assistant` | Start the operator explicitly |
| `design` | Turn a natural-language brief into a spec + generated config. Runs cast design if `--docs` is provided |
| `run` | Full pipeline: ingest -> analyze -> generate -> simulate. Pass `--spec` to use designed focus actors, cast seeds, and communities |
| `ingest` | Document ingestion and chunking phase |
| `analyze` | Ontology extraction and graph build. Pass `--spec` for entity type hints from cast design |
| `generate` | Profile generation from graph entities. Pass `--spec` for focus actors, cast seeds, and communities |
| `simulate` | Run an existing simulation |
| `resume` | Resume a cancelled or failed run from the latest persisted snapshot |
| `replay` | Copy a database and replay a run from scaffold + decision cache |
| `stop` | Request a graceful stop for the active run |
| `stats` | Print run metrics and tier breakdown |
| `inspect` | Inspect actor context, beliefs, posts, and recent state |
| `report` | Generate a report for a completed run |
| `interview` | Interview a simulated actor |
| `investigate` | ReACT-style investigative report: iteratively queries data, interviews actors, and synthesizes findings |
| `shell` | Interactive REPL for NL->SQL, schema inspection, and interviews |
| `history` | Show assistant-tracked simulation history |
| `export-agent` | Export a simulated actor as a portable bundle |
| `import-agent` | Import a portable bundle into another run |
| `doctor` | Validate config, API keys, SearXNG, and SQLite |

## Documentation

| Document | Content |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Runtime model, module map, cognition tiers, platform policy, search internals, CKP bundles |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Provider configuration, workspace policy, SearXNG setup, container notes |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Development workflow, testing, mocked vs real integration coverage |
| [PLAN.md](PLAN.md) | Active roadmap and design decisions |
| [PLAN_PRODUCT_EVOLUTION.md](PLAN_PRODUCT_EVOLUTION.md) | Product evolution roadmap: temporal memory, feed realism, cast enrichment |
| [IMPLEMENTATION_CHECKLIST.md](IMPLEMENTATION_CHECKLIST.md) | Phase-by-phase implementation task list with parallelism analysis |
| [IMPLEMENTATION_HISTORY.md](IMPLEMENTATION_HISTORY.md) | Historical milestones and implementation log |

## Roadmap

PublicMachina is actively evolving. The current engine ships with grounded agents, replay/resume, 3-tier cognition, a conversational operator, round quality evaluation, resilient LLM execution, and investigative reporting.

### Already implemented (feature-flagged)

- **Temporal memory infrastructure** — episode derivation, outbox pattern, retrieval with per-tier context budgets, and fallback. Graphiti provider ready for FalkorDB integration.
- **Feed realism** — TwHIN-BERT social-representation embeddings as an additional ranking signal (`social-hybrid` and `twhin-hybrid` algorithms). Requires `@huggingface/transformers`.
- **Cast enrichment** — 2-step LLM entity validation (extract + judge with few-shot calibration), graph-backed type validation, community-influenced follow/sentiment.
- **Round evaluator** — independent quality scoring per round (diversity, evolution, consistency, conflict) with corrective guidance injection. Enabled by default.
- **Resilience layer** — retry with backoff, idle fallback, optional JSON repair, failure message persistence.
- **ReportAgent** — ReACT-style investigative reports via `investigate` command.
- **Sprint decomposition** — narrative checkpoints for runs >10 rounds.

### Next priorities

- **Graphiti spike** — connect the temporal memory provider to FalkorDB and validate whether graph-based memory improves agent coherence.
- **Evaluation framework** — 5 benchmark scenarios with 10 formal metrics for A/B comparison of memory, feed, and cast variants.

All changes are gated behind formal evaluation: no new layer becomes default unless it measurably improves simulation quality without breaking cost or latency constraints. Full plan, architecture decisions, phases, risks, and success criteria live in [PLAN_PRODUCT_EVOLUTION.md](PLAN_PRODUCT_EVOLUTION.md).

## License

[Apache License 2.0](LICENSE)
