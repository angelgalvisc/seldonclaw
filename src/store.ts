/**
 * store.ts — GraphStore interface + SQLiteGraphStore implementation
 *
 * The storage boundary for SeldonClaw. All persistence goes through GraphStore.
 * SQLiteGraphStore is the sole implementation (v1).
 */

import Database from "better-sqlite3";
import { randomUUID, createHash } from "node:crypto";
import { SCHEMA_SQL } from "./schema.js";
import type {
  DocumentRecord,
  Chunk,
  Claim,
  EntityType,
  EdgeType,
  Entity,
  RawEntity,
  Edge,
  ActorRow,
  Post,
  Exposure,
  Follow,
  NarrativeRow,
  PostSnapshot,
  ActorSnapshot,
  CommunitySnapshot,
  EngagementStats,
  StanceChange,
  PlatformState,
  ProvenanceChain,
  NarrativeState,
  ActorContext,
  RunManifest,
  FeedItem,
} from "./types.js";

// ═══════════════════════════════════════════════════════
// GraphStore INTERFACE
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
  getLatestRunId(): string | null;
  getRunRoundSummary(runId: string): {
    roundsCompleted: number;
    totalPosts: number;
    totalActions: number;
    avgActiveActors: number;
  };
  getRunTierCallTotals(runId: string): {
    tierACalls: number;
    tierBCalls: number;
    tierCActions: number;
  };

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

  getLatestRunId(): string | null {
    const row = this.db
      .prepare(`SELECT id FROM run_manifest ORDER BY started_at DESC LIMIT 1`)
      .get() as { id: string } | undefined;
    return row?.id ?? null;
  }

  getRunRoundSummary(runId: string): {
    roundsCompleted: number;
    totalPosts: number;
    totalActions: number;
    avgActiveActors: number;
  } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as roundsCompleted,
                COALESCE(SUM(total_posts), 0) as totalPosts,
                COALESCE(SUM(total_actions), 0) as totalActions,
                COALESCE(AVG(active_actors), 0) as avgActiveActors
         FROM rounds WHERE run_id = ?`
      )
      .get(runId) as {
        roundsCompleted: number;
        totalPosts: number;
        totalActions: number;
        avgActiveActors: number;
      };

    return row;
  }

  getRunTierCallTotals(runId: string): {
    tierACalls: number;
    tierBCalls: number;
    tierCActions: number;
  } {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(tier_a_calls), 0) as tierACalls,
                COALESCE(SUM(tier_b_calls), 0) as tierBCalls,
                COALESCE(SUM(tier_c_actions), 0) as tierCActions
         FROM rounds WHERE run_id = ?`
      )
      .get(runId) as {
        tierACalls: number;
        tierBCalls: number;
        tierCActions: number;
      };

    return row;
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
