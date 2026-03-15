# SeldonClaw Data Model

This document is the human-readable map of the relational model implemented in [schema.ts](/Users/agc/Documents/seldonclaw/src/schema.ts) and accessed through [store.ts](/Users/agc/Documents/seldonclaw/src/store.ts). It is meant for:

- engineers implementing pipeline and runtime code
- operator tooling and CLI/shell work
- future frontend or API layers that need a stable mental model

The companion machine-readable file lives at [data-model.json](/Users/agc/Documents/seldonclaw/docs/data-model.json).

## Layers

SeldonClaw's relational model is organized in five layers:

1. **Provenance**
   Documents, chunks, and extracted claims.
2. **Knowledge Graph**
   Entity/edge ontology, instances, aliases, merges, and provenance links.
3. **Social Simulation**
   Actors, communities, follows, mutes, blocks, posts, reports, exposures, narratives, memories, and embedding caches.
4. **Observability**
   Telemetry, round summaries, skipped-round audit spans, and per-actor search audit logs.
5. **Reproducibility**
   Run manifests, decision cache, snapshots, and reusable web search cache.

## Layered ERD

### 1. Provenance + Graph

```mermaid
erDiagram
  DOCUMENTS ||--o{ CHUNKS : contains
  CHUNKS ||--o{ CLAIMS : source_of
  ENTITY_TYPES ||--o{ ENTITIES : types
  EDGE_TYPES ||--o{ EDGES : types
  ENTITIES ||--o{ EDGES : source_id
  ENTITIES ||--o{ EDGES : target_id
  ENTITIES ||--o{ ENTITY_ALIASES : has
  ENTITIES ||--o{ ENTITY_MERGES : kept_entity
  ENTITIES ||--o{ ENTITY_MERGES : merged_entity
  ENTITIES ||--o{ ENTITY_CLAIMS : linked_to
  CLAIMS ||--o{ ENTITY_CLAIMS : provenance
  EDGES ||--o{ EDGE_CLAIMS : linked_to
  CLAIMS ||--o{ EDGE_CLAIMS : provenance

  DOCUMENTS {
    text id PK
    text filename
    text content_hash
    text mime_type
    text ingested_at
  }
  CHUNKS {
    text id PK
    text document_id FK
    int chunk_index
    text content
    int token_count
  }
  CLAIMS {
    text id PK
    text source_chunk_id FK
    text subject
    text predicate
    text object
    real confidence
    text valid_from
    text valid_to
    text observed_at
  }
  ENTITY_TYPES {
    text name PK
  }
  EDGE_TYPES {
    text name PK
    text source_type
    text target_type
  }
  ENTITIES {
    text id PK
    text type FK
    text name
    text merged_into FK
  }
  EDGES {
    text id PK
    text type FK
    text source_id FK
    text target_id FK
  }
  ENTITY_ALIASES {
    text entity_id FK
    text alias
    text source
  }
  ENTITY_MERGES {
    text id PK
    text kept_entity_id FK
    text merged_entity_id FK
    real confidence
    text merge_reason
  }
  ENTITY_CLAIMS {
    text entity_id FK
    text claim_id FK
  }
  EDGE_CLAIMS {
    text edge_id FK
    text claim_id FK
  }
```

### 2. Run-scoped Social Simulation

```mermaid
erDiagram
  RUN_MANIFEST ||--o{ ACTORS : scopes
  RUN_MANIFEST ||--o{ COMMUNITIES : scopes
  RUN_MANIFEST ||--o{ COMMUNITY_OVERLAP : scopes
  RUN_MANIFEST ||--o{ POSTS : scopes
  RUN_MANIFEST ||--o{ FOLLOWS : scopes
  RUN_MANIFEST ||--o{ MUTES : scopes
  RUN_MANIFEST ||--o{ BLOCKS : scopes
  RUN_MANIFEST ||--o{ EXPOSURES : scopes
  RUN_MANIFEST ||--o{ NARRATIVES : scopes
  RUN_MANIFEST ||--o{ ACTOR_MEMORIES : scopes
  RUN_MANIFEST ||--o{ REPORTS : scopes
  RUN_MANIFEST ||--o{ SEARCH_REQUESTS : scopes

  ENTITIES ||--o{ ACTORS : optional_origin
  ACTORS ||--o{ ACTOR_TOPICS : has
  ACTORS ||--o{ ACTOR_BELIEFS : has
  ACTORS ||--o{ POSTS : authors
  ACTORS ||--o{ FOLLOWS : follower_id
  ACTORS ||--o{ FOLLOWS : following_id
  ACTORS ||--o{ MUTES : actor_id
  ACTORS ||--o{ MUTES : muted_actor_id
  ACTORS ||--o{ BLOCKS : actor_id
  ACTORS ||--o{ BLOCKS : blocked_actor_id
  ACTORS ||--o{ EXPOSURES : sees
  ACTORS ||--o{ ACTOR_MEMORIES : remembers
  ACTORS ||--o{ ACTOR_INTEREST_EMBEDDINGS : semantic_profile
  ACTORS ||--o{ REPORTS : reports
  ACTORS ||--o{ SEARCH_REQUESTS : searches
  POSTS ||--o{ POST_TOPICS : tagged_with
  POSTS ||--o{ EXPOSURES : exposed_as
  POSTS ||--o{ POST_EMBEDDINGS : semantic_representation
  POSTS ||--o{ ACTOR_MEMORIES : source_post
  POSTS ||--o{ REPORTS : reported_post

  COMMUNITIES ||--o{ ACTORS : membership
  COMMUNITIES ||--o{ COMMUNITY_OVERLAP : community_a
  COMMUNITIES ||--o{ COMMUNITY_OVERLAP : community_b

  RUN_MANIFEST {
    text id PK
    int seed
    text graph_revision_id
    text status
  }
  ACTORS {
    text id PK
    text run_id FK
    text entity_id FK
    text archetype
    text cognition_tier
    text name
    text community_id
  }
  ACTOR_TOPICS {
    text actor_id FK
    text topic
    real weight
  }
  ACTOR_BELIEFS {
    text actor_id FK
    text topic
    real sentiment
    int round_updated
  }
  COMMUNITIES {
    text id PK
    text run_id FK
    text name
    real cohesion
  }
  COMMUNITY_OVERLAP {
    text community_a FK
    text community_b FK
    text run_id FK
    real weight
  }
  POSTS {
    text id PK
    text run_id FK
    text author_id FK
    text post_kind
    int round_num
    text sim_timestamp
    real sentiment
    int is_deleted
    text moderation_status
  }
  POST_TOPICS {
    text post_id FK
    text topic
  }
  FOLLOWS {
    text follower_id FK
    text following_id FK
    text run_id FK
    int since_round
  }
  MUTES {
    text actor_id FK
    text muted_actor_id FK
    text run_id FK
    int since_round
  }
  BLOCKS {
    text actor_id FK
    text blocked_actor_id FK
    text run_id FK
    int since_round
  }
  EXPOSURES {
    text actor_id FK
    text post_id FK
    int round_num
    text run_id FK
    text reaction
  }
  NARRATIVES {
    text id PK
    text run_id FK
    text topic
    real current_intensity
  }
  ACTOR_MEMORIES {
    text id PK
    text run_id FK
    text actor_id FK
    int round_num
    text kind
    real salience
  }
  REPORTS {
    text id PK
    text run_id FK
    int round_num
    text reporter_id FK
    text post_id FK
  }
  POST_EMBEDDINGS {
    text post_id FK
    text model_id PK
    text content_hash
  }
  ACTOR_INTEREST_EMBEDDINGS {
    text actor_id FK
    text model_id PK
    text profile_hash
  }
  SEARCH_REQUESTS {
    text id PK
    text run_id FK
    int round_num
    text actor_id FK
    text query
    int cache_hit
  }
  SEARCH_CACHE {
    text id PK
    text query
    text cutoff_date
    text language
    text categories
  }
```

### 3. Observability + Reproducibility

```mermaid
erDiagram
  RUN_MANIFEST ||--o{ ROUNDS : summarizes
  RUN_MANIFEST ||--o{ TELEMETRY : logs
  RUN_MANIFEST ||--o{ DECISION_CACHE : caches
  RUN_MANIFEST ||--o{ SNAPSHOTS : checkpoints
  RUN_MANIFEST ||--o{ SEARCH_REQUESTS : search_audit
  RUN_MANIFEST ||--o{ SKIPPED_ROUNDS : time_acceleration
  ACTORS ||--o{ TELEMETRY : actor_events
  ACTORS ||--o{ DECISION_CACHE : decisions
  ACTORS ||--o{ SEARCH_REQUESTS : search_actor

  ROUNDS {
    int num PK
    text run_id PK
    text sim_time
    int active_actors
    int total_posts
    int total_actions
  }
  TELEMETRY {
    int id PK
    text run_id FK
    int round_num
    text actor_id FK
    text cognition_tier
    text action_type
    real cost_usd
  }
  DECISION_CACHE {
    text id PK
    text run_id FK
    int round_num
    text actor_id FK
    text request_hash
    text model_id
    text prompt_version
  }
  SNAPSHOTS {
    text id PK
    text run_id FK
    int round_num
    text rng_state
  }
  SEARCH_REQUESTS {
    text id PK
    text run_id FK
    int round_num
    text actor_id FK
    text query
    text cutoff_date
    int result_count
  }
  SKIPPED_ROUNDS {
    text id PK
    text run_id FK
    int from_round
    int to_round
    text sim_time_start
    text sim_time_end
    text reason
  }
  SEARCH_CACHE {
    text id PK
    text query
    text cutoff_date
    text fetched_at
  }
```

## Full ERD

```mermaid
erDiagram
  DOCUMENTS ||--o{ CHUNKS : contains
  CHUNKS ||--o{ CLAIMS : source_of
  ENTITY_TYPES ||--o{ ENTITIES : types
  EDGE_TYPES ||--o{ EDGES : types
  ENTITIES ||--o{ EDGES : source_id
  ENTITIES ||--o{ EDGES : target_id
  ENTITIES ||--o{ ENTITY_ALIASES : has
  ENTITIES ||--o{ ENTITY_MERGES : kept_entity
  ENTITIES ||--o{ ENTITY_MERGES : merged_entity
  ENTITIES ||--o{ ENTITY_CLAIMS : linked_to
  CLAIMS ||--o{ ENTITY_CLAIMS : provenance
  EDGES ||--o{ EDGE_CLAIMS : linked_to
  CLAIMS ||--o{ EDGE_CLAIMS : provenance

  RUN_MANIFEST ||--o{ ACTORS : scopes
  RUN_MANIFEST ||--o{ COMMUNITIES : scopes
  RUN_MANIFEST ||--o{ COMMUNITY_OVERLAP : scopes
  RUN_MANIFEST ||--o{ POSTS : scopes
  RUN_MANIFEST ||--o{ FOLLOWS : scopes
  RUN_MANIFEST ||--o{ EXPOSURES : scopes
  RUN_MANIFEST ||--o{ NARRATIVES : scopes
  RUN_MANIFEST ||--o{ ACTOR_MEMORIES : scopes
  RUN_MANIFEST ||--o{ TELEMETRY : scopes
  RUN_MANIFEST ||--o{ ROUNDS : scopes
  RUN_MANIFEST ||--o{ DECISION_CACHE : scopes
  RUN_MANIFEST ||--o{ SNAPSHOTS : scopes
  RUN_MANIFEST ||--o{ SEARCH_REQUESTS : scopes
  RUN_MANIFEST ||--o{ SKIPPED_ROUNDS : scopes

  ENTITIES ||--o{ ACTORS : optional_origin
  ACTORS ||--o{ ACTOR_TOPICS : has
  ACTORS ||--o{ ACTOR_BELIEFS : has
  ACTORS ||--o{ POSTS : authors
  ACTORS ||--o{ FOLLOWS : follower_id
  ACTORS ||--o{ FOLLOWS : following_id
  ACTORS ||--o{ EXPOSURES : sees
  ACTORS ||--o{ ACTOR_MEMORIES : remembers
  ACTORS ||--o{ ACTOR_INTEREST_EMBEDDINGS : semantic_profile
  ACTORS ||--o{ TELEMETRY : acts
  ACTORS ||--o{ DECISION_CACHE : decides
  ACTORS ||--o{ SEARCH_REQUESTS : searches

  POSTS ||--o{ POST_TOPICS : tagged_with
  POSTS ||--o{ EXPOSURES : reaches
  POSTS ||--o{ POST_EMBEDDINGS : semantic_representation
  POSTS ||--o{ ACTOR_MEMORIES : source_post

  COMMUNITIES ||--o{ ACTORS : membership
  COMMUNITIES ||--o{ COMMUNITY_OVERLAP : community_a
  COMMUNITIES ||--o{ COMMUNITY_OVERLAP : community_b
```

## Core invariants

- `documents`, `chunks`, `claims`, `entities`, and `edges` are the base knowledge corpus.
- `actors`, `posts`, `follows`, `exposures`, `narratives`, `actor_memories`, `telemetry`, `rounds`, `decision_cache`, `snapshots`, `search_requests`, and `skipped_rounds` are **run-scoped**.
- `mutes`, `blocks`, and `reports` are also **run-scoped** and participate directly in runtime visibility / moderation.
- `communities` and `community_overlap` are also **run-scoped** in the current implementation.
- `post_embeddings` and `actor_interest_embeddings` are per-post / per-actor caches keyed by model id.
- `search_cache` is reusable across runs and intentionally not foreign-keyed to a specific actor or round.
- `posts.post_kind` distinguishes `post`, `comment`, `repost`, and `quote`.
- `posts.is_deleted = 1` soft-deletes content without removing audit history.
- `posts.moderation_status = 'shadowed'` removes content from feed and propagation projections.
- `entities.merged_into IS NULL` means the entity is active and should appear in search/build steps.
- `exposure_summary` is a view over `exposures`, not a source-of-truth table.

## Runtime projections

These are not separate tables, but they are important to keep in mind when building the CLI or shell:

- `PlatformState`
  Read-only projection over `posts`, `post_topics`, `actors`, `communities`, `community_overlap`, `follows`, `mutes`, `blocks`, `exposures`, `post_embeddings`, and `actor_interest_embeddings`, plus derived interaction traces.
- `ActorContext`
  Read model assembled from `actors`, `actor_topics`, `actor_beliefs`, `posts`, `exposures`, and `actor_memories`.
- `NarrativeState`
  In-memory projection over `narratives`.
- `RoundContext`
  Runtime object created by the engine, not persisted directly.

## Recommended uses

- Use [data-model.md](/Users/agc/Documents/seldonclaw/docs/data-model.md) for human navigation and architecture reviews.
- Use [data-model.json](/Users/agc/Documents/seldonclaw/docs/data-model.json) for CLI/shell features that need schema-aware behavior:
  - intent routing
  - validation
  - schema introspection
  - safe query generation
