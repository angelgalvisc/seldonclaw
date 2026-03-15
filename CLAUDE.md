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

## Phase 0: Spike — NullClaw round-trip ⏭️ SKIPPED

**Decision:** NullClaw integration deferred. DirectLLMBackend chosen instead.
NullClaw (96K LOC Zig binary, 678KB) provides agent capabilities (tools, channels, sandbox, memory)
that SeldonClaw actors don't need — actors only require structured LLM completions.
DirectLLMBackend calls llm.ts directly: zero external process, zero HTTP overhead, same TypeScript stack.
CKP compatibility preserved via `@clawkernel/sdk` (actor export/import contract).
CognitionBackend interface allows future NullClaw swap if agent capabilities become needed.

---

## Phase 1: Foundation — 3 files, no interdependencies (3 days) ✅ COMPLETE

These three do NOT depend on each other. Can be built in parallel.

### Step 1.1: db.ts ✅

**Ref:** PLAN.md §SQLite Schema (lines 145-581), §GraphStore interface (lines 774-807)

- [x] SQLite schema bootstrap for fresh databases — all Phase 1 tables and indices implemented
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

**Notes:**
- Current DB layer bootstraps fresh SQLite files via `SCHEMA_SQL`.
- Versioned migrations are not implemented yet; if the schema changes again, add them before claiming migration support.

**EXIT GATE:** ✅ All 3 files with green tests (46/46). `simulation.db` creates correctly.

---

## Phase 2: Ingestion Pipeline — linear chain (4 days) ✅ COMPLETE

Each step feeds the next. Strict order.

### Step 2.1: ingest.ts ✅

**Ref:** PLAN.md §Project Structure (line 110), §Provenance tables (lines 176-207)

**Depends on:** db.ts

- [x] Parse MD/TXT documents
- [x] Chunking (by paragraph, with oversize splitting by sentence and hard boundary)
- [x] `content_hash` (SHA-256, cross-platform CRLF normalization) for dedup
- [x] `GraphStore.addDocument()`, `addChunk()` + new query methods: `getDocumentByHash()`, `getChunksByDocument()`, `getAllDocuments()`

**Verification:**
- [x] `fixtures/sample-docs/` → documents (3), chunks (>0) in DB — 28 tests
- [x] Re-ingest same doc → no duplicates (content_hash check)
- [x] Re-ingest same directory → all files deduplicated
- [x] Chunks have valid `document_id` FK
- [x] Unsupported file extension → descriptive error

### Step 2.2: ontology.ts ✅

**Ref:** PLAN.md §Ontology tables (lines 209-223), §Project Structure (line 111)

**Depends on:** db.ts, llm.ts, ingest.ts (chunks must exist)

- [x] LLM (native Anthropic) extracts `entity_types`, `edge_types` from chunks (schema discovery)
- [x] LLM extracts claims (subject, predicate, object, temporality) in batches
- [x] Structured output with `completeJSON()` + `normalizeTypeName()`

**Verification:**
- [x] `entity_types` (>0), `edge_types` (>0), `claims` (>0) in DB — 13 tests
- [x] Every claim has valid `source_chunk_id` FK (provenance)
- [x] Claims have `valid_from`/`valid_to` when applicable
- [x] Claims have topics as JSON array
- [x] Confidence in [0.0, 1.0]
- [x] Empty chunks → graceful empty result

### Step 2.3: graph.ts (+ entity resolution) ✅

**Ref:** PLAN.md §Knowledge Graph (lines 225-249), §Entity Resolution (lines 257-282, 809-828)

**Depends on:** db.ts, ontology.ts (claims + types must exist)

- [x] `EntityResolver.normalize()` — lowercase, trim, remove honorifics, normalize whitespace
- [x] `EntityResolver.findDuplicates()` — Sørensen–Dice coefficient on bigrams
- [x] `EntityResolver.merge()` — keeps longer (more descriptive) name
- [x] `entity_claims` and `edge_claims` (provenance links)
- [x] `entity_merges` (audit trail with merge_reason and merge_reason_detail)
- [x] FTS5 sync (handled by GraphStore.addEntity/mergeEntities)
- [x] `graph_revision_id` generation (hash of entities+edges+merges)
- [x] Added to GraphStore interface: `getClaimsByChunk()`, `getEntityTypes()`, `getEdgeTypes()`, `getAllActiveEntities()`

**Verification:**
- [x] entities (>0), edges (>0) in DB — 24 tests
- [x] Intentional duplicates ("Universidad Nacional" / "Universidad Nacional de Colombia") merged
- [x] `entity_merges` has records with `merge_reason`
- [x] `queryProvenance(entityId)` returns chain: entity → claims → chunks → documents
- [x] `graph_revision_id` is deterministic (same input → same hash)
- [x] Tests: `graph.test.ts` (fixtures with intentional duplicates)
- [x] `diceCoefficient()` tested: identical, different, partial, symmetric

### Step 2.4: profiles.ts ✅

**Ref:** PLAN.md §ActorSpec vs ActorState (lines 585-631), §Actors table (lines 284-314)

**Depends on:** db.ts, llm.ts, graph.ts (entities must exist)

- [x] LLM generates personality, bio, age, gender, profession, region, language
- [x] Initial stance, sentiment_bias, activity_level, influence_weight (clamped)
- [x] Archetype mapping: person→persona, organization→organization, university→institution, media→media
- [x] Cognition tier from influence + archetype (per PLAN.md CognitionRouter rules)
- [x] Community detection by topic clustering (greedy Jaccard-based)
- [x] `community_overlap` computed between communities
- [x] Follow graph with deterministic hash (no Math.random)
- [x] Seed posts for tier A actors at round 0
- [x] Added to GraphStore interface: `updateActorCommunity()`

**Verification:**
- [x] actors created from entities with correct archetypes — 17 tests
- [x] Each actor has valid `entity_id` FK
- [x] `actor_topics` (>0), `actor_beliefs` (>0) in DB
- [x] communities (>0), actors assigned to communities
- [x] follows (>0)
- [x] Seed posts at round 0 for tier A actors
- [x] Fields `gender`, `region`, `language` populated
- [x] sentiment_bias in [-1, 1], activity_level in [0, 1]
- [x] maxActors option respected
- [x] Empty entities → graceful empty result

**EXIT GATE:** ✅ All 4 files with green tests (140/140). Ingestion pipeline complete: documents → chunks → entity_types → edge_types → claims → entities → edges → entity_resolution → actors → communities → follows → seed_posts.

**Post-audit fixes applied:**
- profiles.ts: replaced `randomUUID()` with `stableId()` (SHA-256 derived) for actors, communities, and seed posts. Added stable sort tiebreaker in `detectCommunities()`.
- db.ts: `getAllActiveEntities()` now uses `ORDER BY id` for deterministic entity ordering.
- ontology.ts: claim extraction changed from batch to per-chunk for exact `source_chunk_id` provenance. Removed `findBestSourceChunk()` heuristic.
- Added reproducibility tests verifying same inputs + same `runId` → same structural outputs across pipeline runs.

---

## Phase 3: Cognition Layer (3 days) ✅ COMPLETE

**Architecture decision:** NullClaw replaced with DirectLLMBackend.
NullClaw (96K LOC Zig binary) was evaluated as over-engineering for SeldonClaw's needs.
Actor decisions only require structured LLM completions — not agent capabilities (tools, channels, sandbox).
DirectLLMBackend calls llm.ts directly, zero external process dependency.
CKP compatibility preserved via `@clawkernel/sdk` (actor export/import, A2A message types).
NullClawBackend remains defined in CognitionBackend interface for future swap if needed.

### Step 3.1: cognition.ts ✅

**Ref:** PLAN.md §Cognition: 3 Separate Layers (lines 992-1036), §Interaction Summary (lines 1240-1278), §Shared Types (lines 1212-1238)

**Depends on:** db.ts (types), config.ts (CognitionConfig), llm.ts (LLMClient), reproducibility.ts (PRNG, hashing)

- [x] `CognitionRouter` (routeCognition → tier A/B/C)
- [x] `DecisionPolicy` (applyTierCRules for tier C — uses PRNG, NOT Math.random)
- [x] `CognitionBackend` interface (start, shutdown, decide, interview)
- [x] `DirectLLMBackend implements CognitionBackend` (uses llm.ts "simulation" provider)
- [x] `MockCognitionBackend` for tests (canned decisions, call tracking)
- [x] Types: `DecisionRequest`, `DecisionResponse`, `CognitionRoute`, `CognitionTier`
- [x] `buildSimContext()` — builds interaction summary from GraphStore
- [x] `buildDecisionRequest()` — convenience builder for engine.ts
- [x] Decision caching in `decision_cache` for RecordedBackend replay
- [x] Prompt templates with versioning (`getPromptVersion()`)
- [x] Response validation with fallback to idle on invalid actions

**Verification:**
- [x] Router classifies correctly:
  - influence 0.9 → tier A
  - archetype "media" or "institution" → tier A
  - mentioned in active event → tier B
  - random sampling at configured rate → tier B
  - default (low influence, no salience) → tier C
- [x] `applyTierCRules` with fixed seed → same decision every time
- [x] Viral repost probability ~40% across seeds (matches config)
- [x] Aligned like probability ~60% across seeds (matches config)
- [x] Non-aligned posts → never liked (0%)
- [x] `buildSimContext()` generates readable summary from test data
- [x] `buildDecisionRequest()` builds correct structure
- [x] MockCognitionBackend tracks decide/interview calls
- [x] Tests: `cognition.test.ts` — 21 tests pass

### Step 3.2: reproducibility.ts ✅

**Ref:** PLAN.md §RecordedBackend (lines 1200-1210), §Reproducibility tables (lines 500-580)

**Depends on:** db.ts, cognition.ts

- [x] Seedable PRNG (xoshiro128** — 32-bit, fast, good distribution)
  - `SeedablePRNG` implements `PRNG` interface from db.ts
  - `next()` returns [0, 1), `nextInt(min, max)` returns integer in range
  - `state()` / `fromState()` for snapshot persistence
- [x] `RecordedBackend implements CognitionBackend`
  - lookup by `(request_hash, model_id, prompt_version)`
  - Throws descriptive error on cache miss (no silent fallback)
  - Supports interview replay via synthetic request hash
- [x] `hashDecisionRequest()` — SHA-256 of canonical JSON
- [x] Snapshot: `saveSnapshot()` / `restoreSnapshot()` round-trip
  - actor_states + narrative_states + rng_state serialized to JSON

**Verification:**
- [x] PRNG with seed 42 → same sequence every time (100 values)
- [x] Different seeds → different sequences
- [x] Values in [0, 1) range (1000 samples)
- [x] nextInt returns integers in [min, max] (100 samples)
- [x] Distribution roughly uniform (5 buckets, 15% tolerance)
- [x] State save/restore continues identical sequence
- [x] `RecordedBackend` finds cached decision → returns it
- [x] `RecordedBackend` cache miss → throws error (not silent)
- [x] `RecordedBackend` different `prompt_version` → cache miss
- [x] Interview replay from cache
- [x] hashDecisionRequest: same input → same hash, different → different
- [x] Snapshot save + restore → identical states
- [x] Latest snapshot selected when multiple exist
- [x] PRNG state in snapshot allows continuing sequence
- [x] Tests: `reproducibility-prng.test.ts` — 20 tests pass

**EXIT GATE:** ✅ `CognitionBackend.decide()` works with DirectLLMBackend, MockCognitionBackend, and RecordedBackend. 41 new tests pass.

---

## Phase 4: Social Modules ✅ COMPLETE

225/225 tests (13 test files). All three modules implemented with full test coverage.

### Step 4.1: activation.ts ✅

- [x] `computeActivation()` using `round.rng` (NOT Math.random)
- [x] Hour multiplier, event boost, fatigue penalty (stub=0)
- [x] Uses `ActivationConfig` (derived from SimConfig by engine.ts)
- [x] Actors sorted by id, each consumes exactly one `rng.next()` for determinism
- [x] Tests: `activation.test.ts` (13 tests)

### Step 4.2: feed.ts ✅

- [x] `buildFeed()` with scoring: recency, popularity, relevance, community affinity
- [x] Echo chamber effect (cohesion * echoChamberStrength)
- [x] Partial exposure (topN, not entire feed)
- [x] Candidate collection: follow → community → trending (deduped)
- [x] Tests: `feed.test.ts` (14 tests)

### Step 4.3: telemetry.ts ✅

- [x] `logAction()` → INSERT into telemetry (with optional llmStats)
- [x] `sanitizeDetail()` — redact secrets from action_detail JSON
- [x] `updateRound()` → INSERT/UPDATE into rounds
- [x] `getTierStats()` — count actors per cognition tier
- [x] Tests: `telemetry.test.ts` (14 tests)

---

## Phase 5: Engine + CLI — MVP ✅ COMPLETE

248/248 tests (15 test files). Main simulation loop and CLI entry point.

### Step 5.1: engine.ts ✅

- [x] Main loop: for each round → activation → feed → decide → execute → telemetry
- [x] `buildPlatformState()` at start of each round (via GraphStore)
- [x] Bulk `getActorTopicsByRun()` / `getActorBeliefsByRun()` (added to db.ts)
- [x] Persist changes to SQLite per actor (addPost, addExposure, addFollow, etc.)
- [x] Snapshot every N rounds (rng_state for resume)
- [x] `RoundContext` construction (simTimestamp, simHour, activeEvents, rng)
- [x] Sequential execution (concurrency=1, v1)
- [x] Tests: `engine.test.ts` (18 tests)

### Step 5.2: index.ts (CLI) ✅

- [x] Commander CLI with subcommands
- [x] `seldonclaw simulate` (fully wired)
- [x] `seldonclaw stats` (fully wired, --tiers option)
- [x] Stub commands: run, ingest, analyze, generate, inspect, resume, replay
- [x] Tests: `index.test.ts` (5 tests)

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
