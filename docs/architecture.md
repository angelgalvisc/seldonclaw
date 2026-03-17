# PublicMachina Architecture

This document holds the technical detail that no longer belongs in the landing-page README.

## Runtime model

PublicMachina is a CLI-first TypeScript runtime with:

- one Node.js process for the operator or pipeline command
- one SQLite database per run or experiment
- one optional LLM provider configuration
- one optional SearXNG endpoint for web-grounded search
- one optional operator workspace for memory, session history, and simulation records

The product surface is not a sandboxed code runner and not a multi-process agent swarm. It is a typed simulation engine with a conversational operator on top.

## Web-grounded search

PublicMachina lets Tier A and Tier B actors search the real internet during simulation rounds through SearXNG.

### Search flow

```text
Round N
  ↓
Actor activates
  ↓
Build search query from topics, events, and feed context
  ↓
Check SQLite cache
  ↓
Query SearXNG on cache miss
  ↓
Apply exact cutoff date after retrieval
  ↓
Inject recent web information into the cognition prompt
  ↓
Actor decides what to do
```

### Why cutoff happens after retrieval

SearXNG exposes broad time filtering where engines support it, but PublicMachina applies the exact cutoff itself so a run can be replayed under the same information boundary even when result sources differ in date quality.

### Search configuration

```yaml
search:
  enabled: true
  endpoint: "http://localhost:8888"
  cutoffDate: "2024-09-15"
  strictCutoff: true
  enabledTiers: ["A", "B"]
  maxActorsPerRound: 4
  maxActorsByTier:
    A: 2
    B: 2
  allowArchetypes: ["media", "institution"]
  denyArchetypes: []
  allowProfessions: ["journalist", "analyst"]
  denyProfessions: []
  allowActors: []
  denyActors: []
  maxResultsPerQuery: 5
  maxQueriesPerActor: 2
  categories: "news"
  defaultLanguage: "auto"
  timeoutMs: 3000
```

### Replay model

Search results are cached in SQLite by query, cutoff, language, and category. That gives you:

- deterministic replay when seed and cache match
- auditability through `search_requests`
- offline reruns once results have already been cached

## Cognition tiers

PublicMachina uses tiered cognition to keep cost proportional to agent importance.

| Tier | Strategy | Typical use | Web search |
|---|---|---|---|
| `A` | Always LLM | key influencers, journalists, officials | Yes |
| `B` | Probabilistic LLM | active regular accounts | Yes |
| `C` | Rules only | background population | No |

Tier routing is deterministic under the run seed. Tier B calls the model stochastically; Tier C stays entirely rule-based.

## Time acceleration

Time acceleration is conservative. PublicMachina only fast-forwards spans where the engine can prove that no meaningful action is happening.

Conditions:

- no recent posts remain in the propagation window
- no scheduled or active events fire in the skipped span
- no actors activate during the skipped span

Configuration:

```yaml
simulation:
  totalHours: 72
  minutesPerRound: 60
  timeAccelerationMode: "fast-forward"
  maxFastForwardRounds: 24
```

Skipped spans are written to SQLite so the optimization remains inspectable.

## Platform policy

The engine does not assume a single hardcoded platform. Platform policy controls:

- platform name shown to cognition
- global action surface
- tier-specific allowed actions
- recommendation policy
- moderation response to reports

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

## Operator architecture

The conversational operator is layered on top of typed internals.

```text
User input
  ↓
assistant-operator.ts
  ↓
/help, /clear, /model, /stop, /exit  → deterministic slash commands
  ↓
assistant-planner.ts                 → choose reply vs tool call
  ↓
assistant-tools.ts                   → typed tools
  ↓
simulation-service.ts                → thin orchestration
  ↓
engine.ts                            → simulation loop
```

The operator also maintains:

- `IDENTITY.md`
- `SOUL.md`
- `USER.md`
- `MEMORY.md`
- daily notes
- session transcripts
- simulation history

Those memories live in the assistant workspace and stay separate from actor memory stored in SQLite.

## Design and grounding pipeline

The full pipeline from brief to running simulation has three layers.

### Design layer (LLM-guided, two passes)

```text
Brief
  ↓
Pass 1: interpretSimulationBrief()        → SimulationSpec
  (title, objective, hypothesis, focusActors, sourceUrls, search, feed)
  ↓
materializeSourceDocs()                   → downloads sourceUrls to docs/
  ↓
Pass 2: designCast()                      → CastDesign
  (castSeeds, communityProposals, entityTypeHints)
  ↓
Persist castDesign to simulation.spec.json
```

Pass 1 runs from the brief alone. Pass 2 runs **after** source documents are downloaded and uses their content to propose actors, communities, and entity type hints. This two-pass design ensures the cast is grounded in real source material, not just the brief.

**CLI support**: the CLI `design` command runs both passes when `--docs` is provided (it reads downloaded documents for cast design). When using individual phase commands (`analyze`, `generate`), pass `--spec` to supply entity type hints, focus actors, cast seeds, and communities from a prior design. The `run` command reads the full spec automatically when `--spec` is provided.

### Grounding layer (LLM + deterministic)

```text
Source docs → ingestDirectory()           → chunks in DB
  ↓
extractOntology()                         → entity types, edge types, claims
  (LLM: schema discovery + claims extraction, parallelized via pipelineConcurrency)
  ↓
buildKnowledgeGraph()                     → entities, edges, merges
  (deterministic; uses entityTypeHints from cast design for type resolution)
  ↓
generateProfiles()                        → actors, communities, follows, seed posts
  (LLM: profile generation + seed posts, parallelized via pipelineConcurrency)
  (deterministic: community assignment from proposals, follow graph, tier assignment)
```

Actor priority order:
1. `focusActors` from the spec (user-specified)
2. `castSeeds` from cast design (LLM-proposed)
3. Graph entities ranked by claim count (complementary)
4. Hard cap by `actorCount`

### Simulation runtime (deterministic, auditable)

The engine, scheduler, feed, propagation, fatigue, events, memory, and moderation modules are deterministic given the same PRNG seed and cached web context. All state is persisted in SQLite.

### Pipeline concurrency

LLM calls in the grounding layer (claims extraction, profile generation, seed posts) run with bounded concurrency controlled by `simulation.pipelineConcurrency` (default: 3). This is separate from `simulation.concurrency` which controls the runtime scheduler. Traces are written to the telemetry table with `action_type = 'pipeline_trace'`.

## Data model

The simulation database centers on:

- `documents`, `chunks`, `claims`
- `entities`, `edges`
- `actors`, `beliefs`, `topics`, `memories`
- `posts`, `exposures`, `rounds`, `runs`
- `search_cache`, `search_requests`
- telemetry, embeddings, moderation, and narrative state

The full schema references already live in:

- [data-model.md](./data-model.md)
- [data-model.json](./data-model.json)

## CKP bundles

PublicMachina uses CKP as a portable actor exchange format, not as its runtime model.

Export bundles include:

- `claw.yaml`
- `actor_state.json`
- `beliefs.json`
- `topics.json`
- `memories.json`
- `posts.json`
- `exposures.json`
- `decisions.json`
- `provenance.json`
- `persona.md`
- `manifest.meta.json`

What this preserves:

- beliefs and topics
- lived memory
- authored posts
- exposure history
- decision traces

What it does not preserve yet:

- follow / mute / block graph state
- full round snapshots and RNG replay state
- full community state outside the exported actor

## Module map

| Module | Purpose |
|---|---|
| `index.ts` | Commander wiring, setup flow, operator entrypoint, and CLI commands |
| `engine.ts` | Main simulation loop with progress callbacks and cooperative cancellation |
| `scheduler.ts` | Round scheduling, activation batching, and tier-based actor resolution |
| `cognition.ts` | 3-tier cognition router and backend contracts |
| `search.ts` | SearXNG client, cutoff filtering, and cache logic |
| `design.ts` | Natural-language brief -> typed spec -> rendered config |
| `cast-design.ts` | LLM-guided cast & community proposals from spec + source docs |
| `concurrency.ts` | Shared bounded-concurrency utility for parallel LLM calls |
| `assistant-operator.ts` | Conversational operator loop |
| `assistant-planner.ts` | Planner that chooses reply vs typed tool |
| `assistant-tools.ts` | Tool execution layer for design, run, stop, query, report, export, and provider switching |
| `assistant-context.ts` | Context assembly from identity files, memory, session history, and relevant simulations |
| `assistant-session.ts` | Session transcript persistence for the operator |
| `assistant-workspace.ts` | Workspace bootstrap, identity files, memory, and simulation history |
| `assistant-state.ts` | Persistent operator state, pending confirmations, run progress, and session spend |
| `run-control.ts` | Stop requests, active-run locks, and signal bridging |
| `simulation-service.ts` | Thin orchestration layer for design artifacts and pipeline execution |
| `activation.ts` | Actor activation sampling and hour-aware participation |
| `feed.ts` | Feed scoring, recency/popularity blending, and network mixing |
| `fatigue.ts` | Narrative fatigue accumulation and decay |
| `propagation.ts` | Reaction propagation, contagion, and network spread helpers |
| `events.ts` | Scheduled shocks and threshold-triggered event expansion |
| `memory.ts` | Actor memory writes, salience, and recall helpers |
| `moderation.ts` | Report-threshold moderation actions and enforcement |
| `time-policy.ts` | Time acceleration and fast-forward policy helpers |
| `telemetry.ts` | Tier stats, action logging, and operator-facing metrics |
| `reproducibility.ts` | Seeded PRNG, recorded backend, and replay support |
| `embeddings.ts` | Optional embedding-backed feed relevance provider |
| `profiles.ts` | Actor generation from cast seeds, graph entities, and focus actors; community assignment; LLM seed posts |
| `ontology.ts` | Ontology extraction |
| `ingest.ts` | Document ingestion and chunking |
| `graph.ts` | Entity resolution and graph build with cast-design type hints |
| `llm.ts` | Multi-provider runtime client |
| `model-catalog.ts` | Curated provider/model catalog and lookup helpers |
| `model-command.ts` | Shared `/model` command logic |
| `provider-selection.ts` | Provider resolution and role overrides |
| `query-service.ts` | Read-only SQL helpers |
| `report.ts` | Report metrics and optional narrative generation |
| `interview.ts` | Actor interview flows |
| `ckp.ts` | Actor export and import |
| `shell.ts` | Interactive REPL for querying completed runs |
| `platform.ts` | Platform policy defaults, action contracts, and tier gating |
| `env.ts` | `.env` loading and API key upserts during setup |
| `ids.ts` | UUID and deterministic ID helpers |
| `types.ts` | Shared row, snapshot, and DTO type declarations |
| `config.ts` | YAML config parsing, validation, sanitization, and assistant limits |
| `store.ts` / `schema.ts` / `db.ts` | SQLite schema and store implementation |

## Project structure

```text
publicmachina/
├── src/                    # engine, operator, storage, and runtime modules
├── tests/                  # automated test suite
├── docs/                   # architecture and data-model docs
├── DEPLOYMENT.md           # setup, providers, SearXNG, and operations
├── CONTRIBUTING.md         # development and testing workflow
├── PLAN.md                 # active roadmap
└── IMPLEMENTATION_HISTORY.md
```
