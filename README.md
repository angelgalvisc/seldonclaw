<div align="center">

# SeldonClaw

**Auditable social simulation engine with SQLite-first runs, replayability, and CKP actor portability.**

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/Node-%3E%3D18-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5+-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Tests](https://img.shields.io/badge/Tests-348_passing-brightgreen?style=flat-square)]()
[![CKP](https://img.shields.io/badge/CKP-v0.2.6-orange?style=flat-square)](https://github.com/angelgalvisc/clawkernel)

---

*Simulate how narratives propagate through a social network. Inject events, observe stance shifts, and export full audit trails — all from a single SQLite file.*

</div>

## Overview

SeldonClaw builds a high-fidelity social simulation environment where autonomous agents with distinct personalities, beliefs, and social connections interact on a simulated platform. Each agent decides independently — using a 3-tier cognition system — whether to post, reply, repost, or stay silent, driven by their feed, beliefs, fatigue state, and the events unfolding around them.

Every action is stored in a single SQLite database: deterministic, replayable, and fully auditable. Agents can be exported as portable [ClawKernel Protocol (CKP)](https://github.com/angelgalvisc/clawkernel) bundles and imported into other simulations or A2A-compatible systems.

### Key Capabilities

- **Deterministic simulations** — Seedable PRNG (xoshiro128**) guarantees identical runs from the same seed
- **3-tier cognition** — Tier A (always LLM), Tier B (probabilistic LLM), Tier C (rule-based) for cost-efficient agent decisions
- **Knowledge graph foundation** — Ingest documents, extract claims, resolve entities, build ontologies, then generate actor profiles grounded in real data
- **Narrative fatigue** — Topics decay naturally over time; agents lose interest in oversaturated narratives
- **Event injection** — Schedule exogenous shocks (breaking news, policy changes) that alter the simulation mid-run
- **Feed algorithm** — Recency, popularity, relevance, and echo chamber effects shape what each agent sees
- **CKP portability** — Export any agent as a portable bundle with beliefs, provenance, and A2A agent card
- **Interactive shell** — Natural language queries over simulation data, actor interviews, live SQL access
- **Zero-dependency audit** — One `.db` file contains the entire run: config, actors, posts, rounds, graphs

## Architecture

```
Documents ──→ Ingest ──→ Knowledge Graph ──→ Ontology ──→ Profiles
                              │                              │
                              ▼                              ▼
                         Entity Resolution            Actor Generation
                              │                              │
                              └──────────┬───────────────────┘
                                         ▼
                                    Simulation Engine
                                    ┌─────────────┐
                                    │  Activation  │ who acts this round?
                                    │  Feed        │ what do they see?
                                    │  Cognition   │ what do they decide?
                                    │  Propagation │ who gets exposed?
                                    │  Fatigue     │ what topics decay?
                                    │  Events      │ what shocks occur?
                                    └─────────────┘
                                         │
                              ┌──────────┼──────────┐
                              ▼          ▼          ▼
                           Report    Interview    CKP Export
                           (metrics   (talk to    (portable
                            + LLM     actors)     agent bundles)
                           narrative)
```

## Module Map

| Module | Purpose | Lines |
|--------|---------|-------|
| `db.ts` | SQLite schema + `SQLiteGraphStore` (40+ methods) | ~900 |
| `store.ts` | `GraphStore` interface — storage abstraction boundary | ~200 |
| `engine.ts` | Round loop: activate → feed → cognition → propagate → fatigue → events | ~350 |
| `cognition.ts` | 3-tier router + `CognitionBackend` (LLM / Mock / Policy) | ~400 |
| `activation.ts` | Hourly activity curves, influence weighting, fatigue gating | ~150 |
| `feed.ts` | Algorithmic feed: follow graph, trending, community, echo chamber | ~200 |
| `fatigue.ts` | Narrative decay: exponential cooldown, extinction threshold | ~120 |
| `propagation.ts` | Exposure spreading: followers, community overlap, viral reach | ~150 |
| `events.ts` | Scheduled + threshold-triggered exogenous events | ~200 |
| `profiles.ts` | LLM-powered actor generation from knowledge graph entities | ~250 |
| `ontology.ts` | LLM-powered ontology extraction (entity types, edge types, topics) | ~200 |
| `ingest.ts` | Document ingestion → chunks → claims (provenance chain) | ~200 |
| `graph.ts` | Entity resolution, merge candidates, confidence scoring | ~250 |
| `llm.ts` | Multi-role Anthropic client + `MockLLMClient` for tests | ~330 |
| `report.ts` | SQL → metrics + optional LLM narrative | ~200 |
| `interview.ts` | Actor interview flow (single-turn and multi-turn) | ~150 |
| `ckp.ts` | CKP export/import with secret scrubbing | ~200 |
| `shell.ts` | Conversational REPL: NL→SQL, interviews, schema inspection | ~250 |
| `config.ts` | YAML config parsing, validation, secret sanitization | ~300 |
| `telemetry.ts` | Round-level metrics persistence (tier calls, timing) | ~100 |
| `reproducibility.ts` | xoshiro128** PRNG, deterministic UUID generation | ~100 |

## Quick Start

### Prerequisites

| Tool | Version | Check |
|------|---------|-------|
| Node.js | >= 18 | `node --version` |
| npm | >= 9 | `npm --version` |

### Installation

```bash
# Clone the repository
git clone https://github.com/angelgalvisc/seldonclaw.git
cd seldonclaw

# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test
```

### Configuration

```bash
# Interactive guided setup
seldonclaw init

# Or copy the example env file
cp .env.example .env
# Edit .env with your Anthropic API key
```

The `init` command generates a `seldonclaw.config.yaml` with model selection, API key references (never raw secrets), and output directory configuration.

### Run a Simulation

```bash
# With real LLM backend
seldonclaw simulate --db simulation.db --run my-run --rounds 5

# With mock backend (no API key needed)
seldonclaw simulate --db simulation.db --run my-run --rounds 3 --mock
```

### Analyze Results

```bash
# Run statistics with tier breakdown
seldonclaw stats --db simulation.db --run my-run --tiers

# Generate a report (metrics + LLM narrative)
seldonclaw report --db simulation.db --run my-run

# Interview an actor
seldonclaw interview --db simulation.db --actor "journalist-01" --question "Why did you change your stance?"

# Interactive shell
seldonclaw shell --db simulation.db
```

### Export/Import Agents (CKP)

```bash
# Export an actor as a portable CKP bundle
seldonclaw export-agent --db simulation.db --actor journalist-01 --out ./exports

# Import into another simulation
seldonclaw import-agent --bundle ./exports/journalist-01 --db other-sim.db --run new-run
```

## CLI Reference

| Command | Description |
|---------|-------------|
| `simulate` | Run a simulation (supports `--mock` for testing) |
| `stats` | Print run summary, round counts, tier breakdown |
| `report` | Generate metrics report with optional LLM narrative |
| `interview` | Interview an actor (single question or REPL mode) |
| `export-agent` | Export actor as CKP bundle |
| `import-agent` | Import CKP bundle into a run |
| `shell` | Interactive REPL with NL→SQL, interviews, and schema exploration |
| `init` | Guided configuration wizard |
| `doctor` | Diagnostic checks (Node version, config, API keys, SQLite) |

## Cognition Tiers

SeldonClaw uses a tiered cognition system to balance simulation fidelity with cost:

| Tier | Strategy | Use Case | Cost |
|------|----------|----------|------|
| **A** | Always LLM | Key influencers, journalists, politicians | High |
| **B** | Probabilistic LLM | Regular active users (LLM called stochastically) | Medium |
| **C** | Rule-based | Background population, low-activity accounts | Zero |

Tier assignment is per-actor and configurable. The cognition router dispatches each decision to the appropriate backend based on the actor's tier and a PRNG roll (for Tier B).

## Data Model

Everything lives in a single SQLite database:

```
┌──────────┐    ┌──────────┐    ┌──────────┐
│ documents│───→│  chunks  │───→│  claims  │
└──────────┘    └──────────┘    └──────────┘
                                     │
                    ┌────────────────┘
                    ▼
              ┌──────────┐    ┌──────────┐
              │ entities │───→│  edges   │
              └──────────┘    └──────────┘
                    │
                    ▼
              ┌──────────┐    ┌──────────┐    ┌──────────┐
              │  actors  │───→│  posts   │───→│exposures │
              └──────────┘    └──────────┘    └──────────┘
                    │              │
                    ▼              ▼
              ┌──────────┐    ┌──────────┐
              │ beliefs  │    │narratives│
              │ topics   │    │  rounds  │
              │ follows  │    │  runs    │
              └──────────┘    └──────────┘
```

## CKP (ClawKernel Protocol)

Exported agent bundles follow the CKP specification via `@clawkernel/sdk`:

```
agent-bundle/
├── claw.yaml              # CKP manifest with A2A agent card
├── actor_state.json       # stance, influence, activity, followers
├── beliefs.json           # topic → sentiment mappings
├── topics.json            # topic interests + weights
├── provenance.json        # entity → claims → chunks → documents
├── persona.md             # personality description
└── manifest.meta.json     # run metadata, version, export timestamp
```

All exports are automatically scrubbed for secrets (API keys, tokens, credentials) before writing.

## Development

```bash
# Watch mode for TypeScript
npm run dev

# Run tests in watch mode
npx vitest

# Type check without emitting
npx tsc --noEmit
```

### Test Suite

348 tests across 22 test files covering:

- Knowledge graph pipeline (ingest → claims → entities → resolution)
- Ontology extraction and entity typing
- Actor profile generation from knowledge graph
- Simulation engine (activation, feed, cognition, propagation, fatigue, events)
- Deterministic reproducibility (seed → identical runs)
- CKP export/import with secret scrubbing
- Report generation (metrics + narrative)
- Actor interviews (single and multi-turn)
- Interactive shell (intent classification, schema extraction, query execution)
- CLI command wiring and end-to-end flows

## Project Structure

```
seldonclaw/
├── src/
│   ├── index.ts          # CLI entry point (Commander)
│   ├── engine.ts         # Simulation round loop
│   ├── cognition.ts      # 3-tier decision engine
│   ├── db.ts             # SQLite schema + GraphStore impl
│   ├── store.ts          # GraphStore interface
│   ├── activation.ts     # Agent activation logic
│   ├── feed.ts           # Algorithmic feed assembly
│   ├── fatigue.ts        # Narrative decay
│   ├── propagation.ts    # Exposure spreading
│   ├── events.ts         # Event scheduling + triggers
│   ├── profiles.ts       # LLM actor generation
│   ├── ontology.ts       # LLM ontology extraction
│   ├── ingest.ts         # Document → claims pipeline
│   ├── graph.ts          # Entity resolution
│   ├── llm.ts            # Anthropic SDK client
│   ├── report.ts         # SQL → report pipeline
│   ├── interview.ts      # Actor interview flows
│   ├── ckp.ts            # CKP export/import
│   ├── shell.ts          # Interactive REPL
│   ├── config.ts         # YAML config + validation
│   ├── telemetry.ts      # Round metrics
│   ├── reproducibility.ts # Seedable PRNG
│   ├── types.ts          # Domain types
│   ├── schema.ts         # SQL schema definitions
│   └── ids.ts            # ID generation
├── tests/                # 22 test files, 348 tests
├── package.json
├── tsconfig.json
├── .env.example
└── LICENSE               # Apache 2.0
```

## License

[Apache License 2.0](LICENSE)
