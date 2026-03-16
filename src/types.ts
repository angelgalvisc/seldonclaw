/**
 * types.ts — Domain types: rows, snapshots, DTOs
 *
 * Pure type declarations. No runtime code. No imports.
 * GraphStore interface lives in store.ts (storage boundary).
 */

// ═══════════════════════════════════════════════════════
// FIRST-CLASS CONCEPTS — from PLAN.md §First-Class Concepts
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
  post_kind?: "post" | "comment" | "repost" | "quote";
  round_num: number;
  sim_timestamp: string;
  likes: number;
  reposts: number;
  comments: number;
  reach: number;
  sentiment?: number | null;
  is_deleted?: number;
  deleted_at?: string | null;
  moderation_status?: "none" | "flagged" | "shadowed";
}

export interface Exposure {
  actor_id: string;
  post_id: string;
  round_num: number;
  run_id: string;
  reaction: "seen" | "liked" | "commented" | "reposted";
}

export interface ActorPostSnapshot {
  id: string;
  run_id: string;
  author_id: string;
  content: string;
  reply_to?: string | null;
  quote_of?: string | null;
  post_kind?: Post["post_kind"];
  round_num: number;
  sim_timestamp: string;
  likes: number;
  reposts: number;
  comments: number;
  reach: number;
  sentiment?: number | null;
  is_deleted?: number;
  deleted_at?: string | null;
  moderation_status?: Post["moderation_status"];
  topics: string[];
}

export interface ActorExposureSnapshot {
  actor_id: string;
  post_id: string;
  round_num: number;
  run_id: string;
  reaction: Exposure["reaction"];
  post_author_id: string;
  post_content: string;
  post_topics: string[];
  post_kind: Post["post_kind"];
  post_sentiment?: number | null;
  post_sim_timestamp: string;
}

export interface Follow {
  follower_id: string;
  following_id: string;
  run_id: string;
  since_round?: number;
}

export interface Mute {
  actor_id: string;
  muted_actor_id: string;
  run_id: string;
  since_round?: number;
}

export interface Block {
  actor_id: string;
  blocked_actor_id: string;
  run_id: string;
  since_round?: number;
}

export interface ReportRow {
  id: string;
  run_id: string;
  round_num: number;
  reporter_id: string;
  post_id: string;
  reason?: string | null;
  created_at?: string;
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

export interface ActorMemoryRow {
  id: string;
  run_id: string;
  actor_id: string;
  round_num: number;
  kind: "reflection" | "interaction" | "narrative" | "event";
  summary: string;
  salience: number;
  topic?: string | null;
  source_post_id?: string | null;
  source_actor_id?: string | null;
  created_at?: string;
}

export interface PostEmbeddingRow {
  post_id: string;
  model_id: string;
  vector: string;
  content_hash: string;
  created_at?: string;
}

export interface ActorInterestEmbeddingRow {
  actor_id: string;
  model_id: string;
  vector: string;
  profile_hash: string;
  created_at?: string;
}

export interface SearchCacheRow {
  id: string;
  query: string;
  cutoff_date: string;
  language?: string | null;
  categories?: string | null;
  results: string;
  fetched_at?: string;
  run_id?: string | null;
}

export interface DecisionCacheRow {
  id: string;
  run_id: string;
  round_num: number;
  actor_id: string;
  request_hash: string;
  raw_response: string;
  parsed_decision: string;
  model_id: string;
  prompt_version: string;
  tokens_input?: number | null;
  tokens_output?: number | null;
  duration_ms?: number | null;
}

export interface SearchRequestRow {
  id: string;
  run_id: string;
  round_num: number;
  actor_id: string;
  query: string;
  cutoff_date: string;
  language?: string | null;
  categories?: string | null;
  cache_hit: number;
  result_count: number;
  created_at?: string;
}

export interface SkippedRoundSpanRow {
  id: string;
  run_id: string;
  from_round: number;
  to_round: number;
  sim_time_start: string;
  sim_time_end: string;
  reason: string;
  novelty_score: number;
  pending_events: number;
  created_at?: string;
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
  quoteOf?: string;
  postKind?: "post" | "comment" | "repost" | "quote";
  isDeleted?: boolean;
  moderationStatus?: "none" | "flagged" | "shadowed";
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

export interface ActorInteractionTrace {
  engagedPostIds: Set<string>;
  authorScores: Map<string, number>;
  topicScores: Map<string, number>;
  inNetworkScore: number;
  outOfNetworkScore: number;
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
  exposedActors: Map<string, Set<string>>; // postId → actorIds already exposed
  muteGraph?: Map<string, Set<string>>;
  blockGraph?: Map<string, Set<string>>;
  interactionTrace?: Map<string, ActorInteractionTrace>;
  postEmbeddings?: Map<string, number[]>;
  actorInterestEmbeddings?: Map<string, number[]>;
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
  actorArchetype?: string;
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
  recentMemories: Array<{
    kind: string;
    summary: string;
    salience: number;
    round_num: number;
    topic?: string | null;
  }>;
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
