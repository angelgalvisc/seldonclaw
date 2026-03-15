/**
 * db.ts — SQLite schema, migrations, GraphStore interface + SQLiteGraphStore
 *
 * Source of truth: PLAN.md §SQLite Schema (lines 141-577),
 *                  §GraphStore interface (lines 770-803),
 *                  §PlatformState (lines 670-725)
 *
 * Single file: simulation.db
 * Policy: UUIDs v4 globally unique. Derived tables carry run_id FK.
 *         Static graph tables shared across runs.
 */

import Database from "better-sqlite3";
import { randomUUID, createHash } from "node:crypto";

// ═══════════════════════════════════════════════════════
// TYPE DEFINITIONS — from PLAN.md §First-Class Concepts
// ═══════════════════════════════════════════════════════

/** ActorSpec — portable agent contract (exportable via CKP) */
export interface ActorSpec {
  id: string;
  archetype: "persona" | "organization" | "media" | "institution";
  name: string;
  handle: string;
  personality: string;
  bio: string;
  age?: number;
  gender?: string;
  profession?: string;
  region?: string;
  language: string;
  cognition_tier: "A" | "B" | "C";
  tools: string[];
  policies: PolicyRule[];
  provider_hints: ProviderHint;
}

/** ActorState — live simulation state (not CKP, SeldonClaw-specific) */
export interface ActorState {
  actor_id: string;
  beliefs: Map<string, number>;
  stance: string;
  sentiment_bias: number;
  activity_level: number;
  influence_weight: number;
  community_id: string;
  active_hours: number[];
  topics: string[];
  follower_count: number;
  following_count: number;
}

export interface PolicyRule {
  id: string;
  action: string;
  scope: string;
  match: Record<string, string>;
  conditions: Record<string, number>;
}

export interface ProviderHint {
  protocol?: string;
  endpoint?: string;
  model?: string;
  tokens_per_request?: number;
}

// ─── Provenance types ───

export interface DocumentRecord {
  id: string;
  filename: string;
  content_hash: string;
  mime_type?: string;
  ingested_at?: string;
  metadata?: string; // JSON
}

export interface Chunk {
  id: string;
  document_id: string;
  chunk_index: number;
  content: string;
  token_count?: number;
}

export interface Claim {
  id: string;
  source_chunk_id: string;
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
  valid_from?: string;
  valid_to?: string;
  observed_at: string;
  topics?: string; // JSON array
}

// ─── Graph types ───

export interface EntityType {
  name: string;
  description?: string;
  attributes?: string; // JSON array
}

export interface EdgeType {
  name: string;
  description?: string;
  source_type?: string;
  target_type?: string;
}

export interface Entity {
  id: string;
  type: string;
  name: string;
  attributes?: string; // JSON object
  merged_into?: string | null; // NULL = active, non-NULL = absorbed into this entity
}

export interface RawEntity {
  name: string;
  type: string;
  attributes?: Record<string, unknown>;
  source_claim_ids?: string[];
}

export interface Edge {
  id: string;
  type: string;
  source_id: string;
  target_id: string;
  attributes?: string;
  confidence: number;
  valid_from?: string;
  valid_to?: string;
}

export interface MergeCandidate {
  entityA: Entity;
  entityB: Entity;
  confidence: number;
  reason: string;
  reason_detail?: string;
}

export interface MergeRecord {
  id: string;
  kept_entity_id: string;
  merged_entity_id: string;
  confidence: number;
  merge_reason: string;
  merge_reason_detail?: string;
  merged_at: string;
  reversed: boolean;
}

// ─── Actor types (DB row) ───

export interface ActorRow {
  id: string;
  run_id: string;
  entity_id: string | null;
  archetype: string;
  cognition_tier: string;
  name: string;
  handle: string | null;
  personality: string;
  bio: string | null;
  age: number | null;
  gender: string | null;
  profession: string | null;
  region: string | null;
  language: string;
  stance: string;
  sentiment_bias: number;
  activity_level: number;
  influence_weight: number;
  community_id: string | null;
  active_hours: string | null; // JSON array
  follower_count: number;
  following_count: number;
}

// ─── Platform types ───

export interface Post {
  id: string;
  run_id: string;
  author_id: string;
  content: string;
  reply_to?: string | null;
  quote_of?: string | null;
  round_num: number;
  sim_timestamp: string;
  likes: number;
  reposts: number;
  comments: number;
  reach: number;
  sentiment?: number | null;
}

export interface Exposure {
  actor_id: string;
  post_id: string;
  round_num: number;
  run_id: string;
  reaction: "seen" | "liked" | "commented" | "reposted";
}

export interface Follow {
  follower_id: string;
  following_id: string;
  run_id: string;
  since_round?: number;
}

export interface NarrativeRow {
  id: string;
  run_id: string;
  topic: string;
  first_round: number | null;
  peak_round: number | null;
  current_intensity: number;
  total_posts: number;
  dominant_sentiment: number;
}

// ─── PlatformState projections (PLAN.md §PlatformState) ───

export interface PostSnapshot {
  id: string;
  authorId: string;
  content: string;
  roundNum: number;
  simTimestamp: string;
  topics: string[];
  sentiment: number;
  likes: number;
  reposts: number;
  comments: number;
  reach: number;
  replyTo?: string;
}

export interface ActorSnapshot {
  id: string;
  communityId: string;
  influenceWeight: number;
  stance: string;
  sentimentBias: number;
}

export interface CommunitySnapshot {
  id: string;
  cohesion: number;
  memberIds: string[];
  overlaps: Map<string, number>;
}

export interface EngagementStats {
  likes: number;
  reposts: number;
  comments: number;
  reach: number;
}

export interface StanceChange {
  actorId: string;
  actorName: string;
  previousStance: string;
  newStance: string;
  round: number;
}

export interface PlatformState {
  runId: string;
  recentPosts: PostSnapshot[];
  followGraph: Map<string, string[]>;
  engagementByPost: Map<string, EngagementStats>;
  actors: Map<string, ActorSnapshot>;
  communities: CommunitySnapshot[];
}

// ─── Provenance chain ───

export interface ProvenanceChain {
  entity: Entity;
  claims: Claim[];
  chunks: Chunk[];
  documents: DocumentRecord[];
}

// ─── Narrative state (in-memory projection) ───

export interface NarrativeState {
  topic: string;
  firstRound: number;
  peakRound: number;
  currentIntensity: number;
  totalPosts: number;
  dominantSentiment: number;
}

// ─── Round context types ───

export interface SimEvent {
  type: "initial_post" | "scheduled" | "threshold_trigger";
  round: number;
  actor_id?: string;
  content: string;
  topics: string[];
}

export interface PRNG {
  next(): number;
  state(): string;
}

export interface RoundContext {
  runId: string;
  roundNum: number;
  simTimestamp: string;
  simHour: number;
  activeEvents: SimEvent[];
  rng: PRNG;
}

// ─── Feed types ───

export interface FeedConfig {
  size: number;
  recencyWeight: number;
  popularityWeight: number;
  relevanceWeight: number;
  echoChamberStrength: number;
}

export interface FeedItem {
  post: PostSnapshot;
  score: number;
  source: "follow" | "trending" | "community" | "algorithm";
}

// ─── Actor context for cognition ───

export interface ActorContext {
  actor: ActorRow;
  beliefs: Array<{ topic: string; sentiment: number }>;
  topics: Array<{ topic: string; weight: number }>;
  recentPosts: Post[];
  recentExposures: Array<{ post_id: string; reaction: string }>;
}

// ─── Run manifest ───

export interface RunManifest {
  id: string;
  started_at: string;
  finished_at?: string;
  seed: number;
  config_snapshot: string; // JSON, sanitized
  hypothesis?: string;
  docs_hash?: string;
  graph_revision_id: string;
  total_rounds?: number;
  status: "running" | "completed" | "failed" | "paused";
  resumed_from?: string;
  version?: string;
}

// ═══════════════════════════════════════════════════════
// SQLite SCHEMA — from PLAN.md §SQLite Schema (verbatim)
// ═══════════════════════════════════════════════════════

const SCHEMA_SQL = `
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

// ═══════════════════════════════════════════════════════
// GraphStore INTERFACE — from PLAN.md §GraphStore
// ═══════════════════════════════════════════════════════

export interface GraphStore {
  // Provenance
  addDocument(doc: DocumentRecord): string;
  addChunk(chunk: Chunk): string;
  addClaim(claim: Claim): string;

  // Ontology
  addEntityType(et: EntityType): void;
  addEdgeType(et: EdgeType): void;

  // Entity resolution
  addEntity(entity: Entity): string;
  addEdge(edge: Edge): string;
  resolveEntities(candidates: RawEntity[]): Entity[];
  linkClaimToEntity(entityId: string, claimId: string): void;
  linkClaimToEdge(edgeId: string, claimId: string): void;

  // Aliases + Merges
  addAlias(entityId: string, alias: string, source: string): void;
  mergeEntities(
    keptId: string,
    mergedId: string,
    confidence: number,
    reason: string,
    detail?: string
  ): string;

  // Bulk queries (engine.ts)
  getActorTopicsByRun(runId: string): Map<string, string[]>;
  getActorBeliefsByRun(runId: string): Map<string, Record<string, number>>;

  // Queries
  queryActorContext(actorId: string, runId: string): ActorContext;
  queryNarrativeState(topic: string, runId: string): NarrativeState | null;
  queryProvenance(entityId: string): ProvenanceChain;

  // Actors
  addActor(actor: ActorRow): string;
  getActor(actorId: string): ActorRow | null;
  getActorsByRun(runId: string): ActorRow[];
  updateActorStance(actorId: string, stance: string): void;
  updateActorCommunity(actorId: string, communityId: string): void;
  addActorTopic(actorId: string, topic: string, weight: number): void;
  addActorBelief(
    actorId: string,
    topic: string,
    sentiment: number,
    round?: number
  ): void;

  // Communities
  addCommunity(id: string, runId: string, name: string, description?: string, cohesion?: number): void;
  addCommunityOverlap(communityA: string, communityB: string, runId: string, weight: number): void;

  // Platform state
  addPost(post: Post): void;
  addExposure(exposure: Exposure): void;
  addFollow(follow: Follow): void;
  updatePostEngagement(
    postId: string,
    field: "likes" | "reposts" | "comments" | "reach",
    increment: number
  ): void;
  addPostTopic(postId: string, topic: string): void;

  // Interaction history (for buildSimContext in cognition.ts)
  getRecentPostsByActor(
    actorId: string,
    runId: string,
    sinceRound: number
  ): Post[];
  getEngagementOnPosts(
    postIds: string[],
    runId: string
  ): Map<string, EngagementStats>;
  getMentions(
    actorId: string,
    runId: string,
    sinceRound: number
  ): Post[];
  getFollowedStanceChanges(
    actorId: string,
    runId: string,
    roundNum: number
  ): StanceChange[];

  // Platform state projection (for engine.ts → PlatformState)
  buildPlatformState(
    runId: string,
    roundNum: number,
    lookbackRounds: number
  ): PlatformState;

  // Narratives
  addNarrative(narrative: NarrativeRow): void;
  updateNarrative(id: string, updates: Partial<NarrativeRow>): void;
  getNarrativesByRun(runId: string): NarrativeRow[];

  // Run manifest
  createRun(manifest: RunManifest): string;
  updateRun(id: string, updates: Partial<RunManifest>): void;
  getRun(id: string): RunManifest | null;

  // Decision cache
  cacheDecision(entry: {
    id: string;
    run_id: string;
    round_num: number;
    actor_id: string;
    request_hash: string;
    raw_response: string;
    parsed_decision: string;
    model_id: string;
    prompt_version: string;
    tokens_input?: number;
    tokens_output?: number;
    duration_ms?: number;
  }): void;
  lookupDecision(
    requestHash: string,
    modelId: string,
    promptVersion: string
  ): { raw_response: string; parsed_decision: string } | null;

  // Snapshots
  saveSnapshot(snapshot: {
    id: string;
    run_id: string;
    round_num: number;
    actor_states: string;
    narrative_states: string;
    rng_state: string;
  }): void;
  getLatestSnapshot(
    runId: string
  ): { round_num: number; actor_states: string; narrative_states: string; rng_state: string } | null;

  // Telemetry
  logTelemetry(entry: {
    run_id: string;
    round_num: number;
    actor_id?: string;
    cognition_tier?: string;
    action_type: string;
    action_detail?: string;
    tokens_input?: number;
    tokens_output?: number;
    cost_usd?: number;
    duration_ms?: number;
    provider?: string;
  }): void;

  // Rounds
  upsertRound(round: {
    num: number;
    run_id: string;
    sim_time?: string;
    active_actors?: number;
    total_posts?: number;
    total_actions?: number;
    tier_a_calls?: number;
    tier_b_calls?: number;
    tier_c_actions?: number;
    avg_sentiment?: number;
    trending_topics?: string;
    events?: string;
    wall_time_ms?: number;
  }): void;

  // Graph revision
  computeGraphRevisionId(): string;

  // FTS
  searchEntities(query: string, limit?: number): Entity[];

  // Provenance queries (for ingest dedup + downstream)
  getDocumentByHash(contentHash: string): DocumentRecord | null;
  getChunksByDocument(documentId: string): Chunk[];
  getAllDocuments(): DocumentRecord[];

  // Graph queries (for graph.ts)
  getClaimsByChunk(chunkId: string): Claim[];
  getEntityTypes(): EntityType[];
  getEdgeTypes(): EdgeType[];
  getAllActiveEntities(): Entity[];

  // Utility
  close(): void;
}

// ═══════════════════════════════════════════════════════
// SQLiteGraphStore IMPLEMENTATION
// ═══════════════════════════════════════════════════════

export class SQLiteGraphStore implements GraphStore {
  readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);

    // Operational PRAGMAs — PLAN.md §SQLite Schema
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");

    // Initialize schema
    this.db.exec(SCHEMA_SQL);
  }

  // ─── Provenance ───

  addDocument(doc: DocumentRecord): string {
    const id = doc.id || randomUUID();
    this.db
      .prepare(
        `INSERT INTO documents (id, filename, content_hash, mime_type, metadata)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(id, doc.filename, doc.content_hash, doc.mime_type ?? null, doc.metadata ?? null);
    return id;
  }

  addChunk(chunk: Chunk): string {
    const id = chunk.id || randomUUID();
    this.db
      .prepare(
        `INSERT INTO chunks (id, document_id, chunk_index, content, token_count)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(id, chunk.document_id, chunk.chunk_index, chunk.content, chunk.token_count ?? null);
    return id;
  }

  addClaim(claim: Claim): string {
    const id = claim.id || randomUUID();
    this.db
      .prepare(
        `INSERT INTO claims (id, source_chunk_id, subject, predicate, object, confidence, valid_from, valid_to, observed_at, topics)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        claim.source_chunk_id,
        claim.subject,
        claim.predicate,
        claim.object,
        claim.confidence,
        claim.valid_from ?? null,
        claim.valid_to ?? null,
        claim.observed_at,
        claim.topics ?? null
      );
    return id;
  }

  // ─── Ontology ───

  addEntityType(et: EntityType): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO entity_types (name, description, attributes) VALUES (?, ?, ?)`
      )
      .run(et.name, et.description ?? null, et.attributes ?? null);
  }

  addEdgeType(et: EdgeType): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO edge_types (name, description, source_type, target_type) VALUES (?, ?, ?, ?)`
      )
      .run(et.name, et.description ?? null, et.source_type ?? null, et.target_type ?? null);
  }

  // ─── Graph ───

  addEntity(entity: Entity): string {
    const id = entity.id || randomUUID();
    this.db
      .prepare(
        `INSERT INTO entities (id, type, name, attributes) VALUES (?, ?, ?, ?)`
      )
      .run(id, entity.type, entity.name, entity.attributes ?? null);

    // Sync FTS5
    this.db
      .prepare(
        `INSERT INTO entities_fts (rowid, name, attributes)
         VALUES ((SELECT rowid FROM entities WHERE id = ?), ?, ?)`
      )
      .run(id, entity.name, entity.attributes ?? "");

    return id;
  }

  addEdge(edge: Edge): string {
    const id = edge.id || randomUUID();
    this.db
      .prepare(
        `INSERT INTO edges (id, type, source_id, target_id, attributes, confidence, valid_from, valid_to)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        edge.type,
        edge.source_id,
        edge.target_id,
        edge.attributes ?? null,
        edge.confidence,
        edge.valid_from ?? null,
        edge.valid_to ?? null
      );
    return id;
  }

  resolveEntities(candidates: RawEntity[]): Entity[] {
    // Stub — real implementation in graph.ts (EntityResolver)
    // This method is the integration point; graph.ts calls addEntity + merge
    const entities: Entity[] = [];
    for (const c of candidates) {
      const id = randomUUID();
      const entity: Entity = {
        id,
        type: c.type,
        name: c.name,
        attributes: c.attributes ? JSON.stringify(c.attributes) : undefined,
      };
      this.addEntity(entity);
      entities.push(entity);
    }
    return entities;
  }

  linkClaimToEntity(entityId: string, claimId: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO entity_claims (entity_id, claim_id) VALUES (?, ?)`
      )
      .run(entityId, claimId);
  }

  linkClaimToEdge(edgeId: string, claimId: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO edge_claims (edge_id, claim_id) VALUES (?, ?)`
      )
      .run(edgeId, claimId);
  }

  // ─── Aliases + Merges ───

  addAlias(entityId: string, alias: string, source: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO entity_aliases (entity_id, alias, source) VALUES (?, ?, ?)`
      )
      .run(entityId, alias, source);
  }

  mergeEntities(
    keptId: string,
    mergedId: string,
    confidence: number,
    reason: string,
    detail?: string
  ): string {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO entity_merges (id, kept_entity_id, merged_entity_id, confidence, merge_reason, merge_reason_detail)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(id, keptId, mergedId, confidence, reason, detail ?? null);

    // Transfer edges from merged to kept
    this.db
      .prepare(`UPDATE edges SET source_id = ? WHERE source_id = ?`)
      .run(keptId, mergedId);
    this.db
      .prepare(`UPDATE edges SET target_id = ? WHERE target_id = ?`)
      .run(keptId, mergedId);

    // Transfer claims
    this.db
      .prepare(
        `INSERT OR IGNORE INTO entity_claims (entity_id, claim_id)
         SELECT ?, claim_id FROM entity_claims WHERE entity_id = ?`
      )
      .run(keptId, mergedId);

    // Transfer aliases
    const mergedName = this.db
      .prepare(`SELECT name FROM entities WHERE id = ?`)
      .get(mergedId) as { name: string } | undefined;
    if (mergedName) {
      this.addAlias(keptId, mergedName.name, "merge");
    }

    // Mark absorbed entity — not deleted, but excluded from active queries
    this.db
      .prepare(`UPDATE entities SET merged_into = ? WHERE id = ?`)
      .run(keptId, mergedId);

    // Remove absorbed entity from FTS index
    const mergedRowid = this.db
      .prepare(`SELECT rowid FROM entities WHERE id = ?`)
      .get(mergedId) as { rowid: number } | undefined;
    if (mergedRowid) {
      this.db
        .prepare(`DELETE FROM entities_fts WHERE rowid = ?`)
        .run(mergedRowid.rowid);
    }

    return id;
  }

  // ─── Bulk queries (engine.ts) ───

  getActorTopicsByRun(runId: string): Map<string, string[]> {
    const rows = this.db
      .prepare(
        `SELECT at.actor_id, at.topic FROM actor_topics at
         JOIN actors a ON a.id = at.actor_id
         WHERE a.run_id = ?`
      )
      .all(runId) as Array<{ actor_id: string; topic: string }>;

    const result = new Map<string, string[]>();
    for (const row of rows) {
      const topics = result.get(row.actor_id) ?? [];
      topics.push(row.topic);
      result.set(row.actor_id, topics);
    }
    return result;
  }

  getActorBeliefsByRun(runId: string): Map<string, Record<string, number>> {
    const rows = this.db
      .prepare(
        `SELECT ab.actor_id, ab.topic, ab.sentiment FROM actor_beliefs ab
         JOIN actors a ON a.id = ab.actor_id
         WHERE a.run_id = ?`
      )
      .all(runId) as Array<{ actor_id: string; topic: string; sentiment: number }>;

    const result = new Map<string, Record<string, number>>();
    for (const row of rows) {
      const beliefs = result.get(row.actor_id) ?? {};
      beliefs[row.topic] = row.sentiment;
      result.set(row.actor_id, beliefs);
    }
    return result;
  }

  // ─── Queries ───

  queryActorContext(actorId: string, runId: string): ActorContext {
    const actor = this.db
      .prepare(`SELECT * FROM actors WHERE id = ?`)
      .get(actorId) as ActorRow;

    const beliefs = this.db
      .prepare(`SELECT topic, sentiment FROM actor_beliefs WHERE actor_id = ?`)
      .all(actorId) as Array<{ topic: string; sentiment: number }>;

    const topics = this.db
      .prepare(`SELECT topic, weight FROM actor_topics WHERE actor_id = ?`)
      .all(actorId) as Array<{ topic: string; weight: number }>;

    const recentPosts = this.db
      .prepare(
        `SELECT * FROM posts WHERE author_id = ? AND run_id = ? ORDER BY round_num DESC LIMIT 10`
      )
      .all(actorId, runId) as Post[];

    const recentExposures = this.db
      .prepare(
        `SELECT post_id, reaction FROM exposures
         WHERE actor_id = ? AND run_id = ?
         ORDER BY round_num DESC LIMIT 20`
      )
      .all(actorId, runId) as Array<{ post_id: string; reaction: string }>;

    return { actor, beliefs, topics, recentPosts, recentExposures };
  }

  queryNarrativeState(topic: string, runId: string): NarrativeState | null {
    const row = this.db
      .prepare(
        `SELECT * FROM narratives WHERE topic = ? AND run_id = ?`
      )
      .get(topic, runId) as NarrativeRow | undefined;

    if (!row) return null;

    return {
      topic: row.topic,
      firstRound: row.first_round ?? 0,
      peakRound: row.peak_round ?? 0,
      currentIntensity: row.current_intensity,
      totalPosts: row.total_posts,
      dominantSentiment: row.dominant_sentiment,
    };
  }

  queryProvenance(entityId: string): ProvenanceChain {
    const entity = this.db
      .prepare(`SELECT * FROM entities WHERE id = ?`)
      .get(entityId) as Entity;

    const claims = this.db
      .prepare(
        `SELECT c.* FROM claims c
         JOIN entity_claims ec ON ec.claim_id = c.id
         WHERE ec.entity_id = ?`
      )
      .all(entityId) as Claim[];

    const chunkIds = [...new Set(claims.map((c) => c.source_chunk_id))];
    const chunks: Chunk[] = [];
    const docIds = new Set<string>();

    for (const chunkId of chunkIds) {
      const chunk = this.db
        .prepare(`SELECT * FROM chunks WHERE id = ?`)
        .get(chunkId) as Chunk | undefined;
      if (chunk) {
        chunks.push(chunk);
        docIds.add(chunk.document_id);
      }
    }

    const documents: DocumentRecord[] = [];
    for (const docId of docIds) {
      const doc = this.db
        .prepare(`SELECT * FROM documents WHERE id = ?`)
        .get(docId) as DocumentRecord | undefined;
      if (doc) documents.push(doc);
    }

    return { entity, claims, chunks, documents };
  }

  // ─── Actors ───

  addActor(actor: ActorRow): string {
    const id = actor.id || randomUUID();
    this.db
      .prepare(
        `INSERT INTO actors (id, run_id, entity_id, archetype, cognition_tier, name, handle,
         personality, bio, age, gender, profession, region, language, stance, sentiment_bias,
         activity_level, influence_weight, community_id, active_hours, follower_count, following_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id, actor.run_id, actor.entity_id, actor.archetype, actor.cognition_tier,
        actor.name, actor.handle, actor.personality, actor.bio, actor.age,
        actor.gender, actor.profession, actor.region, actor.language, actor.stance,
        actor.sentiment_bias, actor.activity_level, actor.influence_weight,
        actor.community_id, actor.active_hours, actor.follower_count, actor.following_count
      );
    return id;
  }

  getActor(actorId: string): ActorRow | null {
    return (
      (this.db.prepare(`SELECT * FROM actors WHERE id = ?`).get(actorId) as ActorRow | undefined) ??
      null
    );
  }

  getActorsByRun(runId: string): ActorRow[] {
    return this.db
      .prepare(`SELECT * FROM actors WHERE run_id = ?`)
      .all(runId) as ActorRow[];
  }

  updateActorStance(actorId: string, stance: string): void {
    this.db
      .prepare(`UPDATE actors SET stance = ? WHERE id = ?`)
      .run(stance, actorId);
  }

  updateActorCommunity(actorId: string, communityId: string): void {
    this.db
      .prepare(`UPDATE actors SET community_id = ? WHERE id = ?`)
      .run(communityId, actorId);
  }

  addActorTopic(actorId: string, topic: string, weight: number): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO actor_topics (actor_id, topic, weight) VALUES (?, ?, ?)`
      )
      .run(actorId, topic, weight);
  }

  addActorBelief(
    actorId: string,
    topic: string,
    sentiment: number,
    round?: number
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO actor_beliefs (actor_id, topic, sentiment, round_updated) VALUES (?, ?, ?, ?)`
      )
      .run(actorId, topic, sentiment, round ?? null);
  }

  // ─── Communities ───

  addCommunity(
    id: string,
    runId: string,
    name: string,
    description?: string,
    cohesion?: number
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO communities (id, run_id, name, description, cohesion) VALUES (?, ?, ?, ?, ?)`
      )
      .run(id, runId, name, description ?? null, cohesion ?? 0.5);
  }

  addCommunityOverlap(communityA: string, communityB: string, runId: string, weight: number): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO community_overlap (community_a, community_b, run_id, weight) VALUES (?, ?, ?, ?)`
      )
      .run(communityA, communityB, runId, weight);
  }

  // ─── Platform state ───

  addPost(post: Post): void {
    this.db
      .prepare(
        `INSERT INTO posts (id, run_id, author_id, content, reply_to, quote_of, round_num,
         sim_timestamp, likes, reposts, comments, reach, sentiment)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        post.id, post.run_id, post.author_id, post.content,
        post.reply_to ?? null, post.quote_of ?? null, post.round_num,
        post.sim_timestamp, post.likes, post.reposts, post.comments,
        post.reach, post.sentiment ?? null
      );
  }

  addExposure(exposure: Exposure): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO exposures (actor_id, post_id, round_num, run_id, reaction)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        exposure.actor_id,
        exposure.post_id,
        exposure.round_num,
        exposure.run_id,
        exposure.reaction
      );
  }

  addFollow(follow: Follow): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO follows (follower_id, following_id, run_id, since_round)
         VALUES (?, ?, ?, ?)`
      )
      .run(
        follow.follower_id,
        follow.following_id,
        follow.run_id,
        follow.since_round ?? null
      );
  }

  updatePostEngagement(
    postId: string,
    field: "likes" | "reposts" | "comments" | "reach",
    increment: number
  ): void {
    // Safely parameterize field name (whitelist only)
    const allowed = ["likes", "reposts", "comments", "reach"];
    if (!allowed.includes(field)) throw new Error(`Invalid field: ${field}`);
    this.db
      .prepare(`UPDATE posts SET ${field} = ${field} + ? WHERE id = ?`)
      .run(increment, postId);
  }

  addPostTopic(postId: string, topic: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO post_topics (post_id, topic) VALUES (?, ?)`
      )
      .run(postId, topic);
  }

  // ─── Interaction history (cognition.ts) ───

  getRecentPostsByActor(
    actorId: string,
    runId: string,
    sinceRound: number
  ): Post[] {
    return this.db
      .prepare(
        `SELECT * FROM posts
         WHERE author_id = ? AND run_id = ? AND round_num >= ?
         ORDER BY round_num DESC`
      )
      .all(actorId, runId, sinceRound) as Post[];
  }

  getEngagementOnPosts(
    postIds: string[],
    runId: string
  ): Map<string, EngagementStats> {
    const result = new Map<string, EngagementStats>();
    if (postIds.length === 0) return result;

    const placeholders = postIds.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT id, likes, reposts, comments, reach FROM posts
         WHERE id IN (${placeholders}) AND run_id = ?`
      )
      .all(...postIds, runId) as Array<{
      id: string;
      likes: number;
      reposts: number;
      comments: number;
      reach: number;
    }>;

    for (const row of rows) {
      result.set(row.id, {
        likes: row.likes,
        reposts: row.reposts,
        comments: row.comments,
        reach: row.reach,
      });
    }
    return result;
  }

  getMentions(
    actorId: string,
    runId: string,
    sinceRound: number
  ): Post[] {
    return this.db
      .prepare(
        `SELECT * FROM posts
         WHERE run_id = ? AND round_num >= ?
         AND (reply_to IN (SELECT id FROM posts WHERE author_id = ?)
              OR content LIKE '%@' || (SELECT handle FROM actors WHERE id = ?) || '%')
         ORDER BY round_num DESC`
      )
      .all(runId, sinceRound, actorId, actorId) as Post[];
  }

  getFollowedStanceChanges(
    actorId: string,
    runId: string,
    roundNum: number
  ): StanceChange[] {
    // Look for actors that this actor follows whose stance changed recently
    // We track stance in actors table; telemetry records stance changes
    return this.db
      .prepare(
        `SELECT t.actor_id as actorId, a.name as actorName,
                json_extract(t.action_detail, '$.previous_stance') as previousStance,
                json_extract(t.action_detail, '$.new_stance') as newStance,
                t.round_num as round
         FROM telemetry t
         JOIN actors a ON a.id = t.actor_id
         JOIN follows f ON f.following_id = t.actor_id AND f.follower_id = ?
         WHERE t.run_id = ? AND t.round_num = ?
         AND t.action_type = 'stance_change'
         AND f.run_id = ?`
      )
      .all(actorId, runId, roundNum, runId) as StanceChange[];
  }

  // ─── Platform state projection ───

  buildPlatformState(
    runId: string,
    roundNum: number,
    lookbackRounds: number
  ): PlatformState {
    const sinceRound = Math.max(0, roundNum - lookbackRounds);

    // Recent posts with topics denormalized
    const rawPosts = this.db
      .prepare(
        `SELECT * FROM posts WHERE run_id = ? AND round_num >= ? ORDER BY round_num DESC`
      )
      .all(runId, sinceRound) as Post[];

    const recentPosts: PostSnapshot[] = rawPosts.map((p) => {
      const topics = this.db
        .prepare(`SELECT topic FROM post_topics WHERE post_id = ?`)
        .all(p.id) as Array<{ topic: string }>;
      return {
        id: p.id,
        authorId: p.author_id,
        content: p.content,
        roundNum: p.round_num,
        simTimestamp: p.sim_timestamp,
        topics: topics.map((t) => t.topic),
        sentiment: p.sentiment ?? 0,
        likes: p.likes,
        reposts: p.reposts,
        comments: p.comments,
        reach: p.reach,
        replyTo: p.reply_to ?? undefined,
      };
    });

    // Follow graph
    const followGraph = new Map<string, string[]>();
    const followRows = this.db
      .prepare(`SELECT follower_id, following_id FROM follows WHERE run_id = ?`)
      .all(runId) as Array<{ follower_id: string; following_id: string }>;
    for (const f of followRows) {
      const existing = followGraph.get(f.follower_id) ?? [];
      existing.push(f.following_id);
      followGraph.set(f.follower_id, existing);
    }

    // Engagement by post
    const engagementByPost = new Map<string, EngagementStats>();
    for (const p of rawPosts) {
      engagementByPost.set(p.id, {
        likes: p.likes,
        reposts: p.reposts,
        comments: p.comments,
        reach: p.reach,
      });
    }

    // Actor snapshots
    const actors = new Map<string, ActorSnapshot>();
    const actorRows = this.db
      .prepare(
        `SELECT id, community_id, influence_weight, stance, sentiment_bias
         FROM actors WHERE run_id = ?`
      )
      .all(runId) as Array<{
      id: string;
      community_id: string | null;
      influence_weight: number;
      stance: string;
      sentiment_bias: number;
    }>;
    for (const a of actorRows) {
      actors.set(a.id, {
        id: a.id,
        communityId: a.community_id ?? "",
        influenceWeight: a.influence_weight,
        stance: a.stance,
        sentimentBias: a.sentiment_bias,
      });
    }

    // Communities with overlaps and member lists — scoped by run_id
    const communityRows = this.db
      .prepare(`SELECT * FROM communities WHERE run_id = ?`)
      .all(runId) as Array<{
      id: string;
      name: string;
      description: string | null;
      cohesion: number;
    }>;

    const communities: CommunitySnapshot[] = communityRows.map((c) => {
      const memberIds = actorRows
        .filter((a) => a.community_id === c.id)
        .map((a) => a.id);

      const overlapRows = this.db
        .prepare(
          `SELECT community_b, weight FROM community_overlap WHERE community_a = ? AND run_id = ?
           UNION
           SELECT community_a, weight FROM community_overlap WHERE community_b = ? AND run_id = ?`
        )
        .all(c.id, runId, c.id, runId) as Array<{ community_b: string; weight: number }>;

      const overlaps = new Map<string, number>();
      for (const o of overlapRows) {
        overlaps.set(o.community_b, o.weight);
      }

      return {
        id: c.id,
        cohesion: c.cohesion,
        memberIds,
        overlaps,
      };
    });

    return {
      runId,
      recentPosts,
      followGraph,
      engagementByPost,
      actors,
      communities,
    };
  }

  // ─── Narratives ───

  addNarrative(narrative: NarrativeRow): void {
    this.db
      .prepare(
        `INSERT INTO narratives (id, run_id, topic, first_round, peak_round, current_intensity, total_posts, dominant_sentiment)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        narrative.id,
        narrative.run_id,
        narrative.topic,
        narrative.first_round,
        narrative.peak_round,
        narrative.current_intensity,
        narrative.total_posts,
        narrative.dominant_sentiment
      );
  }

  updateNarrative(id: string, updates: Partial<NarrativeRow>): void {
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of Object.entries(updates)) {
      if (key === "id") continue;
      fields.push(`${key} = ?`);
      values.push(value);
    }
    if (fields.length === 0) return;
    values.push(id);
    this.db
      .prepare(`UPDATE narratives SET ${fields.join(", ")} WHERE id = ?`)
      .run(...values);
  }

  getNarrativesByRun(runId: string): NarrativeRow[] {
    return this.db
      .prepare(`SELECT * FROM narratives WHERE run_id = ?`)
      .all(runId) as NarrativeRow[];
  }

  // ─── Run manifest ───

  createRun(manifest: RunManifest): string {
    this.db
      .prepare(
        `INSERT INTO run_manifest (id, started_at, seed, config_snapshot, hypothesis, docs_hash,
         graph_revision_id, total_rounds, status, resumed_from, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        manifest.id,
        manifest.started_at,
        manifest.seed,
        manifest.config_snapshot,
        manifest.hypothesis ?? null,
        manifest.docs_hash ?? null,
        manifest.graph_revision_id,
        manifest.total_rounds ?? null,
        manifest.status,
        manifest.resumed_from ?? null,
        manifest.version ?? null
      );
    return manifest.id;
  }

  updateRun(id: string, updates: Partial<RunManifest>): void {
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of Object.entries(updates)) {
      if (key === "id") continue;
      fields.push(`${key} = ?`);
      values.push(value);
    }
    if (fields.length === 0) return;
    values.push(id);
    this.db
      .prepare(`UPDATE run_manifest SET ${fields.join(", ")} WHERE id = ?`)
      .run(...values);
  }

  getRun(id: string): RunManifest | null {
    return (
      (this.db
        .prepare(`SELECT * FROM run_manifest WHERE id = ?`)
        .get(id) as RunManifest | undefined) ?? null
    );
  }

  // ─── Decision cache ───

  cacheDecision(entry: {
    id: string;
    run_id: string;
    round_num: number;
    actor_id: string;
    request_hash: string;
    raw_response: string;
    parsed_decision: string;
    model_id: string;
    prompt_version: string;
    tokens_input?: number;
    tokens_output?: number;
    duration_ms?: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO decision_cache (id, run_id, round_num, actor_id, request_hash,
         raw_response, parsed_decision, model_id, prompt_version,
         tokens_input, tokens_output, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        entry.id,
        entry.run_id,
        entry.round_num,
        entry.actor_id,
        entry.request_hash,
        entry.raw_response,
        entry.parsed_decision,
        entry.model_id,
        entry.prompt_version,
        entry.tokens_input ?? null,
        entry.tokens_output ?? null,
        entry.duration_ms ?? null
      );
  }

  lookupDecision(
    requestHash: string,
    modelId: string,
    promptVersion: string
  ): { raw_response: string; parsed_decision: string } | null {
    const row = this.db
      .prepare(
        `SELECT raw_response, parsed_decision FROM decision_cache
         WHERE request_hash = ? AND model_id = ? AND prompt_version = ?
         LIMIT 1`
      )
      .get(requestHash, modelId, promptVersion) as
      | { raw_response: string; parsed_decision: string }
      | undefined;
    return row ?? null;
  }

  // ─── Snapshots ───

  saveSnapshot(snapshot: {
    id: string;
    run_id: string;
    round_num: number;
    actor_states: string;
    narrative_states: string;
    rng_state: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO snapshots (id, run_id, round_num, actor_states, narrative_states, rng_state)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        snapshot.id,
        snapshot.run_id,
        snapshot.round_num,
        snapshot.actor_states,
        snapshot.narrative_states,
        snapshot.rng_state
      );
  }

  getLatestSnapshot(
    runId: string
  ): {
    round_num: number;
    actor_states: string;
    narrative_states: string;
    rng_state: string;
  } | null {
    const row = this.db
      .prepare(
        `SELECT round_num, actor_states, narrative_states, rng_state
         FROM snapshots WHERE run_id = ? ORDER BY round_num DESC LIMIT 1`
      )
      .get(runId) as
      | {
          round_num: number;
          actor_states: string;
          narrative_states: string;
          rng_state: string;
        }
      | undefined;
    return row ?? null;
  }

  // ─── Telemetry ───

  logTelemetry(entry: {
    run_id: string;
    round_num: number;
    actor_id?: string;
    cognition_tier?: string;
    action_type: string;
    action_detail?: string;
    tokens_input?: number;
    tokens_output?: number;
    cost_usd?: number;
    duration_ms?: number;
    provider?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO telemetry (run_id, round_num, actor_id, cognition_tier, action_type,
         action_detail, tokens_input, tokens_output, cost_usd, duration_ms, provider)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        entry.run_id,
        entry.round_num,
        entry.actor_id ?? null,
        entry.cognition_tier ?? null,
        entry.action_type,
        entry.action_detail ?? null,
        entry.tokens_input ?? null,
        entry.tokens_output ?? null,
        entry.cost_usd ?? null,
        entry.duration_ms ?? null,
        entry.provider ?? null
      );
  }

  // ─── Rounds ───

  upsertRound(round: {
    num: number;
    run_id: string;
    sim_time?: string;
    active_actors?: number;
    total_posts?: number;
    total_actions?: number;
    tier_a_calls?: number;
    tier_b_calls?: number;
    tier_c_actions?: number;
    avg_sentiment?: number;
    trending_topics?: string;
    events?: string;
    wall_time_ms?: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO rounds (num, run_id, sim_time, active_actors, total_posts, total_actions,
         tier_a_calls, tier_b_calls, tier_c_actions, avg_sentiment, trending_topics, events, wall_time_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(num, run_id) DO UPDATE SET
           sim_time = COALESCE(excluded.sim_time, sim_time),
           active_actors = COALESCE(excluded.active_actors, active_actors),
           total_posts = COALESCE(excluded.total_posts, total_posts),
           total_actions = COALESCE(excluded.total_actions, total_actions),
           tier_a_calls = COALESCE(excluded.tier_a_calls, tier_a_calls),
           tier_b_calls = COALESCE(excluded.tier_b_calls, tier_b_calls),
           tier_c_actions = COALESCE(excluded.tier_c_actions, tier_c_actions),
           avg_sentiment = COALESCE(excluded.avg_sentiment, avg_sentiment),
           trending_topics = COALESCE(excluded.trending_topics, trending_topics),
           events = COALESCE(excluded.events, events),
           wall_time_ms = COALESCE(excluded.wall_time_ms, wall_time_ms)`
      )
      .run(
        round.num,
        round.run_id,
        round.sim_time ?? null,
        round.active_actors ?? null,
        round.total_posts ?? null,
        round.total_actions ?? null,
        round.tier_a_calls ?? null,
        round.tier_b_calls ?? null,
        round.tier_c_actions ?? null,
        round.avg_sentiment ?? null,
        round.trending_topics ?? null,
        round.events ?? null,
        round.wall_time_ms ?? null
      );
  }

  // ─── Graph revision ───

  computeGraphRevisionId(): string {
    const hash = createHash("sha256");

    // Hash all active entities (exclude absorbed)
    const entities = this.db
      .prepare(`SELECT id, type, name, attributes FROM entities WHERE merged_into IS NULL ORDER BY id`)
      .all() as Entity[];
    hash.update(JSON.stringify(entities));

    // Hash all edges
    const edges = this.db
      .prepare(
        `SELECT id, type, source_id, target_id, attributes FROM edges ORDER BY id`
      )
      .all() as Edge[];
    hash.update(JSON.stringify(edges));

    // Hash all merges (non-reversed)
    const merges = this.db
      .prepare(
        `SELECT kept_entity_id, merged_entity_id, merge_reason FROM entity_merges
         WHERE reversed = 0 ORDER BY id`
      )
      .all();
    hash.update(JSON.stringify(merges));

    return hash.digest("hex");
  }

  // ─── FTS ───

  searchEntities(query: string, limit = 20): Entity[] {
    return this.db
      .prepare(
        `SELECT e.* FROM entities e
         JOIN entities_fts fts ON fts.rowid = e.rowid
         WHERE entities_fts MATCH ?
         AND e.merged_into IS NULL
         LIMIT ?`
      )
      .all(query, limit) as Entity[];
  }

  // ─── Provenance queries ───

  getDocumentByHash(contentHash: string): DocumentRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM documents WHERE content_hash = ?`)
      .get(contentHash) as DocumentRecord | undefined;
    return row ?? null;
  }

  getChunksByDocument(documentId: string): Chunk[] {
    return this.db
      .prepare(
        `SELECT * FROM chunks WHERE document_id = ? ORDER BY chunk_index ASC`
      )
      .all(documentId) as Chunk[];
  }

  getAllDocuments(): DocumentRecord[] {
    return this.db
      .prepare(`SELECT * FROM documents ORDER BY ingested_at ASC`)
      .all() as DocumentRecord[];
  }

  // ─── Graph queries ───

  getClaimsByChunk(chunkId: string): Claim[] {
    return this.db
      .prepare(`SELECT * FROM claims WHERE source_chunk_id = ?`)
      .all(chunkId) as Claim[];
  }

  getEntityTypes(): EntityType[] {
    return this.db
      .prepare(`SELECT * FROM entity_types`)
      .all() as EntityType[];
  }

  getEdgeTypes(): EdgeType[] {
    return this.db
      .prepare(`SELECT * FROM edge_types`)
      .all() as EdgeType[];
  }

  getAllActiveEntities(): Entity[] {
    return this.db
      .prepare(`SELECT * FROM entities WHERE merged_into IS NULL ORDER BY id`)
      .all() as Entity[];
  }

  // ─── Utility ───

  close(): void {
    this.db.close();
  }
}

// ─── Helper: generate UUID ───

export function uuid(): string {
  return randomUUID();
}

/**
 * Generate a deterministic UUID-like ID from input parts.
 * Uses SHA-256 truncated to 32 hex chars (128 bits).
 * Formatted as UUID-like: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
 *
 * This replaces randomUUID() for structural IDs to ensure reproducibility:
 * same inputs → same IDs → same downstream decisions.
 */
export function stableId(...parts: string[]): string {
  const hash = createHash("sha256").update(parts.join("|")).digest("hex");
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join("-");
}
