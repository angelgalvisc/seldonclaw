<div align="center">

<pre>
 ◉     ◉     ◉     ◉     ◉     ◉     ◉
 │     │     │     │     │     │     │
╭┴╮   ╭┴╮   ╭┴╮   ╭┴╮   ╭┴╮   ╭┴╮   ╭┴╮
⌐°‿°¬ ⌐°o°¬ ⌐·_·¬ ⌐>‿<¬ ⌐°‿°¬ ⌐°_°¬ ⌐ᵔ‿ᵔ¬
╘═╛   ╘═╛   ╘═╛   ╘═╛   ╘═╛   ╘═╛   ╘═╛
</pre>

# PublicMachina

**The first social simulation engine where agents search the real web before deciding what to say.**

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/Node-%3E%3D18-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5+-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Tests](https://img.shields.io/badge/Tests-414_passing-brightgreen?style=flat-square)]()

---

*Simulate how narratives propagate through a social network — with agents that read real news before they post. Inject events, observe stance shifts, and export full audit trails from a single SQLite file.*

</div>

## Overview

PublicMachina is an auditable social simulation engine for testing how narratives, institutions, media actors, and online communities respond to real-world scenarios. It turns source material, configurable social dynamics, and optional live web context into a replayable simulation environment where agents observe, decide, interact, and evolve across rounds.

These are simulated agents orchestrated by a central engine, not independent runtime containers. Each actor carries persistent state and moves through feed construction, cognitive routing, memory retrieval, optional web search, and platform policy before acting.

Its strongest differentiator is explicit and visible: **PublicMachina is the first social simulation engine where agents can search the real web before deciding what to say.** Tier A and Tier B actors can query a live SearXNG endpoint, then PublicMachina applies an exact temporal cutoff before injecting that context into the decision loop. Results are cached in SQLite, logged per actor and round, and replayable later under the same cutoff and seed.

This makes PublicMachina useful as both a scenario lab and an operator tool: you can stress-test communication strategies, simulate narrative shocks, interview generated actors after the run, and inspect the full chain of why a given behavior emerged. Every run lives in a single SQLite file. Every major artifact remains inspectable.

## What You Give It

- Source documents: briefs, reports, articles, notes, policy drafts, or scenario material
- A simulation goal or hypothesis
- Optional natural-language design instructions
- Optional live web grounding through SearXNG
- Optional search policy, feed tuning, and scenario constraints

## What It Returns

- A full simulated run with actors, posts, rounds, exposures, narratives, and telemetry
- A generated `simulation.spec.json` and executable config when you use natural-language design
- Reports, actor interviews, and shell-based analysis tools
- Reusable actor bundles plus a reproducible audit trail

## Documentation Map

- `README.md` — product overview, installation, quick start, and active feature surface
- `PLAN.md` — active architecture and roadmap
- `IMPLEMENTATION_HISTORY.md` — historical implementation log and milestone record
- `DEPLOYMENT.md` — operational notes for local runs, packaged installs, and optional SearXNG
- `docs/data-model.md` — human-readable relational model
- `docs/data-model.json` — machine-readable schema map for tooling

## Why It Exists

Most agent demos optimize for spectacle. Most research simulators optimize for flexibility. PublicMachina is built for a narrower but harder target: **high-agency simulation with auditability, reproducibility, and operator control**.

At the system level, it works as a rehearsal environment for crisis communication, institutional response, reputation stress-testing, policy scenarios, and narrative competition.

At the operator level, it gives researchers and builders a way to design simulations in plain English, ground agents in real source material, inject exogenous events, replay outcomes, and inspect why specific trajectories emerged.

### Key Capabilities

- **Web-grounded decisions** — Tier A/B agents query real web sources via SearXNG before deciding, with an exact cutoff applied by PublicMachina and cache-first determinism. [See details below.](#web-grounded-search)
- **Natural-language simulation design** — Turn a free-form brief into a validated `simulation.spec.json` plus deterministic `publicmachina.config.yaml`
- **Deterministic simulations** — Seedable PRNG (xoshiro128**) guarantees identical runs from the same seed
- **3-tier cognition** — Tier A (always LLM), Tier B (probabilistic LLM), Tier C (rule-based) for cost-efficient agent decisions
- **Knowledge graph foundation** — Ingest documents, extract claims, resolve entities, build ontologies, then generate actor profiles grounded in real data
- **Narrative fatigue** — Topics decay naturally over time; agents lose interest in oversaturated narratives
- **Event injection** — Schedule exogenous shocks (breaking news, policy changes) that alter the simulation mid-run
- **Agent memory** — Tier A/B actors accumulate deliberative memories across rounds for coherent follow-up behavior and interviews
- **Configurable platform policy** — Simulate X-style, forum-like, reddit-like, or custom behavior by configuring actions, tier capabilities, moderation, and ranking policy
- **Expanded action surface** — Quote, unfollow, unlike, delete, mute, block, and report complement post/comment/repost/like/follow
- **Feed algorithms** — Chronological, heuristic, trace-aware, embedding, and hybrid ranking modes with out-of-network mix control
- **Negative social dynamics** — Mutes and blocks alter feed visibility and cross-actor propagation; report actions can trigger deterministic platform moderation
- **Idle fast-forward** — Quiet tails with no recent posts, no events, and no activated actors can be compressed into audited skipped spans
- **Portable actor bundles** — Export or import actors as CKP-compatible bundles with beliefs, memories, provenance, and an agent card for downstream reuse
- **Interactive shell** — Natural language queries over simulation data, actor interviews, live SQL access
- **Zero-dependency audit** — One `.db` file contains the entire run: config, actors, posts, rounds, graphs, search cache

## Web-Grounded Search

PublicMachina is the only social simulation engine that breaks the closed-information-bubble paradigm. Instead of limiting agents to the posts in their feed, Tier A and Tier B agents can search the real web — just like a real person would check the news before reacting to a trending topic.

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
                    │  repost / quote /    │
                    │  like / report /     │
                    │  unfollow / idle     │
                    └─────────────────────┘
```

### Temporal Backtesting

The `cutoffDate` parameter controls what information agents can access. SearXNG itself exposes broad `time_range` filters for engines that support them, but PublicMachina applies the exact cutoff date after retrieval so the same scenario can be replayed under tightly bounded information conditions.

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

| Feature | PublicMachina | OASIS | Concordia | S³ | AgentSociety |
|---------|-----------|-------|-----------|-----|-------------|
| Agents search the web | **Yes** | No | No | No | No |
| Temporal cutoff control | **Yes** | — | — | — | — |
| Deterministic search replay | **Yes** | — | — | — | — |
| Search audit trail | **Yes** | — | — | — | — |
| Self-hosted metasearch backend | **Yes** (SearXNG) | — | — | — | — |

### Search Configuration

```yaml
search:
  enabled: true
  endpoint: "http://localhost:8888"  # self-hosted SearXNG instance
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

> **Prerequisite:** A running [SearXNG](https://docs.searxng.org/) instance with JSON output enabled in `search.formats`. The official SearXNG docs recommend a containerized deployment and expose a local instance naturally at `http://localhost:8888`. Exact cutoff quality depends on engines returning published dates; `strictCutoff: true` will exclude undated results. If search is disabled, the engine falls back to feed-only cognition with no behavior change.

Search eligibility is policy-driven:

- choose which cognition tiers may search
- cap how many search-enabled actors run per round
- split the budget by tier
- allow or deny search by archetype, profession, or explicit actor identity

`deny*` rules take precedence. `allow*` rules are additive: an actor may search if it matches any allowed actor, archetype, or profession rule.

## Time Acceleration

PublicMachina now supports a conservative time-acceleration mode for long quiet tails. It does not invent behavior or skip active periods. Instead, it compresses stretches where the engine can prove that nothing actionable happens:

- no recent posts remain in the propagation window
- no active or scheduled events fire in the skipped span
- no actors activate during the skipped span

Every compressed span is persisted to `skipped_rounds` in SQLite, so the optimization remains inspectable.

```yaml
simulation:
  totalHours: 72
  minutesPerRound: 60
  timeAccelerationMode: "fast-forward"  # or "off"
  maxFastForwardRounds: 24
```

This is Phase 9A only: a conservative fast-forward path for quiet tails. Adaptive round size and budget-aware execution remain future phases.

## Platform Policy

PublicMachina no longer treats the platform as a single hardcoded X/Twitter action list. The runtime now consumes a `platform` policy that controls:

- the platform name shown to cognition
- which actions exist globally
- which actions each tier may emit
- which recommendation algorithm powers feed ranking
- whether report-driven moderation can shadow content automatically

```yaml
platform:
  name: "x"
  features:
    upvoteDownvote: false
    threads: false
    characterLimit: 280
    anonymousPosting: false
    communitiesUserCreated: false
  actions:
    - post
    - comment
    - repost
    - quote
    - like
    - unlike
    - follow
    - unfollow
    - mute
    - block
    - report
    - delete
    - search
    - idle
  recsys: "hybrid"
  tierAllowedActions:
    A: ["post", "comment", "repost", "quote", "like", "unlike", "follow", "unfollow", "mute", "block", "report", "delete", "search", "idle"]
    B: ["post", "comment", "repost", "quote", "like", "unlike", "follow", "unfollow", "mute", "report", "delete", "search", "idle"]
    C: ["post", "comment", "repost", "like", "follow", "unfollow", "idle"]
  moderation:
    enabled: true
    reportThreshold: 3
    shadowBanOnThreshold: true
```

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
                                    │  Time Policy     │ can this round be compressed?
                                    └─────────────────┘
                                         │
                              ┌──────────┼──────────┐
                              ▼          ▼          ▼
                           Report    Interview    Bundle Export
                           (metrics   (talk to    (portable
                            + LLM     actors)     actor bundles)
                           narrative)
```

## Module Map

| Module | Purpose | Lines |
|--------|---------|-------|
| `db.ts` | Barrel re-export for storage modules | ~20 |
| `schema.ts` | SQLite DDL for provenance, graph, simulation, moderation, memory, search cache, and embeddings | ~526 |
| `store.ts` | `GraphStore` interface + `SQLiteGraphStore` implementation | ~2153 |
| `engine.ts` | Round loop: events → activate → feed → search → cognition → execute → moderate → propagate → fatigue | ~786 |
| `scheduler.ts` | V2 round scheduler: deterministic staging + bounded-concurrency backend calls | ~263 |
| `cognition.ts` | 3-tier router + `CognitionBackend` + platform-aware action contracts | ~629 |
| `activation.ts` | Hourly activity curves, influence weighting, fatigue gating | ~150 |
| `feed.ts` | Platform-aware feed ranking: chronological, heuristic, trace-aware, embedding, hybrid | ~371 |
| `fatigue.ts` | Narrative decay: exponential cooldown, extinction threshold | ~105 |
| `propagation.ts` | Exposure spreading with community overlap and block-aware visibility | ~179 |
| `events.ts` | Scheduled + threshold-triggered exogenous events | ~200 |
| `memory.ts` | Deliberative actor memory derivation and persistence | ~175 |
| `platform.ts` | Configurable platform policy, action catalog, and tier capability matrix | ~148 |
| `moderation.ts` | Deterministic platform moderation from report thresholds | ~30 |
| `embeddings.ts` | Deterministic embedding provider, cache, and state enrichment | ~220 |
| `search.ts` | SearXNG client, temporal cutoff filtering, cache-first web context | ~500 |
| `time-policy.ts` | Conservative time acceleration policy for quiet-tail compression | ~150 |
| `design.ts` | Natural-language brief -> typed simulation spec -> rendered config | ~530 |
| `profiles.ts` | LLM-powered actor generation from knowledge graph entities | ~610 |
| `ontology.ts` | LLM-powered ontology extraction (entity types, edge types, topics) | ~370 |
| `ingest.ts` | Document ingestion → chunks → claims (provenance chain) | ~435 |
| `graph.ts` | Entity resolution, merge candidates, confidence scoring | ~540 |
| `llm.ts` | Multi-provider runtime client (Anthropic, OpenAI, Moonshot) + `MockLLMClient` | ~405 |
| `model-catalog.ts` | Curated provider/model presets, aliases, and display metadata for onboarding and `/model` | ~149 |
| `provider-selection.ts` | Provider/model normalization, resolution, and global/role-specific switching helpers | ~268 |
| `report.ts` | SQL → metrics + optional LLM narrative | ~200 |
| `interview.ts` | Actor interview flow (single-turn and multi-turn) | ~200 |
| `ckp.ts` | CKP export/import with secret scrubbing and lived-experience bundle capture | ~718 |
| `shell.ts` | Conversational REPL: NL→SQL, interviews, schema inspection, and live provider/model switching | ~515 |
| `config.ts` | YAML config parsing, validation, platform policy normalization, and secret sanitization | ~812 |
| `env.ts` | Lightweight `.env` loading and in-place API key persistence for setup | ~58 |
| `telemetry.ts` | Round-level metrics persistence (tier calls, timing) | ~155 |
| `types.ts` | Domain types: rows, snapshots, DTOs, platform/runtime projections | ~537 |
| `ids.ts` | UUID generation + deterministic SHA-256 stable IDs | ~30 |
| `reproducibility.ts` | xoshiro128** PRNG, deterministic UUID generation | ~280 |

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
git clone https://github.com/angelgalvisc/publicmachina.git
cd publicmachina

# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test
```

For a source checkout, invoke the CLI with `node dist/index.js ...` or `npm link`.
After the package is published, the same commands will work as `npx publicmachina ...` or `publicmachina ...`.

### Configuration

```bash
# First-run guided setup
node dist/index.js setup

# Or launch the default interactive entrypoint
node dist/index.js

# Or copy the example env file
cp .env.example .env
# Edit .env with your Anthropic, OpenAI, or Moonshot API key
```

The `setup` command generates a `publicmachina.config.yaml`, offers curated model presets for Anthropic, OpenAI, and Moonshot AI, and writes API keys to `.env` instead of storing secrets in YAML.
Provider selection is stored as a global default plus optional role-specific overrides:

```yaml
providers:
  default:
    provider: "anthropic"
    model: "claude-sonnet-4-6"
    apiKeyEnv: "ANTHROPIC_API_KEY"
  overrides:
    report:
      provider: "openai"
      model: "gpt-5-mini-2025-08-07"
      apiKeyEnv: "OPENAI_API_KEY"
```

Inside the shell you can switch the global default or override a single role without editing YAML manually:

```text
/model
/model provider openai
/model use gpt-5.4
/model provider moonshot --role report
/model use kimi-k2-thinking --role report
/model reset --role report
```

The `doctor` command verifies your environment — including the SearXNG endpoint, if search is enabled.

### Design a Simulation in Natural Language

After basic setup, use `design` to convert a natural-language brief into:

- `simulation.spec.json` — the semantic design record
- `publicmachina.generated.config.yaml` — the executable engine config

```bash
node dist/index.js design \
  --docs ./docs/product-recall \
  --brief "Create a 10-round simulation about a global consumer electronics product recall. Focus on journalists, company spokespeople, regulators, investors, and customers. Only journalists, analysts, and institutions may search the web. Allow up to 4 search-enabled actors per round, with 2 Tier A and 2 Tier B. Enable embedding-aware feed ranking." \
  --out-spec simulation.spec.json \
  --out-config publicmachina.generated.config.yaml
```

The command does **not** run the simulation immediately. It follows a professional, auditable flow:

1. Interpret the brief into a typed simulation spec
2. Validate assumptions, warnings, and unsupported combinations
3. Show a human-readable plan preview
4. Write the spec JSON and generated YAML after confirmation

Example preview:

```text
Simulation Plan
- Title: Global Product Recall Response
- Objective: Simulate how narratives and institutional responses evolve after a global consumer electronics recall.
- Rounds: 10
- Documents: ./docs/product-recall
- Focus actors: company spokespeople, customers, investors, journalists, regulators
- Hypothesis: Journalists and regulators accelerate negative sentiment faster than the company can stabilize the narrative.
- Web search: enabled
- Search policy: tiers A, B, up to 4 actors/round (A:2, B:2)
- Search targeting: archetypes institution, professions analyst, journalist, actors none
- Search cutoff: 2026-03-01
- Embedding-aware feed: enabled (weight 0.35)
```

Once the plan looks right:

```bash
node dist/index.js run \
  --config ./publicmachina.generated.config.yaml \
  --docs ./docs/product-recall \
  --hypothesis "Journalists and regulators accelerate negative sentiment faster than the company can stabilize the narrative."
```

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

### Portable Actor Bundles

```bash
# Export an actor as a portable actor bundle
node dist/index.js export-agent --db simulation.db --actor journalist-01 --out ./exports

# Import into another simulation
node dist/index.js import-agent --bundle ./exports --db other-sim.db --run new-run
```

This is a secondary portability feature, not the runtime core. PublicMachina does not execute CKP agents internally; it simulates actors inside a central engine, then projects them into portable bundles for:

- moving an evolved actor between simulations
- preserving a reusable actor snapshot outside the SQLite run file
- future interoperability with external CKP runtimes

## CLI Reference

| Command | Description |
|---------|-------------|
| `simulate` | Run a simulation (supports `--mock` for testing) |
| `design` | Convert a natural-language brief into a validated spec + generated config |
| `run` | Full pipeline: ingest → analyze → generate → simulate |
| `ingest` | Ingest source documents into the provenance store |
| `analyze` | Extract ontology + claims and build the knowledge graph |
| `generate` | Generate actor profiles from the knowledge graph |
| `stats` | Print run summary, round counts, tier breakdown |
| `inspect` | Show actor context, beliefs, topics, and recent posts |
| `report` | Generate metrics report with optional LLM narrative |
| `interview` | Interview an actor (single question or REPL mode) |
| `export-agent` | Export actor as portable bundle |
| `import-agent` | Import portable bundle into a run |
| `shell` | Interactive REPL with NL→SQL, interviews, and schema exploration |
| `setup` / `init` | Guided provider + model setup wizard |
| `doctor` | Diagnostic checks (Node version, config, API keys, SearXNG, SQLite) |

## Cognition Tiers

PublicMachina uses a tiered cognition system to balance simulation fidelity with cost:

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

## Portable Actor Bundles

PublicMachina uses CKP as an exchange format for actor bundles, not as the active runtime model. Exported bundles follow the CKP specification via `@clawkernel/sdk` and now include the actor's persisted deliberative memories plus a portable record of authored posts, exposure history, and decision traces:

```
agent-bundle/
├── claw.yaml              # CKP manifest with A2A agent card
├── actor_state.json       # stance, influence, activity, followers
├── beliefs.json           # topic → sentiment mappings
├── topics.json            # topic interests + weights
├── memories.json          # persisted reflections, interactions, event and narrative memories
├── posts.json             # authored posts with topics, engagement, moderation state
├── exposures.json         # what the actor saw and how they reacted
├── decisions.json         # decision traces with action, reasoning, and model metadata
├── provenance.json        # entity → claims → chunks → documents
├── persona.md             # personality description
└── manifest.meta.json     # run metadata, version, export timestamp
```

All exports are automatically scrubbed for secrets (API keys, tokens, credentials) before writing.

What this gives you today:

- a portable actor snapshot with beliefs, topics, lived memory, authored posts, exposures, and decision traces carried out of the run
- a clean import path back into another PublicMachina run
- import-side experience rehydration: posts, exposures, and decisions come back as safe actor memories instead of mutating the destination run's original timeline
- an early interoperability layer for external CKP consumers

What it does not yet export:

- the original follow / mute / block graph state
- round snapshots and RNG state for replay
- full community and narrative state outside the actor bundle

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

414 tests across 28 test files covering:

- Knowledge graph pipeline (ingest → claims → entities → resolution)
- Ontology extraction and entity typing
- Actor profile generation from knowledge graph
- Simulation engine (activation, feed, cognition, propagation, fatigue, events)
- V2 scheduler (bounded concurrency, deterministic staging, transactional commits)
- Persisted agent memory and memory-aware cognition context
- Optional embedding-aware feed ranking with deterministic cache
- **Web-grounded search** (SearXNG client, cache-first resolution, temporal cutoff filtering, query building, search audit trail)
- **Natural-language design** (brief interpretation, typed validation, deterministic config rendering, CLI file generation)
- Deterministic reproducibility (seed → identical runs)
- CKP export/import with secret scrubbing
- Report generation (metrics + narrative)
- Actor interviews (single and multi-turn)
- Interactive shell (intent classification, schema extraction, query execution)
- CLI command wiring and end-to-end flows

### Integration Coverage

The automated suite is intentionally mixed:

- **Real in CI/local tests** — SQLite, filesystem I/O, schema bootstrap, ingestion fixtures, report queries, scheduler behavior, CLI wiring, and a subprocess smoke test against `dist/index.js`
- **HTTP integration under test control** — `doctor` checks search health against a local test server, not a public internet dependency
- **Mocked by design** — Anthropic-backed extraction, actor decisions, report narrative generation, shell NL→SQL prompting, and natural-language simulation design use explicit mock clients in automated tests

This keeps the suite deterministic and fast while still validating real storage and CLI behavior. It also means two paths remain **manual integration checks**, not CI claims:

1. live LLM-provider execution with your configured API key
2. live SearXNG-backed search against your own running endpoint

Use `publicmachina doctor`, then run a non-`--mock` scenario locally when you want to validate those external integrations end-to-end.

## Project Structure

```
publicmachina/
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
│   ├── platform.ts       # Platform policy + tier action matrix
│   ├── moderation.ts     # Deterministic moderation rules
│   ├── embeddings.ts     # Embedding cache + semantic features
│   ├── search.ts         # SearXNG-backed web grounding
│   ├── design.ts         # Natural-language simulation design
│   ├── profiles.ts       # LLM actor generation
│   ├── ontology.ts       # LLM ontology extraction
│   ├── ingest.ts         # Document → claims pipeline
│   ├── graph.ts          # Entity resolution
│   ├── llm.ts            # Multi-provider LLM client
│   ├── model-catalog.ts  # Curated provider/model catalog
│   ├── provider-selection.ts # Provider resolution + override helpers
│   ├── report.ts         # SQL → report pipeline
│   ├── interview.ts      # Actor interview flows
│   ├── ckp.ts            # CKP export/import
│   ├── shell.ts          # Interactive REPL
│   ├── config.ts         # YAML config + validation
│   ├── env.ts            # Lightweight .env loading/writing
│   ├── telemetry.ts      # Round metrics
│   ├── reproducibility.ts # Seedable PRNG
│   ├── types.ts          # Domain types
│   └── ids.ts            # ID generation
├── tests/                # 28 test files, 414 tests
├── package.json
├── tsconfig.json
├── .env.example
└── LICENSE               # Apache 2.0
```

## License

[Apache License 2.0](LICENSE)
