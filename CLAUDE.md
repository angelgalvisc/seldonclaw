# SeldonClaw — Implementation Roadmap

> **Source of truth:** `PLAN.md` (architecture, interfaces, schema, types).
> This file is the **execution checklist**. Every step references concrete lines/sections in PLAN.md.
> Do NOT duplicate specs here — only reference them.

## How to use this file across sessions

Start each session with:

```
"SeldonClaw, Phase N, Step M. Previous steps passed verification.
 Spec: /Users/agc/Documents/seldonclaw/PLAN.md
 Ops: /Users/agc/Documents/seldonclaw/DEPLOYMENT.md
 Implement Step M."
```

## Status Legend

- `[ ]` Not started
- `[~]` In progress
- `[x]` Completed — verification passed
- `[!]` Blocked — see notes

---

## Phase 0: Spike — NullClaw round-trip (2-3 days)

**Why first:** If A2A doesn't work, the entire cognition architecture changes. Validate before building anything.

### Step 0.1: NullClaw integration spike

- [ ] Create `spike/nullclaw-test.ts` (throwaway script, not project structure)
- [ ] Spawn NullClaw binary
- [ ] `GET /health` → assert 200
- [ ] `POST /pair` → store token in memory
- [ ] `POST /a2a` with hardcoded `A2ADecisionMessage` → parse response
- [ ] `POST /a2a` with hardcoded `A2AInterviewMessage` → extract text

**Verification:**
- [ ] Health check responds 200
- [ ] Pairing returns token
- [ ] DecisionMessage round-trip → parseable DecisionResponse
- [ ] InterviewMessage round-trip → coherent string

**Decision to document in PLAN.md before proceeding:**
- [ ] Does NullClaw accept `message/send` via `/a2a` or must we use `/webhook`?
- [ ] Config mechanism: CLI args, env vars, or profile?

**EXIT GATE:** All 4 checks green. If any fails → adjust adapter design before Phase 1.

---

## Phase 1: Foundation — 3 files, no interdependencies (3 days) ✅ COMPLETE

These three do NOT depend on each other. Can be built in parallel.

### Step 1.1: db.ts ✅

**Ref:** PLAN.md §SQLite Schema (lines 145-581), §GraphStore interface (lines 774-807)

- [x] SQLite schema — all tables from PLAN.md (copy SQL verbatim)
- [x] PRAGMAs: WAL, FK, busy_timeout
- [x] `GraphStore` interface (all methods including interaction history + buildPlatformState)
- [x] `SQLiteGraphStore` implementation (v1)
- [x] Types: `PostSnapshot`, `ActorSnapshot`, `CommunitySnapshot`, `EngagementStats`, `StanceChange`

**Verification:**
- [x] `new SQLiteGraphStore('test.db')` creates all tables (19 tests pass)
- [x] All indices exist (query `sqlite_master`) — 17 indices verified
- [x] FTS5 `entities_fts` works (INSERT + search)
- [x] `exposure_summary` VIEW returns correct data (strongest_reaction aggregation)
- [x] FK constraints active (INSERT with invalid FK → error)
- [x] Tests: `db.test.ts` — 19 tests pass

### Step 1.2: config.ts ✅

**Ref:** PLAN.md §SimConfig (lines 1470-1559)

- [x] Loader for `seldonclaw.config.yaml`
- [x] Types: `SimConfig`, `CognitionConfig`, `FeedConfig`, `FatigueConfig`, `PropagationConfig`, `EventConfig`, `ActivationConfig`
- [x] `sanitizeForStorage()` — strip secrets before persisting
- [x] Validation: required fields, valid ranges

**Verification:**
- [x] Loads example config from PLAN.md
- [x] `sanitizeForStorage()` removes `apiKeyEnv` values, pairing token
- [x] Invalid config (negative seed, probability > 1) → descriptive error (ConfigError with field)
- [x] Tests: `config.test.ts` — 17 tests pass

### Step 1.3: llm.ts ✅

**Ref:** PLAN.md §Dependencies (lines 1597-1623), §SimConfig providers (lines 1496-1511)

- [x] `LLMClient` with multi-provider (analysis, generation, simulation, report)
- [x] Anthropic native SDK (`@anthropic-ai/sdk`)
- [x] Structured output helpers (`completeJSON` with JSON extraction)
- [x] `MockLLMClient` for tests without API keys

**Verification:**
- [~] Real call to claude-haiku with simple prompt → deferred (requires API key)
- [x] Provider "analysis" and "report" use Anthropic native SDK
- [x] Tokens counted, cost calculated (pricing table per model)
- [x] `MockLLMClient` available for CI tests

**EXIT GATE:** ✅ All 3 files with green tests (36/36). `simulation.db` creates correctly.

---

## Phase 2: Ingestion Pipeline — linear chain (4 days)

Each step feeds the next. Strict order.

### Step 2.1: ingest.ts

**Ref:** PLAN.md §Project Structure (line 110), §Provenance tables (lines 176-207)

**Depends on:** db.ts

- [ ] Parse MD/TXT documents
- [ ] Chunking (by paragraph or token count)
- [ ] `content_hash` (SHA-256) for dedup
- [ ] `GraphStore.addDocument()`, `addChunk()`

**Verification:**
- [ ] `fixtures/sample-docs/` → documents (>0), chunks (>0) in DB
- [ ] Re-ingest same doc → no duplicates (content_hash check)
- [ ] Chunks have valid `document_id` FK

### Step 2.2: ontology.ts

**Ref:** PLAN.md §Ontology tables (lines 209-223), §Project Structure (line 111)

**Depends on:** db.ts, llm.ts, ingest.ts (chunks must exist)

- [ ] LLM (native Anthropic) extracts `entity_types`, `edge_types` from chunks
- [ ] LLM extracts claims (subject, predicate, object, temporality)
- [ ] Structured output with `response_format`

**Verification:**
- [ ] `entity_types` (>0), `edge_types` (>0), `claims` (>0) in DB
- [ ] Every claim has valid `source_chunk_id` FK (provenance)
- [ ] Claims have `valid_from`/`valid_to` when applicable

### Step 2.3: graph.ts (+ entity resolution)

**Ref:** PLAN.md §Knowledge Graph (lines 225-249), §Entity Resolution (lines 257-282, 809-828)

**Depends on:** db.ts, ontology.ts (claims + types must exist)

- [ ] `EntityResolver.normalize()`
- [ ] `EntityResolver.findDuplicates()` + `merge()`
- [ ] `EntityResolver.resolveAlias()`
- [ ] `entity_claims` and `edge_claims` (provenance links)
- [ ] `entity_merges` (audit trail)
- [ ] FTS5 sync (`entities_fts`)
- [ ] `graph_revision_id` generation (hash of entities+edges+merges)

**Verification:**
- [ ] entities (>0), edges (>0) in DB
- [ ] No obvious duplicates (e.g., "Universidad Nacional" and "U. Nacional" merged)
- [ ] `entity_merges` has records with `merge_reason`
- [ ] `queryProvenance(entityId)` returns chain: entity → claims → chunks → documents
- [ ] `graph_revision_id` is deterministic (same input → same hash)
- [ ] Tests: `graph.test.ts` (fixtures with intentional duplicates)

### Step 2.4: profiles.ts

**Ref:** PLAN.md §ActorSpec vs ActorState (lines 585-631), §Actors table (lines 284-314)

**Depends on:** db.ts, llm.ts, graph.ts (entities must exist)

- [ ] LLM generates `ActorSpec` (personality, bio, age, gender, region, language)
- [ ] Initial `ActorState` (stance, sentiment_bias, activity_level, influence_weight)
- [ ] Community detection (by topic cluster or entity proximity)
- [ ] `community_overlap`
- [ ] Initial follow graph
- [ ] Initial posts (round 0 seeds)

**Verification:**
- [ ] actors (10-20), `actor_topics` (>0), `actor_beliefs` (>0) in DB
- [ ] Each actor has valid `entity_id` FK (or null for synthetics)
- [ ] communities (>0), `community_overlap` (>0)
- [ ] follows (>0), reasonable distribution
- [ ] `ActorSpec` exportable (has all interface fields)
- [ ] Fields `gender`, `region`, `language` populated

**EXIT GATE:** `seldonclaw ingest + analyze + generate` produces DB with actors ready to simulate.

---

## Phase 3: Cognition Layer (3 days)

### Step 3.1: cognition.ts

**Ref:** PLAN.md §Cognition: 3 Separate Layers (lines 992-1036), §Interaction Summary (lines 1240-1278), §Shared Types (lines 1212-1238)

**Depends on:** db.ts (types), config.ts (CognitionConfig)

- [ ] `CognitionRouter` (route → tier A/B/C)
- [ ] `DecisionPolicy` (applyRules for tier C — uses PRNG, NOT Math.random)
- [ ] `CognitionBackend` interface
- [ ] Types: `DecisionRequest`, `DecisionResponse`, `CognitionRoute`
- [ ] `buildSimContext()` — builds simContext from GraphStore

**Verification:**
- [ ] Router classifies correctly:
  - influence 0.9 + archetype "media" → tier A
  - influence 0.5 + relevant event → tier B
  - influence 0.2 + off-peak → tier C
- [ ] `DecisionPolicy` with fixed seed → same decision every time
- [ ] `buildSimContext()` generates readable summary from test data

### Step 3.2: nullclaw-worker.ts

**Ref:** PLAN.md §NullClawBackend (lines 1044-1198)

**Depends on:** cognition.ts (CognitionBackend interface), Phase 0 (spike findings)

- [ ] `NullClawBackend implements CognitionBackend`
- [ ] `NullClawAdapter` (toDecisionMessage, fromA2AResult, etc.)
- [ ] `bootstrapNullClaw()` — spawn + health + pair
- [ ] `authHeaders()` — bearer token in-memory only
- [ ] `cacheDecision()` — persist in decision_cache

**Verification:**
- [ ] `start()` → NullClaw alive + paired
- [ ] `decide(request)` → parseable DecisionResponse
- [ ] `interview(context, question)` → coherent string
- [ ] `decision_cache` has row after `decide()`
- [ ] `authToken` NEVER appears in telemetry or decision_cache

### Step 3.3: reproducibility.ts

**Ref:** PLAN.md §RecordedBackend (lines 1200-1210), §Reproducibility tables (lines 500-580)

**Depends on:** db.ts, cognition.ts

- [ ] Seedable PRNG (xoshiro256** or similar)
- [ ] `RecordedBackend implements CognitionBackend`
  - lookup by `(request_hash, model_id, prompt_version)`
- [ ] Snapshot: save/restore of actor_states + narrative_states + rng_state
- [ ] `run_manifest`: create/update

**Verification:**
- [ ] PRNG with seed 42 → same sequence every time
- [ ] `RecordedBackend` finds cached decision → 0 LLM calls
- [ ] `RecordedBackend` with different `prompt_version` → cache miss (no silent replay)
- [ ] Snapshot save + restore → identical states
- [ ] `run_manifest` has `graph_revision_id`, sanitized `config_snapshot`

**EXIT GATE:** `CognitionBackend.decide()` works end-to-end with NullClaw and RecordedBackend.

---

## Phase 4: Social Modules (2.5 days)

These do NOT depend on each other — can be built in parallel.

### Step 4.1: activation.ts

**Ref:** PLAN.md §activation.ts (lines 832-863)

**Depends on:** db.ts (ActorState), cognition.ts (RoundContext)

- [ ] `computeActivation()` using `round.rng` (NOT Math.random)
- [ ] Hour multiplier, event boost, fatigue penalty
- [ ] Uses `ActivationConfig` (derived from SimConfig by engine.ts)

**Verification:**
- [ ] Fixed seed → same actors activated every time
- [ ] Peak hours → more activations
- [ ] Relevant event → activation boost
- [ ] Tests: `activation.test.ts`

### Step 4.2: feed.ts

**Ref:** PLAN.md §feed.ts (lines 866-900)

**Depends on:** db.ts (PlatformState, PostSnapshot, ActorSnapshot)

- [ ] `buildFeed()` with scoring: recency, popularity, relevance, community affinity
- [ ] Echo chamber effect (cohesion * echoChamberStrength)
- [ ] Partial exposure (topN, not entire feed)
- [ ] Uses `state.actors` for author community/stance, `state.communities` for cohesion

**Verification:**
- [ ] Feed contains posts from followed actors (source: "follow")
- [ ] High-engagement posts appear (source: "trending")
- [ ] Echo chamber: posts aligned with actor stance rank higher
- [ ] `feedSize` respected (never more than `config.feed.size` posts)
- [ ] Tests: `feed.test.ts`

### Step 4.3: telemetry.ts

**Ref:** PLAN.md §Telemetry table (lines 463-479), §Project Structure (line 123)

**Depends on:** db.ts

- [ ] `logAction()` → INSERT into telemetry
- [ ] `sanitizeDetail()` — redact secrets from action_detail JSON
- [ ] `updateRound()` → INSERT/UPDATE into rounds

**Verification:**
- [ ] `logAction` with `cognition_tier` → row in telemetry
- [ ] `sanitizeDetail()` removes any string resembling API key/token
- [ ] Tokens/cost aggregated correctly

**EXIT GATE:** Each module has green unit tests with test data.

---

## Phase 5: Engine + CLI — MVP (3 days)

### Step 5.1: engine.ts

**Ref:** PLAN.md §Architecture (lines 34-97), §Per-Actor Per-Round Flow (lines 1280-1292)

**Depends on:** ALL previous phases

- [ ] Main loop: for each round → activation → feed → decide → execute → telemetry
- [ ] `buildPlatformState()` at start of each round (via GraphStore)
- [ ] Project `ActorState` from SQLite at start of each round
- [ ] Persist changes to SQLite at end of each round
- [ ] Snapshot every N rounds
- [ ] `RoundContext` construction (simTimestamp, simHour, activeEvents, rng)
- [ ] Concurrency support (sequential for Pi 4, parallel for server)

**Verification:**
- [ ] 5 rounds execute without error
- [ ] posts (>0) created in DB
- [ ] telemetry has rows with cognition_tier A, B, and C
- [ ] rounds has 5 rows with tier_a/b/c_calls
- [ ] `run_manifest` has 1 row with status "completed"
- [ ] Same seed → same simulation (compare post counts and telemetry)

### Step 5.2: index.ts (CLI)

**Ref:** PLAN.md §CLI (lines 1561-1595), §Project Structure (line 106)

**Depends on:** engine.ts, all modules

- [ ] Commander CLI with all commands from PLAN.md
- [ ] `seldonclaw run` (full pipeline)
- [ ] `seldonclaw ingest`, `analyze`, `generate`, `simulate` (individual steps)
- [ ] `seldonclaw stats`, `seldonclaw inspect`
- [ ] `seldonclaw replay`, `seldonclaw resume`

**Verification:**
- [ ] `seldonclaw run --docs fixtures/ --hypothesis "..." --rounds 5 --seed 42` produces valid `simulation.db`
- [ ] `seldonclaw stats --db simulation.db` shows metrics
- [ ] `seldonclaw stats --db simulation.db --tiers` shows A/B/C breakdown

**EXIT GATE:** `seldonclaw run` end-to-end produces valid simulation.db. **This is the functional MVP.**

---

## Phase 6: Advanced Social Dynamics — P1 (2.5 days)

### Step 6.1: propagation.ts

**Ref:** PLAN.md §propagation.ts (lines 902-937)

**Depends on:** db.ts (PlatformState with CommunitySnapshot), engine.ts

- [ ] Simplified SIR model per community
- [ ] Cross-community propagation via `community.overlaps`
- [ ] Viral detection (reach > viralThreshold)
- [ ] Uses `state.actors` for influence, `state.communities` for cohesion/overlaps

**Verification:**
- [ ] Posts from influential actors propagate within their community
- [ ] Viral posts cross to other communities via overlaps
- [ ] `viralPosts[]` contains posts exceeding threshold
- [ ] Tests: `propagation.test.ts`

### Step 6.2: fatigue.ts

**Ref:** PLAN.md §fatigue.ts (lines 939-960)

**Depends on:** db.ts (narratives)

- [ ] Exponential decay per narrative
- [ ] Extinction threshold
- [ ] Re-activation by event

**Verification:**
- [ ] Narrative intensity decays over time
- [ ] Narratives below `extinctionThreshold` → actors stop posting about the topic
- [ ] Event on extinguished topic → reactivation

### Step 6.3: events.ts

**Ref:** PLAN.md §events.ts (lines 962-989)

**Depends on:** db.ts (PlatformState), engine.ts

- [ ] Initial posts (round 0)
- [ ] Scheduled events
- [ ] Threshold triggers (sentiment, post count, stance change)

**Verification:**
- [ ] Round 0 has initial posts
- [ ] Scheduled event appears in correct round
- [ ] Threshold trigger: sentiment < -0.6 → inject event

### Step 6.4: Integrate into engine.ts

- [ ] Add propagation, fatigue, events to engine loop
- [ ] 72-round simulation with propagation + fatigue + events
- [ ] Narratives visibly decay
- [ ] At least 1 threshold trigger fires

**EXIT GATE:** Full simulation with realistic social dynamics.

---

## Phase 7: Analysis + Portability — P2 (3.5 days)

### Step 7.1: ckp.ts

**Ref:** PLAN.md §export-agent / import-agent (lines 1327-1347), §Portability (lines 1294-1325)

**Depends on:** db.ts

- [ ] export-agent: ActorSpec + ActorState → bundle (claw.yaml + JSONs)
- [ ] import-agent: bundle → reconstitute actor in DB
- [ ] `scrubSecrets()` — strip API keys, tokens, env values

**Verification:**
- [ ] Bundle has: claw.yaml, actor_state.json, beliefs.json, topics.json, provenance.json, manifest.meta.json
- [ ] claw.yaml is valid CKP (schema validation via `@clawkernel/sdk`)
- [ ] NO bundle file contains API keys or tokens
- [ ] import-agent reconstitutes actor → DB query confirms beliefs, topics, stance

### Step 7.2: report.ts

**Ref:** PLAN.md §Report Pipeline (lines 1700-1727)

**Depends on:** db.ts, llm.ts (report provider)

- [ ] Phase 1: Pure SQL → structured metrics
- [ ] Phase 2: LLM narrative from findings + hypothesis
- [ ] Report ONLY reads normalized tables (NO JSON blobs)

**Verification:**
- [ ] Phase 1 produces JSON with: post counts, sentiment curves, top actors, tier breakdown
- [ ] Phase 2 produces coherent Markdown
- [ ] `grep` the code: zero `JSON.parse` in report queries

### Step 7.3: interview.ts

**Ref:** PLAN.md §CognitionBackend.interview() (lines 1044-1047)

**Depends on:** cognition.ts (CognitionBackend)

- [ ] Interview flow: build actor context → `CognitionBackend.interview()`
- [ ] Format response

**Verification:**
- [ ] `seldonclaw interview --actor journalist-01` → coherent response
- [ ] Actor responds "in character" (stance, beliefs reflected)

**EXIT GATE:** Export + report + interview all functional.

---

## Phase 8: Interactive Shell — P2 (1.5 days)

### Step 8.1: shell.ts

**Ref:** PLAN.md §Interactive Shell (lines 1729-1828)

**Depends on:** db.ts, report.ts (NL→SQL), interview.ts, ckp.ts

- [ ] REPL with `readline`
- [ ] `ShellContext` (db, runId, backend, llm, schema)
- [ ] Intent classification: query | interview | export | inject | compare
- [ ] NL → SQL via report provider
- [ ] Interview mode (`/exit` to return)
- [ ] Safety: read-only by default, confirm writes

**Verification:**
- [ ] NL query → correct SQL → formatted results
- [ ] "interview journalist-01" → enters interview mode
- [ ] `/exit` → returns to main shell
- [ ] No INSERT/UPDATE/DELETE without confirmation
- [ ] No secrets in any output

**EXIT GATE:** `seldonclaw shell` functional. **Project complete.**

---

## Summary

| Phase | Files | Days | Gate |
|---|---|---|---|
| **0: Spike** | spike script | 2-3 | A2A round-trip works |
| **1: Foundation** | db.ts, config.ts, llm.ts | 3 | Schema + config + LLM client |
| **2: Pipeline** | ingest, ontology, graph, profiles | 4 | Actors in DB from documents |
| **3: Cognition** | cognition, nullclaw-worker, reproducibility | 3 | decide() end-to-end + replay |
| **4: Social** | activation, feed, telemetry | 2.5 | Modules testable in isolation |
| **5: Engine** | engine.ts, index.ts | 3 | **MVP: `seldonclaw run` works** |
| **6: Dynamics** | propagation, fatigue, events | 2.5 | Simulation with social dynamics |
| **7: Analysis** | ckp, report, interview | 3.5 | Export + report + interview |
| **8: Shell** | shell.ts | 1.5 | Conversational REPL |
| **Total** | **~22 files** | **~25 days** | |

---

## Cross-reference: PLAN.md contracts that MUST be honored

These are the non-negotiable contracts. If implementation deviates, update PLAN.md first.

| Contract | Location | Rule |
|---|---|---|
| GraphStore interface | PLAN.md lines 774-807 | All methods must be implemented in SQLiteGraphStore |
| PlatformState projection | PLAN.md lines 674-736 | Read-only snapshot, rebuilt each round, never written to by modules |
| RoundContext | PLAN.md lines 738-755 | Uses `activeEvents` (not `events`), no full SimConfig |
| PRNG everywhere | PLAN.md lines 851, 1009, 1035 | `round.rng.next()`, never `Math.random()` |
| decision_cache lookup | PLAN.md lines 1200-1210 | Key = `(request_hash, model_id, prompt_version)` |
| NullClaw endpoints | PLAN.md lines 1067-1073 | ONLY `/health`, `/pair`, `/webhook`, `/a2a`. Never invent endpoints |
| Report policy | PLAN.md lines 1700-1703 | Reports ONLY read normalized tables. No JSON blobs |
| Security | PLAN.md lines 29, DEPLOYMENT.md | Secrets never in persistent data. sanitize/redact/scrub |
| Pairing default | PLAN.md line 1518 | `enabled: true` — secure by default |
| Platform | PLAN.md lines 1210, 1228, 1457 | `"x"` only (X, formerly Twitter). No Reddit in v1 |
| Actor memory | PLAN.md lines 1240-1278 | Derived on-the-fly via `buildSimContext()`, no `simulation_memories` table |
| prompt_version NOT NULL | PLAN.md line 533 | Required in decision_cache, used in replay lookup |
