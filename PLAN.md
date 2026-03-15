# SeldonClaw — Social Simulation Engine on CKP + DirectLLM

## Context

MiroFish (github.com/666ghj/MiroFish) is a pioneering social simulation engine with a well-designed pipeline (ontology → graph → profiles → simulation → report). However, it has limitations that hinder adoption in resource-constrained or audit-sensitive environments: dependency on Zep Cloud, OASIS as a black box for the social engine, no agent portability, hardcoded timezone, and fragmented storage.

**SeldonClaw** builds on the same pipeline concept but with different design choices: TypeScript-first, SQLite-first, DirectLLMBackend by default (swappable), CKP as the actor portability contract (not as the social engine), explicit and auditable social engine, and flat structure (~20 files).

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Language | **TypeScript** | Native CKP SDK, fast iteration, auditable |
| Storage | **1 SQLite file** behind `GraphStore` interface | Zero cloud, Pi 4 viable, FTS5 + optional embedding cache. Interface allows swapping storage |
| Cognition backend | **DirectLLMBackend** (default), not tied to any external runtime | Calls llm.ts directly. Swappable with NullClawBackend or any CKP conformant runtime |
| Actors | **ActorSpec + ActorState** separated | Spec = portable contract (CKP). State = beliefs/stance/fatigue (simulation) |
| Cognition | **3 layers**: CognitionRouter + DecisionPolicy + CognitionBackend | Router decides tier. Policy decides rules. Backend executes. Clean separation |
| Social engine | **Explicit standalone module** | activation, feed, propagation, fatigue, events — not CKP Swarm |
| CKP | **Actor export/import contract**, not the engine core | Portability = structure (claw.yaml) + state (bundle). Does not replace social engine |
| Graph | **Temporal with provenance + entity resolution P0** | documents→chunks→claims + dedup + merge + alias resolution |
| LLM SDK | **Anthropic native** for critical structured extraction | OpenAI compat ignores strict/response_format/seed. Native for ontology/profiles/report |
| Conformance | **CKP schema validation on archetypes** | L3 on NullClaw Bridge (externally validated), not on own integration |
| Reproducibility | **seed + decision_cache + snapshots + run_manifest** | seed controls local PRNG; decision_cache records LLM responses for exact replay |
| Report | **Normalized tables only → findings → LLM narrative** | Policy: reports never read JSON blobs directly |
| Security | **Secrets never in persistent data** | config_snapshot sanitized, telemetry redacted, export bundles scrubbed. Pairing on by default |
| Structure | **Flat src/ (~20 files)** NanoClaw style | No 7-package monorepo |

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                seldonclaw (1 TS process)              │
│                                                      │
│  ┌────────┐  ┌──────────┐  ┌───────────────────┐     │
│  │ ingest │→ │ ontology │→ │  graph + entity   │     │
│  │ MD/PDF │  │ (native) │  │  resolution/dedup │     │
│  └────────┘  └──────────┘  └────────┬──────────┘     │
│                                     │                │
│                               ┌─────▼──────┐        │
│                               │  profiles  │        │
│                               │  (native)  │        │
│                               └─────┬──────┘        │
│                                     │                │
│  ┌──────────────────────────────────▼─────────────┐  │
│  │          engine.ts                             │  │
│  │  for each round:                               │  │
│  │    1. activation → who comes online            │  │
│  │    2. feed → what each actor sees              │  │
│  │    3. decide:                                  │  │
│  │       CognitionRouter → tier (A/B/C)           │  │
│  │       DecisionPolicy → rules (C) or backend    │  │
│  │       CognitionBackend.decide() → (A/B)        │  │
│  │    4. execute → action on platform DB          │  │
│  │    5. propagation → contagion                  │  │
│  │    6. fatigue → decay                          │  │
│  │    7. events → triggers + injections           │  │
│  │    8. telemetry → log to SQLite                │  │
│  └────────────────────────────────────────────────┘  │
│                      │                               │
│                ┌─────▼──────┐    ┌──────────────┐     │
│                │  report.ts │    │  shell.ts    │     │
│                │ normalized │    │  REPL: NL →  │     │
│                │ SQL only   │    │  SQL/interview│     │
│                └────────────┘    └──────────────┘     │
│                                                      │
│  GraphStore (interface)                               │
│  └── SQLiteGraphStore (v1)                           │
│  ┌──────────────────────────────────────┐             │
│  │ documents | chunks | claims         │             │
│  │ entity_claims | edge_claims         │             │
│  │ actors | actor_topics | actor_beliefs│             │
│  │ communities | community_overlap     │             │
│  │ posts | post_topics | follows       │             │
│  │ exposures | narratives              │             │
│  │ telemetry | rounds                  │             │
│  │ run_manifest | decision_cache       │             │
│  │ snapshots                           │             │
│  └──────────────────────────────────────┘             │
│                                                      │
│  CognitionBackend (interface)                         │
│  ├── DirectLLMBackend (default, calls llm.ts)        │
│  ├── RecordedBackend (replay from decision_cache)    │
│  ├── MockBackend (tests)                             │
│  └── NullClawBackend (optional, HTTP gateway)        │
└──────────────────────────────────────────────────────┘
```

**1 process total. Pi 4 viable (footprint pending benchmark).**
NullClaw Gateway is optional — only needed if `NullClawBackend` is configured instead of `DirectLLMBackend`.

## Project Structure

```
seldonclaw/
├── src/
│   ├── index.ts              # Entry point + CLI (commander)
│   ├── db.ts                 # Barrel re-export (types + schema + store + ids)
│   ├── types.ts              # Domain types: rows, snapshots, DTOs
│   ├── schema.ts             # SQLite DDL (SCHEMA_SQL constant)
│   ├── store.ts              # GraphStore interface + SQLiteGraphStore
│   ├── ids.ts                # uuid() + stableId() helpers
│   ├── config.ts             # Config loader (seldonclaw.config.yaml) + sanitizeForStorage()
│   ├── design.ts             # Natural-language brief → SimulationSpec → rendered config
│   ├── llm.ts                # Multi-provider LLM client (Anthropic native + OpenAI compat)
│   ├── ingest.ts             # Document parsing (MD/TXT, optional PDF)
│   ├── ontology.ts           # LLM (native SDK) → entity types + edge types
│   ├── graph.ts              # Knowledge graph construction + entity resolution/dedup
│   ├── profiles.ts           # Graph entities → ActorSpec + initial ActorState (LLM native)
│   ├── engine.ts             # Main simulation loop (rounds)
│   ├── activation.ts         # Actor activation per round
│   ├── feed.ts               # Feed ranking + partial exposure
│   ├── cognition.ts          # CognitionRouter + DecisionPolicy + CognitionBackend interface
│   ├── telemetry.ts          # Structured event logging to SQLite + sanitizeDetail()
│   ├── reproducibility.ts    # seed, decision_cache, RecordedBackend, snapshots, run_manifest
│   ├── propagation.ts        # Cross-community exposure spread + viral reach
│   ├── fatigue.ts            # Narrative decay + actor fatigue penalty
│   ├── events.ts             # Initial posts, scheduled events, threshold triggers
│   ├── ckp.ts                # CKP export/import with secret scrubbing
│   ├── report.ts             # SQL metrics + optional LLM narrative
│   ├── interview.ts          # Actor interview flow
│   └── shell.ts              # Interactive REPL + NL→SQL + interviews
├── templates/                   # Phase 7 — placeholder (empty)
├── package.json
├── tsconfig.json
├── seldonclaw.config.yaml       # Default config
└── tests/
    ├── db.test.ts
    ├── ingest.test.ts
    ├── ontology.test.ts
    ├── graph.test.ts
    ├── profiles.test.ts
    ├── config.test.ts
    ├── llm.test.ts
    ├── cognition.test.ts
    ├── activation.test.ts
    ├── feed.test.ts
    ├── telemetry.test.ts
    ├── reproducibility.test.ts
    ├── reproducibility-prng.test.ts
    ├── engine.test.ts
    ├── index.test.ts
    └── fixtures/
        └── sample-docs/
```

## SQLite Schema (db.ts)

Single file: `simulation.db`.

**Operational PRAGMAs (set on open):**
```sql
PRAGMA journal_mode=WAL;              -- concurrent reads + write
PRAGMA foreign_keys=ON;
PRAGMA busy_timeout=5000;
```

**ID Policy:**
- Structural IDs are deterministic **UUID-like stable IDs** derived from SHA-256 over canonical inputs
- Same canonical inputs → same ID; different inputs → different ID
- Run-scoped artifacts may intentionally include `run_id` in the ID derivation when identity is per-run
- Derived tables (posts, follows, exposures, narratives, telemetry, rounds) carry a `run_id` FK
- Static graph tables (documents, chunks, claims, entities, edges) are shared across runs
- Rule: `SELECT * FROM posts WHERE run_id = ?` never mixes runs

**Shared Graph Policy (v1):**
- The simulation **does not overwrite** the base graph during a run
- The graph is built during the ingest → ontology → graph phases (before simulation)
- If entity resolution is re-executed later (new merge/dedup), a **new `graph_revision_id`** is generated
- `run_manifest.graph_revision_id` links each run to the exact graph state it used
- Rule: modifying the graph after a run does NOT retroactively invalidate that run;
  a new run with the updated graph will simply have a different `graph_revision_id`

```sql
-- ═══════════════════════════════════════
-- PROVENANCE: documents → chunks → claims
-- (best of Zep/Graphiti without Zep Cloud)
-- ═══════════════════════════════════════

CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  content_hash TEXT NOT NULL,         -- SHA-256 for dedup
  mime_type TEXT,
  ingested_at TEXT DEFAULT (datetime('now')),
  metadata TEXT                       -- JSON: {author, date, source_url, ...}
);

CREATE TABLE chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,       -- order within the document
  content TEXT NOT NULL,
  token_count INTEGER,
  FOREIGN KEY (document_id) REFERENCES documents(id)
);

-- Claims/episodes: extracted facts with temporality
CREATE TABLE claims (
  id TEXT PRIMARY KEY,
  source_chunk_id TEXT NOT NULL,      -- exact provenance
  subject TEXT NOT NULL,              -- "National University"
  predicate TEXT NOT NULL,            -- "announces increase"
  object TEXT NOT NULL,               -- "tuition 30%"
  confidence REAL DEFAULT 1.0,        -- 0.0-1.0 (LLM confidence)
  valid_from TEXT,                    -- when it starts being true
  valid_to TEXT,                      -- when it stops being true (NULL = current)
  observed_at TEXT NOT NULL,          -- when it was observed/extracted
  topics TEXT,                        -- JSON array
  FOREIGN KEY (source_chunk_id) REFERENCES chunks(id)
);

-- ═══════════════════════════════════════
-- ONTOLOGY (types, not instances)
-- ═══════════════════════════════════════

CREATE TABLE entity_types (
  name TEXT PRIMARY KEY,
  description TEXT,
  attributes TEXT                     -- JSON array
);
CREATE TABLE edge_types (
  name TEXT PRIMARY KEY,
  description TEXT,
  source_type TEXT,
  target_type TEXT
);

-- ═══════════════════════════════════════
-- KNOWLEDGE GRAPH (no embeddings in v1)
-- Search via FTS5 + topics + edges + follows
-- ═══════════════════════════════════════

CREATE TABLE entities (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  attributes TEXT,                    -- JSON object (schema-specific, not queried in reports)
  FOREIGN KEY (type) REFERENCES entity_types(name)
);
-- Provenance: normalized in entity_claims (see below)
CREATE TABLE edges (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  attributes TEXT,
  confidence REAL DEFAULT 1.0,
  valid_from TEXT,
  valid_to TEXT,
  FOREIGN KEY (source_id) REFERENCES entities(id),
  FOREIGN KEY (target_id) REFERENCES entities(id)
);

-- FTS5 for full-text search (replaces embeddings in v1)
CREATE VIRTUAL TABLE entities_fts USING fts5(
  name, attributes,
  content='entities', content_rowid='rowid'
);

-- ═══════════════════════════════════════
-- ENTITY RESOLUTION: dedup audit trail
-- ═══════════════════════════════════════

-- Known aliases for an entity
CREATE TABLE entity_aliases (
  entity_id TEXT NOT NULL,
  alias TEXT NOT NULL,                  -- "DoE", "Dept. of Education", etc.
  source TEXT,                          -- "llm_extraction" | "manual" | "merge"
  PRIMARY KEY (entity_id, alias),
  FOREIGN KEY (entity_id) REFERENCES entities(id)
);

-- Log of merges performed (auditable)
CREATE TABLE entity_merges (
  id TEXT PRIMARY KEY,
  kept_entity_id TEXT NOT NULL,         -- entity that survives
  merged_entity_id TEXT NOT NULL,       -- entity that gets absorbed (FK for traceability)
  confidence REAL NOT NULL,             -- 0.0-1.0
  merge_reason TEXT NOT NULL,           -- "name_similarity" | "alias_match" | "llm_confirmed" | "manual"
  merge_reason_detail TEXT,             -- detail: "similarity=0.92 between 'DoE' and 'Department of Education'"
  merged_at TEXT DEFAULT (datetime('now')),
  reversed INTEGER DEFAULT 0,          -- 1 if the merge was reversed
  FOREIGN KEY (kept_entity_id) REFERENCES entities(id),
  FOREIGN KEY (merged_entity_id) REFERENCES entities(id)
);

-- ═══════════════════════════════════════
-- ACTORS (the central unit of the simulation)
-- No MBTI in v1 (decorative, not auditable)
-- ═══════════════════════════════════════

CREATE TABLE actors (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,                -- ← scoped per run
  entity_id TEXT,            -- link to the graph (nullable for synthetic actors)
  archetype TEXT NOT NULL,   -- persona | organization | media | institution
  cognition_tier TEXT NOT NULL DEFAULT 'B',  -- A | B | C
  name TEXT NOT NULL,
  handle TEXT,               -- @username on X
  personality TEXT NOT NULL,  -- LLM-generated persona (can be long)
  bio TEXT,                  -- Short bio
  age INTEGER,
  gender TEXT,                -- male | female | non-binary | null (orgs/institutions)
  profession TEXT,
  region TEXT,                -- geographic region (e.g., "Bogota", "Antioquia")
  language TEXT DEFAULT 'es', -- content language (ISO 639-1)
  stance TEXT DEFAULT 'neutral',       -- supportive | opposing | neutral | observer
  sentiment_bias REAL DEFAULT 0.0,     -- -1.0 to 1.0
  activity_level REAL DEFAULT 0.5,     -- 0.0 to 1.0
  influence_weight REAL DEFAULT 0.5,   -- 0.0 to 1.0
  community_id TEXT,
  active_hours TEXT,         -- JSON array [9,10,11,12,19,20,21,22]
  follower_count INTEGER DEFAULT 100,
  following_count INTEGER DEFAULT 50,
  FOREIGN KEY (entity_id) REFERENCES entities(id),
  FOREIGN KEY (run_id) REFERENCES run_manifest(id)
);

-- ═══════════════════════════════════════
-- NORMALIZED TABLES (no JSON for queryable data)
-- Rule: anything queried in reports does not live in JSON
-- ═══════════════════════════════════════

-- Topics per actor (normalized, not JSON array)
CREATE TABLE actor_topics (
  actor_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  weight REAL DEFAULT 1.0,            -- topic relevance for this actor
  PRIMARY KEY (actor_id, topic),
  FOREIGN KEY (actor_id) REFERENCES actors(id)
);

-- Beliefs per actor (normalized, not JSON object)
CREATE TABLE actor_beliefs (
  actor_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  sentiment REAL NOT NULL,            -- -1.0 to 1.0
  round_updated INTEGER,              -- last round in which it changed
  PRIMARY KEY (actor_id, topic),
  FOREIGN KEY (actor_id) REFERENCES actors(id)
);

-- Topics per post (normalized)
CREATE TABLE post_topics (
  post_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  PRIMARY KEY (post_id, topic),
  FOREIGN KEY (post_id) REFERENCES posts(id)
);

-- Entity provenance (normalized, not JSON array)
CREATE TABLE entity_claims (
  entity_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  PRIMARY KEY (entity_id, claim_id),
  FOREIGN KEY (entity_id) REFERENCES entities(id),
  FOREIGN KEY (claim_id) REFERENCES claims(id)
);

-- Edge provenance
CREATE TABLE edge_claims (
  edge_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  PRIMARY KEY (edge_id, claim_id),
  FOREIGN KEY (edge_id) REFERENCES edges(id),
  FOREIGN KEY (claim_id) REFERENCES claims(id)
);

-- Communities (scoped by run_id)
CREATE TABLE communities (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  cohesion REAL DEFAULT 0.5,         -- 0.0 to 1.0 (echo chamber strength)
  FOREIGN KEY (run_id) REFERENCES run_manifest(id)
);

-- Community overlap (normalized, not JSON, scoped by run_id)
CREATE TABLE community_overlap (
  community_a TEXT NOT NULL,
  community_b TEXT NOT NULL,
  run_id TEXT NOT NULL,
  weight REAL NOT NULL,               -- 0.0 to 1.0
  PRIMARY KEY (community_a, community_b, run_id),
  FOREIGN KEY (community_a) REFERENCES communities(id),
  FOREIGN KEY (community_b) REFERENCES communities(id),
  FOREIGN KEY (run_id) REFERENCES run_manifest(id)
);

-- ═══════════════════════════════════════
-- PLATFORM STATE (all with run_id)
-- ═══════════════════════════════════════

CREATE TABLE posts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  content TEXT NOT NULL,
  reply_to TEXT,
  quote_of TEXT,
  round_num INTEGER NOT NULL,
  sim_timestamp TEXT NOT NULL,         -- simulated time
  likes INTEGER DEFAULT 0,
  reposts INTEGER DEFAULT 0,
  comments INTEGER DEFAULT 0,
  reach INTEGER DEFAULT 0,            -- total exposures
  sentiment REAL,                     -- -1.0 to 1.0
  FOREIGN KEY (author_id) REFERENCES actors(id),
  FOREIGN KEY (run_id) REFERENCES run_manifest(id)
);

CREATE TABLE follows (
  follower_id TEXT,
  following_id TEXT,
  run_id TEXT NOT NULL,
  since_round INTEGER,
  PRIMARY KEY (follower_id, following_id, run_id),
  FOREIGN KEY (run_id) REFERENCES run_manifest(id)
);

-- Exposures: PK includes round_num for temporal re-exposure
CREATE TABLE exposures (
  actor_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  round_num INTEGER NOT NULL,
  run_id TEXT NOT NULL,
  reaction TEXT DEFAULT 'seen',       -- seen | liked | commented | reposted
  PRIMARY KEY (actor_id, post_id, round_num),
  FOREIGN KEY (run_id) REFERENCES run_manifest(id)
);

-- Exposure aggregate (for feed ranking, persuasion, contagion, fatigue)
CREATE VIEW exposure_summary AS
SELECT
  actor_id, post_id, run_id,
  MIN(round_num) AS first_seen_round,
  MAX(round_num) AS last_seen_round,
  COUNT(*) AS exposure_count,
  -- Numeric ranking: reposted(3) > commented(2) > liked(1) > seen(0)
  CASE MAX(
    CASE reaction
      WHEN 'reposted' THEN 3
      WHEN 'commented' THEN 2
      WHEN 'liked' THEN 1
      ELSE 0
    END
  )
    WHEN 3 THEN 'reposted'
    WHEN 2 THEN 'commented'
    WHEN 1 THEN 'liked'
    ELSE 'seen'
  END AS strongest_reaction
FROM exposures
GROUP BY actor_id, post_id, run_id;

-- Narratives (with run_id)
CREATE TABLE narratives (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  first_round INTEGER,
  peak_round INTEGER,
  current_intensity REAL DEFAULT 1.0, -- fatigue decay
  total_posts INTEGER DEFAULT 0,
  dominant_sentiment REAL DEFAULT 0.0,
  FOREIGN KEY (run_id) REFERENCES run_manifest(id)
);

-- Telemetry (with run_id + cognition_tier)
CREATE TABLE telemetry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  round_num INTEGER NOT NULL,
  actor_id TEXT,
  cognition_tier TEXT,                 -- A | B | C (which tier was used)
  action_type TEXT NOT NULL,           -- post | comment | repost | like | follow | search | idle | event
  action_detail TEXT,                  -- JSON (content, targets, etc.) — redacted by telemetry.ts sanitizeDetail()
  tokens_input INTEGER,
  tokens_output INTEGER,
  cost_usd REAL,
  duration_ms INTEGER,
  provider TEXT,                       -- which LLM was used
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (run_id) REFERENCES run_manifest(id)
);

-- Rounds (with run_id)
CREATE TABLE rounds (
  num INTEGER NOT NULL,
  run_id TEXT NOT NULL,
  sim_time TEXT,                      -- simulated timestamp
  active_actors INTEGER,
  total_posts INTEGER,
  total_actions INTEGER,
  tier_a_calls INTEGER DEFAULT 0,     -- LLM calls tier A
  tier_b_calls INTEGER DEFAULT 0,     -- LLM calls tier B
  tier_c_actions INTEGER DEFAULT 0,   -- rule-based actions tier C
  avg_sentiment REAL,
  trending_topics TEXT,               -- JSON array (OK: not queried in report joins)
  events TEXT,                        -- JSON array of injected events
  wall_time_ms INTEGER,               -- real execution time
  PRIMARY KEY (num, run_id),
  FOREIGN KEY (run_id) REFERENCES run_manifest(id)
);

-- ═══════════════════════════════════════
-- REPRODUCIBILITY
-- ═══════════════════════════════════════

-- Run manifest: complete metadata for each execution
CREATE TABLE run_manifest (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  seed INTEGER NOT NULL,              -- for deterministic reproducibility (local PRNG)
  config_snapshot TEXT NOT NULL,       -- JSON: sanitized config (secrets stripped by config.ts sanitizeForStorage())
  hypothesis TEXT,
  docs_hash TEXT,                     -- hash of input documents
  graph_revision_id TEXT NOT NULL,    -- hash of graph state (entities+edges+merges) at run start
                                      -- if you change dedup/merges later, new revision → doesn't break reproducibility
  total_rounds INTEGER,
  status TEXT DEFAULT 'running',      -- running | completed | failed | paused
  resumed_from TEXT,                  -- run_id if resumed from another run
  version TEXT                        -- seldonclaw version
);

-- Decision cache: records each LLM response for exact replay
-- seed only controls local PRNG (activation, sampling, Tier C rules)
-- The remote LLM is NOT deterministic → the actual response is cached
CREATE TABLE decision_cache (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  round_num INTEGER NOT NULL,
  actor_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,          -- SHA-256 of serialized DecisionRequest
  raw_response TEXT NOT NULL,          -- complete LLM response (redacted: no auth headers or embedded secrets)
  parsed_decision TEXT NOT NULL,       -- JSON: parsed DecisionResponse
  model_id TEXT NOT NULL,              -- model used (claude-haiku-4, etc.)
  prompt_version TEXT NOT NULL,        -- hash/version of the prompt template (required for exact replay)
  tokens_input INTEGER,
  tokens_output INTEGER,
  duration_ms INTEGER,
  FOREIGN KEY (run_id) REFERENCES run_manifest(id)
);
-- ═══════════════════════════════════════
-- INDICES
-- ═══════════════════════════════════════

-- Decision cache: replay lookup (prompt_version ensures changed prompts don't silently reuse stale responses)
CREATE INDEX idx_decision_cache_lookup ON decision_cache(request_hash, model_id, prompt_version);

-- Run-scoped queries (most frequent)
CREATE INDEX idx_posts_run_round ON posts(run_id, round_num);
CREATE INDEX idx_posts_author ON posts(author_id, run_id);
CREATE INDEX idx_telemetry_run_round ON telemetry(run_id, round_num);
CREATE INDEX idx_telemetry_actor ON telemetry(actor_id, run_id);
CREATE INDEX idx_exposures_run_round ON exposures(run_id, round_num);
CREATE INDEX idx_narratives_run_topic ON narratives(run_id, topic);
CREATE INDEX idx_actors_run ON actors(run_id);

-- Entity resolution
CREATE INDEX idx_entity_aliases_alias ON entity_aliases(alias);
CREATE INDEX idx_entity_merges_merged ON entity_merges(merged_entity_id);

-- Graph queries
CREATE INDEX idx_edges_source ON edges(source_id);
CREATE INDEX idx_edges_target ON edges(target_id);
CREATE INDEX idx_claims_chunk ON claims(source_chunk_id);
CREATE INDEX idx_chunks_doc ON chunks(document_id);

-- Topic queries (normalized tables)
CREATE INDEX idx_actor_topics_topic ON actor_topics(topic);
CREATE INDEX idx_post_topics_topic ON post_topics(topic);
CREATE INDEX idx_actor_beliefs_topic ON actor_beliefs(topic);

-- Snapshots: complete state at a point for resume/replay
CREATE TABLE snapshots (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  round_num INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  actor_states TEXT NOT NULL,         -- JSON: all actor belief_states + stances
  narrative_states TEXT NOT NULL,     -- JSON: all narrative intensities
  rng_state TEXT NOT NULL,            -- PRNG state for exact replay
  FOREIGN KEY (run_id) REFERENCES run_manifest(id)
);
```

## First-Class Concepts

### ActorSpec vs ActorState

Formal separation. CKP exports ActorSpec. SeldonClaw maintains ActorState.

```typescript
// ActorSpec — portable agent contract (exportable via CKP)
interface ActorSpec {
  id: string;
  archetype: "persona" | "organization" | "media" | "institution";
  name: string;
  handle: string;
  personality: string;           // LLM-generated persona
  bio: string;
  age?: number;
  gender?: string;               // male | female | non-binary | null (orgs/institutions)
  profession?: string;
  region?: string;               // geographic region (e.g., "Bogota", "Antioquia")
  language: string;              // content language (ISO 639-1, default "es")
  cognition_tier: "A" | "B" | "C";
  tools: string[];               // ["post", "comment", "like", "repost", "follow", "search"]
  policies: PolicyRule[];         // rate limits, content rules
  provider_hints: ProviderHint;   // preferred model, token limits
}

// ActorState — live simulation state (not CKP, SeldonClaw-specific)
interface ActorState {
  actor_id: string;
  beliefs: Map<string, number>;   // topic → sentiment (-1.0 to 1.0)
  stance: string;                 // supportive | opposing | neutral | observer
  sentiment_bias: number;
  activity_level: number;
  influence_weight: number;
  community_id: string;
  active_hours: number[];
  topics: string[];               // weighted interests
  follower_count: number;
  following_count: number;
}
```

**Export = ActorSpec + ActorState**. Import = reconstitute both.

**Source of truth vs projection:**
- **Normalized SQLite** (actor_beliefs, actor_topics, etc.) = **source of truth**
- **In-memory ActorState** = **runtime projection/cache** (rebuilt from SQLite)
- At the start of each round, engine.ts projects ActorState from normalized tables
- At the end of each round, changes are persisted back to SQLite

### World Model Layers

The simulation world is not a single entity — it is distributed across 3 layers, each with its own tables, interfaces, and lifecycle.

```
┌─────────────────────────────────────────────────────────┐
│ Layer 1: Knowledge Graph (static, shared across runs)   │
│                                                         │
│ Tables: documents, chunks, claims, entities, edges,     │
│         entity_types, edge_types, entity_aliases,       │
│         entity_claims, edge_claims, entity_merges       │
│                                                         │
│ Interface: GraphStore                                   │
│ Files: ingest.ts, ontology.ts, graph.ts                 │
│ Lifecycle: built once (ingest → ontology → graph),      │
│            immutable during simulation runs              │
├─────────────────────────────────────────────────────────┤
│ Layer 2: Social Network (per-run, scoped by run_id)     │
│                                                         │
│ Tables: actors, actor_topics, actor_beliefs, follows,   │
│         communities, community_overlap, posts,          │
│         post_topics, exposures, narratives              │
│                                                         │
│ Projection: PlatformState (read-only snapshot)          │
│ Files: profiles.ts, engine.ts, feed.ts                  │
│ Lifecycle: initialized by profiles.ts, mutated each     │
│            round by engine.ts                            │
├─────────────────────────────────────────────────────────┤
│ Layer 3: Temporal Dynamics (per-round, ephemeral)        │
│                                                         │
│ Tables: rounds, telemetry, decision_cache, snapshots    │
│ Types: RoundContext, NarrativeState                     │
│ Files: activation.ts, feed.ts, propagation.ts,          │
│        fatigue.ts, events.ts, cognition.ts              │
│ Lifecycle: created and consumed within a single round,  │
│            then persisted as telemetry                    │
└─────────────────────────────────────────────────────────┘
```

**Key principle:** No `WorldModel` God Object wraps these layers. Each module receives only the layer it needs. `engine.ts` orchestrates the layers — that is its job, not a wrapper interface's.

### PlatformState (read-only projection)

Not a service or a second GraphStore — a materialized snapshot of the social state that modules consume per round. Built by `engine.ts` at the start of each round from SQLite.

```typescript
// PlatformState — read-only snapshot of current social state
// Rebuilt from SQLite each round. Not a store, not a facade.
interface PlatformState {
  runId: string;
  recentPosts: PostSnapshot[];                    // posts from last N rounds (enriched)
  followGraph: Map<string, string[]>;             // actor_id → [followed_ids]
  engagementByPost: Map<string, EngagementStats>; // post_id → {likes, reposts, comments, reach}
  actors: Map<string, ActorSnapshot>;             // actor_id → lightweight actor metadata
  communities: CommunitySnapshot[];               // communities with overlap weights
}

// Enriched post with fields that feed.ts and propagation.ts need
interface PostSnapshot {
  id: string;
  authorId: string;
  content: string;
  roundNum: number;
  simTimestamp: string;
  topics: string[];                               // denormalized from post_topics (feed relevance)
  sentiment: number;
  likes: number;
  reposts: number;
  comments: number;
  reach: number;
  replyTo?: string;
}

// Lightweight actor metadata for feed scoring and propagation
// NOT a full ActorState — only what feed.ts/propagation.ts consume
interface ActorSnapshot {
  id: string;
  communityId: string;
  influenceWeight: number;
  stance: string;
  sentimentBias: number;
}

interface CommunitySnapshot {
  id: string;
  cohesion: number;
  memberIds: string[];
  overlaps: Map<string, number>;                  // other_community_id → overlap weight
}

interface EngagementStats {
  likes: number;
  reposts: number;
  comments: number;
  reach: number;
}
```

**Who consumes what:**
- `feed.ts`: `recentPosts` (topics for relevance scoring), `followGraph`, `engagementByPost`, `actors` (community affinity, stance alignment)
- `propagation.ts`: `recentPosts` (reach), `actors` (influence), `communities` (cohesion, overlaps, member lists)
- `events.ts`: `engagementByPost` (thresholds), `recentPosts` (post counts per topic)

None of them write to it — they return results that `engine.ts` persists.

### RoundContext (per-round ephemeral state)

Everything a module needs to know about the current round. No full `SimConfig` — only derived values relevant to this specific round.

```typescript
// RoundContext — passed to activation, feed, propagation, fatigue, events
// Does NOT carry the full SimConfig. Modules receive only what they need.
interface RoundContext {
  runId: string;
  roundNum: number;
  simTimestamp: string;               // ISO 8601 (not Date — clean for SQLite/JSON)
  simHour: number;                    // 0-23 (derived from simTimestamp + timezone)
  activeEvents: SimEvent[];           // events triggered this round
  rng: PRNG;                         // seeded random for deterministic behavior
}
```

**Why no `config: SimConfig`:** Passing the full config to every module widens dependencies. Instead, `engine.ts` passes subconfigs where needed (e.g., `FeedConfig` to `feed.ts`, `FatigueConfig` to `fatigue.ts`) as separate function parameters.

### NarrativeState

Tracks the lifecycle of a topic/narrative across rounds. Used by `fatigue.ts` to compute decay and by `report.ts` to analyze narrative arcs.

```typescript
interface NarrativeState {
  topic: string;
  firstRound: number;
  peakRound: number;
  currentIntensity: number;           // 0.0-1.0 (fatigue decay)
  totalPosts: number;
  dominantSentiment: number;          // -1.0 to 1.0
}
```

Persisted in the `narratives` table (scoped by `run_id`). Projected into memory by `engine.ts` at the start of each round, same pattern as `ActorState`.

### GraphStore interface (store.ts)

Canonical interface: `src/store.ts`. Summary by domain (60+ methods):

| Domain | Methods | Notes |
|--------|---------|-------|
| Provenance | addDocument, addChunk, addClaim | Returns ID |
| Ontology | addEntityType, addEdgeType | INSERT OR REPLACE |
| Entity resolution | addEntity, addEdge, resolveEntities, linkClaimToEntity, linkClaimToEdge, addAlias, mergeEntities | Dedup + merge + alias |
| Bulk queries | getActorTopicsByRun, getActorBeliefsByRun | Avoids N+1 per round |
| Core queries | queryActorContext, queryNarrativeState, queryProvenance | Projections from DB |
| Actors | addActor, getActor, getActorsByRun, updateActorStance, updateActorCommunity, addActorTopic, addActorBelief | CRUD |
| Communities | addCommunity, addCommunityOverlap | With overlap weights |
| Platform state | addPost, addExposure, addFollow, updatePostEngagement, addPostTopic | Write ops |
| Interaction history | getRecentPostsByActor, getEngagementOnPosts, getMentions, getFollowedStanceChanges | For cognition.ts |
| Platform projection | buildPlatformState | Read-only snapshot |
| Narratives | addNarrative, updateNarrative, getNarrativesByRun | Scoped by run_id |
| Run manifest | createRun, updateRun, getRun, getLatestRunId, getRunRoundSummary, getRunTierCallTotals | Lifecycle |
| Decision cache | cacheDecision, lookupDecision | Reproducibility |
| Snapshots | saveSnapshot, getLatestSnapshot | rng_state + actor_states |
| Telemetry | logTelemetry | Structured logging |
| Rounds | upsertRound | UPSERT per round |
| Graph revision | computeGraphRevisionId | SHA-256 of entities+edges+merges |
| FTS | searchEntities | FTS5 |
| Provenance queries | getDocumentByHash, getChunksByDocument, getAllDocuments | Dedup + downstream |
| Graph queries | getClaimsByChunk, getEntityTypes, getEdgeTypes, getAllActiveEntities | For graph.ts |
| Utility | close | |

### Entity resolution (graph.ts, P0)

If the graph is born dirty, everything downstream goes wrong. P0, not P2.

```typescript
interface EntityResolver {
  // Name normalization
  normalize(name: string): string;              // "Dr. Jane Smith" → "jane_smith"

  // Duplicate entity merging
  findDuplicates(entities: Entity[]): MergeCandidate[];
  merge(a: Entity, b: Entity, confidence: number): Entity;

  // Alias resolution
  resolveAlias(name: string): Entity | null;     // "DoE" → entity "Department of Education"

  // Audit trail
  getMergeHistory(entityId: string): MergeRecord[];  // who merged with whom and why
}
```

## Social Engine (the modules MiroFish lacks)

### activation.ts — Who activates this round?

```typescript
interface ActivationConfig {
  peakHours: number[];
  offPeakHours: number[];
  peakHourMultiplier: number;        // default 1.5
  offPeakMultiplier: number;         // default 0.3
  eventBoostMultiplier: number;      // default 2.0
  fatiguePenaltyWeight: number;      // default -0.3
}

interface ActivationResult {
  activeActors: Actor[];
  reason: Map<string, string>;  // actor_id → "peak_hour" | "event_trigger" | "random"
}

function computeActivation(
  actors: Actor[],
  round: RoundContext,
  config: ActivationConfig            // derived by engine.ts from simulation config + defaults
): ActivationResult {
  // For each actor:
  //   baseProb = actor.activity_level
  //   hourMult = isActiveHour(round.simHour, actor.active_hours, config.peakHours, config.offPeakHours)
  //            ? config.peakHourMultiplier
  //            : config.offPeakMultiplier
  //   eventBoost = hasRelevantEvent(round.activeEvents, actor.topics) ? config.eventBoostMultiplier : 1.0
  //   fatiguePenalty = getTopicFatigue(actor.topics, round) * config.fatiguePenaltyWeight
  //   finalProb = clamp(baseProb * hourMult * eventBoost + fatiguePenalty, 0, 1)
  //   activated = round.rng.next() < finalProb   // seeded PRNG, NOT Math.random()
}
```

### feed.ts — What does each actor see?

```typescript
interface FeedItem {
  post: PostSnapshot;
  score: number;
  source: "follow" | "trending" | "community" | "algorithm";
}

function buildFeed(
  actor: ActorState,
  state: PlatformState,
  config: FeedConfig
): FeedItem[] {
  // 1. Collect candidates:
  //    - Posts from followed actors (last N rounds)
  //    - Trending posts (top K by engagement)
  //    - Community cross-posts (overlap weight)
  //
  // 2. Score each candidate:
  //    const author = state.actors.get(post.authorId)
  //    const actorCommunity = state.communities.find(c => c.id === actor.community_id)
  //    score = recency * config.recencyWeight
  //          + popularity * config.popularityWeight
  //          + relevance(post.topics, actor.topics) * config.relevanceWeight
  //          + communityAffinity(author?.communityId, actor.community_id)
  //
  // 3. Apply echo chamber:
  //    if sameStance(post.sentiment, actor.sentiment_bias):
  //      score *= (1 + (actorCommunity?.cohesion ?? 0) * config.echoChamberStrength)
  //
  // 4. Partial exposure:
  //    return topN(scored, config.feedSize)  // Actor doesn't see EVERYTHING
}
```

### Known Stubs (Phase 6 integration points)

These stubs exist in implemented code and will be replaced when Phase 6 modules are built:

- `engine.ts`: `const activeEvents: SimEvent[] = [];` — events array hardcoded empty until events.ts is implemented
- `activation.ts`: `const fatiguePenalty = 0;` — fatigue penalty hardcoded to 0 until fatigue.ts is implemented

### propagation.ts — How does content cross between communities?

```typescript
interface PropagationResult {
  newExposures: Exposure[];
  crossCommunityPosts: Post[];
  viralPosts: Post[];           // posts that exceeded viral_threshold
}

function propagate(
  round: RoundContext,
  state: PlatformState,
  communities: CommunitySnapshot[]
): PropagationResult {
  // Simplified SIR model per community:
  //
  // For each active post in state.recentPosts (not fatigued):
  //   const author = state.actors.get(post.authorId)
  //   const community = communities.find(c => c.id === author?.communityId)
  //   const postVirality = computeVirality(post.reach, state.engagementByPost.get(post.id))
  //
  //   withinCommunity:
  //     exposureProb = (author?.influenceWeight ?? 0) * (community?.cohesion ?? 0)
  //     newExposed = unexposedMembers(community.memberIds, post.id, round.runId) * exposureProb
  //
  //   crossCommunity:
  //     for each [otherCommunityId, overlapWeight] in community.overlaps:
  //       const otherCommunity = communities.find(c => c.id === otherCommunityId)
  //       crossProb = overlapWeight * postVirality
  //       bridgeExposed = unexposedMembers(otherCommunity.memberIds, post.id, round.runId) * crossProb
  //
  //   viralCheck:
  //     if post.reach > config.viralThreshold:
  //       boost all exposure probs by viralMultiplier
}
```

### fatigue.ts — Does a topic burn out?

```typescript
function updateFatigue(
  narratives: Narrative[],
  roundNum: number,
  config: FatigueConfig
): Narrative[] {
  // For each active narrative:
  //   age = roundNum - narrative.first_round
  //   decay = exp(-config.decayRate * age)
  //   narrative.current_intensity = decay
  //
  //   if narrative.current_intensity < config.extinctionThreshold:
  //     mark as extinct (actors stop talking about the topic)
  //
  // Re-activation:
  //   if a new event touches the same topic:
  //     narrative.current_intensity = min(1.0, intensity + config.reactivationBoost)
  //     narrative.peak_round = roundNum (new peak)
}
```

### events.ts — Event injection

```typescript
interface SimEvent {
  type: "initial_post" | "scheduled" | "threshold_trigger";
  round: number;
  actor_id?: string;           // who "publishes" the event
  content: string;
  topics: string[];
}

function processEvents(
  round: RoundContext,
  config: EventConfig,
  state: PlatformState
): SimEvent[] {
  // 1. Initial posts (round 0): seed posts that kick off the simulation
  //
  // 2. Scheduled events: at round N an official statement, leak, etc. appears
  //
  // 3. Threshold triggers (dynamic):
  //    if avgSentiment(topic="tuition") < -0.6:
  //      inject event: "Dean issues official response"
  //    if postCount(topic="protest") > 50:
  //      inject event: "National media covers the protest"
  //    if influencer.stance changes from neutral to opposing:
  //      inject event: "Public figure speaks out"
}
```

## Cognition: 3 Separate Layers (cognition.ts)

Don't mix "who uses LLM" with "what rules apply" with "how the runtime is called."

### Layer 1: CognitionRouter — Which tier?

```typescript
type CognitionTier = "A" | "B" | "C";

interface CognitionRouter {
  route(actor: ActorSpec, state: ActorState, feed: FeedItem[], round: RoundContext): CognitionRoute;
}

interface CognitionRoute {
  tier: CognitionTier;
  reason: string;
}

// Tier A: ALWAYS backend (key actors)
//   - influence_weight >= config.tierA.minInfluence
//   - archetype in config.tierA.archetypeOverrides
//   - user-flagged key actors

// Tier B: Backend ONLY if high salience
//   - Salience: direct mention, relevant event, stance change, random sampling

// Tier C: Pure rules — no backend
//   - Low influence, off-peak, high topic fatigue
```

### Layer 2: DecisionPolicy — What rules for Tier C?

```typescript
interface DecisionPolicy {
  // Resolves action for Tier C without LLM
  applyRules(actor: ActorSpec, state: ActorState, feed: FeedItem[], rng: PRNG): DecisionResponse;
}

// Rules:
//   · Viral post in feed → repost with P=config.tierC.repostProb
//   · Aligned post from followed → like with P=config.tierC.likeProb
//   · Otherwise → idle
// "like" as a cheap action avoids binary engagement
// Deterministic given the seed (uses PRNG, not Math.random)
```

### Layer 3: CognitionBackend — How are A/B executed?

```typescript
interface CognitionBackend {
  start(): Promise<void>;
  shutdown(): Promise<void>;
  decide(request: DecisionRequest): Promise<DecisionResponse>;
  interview(actorContext: string, question: string): Promise<string>;
}

// Implementations:
//   DirectLLMBackend — calls llm.ts directly (default)
//   RecordedBackend  — replay from decision_cache
//   MockBackend      — tests without LLM
//   NullClawBackend  — HTTP gateway loopback (optional)
//   RemoteCKPBackend — v2: any CKP conformant runtime
```

**Rule:** engine.ts never imports DirectLLMBackend or NullClaw directly. It only knows `CognitionBackend`.

**Cost impact:**
With 100 actors, 72 rounds, ~20 active/round:
- Without tiers: 20 × 72 = 1,440 LLM calls
- With tiers (5A + 10B@30% + 5C): (5 + 3 + 0) × 72 = 576 LLM calls → **60% savings**

## NullClawBackend (nullclaw-worker.ts) — Optional

Concrete implementation of `CognitionBackend` via NullClaw HTTP gateway.
**Optional alternative to DirectLLMBackend.** Uses ONLY documented NullClaw endpoints.

**Documented NullClaw Gateway API:**
- `GET /health` — health check
- `POST /pair` — pairing
- `POST /webhook` — webhook messages
- `POST /a2a` — Agent-to-Agent protocol (A2A)

**Do NOT exist:** `/v1/decide`, `/v1/interview`. Never invent endpoints.

```typescript
class NullClawBackend implements CognitionBackend {
  private gatewayUrl: string;  // default: http://localhost:3000
  private authToken?: string;  // pairing token — NEVER logged, NEVER in telemetry/run_manifest

  async start(): Promise<void> {
    // Spawn NullClaw gateway process if not running
    // GET /health to verify
    // If pairing.enabled: POST /pair → store token in memory only
  }

  async decide(request: DecisionRequest): Promise<DecisionResponse> {
    // Via POST /a2a with A2ADecisionMessage:
    const msg = this.adapter.toDecisionMessage(request);
    const result = await fetch(`${this.gatewayUrl}/a2a`, {
      method: "POST",
      headers: this.authHeaders(),   // Bearer token when pairing active
      body: JSON.stringify(msg)
    });
    const decision = this.adapter.fromA2AResult(result);
    await this.cacheDecision(request, decision);  // decision_cache
    return decision;
  }

  async interview(actorContext: string, question: string): Promise<string> {
    // Via POST /a2a with A2AInterviewMessage:
    const msg = this.adapter.toInterviewMessage(actorContext, question);
    const result = await fetch(`${this.gatewayUrl}/a2a`, {
      method: "POST",
      headers: this.authHeaders(),   // Bearer token when pairing active
      body: JSON.stringify(msg)
    });
    return this.adapter.extractInterviewResponse(result);
  }

  private authHeaders(): Record<string, string> {
    // Returns Authorization header if pairing is active, empty otherwise
    // Token is in-memory only — never serialized to disk
  }
}
```

### NullClawAdapter — Local shim contract

```typescript
// Translates between SeldonClaw's DecisionRequest/Response and NullClaw's A2A format

interface NullClawAdapter {
  // SeldonClaw → A2A
  toDecisionMessage(request: DecisionRequest): A2ADecisionMessage;
  toInterviewMessage(actorContext: string, question: string): A2AInterviewMessage;

  // A2A → SeldonClaw
  fromA2AResult(result: A2AMessageResult): DecisionResponse;
  extractInterviewResponse(result: A2AMessageResult): string;
}

// Uses message/send (documented in NullClaw Gateway API)
// NOT "tasks/send" — it's a message, not a protocol task
interface A2ADecisionMessage {
  jsonrpc: "2.0";
  method: "message/send";
  params: {
    message: {
      role: "user";
      parts: [{
        type: "text";
        text: string;                  // prompt with actor context + feed + actions
      }];
    };
    metadata?: {
      seldonclaw_message_type: "decide";
      actor_id: string;
      round_num: number;
    };
  };
}

// Same structure, different type
type A2AInterviewMessage = Omit<A2ADecisionMessage, 'params'> & {
  params: {
    message: {
      role: "user";
      parts: [{ type: "text"; text: string }];   // actorContext + question
    };
    metadata?: {
      seldonclaw_message_type: "interview";
      actor_id: string;
    };
  };
};

// If NullClaw POST /a2a does not support this flow directly,
// the adapter can alternatively use POST /webhook with a
// message format that NullClaw processes.
// The key point: SeldonClaw never invents endpoints that NullClaw doesn't have.
```

**Policy:** SeldonClaw never invents NullClaw endpoints. If `/a2a` doesn't support the flow, use `/webhook` as fallback or contribute to the upstream gateway.

### Operational NullClaw Configuration (nullclaw-worker.ts)

SeldonClaw needs to configure NullClaw with the correct LLM provider. Mechanism:

```typescript
async function bootstrapNullClaw(config: NullClawConfig): Promise<void> {
  // 1. Generate NullClaw config if autoStart=true
  //    Options (determined during Milestone 0 spike):
  //    A: CLI args → spawn(binary, ['--config', configPath])
  //    B: env vars → ANTHROPIC_API_KEY, NULLCLAW_PORT
  //    C: Pre-configured profile that NullClaw already knows
  //
  // 2. Pass upstream provider (model + API key via env)
  //    NullClaw needs to know which LLM to use for completions
  //
  // 3. Spawn NullClaw gateway
  //
  // 4. Wait for GET /health → 200
  //
  // 5. POST /pair if pairing.enabled
}
```

**What gets decided in the spike (Milestone 0):** the actual configuration mechanism. The spike answers this question before building the rest of the system.

### RecordedBackend (reproducibility.ts)

For exact replay of Tier A/B:
1. Serializes `DecisionRequest` → SHA-256 hash
2. Looks up in `decision_cache` by `(request_hash, model_id, prompt_version)`
3. If found → returns `parsed_decision` (no LLM call, no network)
4. If not found → error or fallback to NullClawBackend

**Why `prompt_version` in the lookup key:** The request hash covers the actor context and feed, but NOT the prompt template that wraps them. If you change the system prompt without changing the request payload, the hash stays the same but the LLM would produce a different response. Including `prompt_version` prevents silent replay of stale decisions after prompt changes.

**This solves the fundamental problem:** `seed` controls local PRNG (activation, sampling, Tier C), but the remote LLM is NOT deterministic. `decision_cache` + `RecordedBackend` = identical end-to-end replay.

### Shared Types

```typescript
interface DecisionRequest {
  actor: {
    name: string;
    personality: string;
    stance: string;
    gender?: string;
    region?: string;
    language: string;
    topics: string[];
    belief_state: Record<string, number>;
  };
  feed: FeedItem[];
  availableActions: string[];   // ["post", "comment", "like", "repost", "follow", "idle"]
  platform: "x";                 // X (formerly Twitter) — single platform in v1
  simContext: string;            // interaction summary (see below)
}

interface DecisionResponse {
  action: "post" | "comment" | "repost" | "like" | "follow" | "search" | "idle";
  content?: string;
  target?: string;
  reasoning?: string;
}
```

### Interaction Summary (hybrid actor memory)

Actors need temporal memory — "I argued with @rector-01 last round", "My post about tuition got 40 likes". SeldonClaw now uses a **hybrid memory model**:

- **derived interaction memory** from normalized tables (`posts`, `exposures`, `telemetry`, `follows`)
- **persisted deliberative memory** in `actor_memories` for Tier A/B actors (reflections, salient interactions, event memories, narrative memories)

The interaction summary still gets built at request time, but it now blends live interaction history with persisted memories:

```typescript
// In cognition.ts — builds simContext for Tier A/B DecisionRequests
function buildSimContext(
  actor: ActorState,
  store: GraphStore,
  runId: string,
  roundNum: number,
  lookbackRounds: number = 5    // configurable window
): string {
  // 1. Recent posts by this actor (from posts table)
  const myPosts = store.getRecentPostsByActor(actor.actor_id, runId, roundNum - lookbackRounds);

  // 2. Engagement received on those posts (from exposures + posts)
  const engagement = store.getEngagementOnPosts(myPosts.map(p => p.id), runId);

  // 3. Replies/mentions directed at this actor (from posts where reply_to or content mentions)
  const mentions = store.getMentions(actor.actor_id, runId, roundNum - lookbackRounds);

  // 4. Stance changes observed in followed actors (from actor_beliefs)
  const followedChanges = store.getFollowedStanceChanges(actor.actor_id, runId, roundNum);

  // Format into natural language summary:
  // "In recent rounds: You posted about tuition increases (12 likes, 3 reposts).
  //  @rector-01 replied disagreeing with your position.
  //  @student-leader mentioned you in a post about the protest.
  //  Two actors you follow shifted from neutral to opposing on education policy."
  return formatInteractionSummary(myPosts, engagement, mentions, followedChanges);
}
```

**Why this works better than a `simulation_memories` table:**
- No schema duplication — data already lives in `posts`, `exposures`, `actor_beliefs`
- No sync problem — the summary is always current (derived, not stored)
- Lookback window is configurable — short for fast actors, longer for key actors (Tier A)
- The LLM receives natural language context, not database rows

### Per-Actor Per-Round Flow

1. `CognitionRouter` determines tier (A/B/C)
2. **Tier C:** `DecisionPolicy.applyRules()` — deterministic, no backend, no I/O
3. **Tier A/B:** Engine builds `DecisionRequest`, passes it to the active `CognitionBackend`
   - Normal run: `NullClawBackend` → LLM via gateway → caches in `decision_cache`
   - Replay: `RecordedBackend` → looks up in cache → 0 LLM calls
4. Engine executes the action on platform state (SQLite via GraphStore)
5. Telemetry logs: tier, backend, cache hit, tokens, cost

**Batching:**
- Pi 4: sequential (Tier A/B one by one, Tier C instant batch)
- Server: `simulation.concurrency: 8` (N concurrent requests)

## CKP: Portable Actor Contract, Not the Engine Core

**Principle:** CKP provides structural portability, not behavioral equivalence.
An exported actor can be executed in another CKP conformant runtime,
but it will not behave identically (different LLM, different context, different memory).

| CKP Primitive | Usage in SeldonClaw | Where |
|---|---|---|
| **Identity** | ✅ ActorSpec → personality, autonomy, capabilities | `templates/*.claw.yaml` + export bundles |
| **Provider** | ✅ Multi-provider per stage (native SDK for structured extraction) | `llm.ts` + `seldonclaw.config.yaml` |
| **Channel** | ⚠️ Metadata only (X platform). Not a real CKP Channel | `templates/*.claw.yaml` metadata |
| **Tool** | ✅ 6 social actions with input_schema | `templates/*.claw.yaml` tools section |
| **Skill** | ⚠️ Behavior patterns as instructions in personality | Inline in Identity.personality |
| **Memory** | ✅ MemoryHandler contract: timeline (conversation), beliefs+trust (key-value) | `db.ts` — valid CKP types: conversation, key-value. semantic only with real embeddings |
| **Sandbox** | ⚠️ Implicit: actors don't execute shell/filesystem | No real sandbox needed |
| **Policy** | ✅ Rate limits, content rules as declarative Policy | `templates/*.claw.yaml` policies |
| **Swarm** | ✅ **Only for:** interviews, composition with external agents | `interview.ts`, `report.ts` |
| **Telemetry** | ✅ Every action → structured event in SQLite | `telemetry.ts` |

### Portability in 3 Layers

```
Layer 1: Portable contract (CKP)      Layer 2: Exportable state            Layer 3: Runtime adapter
┌──────────────────────┐               ┌─────────────────────┐           ┌───────────────────┐
│ claw.yaml            │               │ actor_state.json    │           │ NullClawBackend   │
│ identity             │               │ beliefs.json        │           │ RemoteCKPBackend  │
│ tools                │               │ topics.json         │           │ RecordedBackend   │
│ policies             │               │ provenance.json     │           │ MockBackend       │
│ provider hints       │               │ persona.md          │           └───────────────────┘
│ memory declaration   │               │ context_snapshot    │
└──────────────────────┘               └─────────────────────┘
```

### export-agent / import-agent (ckp.ts)

```bash
# Export: generates a portable bundle
# SECURITY: ckp.ts runs scrubSecrets() before writing any bundle file.
# Strips: API keys, bearer tokens, pairing tokens, env var values, auth headers.
# Only secret_ref references are preserved (e.g., "LLM_API_KEY"), never actual values.
seldonclaw export-agent --run <run-id> --actor journalist-01 --out ./agent-bundle/
# Generates:
#   agent-bundle/
#   ├── claw.yaml              # CKP manifest (ActorSpec) — secrets scrubbed
#   ├── actor_state.json       # beliefs, stance, influence, etc.
#   ├── beliefs.json           # normalized beliefs (topic → sentiment)
#   ├── topics.json            # weighted topic interests
#   ├── provenance.json        # entity → claims → chunks → documents
#   ├── persona.md             # full personality text
#   └── manifest.meta.json     # run_id, round exported, seldonclaw version, schema version

# Import: reconstitutes an actor from a bundle
seldonclaw import-agent --bundle ./agent-bundle/ --db simulation.db --run <run-id>
```

## Archetype Manifest Example: persona.claw.yaml

```yaml
claw: "0.2.0"
kind: Claw
metadata:
  name: "persona-archetype"
  version: "1.0.0"
  labels:
    archetype: "persona"
    seldonclaw-version: "0.1.0"
spec:
  identity:
    inline:
      personality: "{{GENERATED_PERSONALITY}}"
      autonomy: "autonomous"
      capabilities: "{{GENERATED_CAPABILITIES}}"

  providers:
    - inline:
        protocol: "openai-compatible"
        endpoint: "{{PROVIDER_ENDPOINT}}"
        model: "{{PROVIDER_MODEL}}"
        auth:
          type: "bearer"
          secret_ref: "LLM_API_KEY"
        limits:
          tokens_per_request: 2000

  channels:
    - inline:
        type: "custom"
        transport: "stdio"
        metadata:
          platform: "x"              # X (formerly Twitter) — single platform in v1
          handle: "{{HANDLE}}"
          followers: "{{FOLLOWER_COUNT}}"

  tools:
    - inline:
        name: "post"
        description: "Publish a post on X"
        input_schema:
          type: object
          properties:
            content: { type: string }
            reply_to: { type: string }
          required: [content]
    - inline:
        name: "comment"
        description: "Comment on an existing post"
        input_schema:
          type: object
          properties:
            post_id: { type: string }
            content: { type: string }
          required: [post_id, content]
    - inline:
        name: "like"
        description: "Like/react to a post (low-cost engagement)"
        input_schema:
          type: object
          properties:
            post_id: { type: string }
          required: [post_id]
    - inline:
        name: "repost"
        description: "Share an existing post"
        input_schema:
          type: object
          properties:
            post_id: { type: string }
            comment: { type: string }
          required: [post_id]
    - inline:
        name: "follow"
        description: "Follow another actor"
        input_schema:
          type: object
          properties:
            actor_id: { type: string }
          required: [actor_id]
    - inline:
        name: "search"
        description: "Search the timeline for topics"
        input_schema:
          type: object
          properties:
            query: { type: string }
          required: [query]

  memory:
    inline:
      stores:
        - name: "timeline"
          type: "conversation"
          backend: "sqlite"
          retention: { max_entries: 200 }
        - name: "beliefs"
          type: "key-value"
          backend: "sqlite"
        - name: "trust"
          type: "key-value"        # CKP valid types: conversation|semantic|key-value|workspace|checkpoint
          backend: "sqlite"        # v1: key-value. semantic only when real embeddings exist

  policies:
    - inline:
        name: "simulation-rules"
        rules:
          - id: "rate-limit-posts"
            action: "allow"
            scope: "tool"
            match: { tool: "post" }
            conditions: { max_calls_per_round: 3 }
          - id: "rate-limit-comments"
            action: "allow"
            scope: "tool"
            match: { tool: "comment" }
            conditions: { max_calls_per_round: 5 }
```

## SimConfig (seldonclaw.config.yaml)

```yaml
# seldonclaw.config.yaml
simulation:
  platform: "x"                   # X (formerly Twitter) — single platform in v1
  totalHours: 72
  minutesPerRound: 60            # 1 hour per round = 72 rounds
  timezone: "America/Bogota"
  concurrency: 1                 # Pi 4: sequential. Server: 4-8
  seed: 42                       # PRNG seed for reproducibility (0 = random)
  snapshotEvery: 10              # snapshot every N rounds (0 = disabled)
  peakHours: [8, 9, 10, 12, 13, 19, 20, 21, 22]
  offPeakHours: [0, 1, 2, 3, 4, 5, 6]

cognition:
  tierA:
    minInfluence: 0.8            # influence_weight >= this → always LLM (tier A)
    archetypeOverrides: ["institution", "media"]  # always tier A
  tierB:
    samplingRate: 0.3            # probability of LLM call without explicit salience
  tierC:
    repostProb: 0.4              # P(repost) given viral post in feed
    likeProb: 0.6                # P(like) given aligned post
  interactionLookback: 5         # rounds of interaction history in simContext (actor memory)

providers:
  analysis:                      # For ontology — NATIVE SDK (structured extraction)
    sdk: "anthropic"             # NOT openai compat (ignores strict/response_format/seed)
    model: "claude-sonnet-4-20250514"
    apiKeyEnv: "ANTHROPIC_API_KEY"
  generation:                    # For profiles — NATIVE SDK
    sdk: "anthropic"
    model: "claude-sonnet-4-20250514"
    apiKeyEnv: "ANTHROPIC_API_KEY"
  simulation:                    # Upstream provider that NullClaw uses for LLM calls
    model: "claude-haiku-4-20250414"   # NullClaw makes the LLM call, not SeldonClaw
    apiKeyEnv: "ANTHROPIC_API_KEY"     # passed to NullClaw via env or config
  report:                        # For report — NATIVE SDK
    sdk: "anthropic"
    model: "claude-sonnet-4-20250514"
    apiKeyEnv: "ANTHROPIC_API_KEY"

nullclaw:
  gatewayUrl: "http://localhost:3000"   # NullClaw gateway default port (doc: 3000)
  binary: "nullclaw"                    # path to binary (if SeldonClaw spawns it)
  autoStart: true                       # auto-spawn if not running
  upstreamProvider: "simulation"        # which LLM provider NullClaw uses
  pairing:
    enabled: true                       # DEFAULT: pairing active (secure by default)
                                        # Disable ONLY for confirmed loopback-only (127.0.0.1)
                                        # NullClaw security guide recommends active pairing
                                        # for any non-loopback connection.
    token: ""                           # pairing token (auto-generated if empty, never logged)
  agentProfile:                         # SeldonClaw agent identity for NullClaw
    name: "seldonclaw-worker"
    capabilities: ["decide", "interview"]

feed:
  size: 20                       # posts per feed
  recencyWeight: 0.4
  popularityWeight: 0.3
  relevanceWeight: 0.3
  echoChamberStrength: 0.5

propagation:
  viralThreshold: 30             # exposures to go viral
  crossCommunityDecay: 0.7
  influenceMultiplier: 1.5

fatigue:
  decayRate: 0.05                # per round
  extinctionThreshold: 0.1
  reactivationBoost: 0.6

events:
  initialPosts: []               # generated in profiles.ts
  scheduled: []                  # generated in profiles.ts
  thresholdTriggers:
    - condition: "avgSentiment(topic) < -0.6"
      event: "Institutional response statement"
      actorArchetype: "institution"
    - condition: "postCount(topic) > 50"
      event: "National media covers the situation"
      actorArchetype: "media"

output:
  dir: "./output"
  format: "both"                 # markdown + json
```

## CLI

```bash
# Full pipeline
seldonclaw run \
  --docs ./documents/ \
  --hypothesis "If the university raises tuition 30%, how does public opinion react" \
  --config seldonclaw.config.yaml

# Individual steps
seldonclaw ingest --docs ./documents/ --out simulation.db
seldonclaw analyze --db simulation.db --hypothesis "..."
seldonclaw generate --db simulation.db
seldonclaw simulate --db simulation.db --rounds 72
seldonclaw report --db simulation.db --out ./output/

# Reproducibility
seldonclaw simulate --db simulation.db --seed 42                  # explicit seed
seldonclaw resume --db simulation.db --run <run-id>               # resume from last snapshot
seldonclaw replay --db simulation.db --run <run-id> --to-round 30 # replay up to round 30

# Utilities
seldonclaw init                                              # conversational setup wizard
seldonclaw design --brief "..." --out-spec simulation.spec.json --out-config seldonclaw.generated.config.yaml
seldonclaw doctor                                            # validate install, config, provider, DB access
seldonclaw config show                                       # print sanitized current config
seldonclaw config set output.dir ./output                    # update a config field
seldonclaw inspect --db simulation.db --actor "journalist-01"     # view actor state
seldonclaw interview --db simulation.db --actor "journalist-01"   # interview via NullClaw
seldonclaw export --db simulation.db --actor "journalist-01"      # export concrete claw.yaml
seldonclaw stats --db simulation.db                               # simulation metrics
seldonclaw stats --db simulation.db --tiers                       # breakdown by cognition tier

# Actor portability
seldonclaw export-agent --run <run-id> --actor journalist-01 --out ./agent-bundle/
seldonclaw import-agent --bundle ./agent-bundle/ --db simulation.db --run <run-id>

# Interactive shell (conversational REPL)
seldonclaw shell --db simulation.db --run <run-id>
```

## Operator Tools Layer

**Principle:** the internal pipeline remains modular (`ingest.ts`, `graph.ts`, `engine.ts`, etc.), but the
user-facing interfaces should not call those modules ad hoc. Instead, SeldonClaw exposes a thin layer of
typed operator tools that all interfaces reuse:

- structured CLI (`index.ts`)
- conversational shell (`shell.ts`)
- future web UI or API

These are **tools**, not CKP "skills". They are runtime-facing handlers for operating SeldonClaw; they do
not replace the core modules and they are not part of the actor cognition model.

```typescript
type OperatorToolName =
  | "run_pipeline"
  | "ingest_documents"
  | "analyze_corpus"
  | "generate_actors"
  | "simulate_run"
  | "report_run"
  | "inspect_actor"
  | "interview_actor"
  | "export_agent_bundle"
  | "import_agent_bundle"
  | "replay_run"
  | "get_stats";

interface OperatorTool<Input, Output> {
  name: OperatorToolName;
  description: string;
  validate(input: unknown): Input;
  execute(input: Input, ctx: ToolContext): Promise<Output>;
}
```

**Rules:**
- CLI subcommands remain the canonical deterministic interface.
- `shell.ts` translates natural language into typed tool invocations, not direct module calls.
- A future frontend reuses the same tool handlers instead of duplicating orchestration logic.
- Tools may compose core modules, but core modules must remain independently testable.
- No arbitrary shell execution from natural language; free text only maps to allowed tools.

**Examples of tool mappings:**
- `run_pipeline` → `ingest.ts` → `ontology.ts` → `graph.ts` → `profiles.ts` → `engine.ts`
- `simulate_run` → `engine.ts`
- `inspect_actor` → `db.ts` + actor state projection
- `interview_actor` → `interview.ts` + `CognitionBackend`
- `export_agent_bundle` / `import_agent_bundle` → `ckp.ts`

**Implementation timing:** this layer is defined now as an architectural boundary, but it is implemented
with the CLI/shell phase, not before Phase 2. The core pipeline comes first.

## Dependencies

```json
{
  "name": "seldonclaw",
  "version": "0.1.0",
  "type": "module",
  "bin": { "seldonclaw": "./dist/index.js" },
  "dependencies": {
    "@clawkernel/sdk": "^0.2.6",
    "@anthropic-ai/sdk": "^0.30.0",
    "better-sqlite3": "^11.0.0",
    "commander": "^12.0.0",
    "yaml": "^2.4.0"
  },
  // openai SDK removed in v1: all structured extraction uses native @anthropic-ai/sdk
  // NullClaw manages its own LLM client internally
  // If v2 needs non-Anthropic providers, add it then
  "devDependencies": {
    "typescript": "^5.5.0",
    "vitest": "^2.0.0",
    "@types/better-sqlite3": "^7.0.0"
  }
}
```

**5 runtime dependencies.** Compact. (`openai` removed: all extraction uses native `@anthropic-ai/sdk`; NullClaw manages its own LLM client.)

## Conformance

| Target | Level | When | Note |
|---|---|---|---|
| NullClaw Bridge | L3 (31/31) | Externally validated by NullClaw | SeldonClaw does **not** re-validate L3; trusts the published conformant bridge |
| seldonclaw→nullclaw integration | **Integration tests** | On SeldonClaw startup | GET /health, POST /pair (if applicable), round-trip /a2a with DecisionMessage + InterviewMessage |
| Archetype manifests (4) | CKP JSON Schema | On generation, via `@clawkernel/sdk` | Validates structure, not runtime |
| Concrete exports | L1 (13/13) | Only when exporting an actor as a real CKP agent | Optional, on demand |

## Improvements Over MiroFish

| Dimension | MiroFish | SeldonClaw |
|---|---|---|
| **Processes** | Flask + OASIS subprocess + Zep Cloud | **1 process** (Node, DirectLLMBackend built-in) |
| **RAM** | >1GB | **Pi 4 viable** (footprint pending benchmark) |
| **Storage** | Zep Cloud + OASIS SQLite + JSONL | **1 SQLite file** |
| **Actors** | Ephemeral Python objects | **SQLite rows** + CKP archetypes |
| **Cognition** | All think alike | **3 tiers**: A (always LLM), B (LLM if salient), C (rules) |
| **Social engine** | OASIS black box | **Explicit:** activation, feed, propagation, fatigue, events |
| **Graph** | Zep Cloud (opaque) | **Temporal with provenance**: documents→chunks→claims |
| **Providers** | 1 LLM for everything | **4 providers** per stage |
| **Entity resolution** | None | **Dedup + merge + alias + merge audit trail (P0)** |
| **Conformance** | None | **CKP schema** on archetypes, integration tests on worker |
| **Reproducibility** | None | **seed (PRNG) + decision_cache (LLM) + snapshots + run_manifest** |
| **Telemetry** | Ad-hoc JSONL | **Structured SQLite** with cost tracking per tier |
| **Portability** | None | **export-agent bundle** (claw.yaml + state + beliefs + provenance) |
| **Composition** | Simulated only | Simulated + real via CKP Swarm |
| **Timezone** | Hardcoded China | **Configurable IANA** |
| **Report** | Direct LLM | **SQL metrics → structured findings → LLM narrative** |
| **Data** | Opaque JSON blobs | **Normalized**: actor_topics, actor_beliefs, post_topics, entity_claims, community_overlap |
| **Engagement** | Post/comment only | **6 actions**: post, comment, like, repost, follow, search |
| **Platform** | Twitter + Reddit (superficial) | **X only** — one platform modeled deeply, not two modeled shallowly |
| **Actor memory** | Separate memory table | **Hybrid**: interaction history derived on-the-fly + persisted `actor_memories` for deliberative continuity |
| **Actor traits** | gender, country, language in separate table | **Inline** on actors table: gender, region, language (no join overhead) |
| **LLM SDK** | OpenAI compat (loses strict/response_format/seed) | **Anthropic native** for structured extraction |
| **Auditable** | Python monolith | **~20 TS files**, flat src/, run_id on every mutable table |

## MVP (Phase 1)

**Architecture decision:** NullClaw spike skipped. DirectLLMBackend chosen (see CLAUDE.md Phase 0).
NullClaw integration deferred — actors only need structured LLM completions, not agent capabilities.

**MVP Scope:** End-to-end pipeline with 10-20 actors, 5 rounds, X (formerly Twitter) only.

| File | Priority | Status |
|---|---|---|
| `db.ts` (types, schema, store, ids) | P0 | ✅ Phase 1 |
| `config.ts` | P0 | ✅ Phase 1 |
| `llm.ts` | P0 | ✅ Phase 1 |
| `ingest.ts` | P0 | ✅ Phase 2 |
| `ontology.ts` | P0 | ✅ Phase 2 |
| `graph.ts` (+ entity resolution/dedup) | P0 | ✅ Phase 2 |
| `profiles.ts` | P0 | ✅ Phase 2 |
| `cognition.ts` | P0 | ✅ Phase 3 |
| `reproducibility.ts` | P0 | ✅ Phase 3 |
| `activation.ts` | P0 | ✅ Phase 4 |
| `feed.ts` | P0 | ✅ Phase 4 |
| `telemetry.ts` | P0 | ✅ Phase 4 |
| `engine.ts` | P0 | ✅ Phase 5 |
| `index.ts` (CLI) | P0 | ✅ Phase 5 |
| `propagation.ts` | P1 | ✅ Phase 6 |
| `fatigue.ts` | P1 | ✅ Phase 6 |
| `events.ts` | P1 | ✅ Phase 6 |
| `ckp.ts` | P2 | ✅ Phase 7 |
| `report.ts` | P2 | ✅ Phase 7 |
| `interview.ts` | P2 | ✅ Phase 7 |
| `shell.ts` | P2 | ✅ Phase 8 |

**Phases 1-8 complete locally** (`389/389` tests, 27 test files). The remaining work is no longer missing core modules; it is validation, documentation upkeep, and future iteration.

## Report Pipeline (report.ts)

**Explicit policy:** reports and metrics ONLY read normalized columns/tables.
JSON only for snapshots, raw payloads, and debug. Never in report queries.

Not pure ReAct. 3-phase pipeline:

```
Phase 1: Pure SQL → structured metrics
  - Total posts, comments, reposts per round
  - Sentiment curve per narrative
  - Top actors by real influence (reach, engagement)
  - Breakdown by cognition tier (A/B/C calls, cost)
  - Cross-community propagation (what crossed, what didn't)
  - Fatigue curves per narrative
  - Event impact (before/after each event)
  → Result: JSON with metrics + findings

Phase 2: LLM on structured findings → narrative
  - Input: Phase 1 JSON + original hypothesis
  - Output: Markdown with analysis, insights, recommendations
  - Provider: report (claude-sonnet-4)
  → 1 LLM call, not iterative

Phase 3 (P2): Optional interviews for deeper insight
  - If the report identifies interesting actors → interview via NullClaw
  - Swarm only here (interview.ts)
```

## Interactive Shell (shell.ts)

Conversational REPL over a completed (or running) simulation. Not a general chatbot — a structured interface that translates natural language into SQL queries, actor interviews, and existing CLI operations.

```bash
seldonclaw shell --db simulation.db --run <run-id>
```

### Conversational Setup

The CLI should also support a guided setup flow for first-time users:

```bash
seldonclaw init
seldonclaw doctor
```

`seldonclaw init` is a conversational setup assistant, not a static flag dump. It should:

1. Detect the local environment
   - Node runtime available
   - writable working directory
   - SQLite file path availability
   - existing `seldonclaw.config.yaml` / `.env`
2. Ask only for the minimum required inputs
   - LLM provider/model profile
   - API key
   - default docs directory
   - output directory
   - timezone
3. Persist configuration safely
   - write `seldonclaw.config.yaml` without embedding secrets
   - store API keys in environment variables, `.env`, or OS keychain
   - never write raw API keys into `run_manifest`, telemetry, exports, or snapshots
4. Validate the setup before exiting
   - confirm provider credentials are present
   - run a minimal provider health check / small completion
   - confirm SQLite database open/create works
5. Offer the next action
   - e.g. "Run a sample simulation now?"

`seldonclaw doctor` is a deterministic diagnostic command. It should:
- verify required files and permissions
- check that configured provider env vars exist
- validate the config schema
- attempt a DB open/create
- optionally run a lightweight provider connectivity test
- print actionable failures, not stack traces by default

**Secret handling rules:**
- Never echo the full API key back to the terminal after entry.
- Never persist raw secrets in `seldonclaw.config.yaml`.
- Never include secrets in telemetry, `config_snapshot`, exports, or shell context.
- `config show` must display only a sanitized view.

**Implementation timing:** this belongs to the CLI/shell user experience layer (Phase 7/8), not the core simulation engine. The deterministic subcommands remain canonical; setup conversation is a guided layer on top.

### Architecture

```typescript
interface ShellContext {
  db: GraphStore;                    // read-only SQL access to simulation data
  runId: string;                     // active run to query
  backend: CognitionBackend;         // for actor interviews (NullClaw or RecordedBackend)
  llm: LLMClient;                   // report provider — translates NL → SQL + interprets results
  schema: TableSchema[];             // normalized table definitions (fed to LLM as context)
}

interface ShellCommand {
  type: "query" | "interview" | "export" | "inject" | "compare" | "help";
  parsed: ParsedIntent;
}
```

### How It Works

1. User types a natural language question or command
2. The LLM (report provider) receives:
   - The normalized schema (table names + columns, not data)
   - The user's input
   - Conversation history (last N turns)
3. The LLM classifies the intent and generates:
   - **query**: a SQL SELECT against normalized tables → results formatted as a table or summary
   - **interview**: routes to `CognitionBackend.interview()` with the specified actor
   - **export**: delegates to `ckp.ts` export-agent pipeline
   - **inject**: schedules an event for a running/resumed simulation
   - **compare**: multi-query composition (e.g., "compare students vs faculty")
4. Results are displayed and become part of conversation context for follow-up questions

### Example Session

```
seldonclaw> what was the overall sentiment trend across all rounds?
  ┌─────────┬──────────────┐
  │ round   │ avg_sentiment│
  ├─────────┼──────────────┤
  │ 1       │  0.12        │
  │ 2       │  0.05        │
  │ 3       │ -0.18        │
  │ ...     │ ...          │
  └─────────┴──────────────┘
  Sentiment started slightly positive and turned negative by round 3.

seldonclaw> who was the most influential actor?
  journalist-01 (influence: 0.92, reach: 847, 23 posts, tier A)

seldonclaw> interview journalist-01
  Entering interview mode with journalist-01. Type /exit to return.

  journalist-01> Why did you change your stance on tuition?
  "Initially I reported the facts neutrally, but after seeing the student
   protests gain traction and reading the leaked budget documents, I felt
   the evidence pointed toward an unjustified increase..."

  journalist-01> /exit

seldonclaw> which posts went viral?
  3 posts exceeded viral threshold (30 exposures):
  - post-a8f3 by student-activist-03 (round 4, reach: 127)
  - post-c2d1 by journalist-01 (round 6, reach: 89)
  - post-f7e2 by faculty-union-rep (round 8, reach: 54)

seldonclaw> compare community "students" vs "faculty" on sentiment
  students:  avg_sentiment = -0.72 (strongly opposing)
  faculty:   avg_sentiment = -0.31 (mildly opposing)
  overlap:   0.4 (moderate cross-exposure)

seldonclaw> export journalist-01
  Exported to ./agent-bundle/journalist-01/ (claw.yaml + state + beliefs)
```

### Safety Constraints

- **Read-only by default.** The shell only executes SELECT queries against SQLite. No INSERT, UPDATE, DELETE, DROP.
- **Write operations are explicit.** Only `inject` (event injection) and `export` modify state, and both require confirmation.
- **Schema-only context.** The LLM receives table definitions, not raw data. Query results are returned to the user, not fed back into the LLM as unbounded context.
- **Same redaction rules.** `sanitizeDetail()` applies to any data surfaced through the shell.
- **No secret exposure.** The shell never queries `config_snapshot` for secret fields, never displays auth tokens, and `scrubSecrets()` applies to exports initiated from the shell.

### Dependencies

- `readline` (Node.js built-in) for the REPL loop
- `report` provider (same LLM used for report generation) for NL → SQL translation
- `CognitionBackend` (already exists) for interviews
- No new runtime dependencies

### Priority

P2 — requires `report.ts`, `interview.ts`, and the core engine to be working first. The shell composes existing capabilities; it doesn't introduce new data paths.

## V3 / V4 Extensions — Implemented

Two post-MVP extensions were added after the core engine stabilized. They were implemented in dependency order so each layer could reuse the previous one without widening the architecture:

### V3 — Agent Memory

**Goal:** increase actor continuity across rounds and improve interview coherence.

**Tasks**
1. Add `actor_memories` table + indices in SQLite.
2. Add `ActorMemoryRow` types and `GraphStore` methods.
3. Add `memory.ts` to derive short, auditable memories from:
   - reflections (`decision.reasoning`)
   - salient feed interactions
   - active events
   - dominant narratives
4. Persist memories for Tier A/B actors in the round transaction.
5. Extend `buildSimContext()` and interview context with top memories.

**Dependency chain**
- schema/types/store first
- then `memory.ts`
- then `engine.ts`
- then `cognition.ts` / `interview.ts`

**Why this order:** memory becomes another read model on top of the current engine instead of a second cognition system.

### V4 — Embedding-aware Feed

**Goal:** augment heuristic feed ranking with semantic relevance while keeping the original ranking path as fallback.

**Tasks**
1. Add `post_embeddings` and `actor_interest_embeddings` tables.
2. Add store cache methods for both embedding types.
3. Introduce `embeddings.ts`:
   - `EmbeddingProvider` interface
   - deterministic hash-based provider for local/offline use
   - cache population helpers
4. Enrich `PlatformState` with optional embedding maps.
5. Update `feed.ts` to add semantic similarity when `feed.embeddingEnabled = true`.
6. Keep heuristics (`recency`, `popularity`, `relevance`, `community affinity`) as the default/base score.

**Dependency chain**
- schema/types/store first
- then provider/cache layer
- then `engine.ts` state enrichment
- then `feed.ts` scoring

**Why this order:** feed ranking stays pure and deterministic; embeddings are attached to state before scheduling instead of making `feed.ts` query storage directly.

### Runtime contract

- `embeddingEnabled = false` preserves the original feed behavior.
- Memory is additive: if no memories exist, `buildSimContext()` still works from interaction history only.
- Reproducibility remains auditable because:
  - memory rows are persisted with `run_id`, `actor_id`, and `round_num`
  - embedding cache rows store `model_id` + content/profile hash
  - no silent recomputation is required during replay

### Code touchpoints

- `src/memory.ts`
- `src/embeddings.ts`
- `src/feed.ts`
- `src/cognition.ts`
- `src/interview.ts`
- `src/engine.ts`
- `src/schema.ts`
- `src/store.ts`
- `src/types.ts`

## V5 Extension — Web-grounded Search

**Goal:** let Tier A/B actors enrich decisions with auditable real-world context without breaking replayability.

**Tasks**
1. Add `search` config with endpoint, cutoff, tiers, eligibility policy, result limits, and timeout.
2. Add `search_cache` for cache-first reuse and `search_requests` for per-actor per-round audit.
3. Introduce `search.ts`:
   - `SearchProvider` interface
   - SearXNG HTTP client
   - temporal cutoff filtering
   - cache-first lookup
   - prompt context formatting
4. Extend `DecisionRequest` with optional `webContext`.
5. Derive search queries deterministically during scheduler staging.
6. Select search-enabled actors deterministically by policy:
   - tier eligibility
   - archetype / profession allow-deny lists
   - explicit actor allow-deny lists
   - per-round and per-tier budgets
7. Resolve web searches only for selected Tier A/B jobs during concurrent execution.
8. Persist `search_requests` in the round transaction.
9. Extend `doctor` to validate the SearXNG endpoint when search is enabled.

**Dependency chain**
- config/schema/types/store first
- then `search.ts`
- then `cognition.ts`
- then `scheduler.ts`
- then `engine.ts` / `index.ts`

**Why this order:** query generation remains deterministic and auditable, while the HTTP fetch work stays outside the sequential staging loop.

**Runtime contract**
- `search.enabled = false` preserves the original behavior.
- `maxActorsPerRound` and `maxActorsByTier` cap who can search in a round.
- `allowArchetypes` / `denyArchetypes`, `allowProfessions` / `denyProfessions`, and `allowActors` / `denyActors` control which actors may search.
- `deny*` rules win. `allow*` rules are additive rather than intersecting.
- `search_cache` stores reusable result sets by `(query, cutoff_date, language, categories)`.
- `search_requests` records which actor searched what in each round.
- `DecisionRequest.webContext` is part of the replay hash.
- Search failures degrade gracefully to feed-only cognition; they do not abort a round.

**Code touchpoints**
- `src/search.ts`
- `src/config.ts`
- `src/schema.ts`
- `src/store.ts`
- `src/cognition.ts`
- `src/scheduler.ts`
- `src/engine.ts`
- `src/index.ts`

## V6 Extension — Natural-Language Simulation Design

**Problem:** a powerful simulation engine still forces users to translate intent into low-level YAML by hand. That creates three failure modes:

1. the user's actual scenario is underspecified or misconfigured
2. defaults remain implicit and hard to audit
3. a chat-first UX can become non-reproducible if the LLM writes executable config directly

**Solution:** insert a design layer between free-form intent and execution:

```
natural-language brief
        ↓
typed SimulationSpec
        ↓
validation + assumptions + warnings
        ↓
deterministic SimConfig rendering
        ↓
generated YAML + JSON spec
        ↓
confirmation
        ↓
run
```

The LLM interprets intent. TypeScript remains the source of truth for validation, defaults, and final config rendering.

### Goals

- let users describe a simulation in plain English after basic setup
- preserve auditability and replayability
- surface assumptions before anything is executed
- generate stable artifacts:
  - `simulation.spec.json`
  - `seldonclaw.generated.config.yaml`

### Recommended user flow

```bash
seldonclaw init
seldonclaw design \
  --docs ./docs/product-recall \
  --brief "Create a 10-round simulation about a global consumer electronics product recall. Focus on journalists, company spokespeople, regulators, investors, and customers. Only journalists, analysts, and institutions may search the web. Allow up to 4 search-enabled actors per round, with 2 Tier A and 2 Tier B. Enable embedding-aware feed ranking."
seldonclaw run \
  --config ./seldonclaw.generated.config.yaml \
  --docs ./docs/product-recall \
  --hypothesis "Journalists and regulators accelerate negative sentiment faster than the company can stabilize the narrative."
```

### Core contract

- free-form text never executes directly
- the LLM never writes raw YAML as the source of truth
- `SimulationSpec` is the semantic layer
- `SimConfig` is the execution layer
- every generated config is reviewable before writing

### Tasks

1. Introduce `src/design.ts`
   - `SimulationSpec`
   - `interpretSimulationBrief()`
   - `validateSimulationSpec()`
   - `renderSimulationConfig()`
   - `renderSimulationConfigYaml()`
   - `formatSimulationPlan()`
2. Add `seldonclaw design`
   - `--brief`
   - `--docs`
   - `--out-spec`
   - `--out-config`
   - `--yes`
   - `--mock`
3. Make the flow explicit:
   - interpret brief
   - validate
   - preview
   - confirm
   - write files
4. Keep the brief examples global and domain-generic
   - product recall
   - cloud outage
   - AI regulation debate
   - labor strike
5. Document the feature in `README.md`
   - setup
   - example brief
   - generated artifacts
   - why the flow is safe

### Dependency chain

- first: `design.ts`
- then: `index.ts` command wiring
- then: tests for parser/render/CLI
- finally: `README.md` and usage docs

### Verification

1. `seldonclaw design --brief "..." --docs ./docs/example --mock --yes`
2. inspect generated `simulation.spec.json`
3. inspect generated `seldonclaw.generated.config.yaml`
4. `seldonclaw run --config ./seldonclaw.generated.config.yaml --docs ./docs/example --mock`
5. confirm:
   - identical brief + identical defaults -> equivalent rendered config
   - warnings are surfaced when docs path is missing
   - unsupported values do not reach the engine unchecked

## Verification

1. `seldonclaw run --docs fixtures/sample-docs/ --hypothesis "..." --rounds 5 --seed 42 --config test.config.yaml`
2. Verify `simulation.db`:
   - Provenance: documents (>0), chunks (>0), claims (>0)
   - Entity resolution: no obvious duplicates, merge_history audited
   - Platform: actors (10-20), posts (>0), actor_topics, actor_beliefs, post_topics normalized
   - Telemetry: telemetry (>0 with cognition_tier), rounds (5 with tier_a/b/c_calls), run_manifest (1 row)
   - Reproducibility: decision_cache (>0), snapshots (≥1)
3. `seldonclaw stats --db simulation.db` shows: total posts, active actors per round, total cost
4. `seldonclaw stats --db simulation.db --tiers` shows: calls per tier A/B/C, estimated savings
5. **Full reproducibility:**
   - `seldonclaw replay --db simulation2.db --run <id>` produces identical results
   - Tier C: deterministic via seed (same rules, same activation)
   - Tier A/B: deterministic via `decision_cache` + `RecordedBackend` (0 LLM calls on replay)
6. **Export-agent:**
   - `seldonclaw export-agent --run <id> --actor journalist-01 --out ./bundle/`
   - Bundle contains: claw.yaml (valid CKP), actor_state.json, beliefs.json, topics.json, provenance.json, manifest.meta.json
7. **Import-agent:** `seldonclaw import-agent --bundle ./bundle/ --db sim2.db --run <id>` reconstitutes actor
8. **Report policy:** `report.ts` only reads normalized tables (verify with grep: no JSON parse in report queries)
9. **Interview:** `seldonclaw interview --db simulation.db --actor journalist-01` responds coherently via CognitionBackend
10. **Interactive shell:**
    - `seldonclaw shell --db simulation.db --run <id>` starts REPL
    - Natural language query returns correct SQL results (verified against direct SQL)
    - Interview mode enters/exits cleanly, actor responds coherently
    - Shell never executes write operations without explicit confirmation
    - No secrets appear in shell output
11. **NullClaw integration test:**
    - `GET /health` → 200 OK (gateway alive)
    - Pairing/token if applicable (POST /pair)
    - Round-trip A2A: `POST /a2a` with DecisionMessage → parseable response
    - Round-trip A2A: `POST /a2a` with InterviewMessage → coherent response
    - `CognitionBackend.decide()` and `.interview()` as internally validated end-to-end API
