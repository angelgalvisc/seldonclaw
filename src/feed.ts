/**
 * feed.ts — Feed ranking + partial exposure
 *
 * Source of truth: PLAN.md §feed.ts (lines 863-900),
 *                  CLAUDE.md Phase 4.2
 *
 * Builds a personalized feed for each actor from PlatformState:
 * - Candidate collection: follow, trending, community cross-posts
 * - Multi-factor scoring: recency, popularity, relevance, community affinity
 * - Echo chamber effect: aligned sentiment boosted by community cohesion
 * - Partial exposure: top N posts (actor doesn't see everything)
 *
 * Pure function — operates on pre-built PlatformState, no store access.
 */

import type {
  ActorRow,
  PlatformState,
  PostSnapshot,
  FeedItem,
  ActorInteractionTrace,
} from "./db.js";
import type { FeedConfig } from "./config.js";
import { embeddingSimilarity } from "./embeddings.js";

// ═══════════════════════════════════════════════════════
// BUILD FEED
// ═══════════════════════════════════════════════════════

/**
 * Build a personalized feed for an actor.
 * Returns scored and sorted FeedItems, limited to config.size.
 */
export function buildFeed(
  actor: ActorRow,
  state: PlatformState,
  config: FeedConfig,
  actorTopics?: string[]
): FeedItem[] {
  if (state.recentPosts.length === 0) return [];

  // 1. Collect candidates with source labels (deduped, own posts excluded)
  const candidates = collectCandidates(actor.id, state, actor.community_id);

  if (candidates.length === 0) return [];

  // 2. Precompute normalization bounds
  const rounds = state.recentPosts.map((p) => p.roundNum);
  const latestRound = Math.max(...rounds);
  const earliestRound = Math.min(...rounds);
  const maxEngagement = Math.max(
    ...state.recentPosts.map((p) => p.likes + p.reposts + p.comments),
    1
  );

  // 3. Find actor's community for echo chamber
  const actorCommunity = actor.community_id
    ? state.communities.find((c) => c.id === actor.community_id)
    : undefined;

  // 4. Score each candidate
  const scored: FeedItem[] = candidates.map(({ post, source }) => {
    const recency = recencyScore(post, latestRound, earliestRound);
    const popularity = popularityScore(post, maxEngagement);
    const relevance = relevanceScore(post.topics, actorTopics ?? []);
    const affinity = communityAffinity(
      post.authorId,
      actor.community_id,
      state
    );

    let score = scoreByAlgorithm({
      actorId: actor.id,
      post,
      source,
      state,
      config,
      recency,
      popularity,
      relevance,
      affinity,
    });

    // Echo chamber: boost aligned sentiment
    if (actorCommunity && sameSign(post.sentiment, actor.sentiment_bias)) {
      score *= 1 + actorCommunity.cohesion * config.echoChamberStrength;
    }

    return { post, score, source };
  });

  // 5. Sort by score descending, take top N
  scored.sort((a, b) => b.score - a.score);
  return applyNetworkMix(scored, config);
}

// ═══════════════════════════════════════════════════════
// CANDIDATE COLLECTION
// ═══════════════════════════════════════════════════════

interface Candidate {
  post: PostSnapshot;
  source: FeedItem["source"];
}

/**
 * Collect candidate posts from multiple sources.
 * Deduplicates: first source found wins (follow > trending > community).
 * Excludes the actor's own posts.
 */
function collectCandidates(
  actorId: string,
  state: PlatformState,
  actorCommunityId: string | null
): Candidate[] {
  const seen = new Set<string>();
  const candidates: Candidate[] = [];

  // a. Follow posts
  const following = state.followGraph.get(actorId) ?? [];
  const followSet = new Set(following);
  for (const post of state.recentPosts) {
    if (post.authorId === actorId) continue;
    if (!isVisibleToActor(actorId, post.authorId, state)) continue;
    if (followSet.has(post.authorId) && !seen.has(post.id)) {
      seen.add(post.id);
      candidates.push({ post, source: "follow" });
    }
  }

  // b. Community cross-posts (from overlapping communities)
  // Collected before trending so community relationship is preserved
  if (actorCommunityId) {
    const actorCommunity = state.communities.find(
      (c) => c.id === actorCommunityId
    );
    if (actorCommunity) {
      const overlapCommunityIds = new Set(actorCommunity.overlaps.keys());
      // Also include same-community posts not already included
      overlapCommunityIds.add(actorCommunityId);

      for (const post of state.recentPosts) {
        if (post.authorId === actorId || seen.has(post.id)) continue;
        if (!isVisibleToActor(actorId, post.authorId, state)) continue;
        const authorSnapshot = state.actors.get(post.authorId);
        if (
          authorSnapshot &&
          overlapCommunityIds.has(authorSnapshot.communityId)
        ) {
          seen.add(post.id);
          candidates.push({ post, source: "community" });
        }
      }
    }
  }

  // c. Trending posts (remaining posts by engagement)
  const byEngagement = [...state.recentPosts]
    .filter((p) => p.authorId !== actorId && !seen.has(p.id) && isVisibleToActor(actorId, p.authorId, state))
    .sort(
      (a, b) =>
        b.likes + b.reposts + b.comments - (a.likes + a.reposts + a.comments)
    );
  for (const post of byEngagement) {
    if (seen.has(post.id)) continue;
    seen.add(post.id);
    candidates.push({ post, source: "trending" });
  }

  return candidates;
}

// ═══════════════════════════════════════════════════════
// SCORING HELPERS
// ═══════════════════════════════════════════════════════

/**
 * Recency score: 1.0 for latest round, 0.0 for earliest.
 */
function recencyScore(
  post: PostSnapshot,
  latestRound: number,
  earliestRound: number
): number {
  const range = latestRound - earliestRound;
  if (range <= 0) return 1.0;
  return (post.roundNum - earliestRound) / range;
}

/**
 * Popularity score: normalized engagement relative to max.
 */
function popularityScore(post: PostSnapshot, maxEngagement: number): number {
  return (post.likes + post.reposts + post.comments) / maxEngagement;
}

/**
 * Relevance score: Jaccard-like overlap between post topics and actor topics.
 */
function relevanceScore(
  postTopics: string[],
  actorTopics: string[]
): number {
  if (postTopics.length === 0 || actorTopics.length === 0) return 0;

  const postSet = new Set(postTopics);
  const actorSet = new Set(actorTopics);
  let intersection = 0;
  for (const t of postSet) {
    if (actorSet.has(t)) intersection++;
  }
  const union = new Set([...postSet, ...actorSet]).size;
  return union > 0 ? intersection / union : 0;
}

/**
 * Community affinity: bonus for same or overlapping community.
 */
function communityAffinity(
  authorId: string,
  actorCommunityId: string | null,
  state: PlatformState
): number {
  if (!actorCommunityId) return 0;

  const authorSnapshot = state.actors.get(authorId);
  if (!authorSnapshot) return 0;

  // Same community
  if (authorSnapshot.communityId === actorCommunityId) return 0.5;

  // Overlapping community
  const actorCommunity = state.communities.find(
    (c) => c.id === actorCommunityId
  );
  if (actorCommunity) {
    const overlap = actorCommunity.overlaps.get(authorSnapshot.communityId);
    if (overlap !== undefined) return overlap * 0.3;
  }

  return 0;
}

/**
 * Check if two values have the same sign (both positive or both negative).
 */
function sameSign(a: number, b: number): boolean {
  return (a >= 0 && b >= 0) || (a < 0 && b < 0);
}

function isVisibleToActor(
  actorId: string,
  authorId: string,
  state: PlatformState
): boolean {
  const muted = state.muteGraph?.get(actorId);
  if (muted?.has(authorId)) return false;

  const actorBlocks = state.blockGraph?.get(actorId);
  if (actorBlocks?.has(authorId)) return false;

  const authorBlocks = state.blockGraph?.get(authorId);
  if (authorBlocks?.has(actorId)) return false;

  return true;
}

function scoreByAlgorithm(opts: {
  actorId: string;
  post: PostSnapshot;
  source: FeedItem["source"];
  state: PlatformState;
  config: FeedConfig;
  recency: number;
  popularity: number;
  relevance: number;
  affinity: number;
}): number {
  const base =
    opts.recency * opts.config.recencyWeight +
    opts.popularity * opts.config.popularityWeight +
    opts.relevance * opts.config.relevanceWeight +
    opts.affinity * 0.1;

  if (opts.config.algorithm === "chronological") {
    return opts.recency;
  }

  let score = base;
  if (opts.config.algorithm === "embedding" || opts.config.algorithm === "hybrid") {
    if (opts.config.embeddingEnabled) {
      score += embeddingSimilarity(opts.actorId, opts.post.id, opts.state) * opts.config.embeddingWeight;
    }
  }

  if (opts.config.algorithm === "trace-aware" || opts.config.algorithm === "hybrid") {
    score += traceScore(opts.actorId, opts.post, opts.source, opts.state, opts.config);
  }

  return score;
}

function traceScore(
  actorId: string,
  post: PostSnapshot,
  source: FeedItem["source"],
  state: PlatformState,
  config: FeedConfig
): number {
  const trace = state.interactionTrace?.get(actorId);
  if (!trace) return 0;

  const maxAuthorScore = maxMapValue(trace.authorScores);
  const maxTopicScore = maxMapValue(trace.topicScores);
  const authorAffinity =
    maxAuthorScore > 0 ? (trace.authorScores.get(post.authorId) ?? 0) / maxAuthorScore : 0;
  const topicAffinity =
    post.topics.length > 0 && maxTopicScore > 0
      ? post.topics.reduce((sum, topic) => sum + (trace.topicScores.get(topic) ?? 0), 0) /
        (post.topics.length * maxTopicScore)
      : 0;

  const totalSourceScore = Math.max(1, trace.inNetworkScore + trace.outOfNetworkScore);
  const networkAffinity =
    source === "follow"
      ? trace.inNetworkScore / totalSourceScore
      : trace.outOfNetworkScore / totalSourceScore;
  const noveltyBoost =
    source === "follow"
      ? 0
      : (1 - authorAffinity) * config.diversityWeight;

  return (
    authorAffinity * config.traceWeight * 0.45 +
    topicAffinity * config.traceWeight * 0.4 +
    networkAffinity * config.traceWeight * 0.15 +
    noveltyBoost
  );
}

function applyNetworkMix(feed: FeedItem[], config: FeedConfig): FeedItem[] {
  if (feed.length <= config.size) return feed;

  const targetOutOfNetwork = Math.round(config.size * config.outOfNetworkRatio);
  const inNetwork = feed.filter((item) => item.source === "follow");
  const outOfNetwork = feed.filter((item) => item.source !== "follow");

  const selected: FeedItem[] = [];
  selected.push(...outOfNetwork.slice(0, targetOutOfNetwork));
  selected.push(...inNetwork.slice(0, Math.max(0, config.size - selected.length)));

  if (selected.length < config.size) {
    const seen = new Set(selected.map((item) => item.post.id));
    for (const item of feed) {
      if (seen.has(item.post.id)) continue;
      selected.push(item);
      seen.add(item.post.id);
      if (selected.length >= config.size) break;
    }
  }

  return selected.slice(0, config.size);
}

function maxMapValue(map: Map<string, number>): number {
  let max = 0;
  for (const value of map.values()) {
    if (value > max) max = value;
  }
  return max;
}
