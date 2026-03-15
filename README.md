<div align="center">

# SeldonClaw

**The first social simulation engine where agents search the real web before deciding what to say.**

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/Node-%3E%3D18-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5+-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Tests](https://img.shields.io/badge/Tests-379_passing-brightgreen?style=flat-square)]()
[![CKP](https://img.shields.io/badge/CKP-v0.2.6-orange?style=flat-square)](https://github.com/angelgalvisc/clawkernel)

---

*Simulate how narratives propagate through a social network — with agents that read real news before they post. Inject events, observe stance shifts, and export full audit trails from a single SQLite file.*

</div>

## Overview

SeldonClaw builds a high-fidelity social simulation environment where autonomous agents with distinct personalities, beliefs, and social connections interact on a simulated platform. Each agent decides independently — using a 3-tier cognition system — whether to post, reply, repost, or stay silent, driven by their feed, beliefs, fatigue state, and the events unfolding around them.

What sets SeldonClaw apart from existing social simulators like OASIS, Concordia, or S³ is **web-grounded cognition**: before making a decision, Tier A and Tier B agents can query a live search engine (via SearXNG), receive real-world context filtered by a configurable temporal cutoff, and incorporate that information into their reasoning. Results are cached in SQLite for full determinism on replay. No other social simulation framework gives agents access to external information during the simulation loop.

Every action is stored in a single SQLite database: deterministic, replayable, and fully auditable. Agents can be exported as portable [ClawKernel Protocol (CKP)](https://github.com/angelgalvisc/clawkernel) bundles and imported into other simulations or A2A-compatible systems.

### Key Capabilities

- **Web-grounded decisions** — Tier A/B agents query real web sources via SearXNG before deciding, with temporal cutoff filtering and cache-first determinism. [See details below.](#web-grounded-search)
- **Deterministic simulations** — Seedable PRNG (xoshiro128**) guarantees identical runs from the same seed
- **3-tier cognition** — Tier A (always LLM), Tier B (probabilistic LLM), Tier C (rule-based) for cost-efficient agent decisions
- **Knowledge graph foundation** — Ingest documents, extract claims, resolve entities, build ontologies, then generate actor profiles grounded in real data
- **Narrative fatigue** — Topics decay naturally over time; agents lose interest in oversaturated narratives
- **Event injection** — Schedule exogenous shocks (breaking news, policy changes) that alter the simulation mid-run
- **Agent memory** — Tier A/B actors accumulate deliberative memories across rounds for coherent follow-up behavior and interviews
- **Feed algorithm** — Recency, popularity, relevance, echo chamber effects, and optional semantic similarity shape what each agent sees
- **CKP portability** — Export any agent as a portable bundle with beliefs, provenance, and A2A agent card
- **Interactive shell** — Natural language queries over simulation data, actor interviews, live SQL access
- **Zero-dependency audit** — One `.db` file contains the entire run: config, actors, posts, rounds, graphs, search cache

## Web-Grounded Search

SeldonClaw is the only social simulation engine that breaks the closed-information-bubble paradigm. Instead of limiting agents to the posts in their feed, Tier A and Tier B agents can search the real web — just like a real person would check the news before reacting to a trending topic.

### How It Works

```
Round N begins
    │
    ▼
┌─────────────────────┐
│  Agent activated     │
│  (Tier A or B)       │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐     ┌─────────────────────┐
│  Build search        │────→│  Check SQLite cache  │
│  queries from:       │     │  (query + cutoff +   │
│  • actor topics      │     │   language)           │
│  • active events     │     └─────────┬───────────┘
│  • trending feed     │           hit? │ miss?
└─────────────────────┘               │
                              ┌───────┴───────┐
                              ▼               ▼
                        Return cached    Query SearXNG
                        results          (self-hosted)
                                              │
                                              ▼
                                        Filter by cutoff
                                        date + store in
                                        cache
                              ┌───────────────┘
                              ▼
                    ┌─────────────────────┐
                    │  Inject web context  │
                    │  into LLM prompt     │
                    │  as "RECENT WEB      │
                    │  INFORMATION"         │
                    └─────────┬───────────┘
                              ▼
                    ┌─────────────────────┐
                    │  Agent decides:      │
                    │  post / reply /      │
                    │  repost / idle       │
                    └─────────────────────┘
```

### Temporal Backtesting

The `cutoffDate` parameter controls what information agents can access. This enables counterfactual analysis: run the same scenario under different information conditions.

| Scenario | `cutoffDate` | Effect |
|----------|-------------|--------|
| Pre-announcement | `2024-06-01` | Agents react without knowledge of the policy change |
| Post-announcement | `2024-07-15` | Agents incorporate early coverage into their decisions |
| Full information | `2024-12-31` | Agents see all available reporting and analysis |

### Cache-First Determinism

Search results are cached in SQLite by `(query, cutoffDate, language, categories)`. The first run fetches live results from SearXNG; every subsequent replay reads from the cache. This means:

- **Same seed + same cache = identical output** — full determinism preserved
- **Audit trail** — every search request is logged in `search_requests` with actor, round, query, and result count
- **Offline replay** — once cached, simulations run without network access

### Comparison with Other Simulators

| Feature | SeldonClaw | OASIS | Concordia | S³ | AgentSociety |
|---------|-----------|-------|-----------|-----|-------------|
| Agents search the web | **Yes** | No | No | No | No |
| Temporal cutoff control | **Yes** | — | — | — | — |
| Deterministic search replay | **Yes** | — | — | — | — |
| Search audit trail | **Yes** | — | — | — | — |
| Self-hosted search engine | **Yes** (SearXNG) | — | — | — | — |

### Search Configuration

```yaml
search:
  enabled: true
  endpoint: "http://localhost:8888"  # SearXNG instance
  cutoffDate: "2024-09-15"          # agents see nothing published after this date
  strictCutoff: true                # drop results without a published date
  enabledTiers: ["A", "B"]          # only LLM-backed tiers search
  maxActorsPerRound: 4              # total search-enabled actors per round
  maxActorsByTier:
    A: 2                            # up to 2 tier-A actors search
    B: 2                            # up to 2 tier-B actors search
  allowArchetypes: ["media", "institution"]
  denyArchetypes: []
  allowProfessions: ["journalist", "analyst"]
  denyProfessions: []
  allowActors: []                   # match actor id, @handle, or name
  denyActors: []
  maxResultsPerQuery: 5
  maxQueriesPerActor: 2
  categories: "news"
  defaultLanguage: "auto"           # inherits from each actor's language field
  timeoutMs: 3000
```

> **Prerequisite:** A running [SearXNG](https://docs.searxng.org/) instance with JSON output enabled. A Docker Compose setup takes under a minute. If search is disabled, the engine falls back to feed-only cognition with no behavior change.

Search eligibility is policy-driven:

- choose which cognition tiers may search
- cap how many search-enabled actors run per round
- split the budget by tier
- allow or deny search by archetype, profession, or explicit actor identity

`deny*` rules take precedence. `allow*` rules are additive: an actor may search if it matches any allowed actor, archetype, or profession rule.

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
                                    ┌─────────────────┐
                                    │  Activation      │ who acts this round?
                                    │  Feed            │ what do they see?
                                    │  Search (SearXNG)│ what does the web say?
                                    │  Cognition       │ what do they decide?
                                    │  Propagation     │ who gets exposed?
                                    │  Fatigue         │ what topics decay?
                                    │  Events          │ what shocks occur?
                                    │  Memory          │ what do they remember?
                                    └─────────────────┘
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
| `db.ts` | Barrel re-export for storage modules | ~20 |
| `schema.ts` | SQLite DDL for provenance, graph, simulation, memory, search cache, and embeddings | ~450 |
| `store.ts` | `GraphStore` interface + `SQLiteGraphStore` implementation | ~1660 |
| `engine.ts` | Round loop: events → activate → feed → search → cognition → propagate → fatigue | ~520 |
| `scheduler.ts` | V2 round scheduler: deterministic staging + bounded-concurrency backend calls | ~240 |
| `cognition.ts` | 3-tier router + `CognitionBackend` + sim context assembly | ~580 |
| `activation.ts` | Hourly activity curves, influence weighting, fatigue gating | ~150 |
| `feed.ts` | Hybrid feed ranking: graph heuristics + optional semantic similarity | ~240 |
| `fatigue.ts` | Narrative decay: exponential cooldown, extinction threshold | ~120 |
| `propagation.ts` | Exposure spreading: followers, community overlap, viral reach | ~150 |
| `events.ts` | Scheduled + threshold-triggered exogenous events | ~200 |
| `memory.ts` | Deliberative actor memory derivation and persistence | ~160 |
| `embeddings.ts` | Deterministic embedding provider, cache, and state enrichment | ~220 |
| `search.ts` | SearXNG client, temporal cutoff filtering, cache-first web context | ~400 |
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

For web-grounded search (optional):

| Tool | Purpose | Check |
|------|---------|-------|
| Docker | Run SearXNG | `docker --version` |
| SearXNG | Metasearch engine | `curl http://localhost:8888/search?q=test&format=json` |

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

For a source checkout, invoke the CLI with `node dist/index.js ...` or `npm link`.
After the package is published, the same commands will work as `npx seldonclaw ...` or `seldonclaw ...`.

### Configuration

```bash
# Interactive guided setup
node dist/index.js init

# Or copy the example env file
cp .env.example .env
# Edit .env with your Anthropic API key
```

The `init` command generates a `seldonclaw.config.yaml` with model selection, API key references (never raw secrets), and output directory configuration.
The `doctor` command verifies your environment — including the SearXNG endpoint, if search is enabled.

### Run the Full Pipeline

The CLI exposes both the end-to-end pipeline and the lower-level stages.

```bash
# Full pipeline: ingest -> analyze -> generate -> simulate
node dist/index.js run --db simulation.db --docs ./tests/fixtures/sample-docs --run my-run --rounds 5 --mock

# Lower-level staged commands are also available
node dist/index.js ingest --db simulation.db --docs ./tests/fixtures/sample-docs
node dist/index.js analyze --db simulation.db --mock
node dist/index.js generate --db simulation.db --run my-run --hypothesis "Tuition protests intensify" --mock
node dist/index.js simulate --db simulation.db --run my-run --rounds 5 --mock

# Use the real LLM backend once your config and API key are in place
node dist/index.js run --db simulation.db --docs ./docs --run my-real-run --rounds 5
```

### Analyze Results

```bash
# Run statistics with tier breakdown
node dist/index.js stats --db simulation.db --run my-run --tiers

# Generate a report (metrics + LLM narrative)
node dist/index.js report --db simulation.db --run my-run

# Interview an actor
node dist/index.js interview --db simulation.db --actor "journalist-01" --question "Why did you change your stance?"

# Interactive shell
node dist/index.js shell --db simulation.db
```

### Export/Import Agents (CKP)

```bash
# Export an actor as a portable CKP bundle
node dist/index.js export-agent --db simulation.db --actor journalist-01 --out ./exports

# Import into another simulation
node dist/index.js import-agent --bundle ./exports --db other-sim.db --run new-run
```

## CLI Reference

| Command | Description |
|---------|-------------|
| `simulate` | Run a simulation (supports `--mock` for testing) |
| `run` | Full pipeline: ingest → analyze → generate → simulate |
| `ingest` | Ingest source documents into the provenance store |
| `analyze` | Extract ontology + claims and build the knowledge graph |
| `generate` | Generate actor profiles from the knowledge graph |
| `stats` | Print run summary, round counts, tier breakdown |
| `inspect` | Show actor context, beliefs, topics, and recent posts |
| `report` | Generate metrics report with optional LLM narrative |
| `interview` | Interview an actor (single question or REPL mode) |
| `export-agent` | Export actor as CKP bundle |
| `import-agent` | Import CKP bundle into a run |
| `shell` | Interactive REPL with NL→SQL, interviews, and schema exploration |
| `init` | Guided configuration wizard |
| `doctor` | Diagnostic checks (Node version, config, API keys, SearXNG, SQLite) |

## Cognition Tiers

SeldonClaw uses a tiered cognition system to balance simulation fidelity with cost:

| Tier | Strategy | Use Case | Web Search | Cost |
|------|----------|----------|------------|------|
| **A** | Always LLM | Key influencers, journalists, politicians | Yes | High |
| **B** | Probabilistic LLM | Regular active users (LLM called stochastically) | Yes | Medium |
| **C** | Rule-based | Background population, low-activity accounts | No | Zero |

Tier assignment is per-actor and configurable. The cognition router dispatches each decision to the appropriate backend based on the actor's tier and a PRNG roll (for Tier B). Only Tier A and B agents perform web searches — Tier C operates on rules alone.

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
              ┌──────────┐    ┌──────────────┐
              │ beliefs  │    │  narratives  │
              │ topics   │    │    rounds    │
              │ follows  │    │     runs     │
              │ memories │    │  embeddings  │
              └──────────┘    └──────────────┘
                                    │
                              ┌─────┴─────┐
                              ▼           ▼
                        ┌──────────┐ ┌────────────────┐
                        │ search   │ │    search       │
                        │ cache    │ │   requests      │
                        └──────────┘ └────────────────┘
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

379 tests across 25 test files covering:

- Knowledge graph pipeline (ingest → claims → entities → resolution)
- Ontology extraction and entity typing
- Actor profile generation from knowledge graph
- Simulation engine (activation, feed, cognition, propagation, fatigue, events)
- V2 scheduler (bounded concurrency, deterministic staging, transactional commits)
- Persisted agent memory and memory-aware cognition context
- Optional embedding-aware feed ranking with deterministic cache
- **Web-grounded search** (SearXNG client, cache-first resolution, temporal cutoff filtering, query building, search audit trail)
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
│   ├── scheduler.ts      # V2 round scheduler with bounded concurrency
│   ├── cognition.ts      # 3-tier decision engine + sim context
│   ├── db.ts             # Barrel exports for storage modules
│   ├── store.ts          # GraphStore + SQLiteGraphStore
│   ├── schema.ts         # SQL schema definitions
│   ├── activation.ts     # Agent activation logic
│   ├── feed.ts           # Hybrid feed ranking
│   ├── fatigue.ts        # Narrative decay
│   ├── propagation.ts    # Exposure spreading
│   ├── events.ts         # Event scheduling + triggers
│   ├── memory.ts         # Persisted actor memories
│   ├── embeddings.ts     # Embedding cache + semantic features
│   ├── search.ts         # SearXNG-backed web grounding
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
│   └── ids.ts            # ID generation
├── tests/                # 25 test files, 379 tests
├── package.json
├── tsconfig.json
├── .env.example
└── LICENSE               # Apache 2.0
```

## License

[Apache License 2.0](LICENSE)
