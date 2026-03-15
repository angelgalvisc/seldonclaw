/**
 * schema.ts — SQLite DDL for SeldonClaw
 *
 * Source of truth: PLAN.md §SQLite Schema
 *
 * Single exported constant: SCHEMA_SQL
 * Used only by SQLiteGraphStore constructor.
 */

export const SCHEMA_SQL = `
-- ═══════════════════════════════════════
-- PROVENANCE: documents → chunks → claims
-- ═══════════════════════════════════════

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  mime_type TEXT,
  ingested_at TEXT DEFAULT (datetime('now')),
  metadata TEXT
);

CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  token_count INTEGER,
  FOREIGN KEY (document_id) REFERENCES documents(id)
);

CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY,
  source_chunk_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  predicate TEXT NOT NULL,
  object TEXT NOT NULL,
  confidence REAL DEFAULT 1.0,
  valid_from TEXT,
  valid_to TEXT,
  observed_at TEXT NOT NULL,
  topics TEXT,
  FOREIGN KEY (source_chunk_id) REFERENCES chunks(id)
);

-- ═══════════════════════════════════════
-- ONTOLOGY (types, not instances)
-- ═══════════════════════════════════════

CREATE TABLE IF NOT EXISTS entity_types (
  name TEXT PRIMARY KEY,
  description TEXT,
  attributes TEXT
);

CREATE TABLE IF NOT EXISTS edge_types (
  name TEXT PRIMARY KEY,
  description TEXT,
  source_type TEXT,
  target_type TEXT
);

-- ═══════════════════════════════════════
-- KNOWLEDGE GRAPH (no embeddings in v1)
-- ═══════════════════════════════════════

CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  attributes TEXT,
  merged_into TEXT,                    -- NULL = active entity, non-NULL = absorbed into this entity id
  FOREIGN KEY (type) REFERENCES entity_types(name),
  FOREIGN KEY (merged_into) REFERENCES entities(id)
);

CREATE TABLE IF NOT EXISTS edges (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  attributes TEXT,
  confidence REAL DEFAULT 1.0,
  valid_from TEXT,
  valid_to TEXT,
  FOREIGN KEY (type) REFERENCES edge_types(name),
  FOREIGN KEY (source_id) REFERENCES entities(id),
  FOREIGN KEY (target_id) REFERENCES entities(id)
);

-- FTS5 for full-text search (replaces embeddings in v1)
CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
  name, attributes,
  content='entities', content_rowid='rowid'
);

-- ═══════════════════════════════════════
-- ENTITY RESOLUTION: dedup audit trail
-- ═══════════════════════════════════════

CREATE TABLE IF NOT EXISTS entity_aliases (
  entity_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  source TEXT,
  PRIMARY KEY (entity_id, alias),
  FOREIGN KEY (entity_id) REFERENCES entities(id)
);

CREATE TABLE IF NOT EXISTS entity_merges (
  id TEXT PRIMARY KEY,
  kept_entity_id TEXT NOT NULL,
  merged_entity_id TEXT NOT NULL,
  confidence REAL NOT NULL,
  merge_reason TEXT NOT NULL,
  merge_reason_detail TEXT,
  merged_at TEXT DEFAULT (datetime('now')),
  reversed INTEGER DEFAULT 0,
  FOREIGN KEY (kept_entity_id) REFERENCES entities(id),
  FOREIGN KEY (merged_entity_id) REFERENCES entities(id)
);

-- ═══════════════════════════════════════
-- REPRODUCIBILITY (must come before actors for FK)
-- ═══════════════════════════════════════

CREATE TABLE IF NOT EXISTS run_manifest (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  seed INTEGER NOT NULL,
  config_snapshot TEXT NOT NULL,
  hypothesis TEXT,
  docs_hash TEXT,
  graph_revision_id TEXT NOT NULL,
  total_rounds INTEGER,
  status TEXT DEFAULT 'running',
  resumed_from TEXT,
  version TEXT
);

-- ═══════════════════════════════════════
-- ACTORS
-- ═══════════════════════════════════════

CREATE TABLE IF NOT EXISTS actors (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  entity_id TEXT,
  archetype TEXT NOT NULL,
  cognition_tier TEXT NOT NULL DEFAULT 'B',
  name TEXT NOT NULL,
  handle TEXT,
  personality TEXT NOT NULL,
  bio TEXT,
  age INTEGER,
  gender TEXT,
  profession TEXT,
  region TEXT,
  language TEXT DEFAULT 'es',
  stance TEXT DEFAULT 'neutral',
  sentiment_bias REAL DEFAULT 0.0,
  activity_level REAL DEFAULT 0.5,
  influence_weight REAL DEFAULT 0.5,
  community_id TEXT,
  active_hours TEXT,
  follower_count INTEGER DEFAULT 100,
  following_count INTEGER DEFAULT 50,
  FOREIGN KEY (entity_id) REFERENCES entities(id),
  FOREIGN KEY (run_id) REFERENCES run_manifest(id)
);

-- ═══════════════════════════════════════
-- NORMALIZED TABLES
-- ═══════════════════════════════════════

CREATE TABLE IF NOT EXISTS actor_topics (
  actor_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  weight REAL DEFAULT 1.0,
  PRIMARY KEY (actor_id, topic),
  FOREIGN KEY (actor_id) REFERENCES actors(id)
);

CREATE TABLE IF NOT EXISTS actor_beliefs (
  actor_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  sentiment REAL NOT NULL,
  round_updated INTEGER,
  PRIMARY KEY (actor_id, topic),
  FOREIGN KEY (actor_id) REFERENCES actors(id)
);

CREATE TABLE IF NOT EXISTS post_topics (
  post_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  PRIMARY KEY (post_id, topic),
  FOREIGN KEY (post_id) REFERENCES posts(id)
);

CREATE TABLE IF NOT EXISTS entity_claims (
  entity_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  PRIMARY KEY (entity_id, claim_id),
  FOREIGN KEY (entity_id) REFERENCES entities(id),
  FOREIGN KEY (claim_id) REFERENCES claims(id)
);

CREATE TABLE IF NOT EXISTS edge_claims (
  edge_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  PRIMARY KEY (edge_id, claim_id),
  FOREIGN KEY (edge_id) REFERENCES edges(id),
  FOREIGN KEY (claim_id) REFERENCES claims(id)
);

CREATE TABLE IF NOT EXISTS communities (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  cohesion REAL DEFAULT 0.5,
  FOREIGN KEY (run_id) REFERENCES run_manifest(id)
);

CREATE TABLE IF NOT EXISTS community_overlap (
  community_a TEXT NOT NULL,
  community_b TEXT NOT NULL,
  run_id TEXT NOT NULL,
  weight REAL NOT NULL,
  PRIMARY KEY (community_a, community_b, run_id),
  FOREIGN KEY (community_a) REFERENCES communities(id),
  FOREIGN KEY (community_b) REFERENCES communities(id),
  FOREIGN KEY (run_id) REFERENCES run_manifest(id)
);

-- ═══════════════════════════════════════
-- PLATFORM STATE (all with run_id)
-- ═══════════════════════════════════════

CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  content TEXT NOT NULL,
  reply_to TEXT,
  quote_of TEXT,
  round_num INTEGER NOT NULL,
  sim_timestamp TEXT NOT NULL,
  likes INTEGER DEFAULT 0,
  reposts INTEGER DEFAULT 0,
  comments INTEGER DEFAULT 0,
  reach INTEGER DEFAULT 0,
  sentiment REAL,
  FOREIGN KEY (author_id) REFERENCES actors(id),
  FOREIGN KEY (run_id) REFERENCES run_manifest(id)
);

CREATE TABLE IF NOT EXISTS follows (
  follower_id TEXT,
  following_id TEXT,
  run_id TEXT NOT NULL,
  since_round INTEGER,
  PRIMARY KEY (follower_id, following_id, run_id),
  FOREIGN KEY (run_id) REFERENCES run_manifest(id)
);

CREATE TABLE IF NOT EXISTS exposures (
  actor_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  round_num INTEGER NOT NULL,
  run_id TEXT NOT NULL,
  reaction TEXT DEFAULT 'seen',
  PRIMARY KEY (actor_id, post_id, round_num),
  FOREIGN KEY (run_id) REFERENCES run_manifest(id)
);

-- Exposure aggregate view
CREATE VIEW IF NOT EXISTS exposure_summary AS
SELECT
  actor_id, post_id, run_id,
  MIN(round_num) AS first_seen_round,
  MAX(round_num) AS last_seen_round,
  COUNT(*) AS exposure_count,
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

CREATE TABLE IF NOT EXISTS narratives (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  first_round INTEGER,
  peak_round INTEGER,
  current_intensity REAL DEFAULT 1.0,
  total_posts INTEGER DEFAULT 0,
  dominant_sentiment REAL DEFAULT 0.0,
  FOREIGN KEY (run_id) REFERENCES run_manifest(id)
);

-- ═══════════════════════════════════════
-- TELEMETRY + ROUNDS
-- ═══════════════════════════════════════

CREATE TABLE IF NOT EXISTS telemetry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  round_num INTEGER NOT NULL,
  actor_id TEXT,
  cognition_tier TEXT,
  action_type TEXT NOT NULL,
  action_detail TEXT,
  tokens_input INTEGER,
  tokens_output INTEGER,
  cost_usd REAL,
  duration_ms INTEGER,
  provider TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (run_id) REFERENCES run_manifest(id)
);

CREATE TABLE IF NOT EXISTS rounds (
  num INTEGER NOT NULL,
  run_id TEXT NOT NULL,
  sim_time TEXT,
  active_actors INTEGER,
  total_posts INTEGER,
  total_actions INTEGER,
  tier_a_calls INTEGER DEFAULT 0,
  tier_b_calls INTEGER DEFAULT 0,
  tier_c_actions INTEGER DEFAULT 0,
  avg_sentiment REAL,
  trending_topics TEXT,
  events TEXT,
  wall_time_ms INTEGER,
  PRIMARY KEY (num, run_id),
  FOREIGN KEY (run_id) REFERENCES run_manifest(id)
);

-- ═══════════════════════════════════════
-- REPRODUCIBILITY
-- ═══════════════════════════════════════

CREATE TABLE IF NOT EXISTS decision_cache (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  round_num INTEGER NOT NULL,
  actor_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  raw_response TEXT NOT NULL,
  parsed_decision TEXT NOT NULL,
  model_id TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  tokens_input INTEGER,
  tokens_output INTEGER,
  duration_ms INTEGER,
  FOREIGN KEY (run_id) REFERENCES run_manifest(id)
);

CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  round_num INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  actor_states TEXT NOT NULL,
  narrative_states TEXT NOT NULL,
  rng_state TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES run_manifest(id)
);

-- ═══════════════════════════════════════
-- INDICES
-- ═══════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_decision_cache_lookup ON decision_cache(request_hash, model_id, prompt_version);
CREATE INDEX IF NOT EXISTS idx_posts_run_round ON posts(run_id, round_num);
CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author_id, run_id);
CREATE INDEX IF NOT EXISTS idx_telemetry_run_round ON telemetry(run_id, round_num);
CREATE INDEX IF NOT EXISTS idx_telemetry_actor ON telemetry(actor_id, run_id);
CREATE INDEX IF NOT EXISTS idx_exposures_run_round ON exposures(run_id, round_num);
CREATE INDEX IF NOT EXISTS idx_narratives_run_topic ON narratives(run_id, topic);
CREATE INDEX IF NOT EXISTS idx_actors_run ON actors(run_id);
CREATE INDEX IF NOT EXISTS idx_entity_aliases_alias ON entity_aliases(alias);
CREATE INDEX IF NOT EXISTS idx_entity_merges_merged ON entity_merges(merged_entity_id);
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
CREATE INDEX IF NOT EXISTS idx_claims_chunk ON claims(source_chunk_id);
CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(document_id);
CREATE INDEX IF NOT EXISTS idx_actor_topics_topic ON actor_topics(topic);
CREATE INDEX IF NOT EXISTS idx_post_topics_topic ON post_topics(topic);
CREATE INDEX IF NOT EXISTS idx_actor_beliefs_topic ON actor_beliefs(topic);
`;
