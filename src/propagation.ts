/**
 * propagation.ts — Within/cross-community post spread
 *
 * Source of truth: PLAN.md §propagation.ts, CLAUDE.md Phase 6
 *
 * Pure function. Uses PlatformState (read-only) to compute new exposures,
 * reach deltas, and viral post detection. Engine.ts persists results
 * via store methods.
 *
 * All sampling uses the seeded PRNG for determinism.
 * Posts and members are sorted by ID before processing.
 */

import type {
  PlatformState,
  Exposure,
  PostSnapshot,
  CommunitySnapshot,
  PRNG,
} from "./db.js";
import type { PropagationConfig } from "./config.js";

// ═══════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════

export interface PropagationResult {
  /** New "seen" exposures created by propagation */
  newExposures: Exposure[];
  /** postId → additional reach from this round's propagation */
  reachDeltas: Map<string, number>;
  /** Post IDs that exceeded viralThreshold (existing + new reach) */
  viralPosts: string[];
}

// ═══════════════════════════════════════════════════════
// PROPAGATE
// ═══════════════════════════════════════════════════════

/**
 * Compute propagation of posts through communities.
 *
 * For each recent post:
 *   1. Within-community: expose community members based on author influence × cohesion
 *   2. Cross-community: spread via community overlaps, modulated by virality
 *   3. Track viral posts (total reach > viralThreshold)
 */
export function propagate(
  state: PlatformState,
  config: PropagationConfig,
  roundNum: number,
  rng: PRNG
): PropagationResult {
  const newExposures: Exposure[] = [];
  const reachDeltas = new Map<string, number>();
  const viralPosts: string[] = [];

  // Build community lookup by ID
  const communityById = new Map<string, CommunitySnapshot>();
  for (const c of state.communities) {
    communityById.set(c.id, c);
  }

  // Process posts in deterministic order
  const sortedPosts = [...state.recentPosts].sort((a, b) =>
    a.id.localeCompare(b.id)
  );

  for (const post of sortedPosts) {
    const author = state.actors.get(post.authorId);
    if (!author) continue;

    // Already-exposed set (from DB + this round's new exposures)
    const alreadyExposed = new Set(
      state.exposedActors.get(post.id) ?? new Set()
    );

    let newReach = 0;

    // 1. Within-community spread
    const community = communityById.get(author.communityId);
    if (community) {
      const members = [...community.memberIds].sort();
      const exposureProb = clamp01(
        author.influenceWeight * community.cohesion * config.influenceMultiplier
      );

      for (const memberId of members) {
        if (memberId === post.authorId) continue;
        if (alreadyExposed.has(memberId)) continue;
        if (!canExpose(post.authorId, memberId, state)) continue;

        if (rng.next() < exposureProb) {
          newExposures.push({
            actor_id: memberId,
            post_id: post.id,
            round_num: roundNum,
            run_id: state.runId,
            reaction: "seen",
          });
          alreadyExposed.add(memberId);
          newReach++;
        }
      }
    }

    // 2. Cross-community spread
    if (community) {
      const virality = computeVirality(post, config.viralThreshold);

      for (const [otherCommunityId, overlapWeight] of community.overlaps) {
        const otherCommunity = communityById.get(otherCommunityId);
        if (!otherCommunity) continue;

        const crossProb = clamp01(
          overlapWeight * config.crossCommunityDecay * virality
        );

        const otherMembers = [...otherCommunity.memberIds].sort();
        for (const memberId of otherMembers) {
          if (alreadyExposed.has(memberId)) continue;
          if (!canExpose(post.authorId, memberId, state)) continue;

          if (rng.next() < crossProb) {
            newExposures.push({
              actor_id: memberId,
              post_id: post.id,
              round_num: roundNum,
              run_id: state.runId,
              reaction: "seen",
            });
            alreadyExposed.add(memberId);
            newReach++;
          }
        }
      }
    }

    // Track reach delta
    if (newReach > 0) {
      reachDeltas.set(post.id, newReach);
    }

    // 3. Viral check
    const totalReach = post.reach + newReach;
    if (totalReach > config.viralThreshold) {
      viralPosts.push(post.id);
    }
  }

  return { newExposures, reachDeltas, viralPosts };
}

// ═══════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════

/**
 * Compute virality score for a post (0-1).
 * Higher engagement relative to viralThreshold → higher virality.
 */
function computeVirality(post: PostSnapshot, viralThreshold: number): number {
  const engagement = post.likes + post.reposts * 2 + post.comments;
  return clamp01(engagement / Math.max(1, viralThreshold));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function canExpose(authorId: string, targetActorId: string, state: PlatformState): boolean {
  const authorBlocks = state.blockGraph?.get(authorId);
  if (authorBlocks?.has(targetActorId)) return false;

  const targetBlocks = state.blockGraph?.get(targetActorId);
  if (targetBlocks?.has(authorId)) return false;

  return true;
}
