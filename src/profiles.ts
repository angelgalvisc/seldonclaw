/**
 * profiles.ts — Graph entities → ActorSpec + initial ActorState
 *
 * Source of truth: PLAN.md §ActorSpec vs ActorState (lines 585-631),
 *                  §Actors table (lines 284-314)
 *
 * Responsibilities:
 * - LLM generates personality, bio, age, gender, region, language per entity
 * - Assign archetype (persona, organization, media, institution) from entity type
 * - Determine cognition_tier from influence and archetype
 * - Initial ActorState: stance, sentiment_bias, activity_level, influence_weight
 * - Community detection by topic clustering
 * - Initial follow graph (follow network)
 * - Initial posts (round 0 seeds)
 * - Persist actors, communities, follows, initial posts to DB
 */

import type {
  GraphStore,
  Entity,
  ActorRow,
  Follow,
  Post,
} from "./db.js";
import { stableId } from "./db.js";
import type { LLMClient } from "./llm.js";
import type { SimConfig } from "./config.js";
import { mapWithConcurrency } from "./concurrency.js";

// ═══════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════

/** LLM-generated profile for an entity */
export interface GeneratedProfile {
  personality: string;
  bio: string;
  age: number | null;
  gender: string | null;
  profession: string | null;
  region: string | null;
  language: string;
  stance: string;
  sentiment_bias: number;
  activity_level: number;
  influence_weight: number;
  handle: string;
  topics: Array<{ topic: string; weight: number }>;
  beliefs: Array<{ topic: string; sentiment: number }>;
}

export interface ProfilesOptions {
  /** Run ID for scoping actors */
  runId: string;
  /** Hypothesis/scenario context for LLM */
  hypothesis?: string;
  /** Max actors to generate (0 = all entities, default: 0) */
  maxActors?: number;
  /** User-specified actor seeds that must be present when possible */
  focusActors?: string[];
  /** Cast seeds from cast-design pass (priority 2 after focusActors) */
  castSeeds?: Array<{ name: string; type: string; role: string; stance?: string; community?: string }>;
  /** Community proposals from cast-design pass */
  communityProposals?: Array<{ name: string; description: string; memberLabels: string[] }>;
  /** Pipeline concurrency for parallel LLM calls (default: 1) */
  pipelineConcurrency?: number;
  /** Platform (default: "x") */
  platform?: string;
  /** Initial follow density: probability two actors follow each other (default: 0.3) */
  followDensity?: number;
  /** Number of seed posts per key actor at round 0 (default: 1) */
  seedPostsPerKeyActor?: number;
  /** Simulation start time ISO string (default: now) */
  simStartTime?: string;
}

export interface ProfilesResult {
  actorsCreated: number;
  communitiesCreated: number;
  followsCreated: number;
  seedPostsCreated: number;
}

interface ProfileCandidate {
  entity: Entity;
  entityId: string | null;
  claimTexts: string[];
}

// ═══════════════════════════════════════════════════════
// ARCHETYPE MAPPING
// ═══════════════════════════════════════════════════════

const ENTITY_TYPE_TO_ARCHETYPE: Record<string, string> = {
  person: "persona",
  organization: "organization",
  university: "institution",
  government_body: "institution",
  media_outlet: "media",
  media: "media",
  institution: "institution",
  entity: "persona", // fallback
};

function mapArchetype(entityType: string): string {
  return ENTITY_TYPE_TO_ARCHETYPE[entityType] ?? "persona";
}

// ═══════════════════════════════════════════════════════
// COGNITION TIER
// ═══════════════════════════════════════════════════════

/**
 * Determine cognition tier from influence and archetype.
 * Per PLAN.md §CognitionRouter:
 * - Tier A: influence >= 0.8 or archetype in ["institution", "media"]
 * - Tier B: influence >= 0.4
 * - Tier C: otherwise
 */
function determineCognitionTier(
  influenceWeight: number,
  archetype: string,
  config?: SimConfig
): "A" | "B" | "C" {
  const minInfluence = config?.cognition?.tierA?.minInfluence ?? 0.8;
  const archetypeOverrides = config?.cognition?.tierA?.archetypeOverrides ?? [
    "institution",
    "media",
  ];

  if (influenceWeight >= minInfluence) return "A";
  if (archetypeOverrides.includes(archetype)) return "A";
  if (influenceWeight >= 0.4) return "B";
  return "C";
}

// ═══════════════════════════════════════════════════════
// PROMPTS
// ═══════════════════════════════════════════════════════

const PROFILE_SYSTEM = `You are generating social media actor profiles for a social simulation. Given an entity from a knowledge graph and contextual information, generate a realistic profile.

Output valid JSON only. No markdown code fences.`;

function buildProfilePrompt(
  entity: Entity,
  entityClaims: string[],
  hypothesis: string,
  platform: string
): string {
  const claimsText = entityClaims.length > 0
    ? `\nRelevant claims about this entity:\n${entityClaims.map((c) => `- ${c}`).join("\n")}`
    : "";

  return `Generate a social media profile for the following entity in a ${platform} simulation.

Entity: ${entity.name}
Type: ${entity.type}
${entity.attributes ? `Attributes: ${entity.attributes}` : ""}
${claimsText}

Scenario/Hypothesis: ${hypothesis}

Generate a profile with:
- personality: A detailed persona description (2-3 sentences, how they would behave on social media)
- bio: A short bio for their profile (1 sentence)
- age: Estimated age (number or null if organization)
- gender: Estimated gender (string or null if organization)
- profession: Their role/profession
- region: Geographic region (e.g., "Bogotá, Colombia")
- language: Primary language code (e.g., "es", "en")
- stance: Their likely stance on the topic ("supportive", "opposing", "neutral", "observer")
- sentiment_bias: Initial sentiment (-1.0 to 1.0, negative = critical, positive = supportive)
- activity_level: How active they'd be (0.0 to 1.0)
- influence_weight: How influential (0.0 to 1.0)
- handle: A realistic ${platform} handle/username
- topics: Array of {topic, weight} pairs they care about
- beliefs: Array of {topic, sentiment} pairs (initial beliefs, -1.0 to 1.0)

Respond with this exact JSON structure:
{
  "personality": "...",
  "bio": "...",
  "age": 35,
  "gender": "male",
  "profession": "...",
  "region": "...",
  "language": "es",
  "stance": "opposing",
  "sentiment_bias": -0.5,
  "activity_level": 0.7,
  "influence_weight": 0.6,
  "handle": "@username",
  "topics": [{"topic": "education", "weight": 0.9}],
  "beliefs": [{"topic": "tuition", "sentiment": -0.6}]
}`;
}

// ═══════════════════════════════════════════════════════
// CORE: generateProfiles
// ═══════════════════════════════════════════════════════

/**
 * Generate actor profiles from graph entities and persist to DB.
 *
 * Pipeline:
 * 1. Load active entities from graph
 * 2. For each entity, generate LLM profile
 * 3. Create actors in DB with generated profiles
 * 4. Detect communities by topic clustering
 * 5. Create follow graph
 * 6. Create seed posts for key actors
 *
 * @param store - GraphStore with entities and claims
 * @param llm - LLMClient with "generation" provider
 * @param options - Profile generation options
 * @param config - SimConfig (optional, for tier thresholds)
 */
export async function generateProfiles(
  store: GraphStore,
  llm: LLMClient,
  options: ProfilesOptions,
  config?: SimConfig
): Promise<ProfilesResult> {
  const {
    runId,
    hypothesis = "Social scenario simulation",
    maxActors = 0,
    focusActors = [],
    castSeeds,
    communityProposals,
    platform = "x",
    followDensity = 0.3,
    seedPostsPerKeyActor = 1,
    simStartTime = new Date().toISOString(),
  } = options;

  const candidates = buildProfileCandidates(store, focusActors, maxActors, castSeeds);
  if (candidates.length === 0) {
    return {
      actorsCreated: 0,
      communitiesCreated: 0,
      followsCreated: 0,
      seedPostsCreated: 0,
    };
  }

  // 2. Generate profiles for each entity
  const actorIds: string[] = [];
  const actorTopicsMap = new Map<string, Array<{ topic: string; weight: number }>>();
  const actorArchetypes = new Map<string, string>();
  const actorNameMap = new Map<string, string>(); // actorId → actor name
  const concurrency = Math.max(1, options.pipelineConcurrency ?? 1);

  // Phase 1: Generate profiles via LLM with bounded concurrency
  const profileResults = await mapWithConcurrency(
    candidates,
    concurrency,
    async (candidate) => {
      const profile = await generateSingleProfile(
        llm,
        candidate.entity,
        candidate.claimTexts,
        hypothesis,
        platform
      );
      return { candidate, profile };
    }
  );

  // Phase 2: Persist to DB sequentially (better-sqlite3 is synchronous)
  const peakHours = config?.simulation?.peakHours ?? [8, 9, 10, 12, 13, 19, 20, 21, 22];

  for (const { candidate, profile } of profileResults) {
    const { entity, entityId } = candidate;
    const archetype = mapArchetype(entity.type);
    const cognitionTier = determineCognitionTier(
      profile.influence_weight,
      archetype,
      config
    );

    const actorId = store.addActor({
      id: stableId(runId, "actor", entity.id),
      run_id: runId,
      entity_id: entityId,
      archetype,
      cognition_tier: cognitionTier,
      name: entity.name,
      handle: profile.handle,
      personality: profile.personality,
      bio: profile.bio,
      age: profile.age,
      gender: profile.gender,
      profession: profile.profession,
      region: profile.region,
      language: profile.language,
      stance: profile.stance,
      sentiment_bias: clamp(profile.sentiment_bias, -1, 1),
      activity_level: clamp(profile.activity_level, 0, 1),
      influence_weight: clamp(profile.influence_weight, 0, 1),
      community_id: null,
      active_hours: JSON.stringify(peakHours),
      follower_count: estimateFollowers(archetype, profile.influence_weight),
      following_count: estimateFollowing(archetype),
    });

    actorIds.push(actorId);
    actorNameMap.set(actorId, entity.name);
    actorTopicsMap.set(actorId, profile.topics);
    actorArchetypes.set(actorId, archetype);

    for (const { topic, weight } of profile.topics) {
      store.addActorTopic(actorId, topic, clamp(weight, 0, 1));
    }
    for (const { topic, sentiment } of profile.beliefs) {
      store.addActorBelief(actorId, topic, clamp(sentiment, -1, 1), 0);
    }
  }

  // 3. Community detection: proposal-driven if available, else topic clustering
  const communities = communityProposals?.length
    ? assignCommunitiesFromProposals(actorIds, actorNameMap, communityProposals, runId, actorTopicsMap)
    : detectCommunities(actorIds, actorTopicsMap);
  let communitiesCreated = 0;

  for (const [communityId, members] of communities) {
    const communityName = `community-${communitiesCreated + 1}`;
    store.addCommunity(communityId, runId, communityName, undefined, 0.5);

    for (const actorId of members) {
      // Update actor's community_id
      updateActorCommunity(store, actorId, communityId);
    }

    communitiesCreated++;
  }

  // Add community overlaps
  if (communities.size > 1) {
    const communityIds = [...communities.keys()];
    for (let i = 0; i < communityIds.length; i++) {
      for (let j = i + 1; j < communityIds.length; j++) {
        const overlap = computeTopicOverlap(
          communities.get(communityIds[i])!,
          communities.get(communityIds[j])!,
          actorTopicsMap
        );
        if (overlap > 0.1) {
          store.addCommunityOverlap(
            communityIds[i],
            communityIds[j],
            runId,
            overlap
          );
        }
      }
    }
  }

  // 4. Create follow graph
  let followsCreated = 0;
  for (let i = 0; i < actorIds.length; i++) {
    for (let j = 0; j < actorIds.length; j++) {
      if (i === j) continue;

      // Higher follow probability for same community
      const sameCommunity = getActorCommunity(store, actorIds[i]) ===
        getActorCommunity(store, actorIds[j]);
      const prob = sameCommunity ? followDensity * 1.5 : followDensity * 0.5;

      // Use a deterministic approach based on IDs for reproducibility
      const hash = simpleHash(`${actorIds[i]}:${actorIds[j]}`);
      if (hash < prob) {
        store.addFollow({
          follower_id: actorIds[i],
          following_id: actorIds[j],
          run_id: runId,
          since_round: 0,
        });
        followsCreated++;
      }
    }
  }

  // 5. Create seed posts for key actors (tier A) — LLM-generated with parallel execution
  const seedJobs: Array<{
    actorId: string;
    actor: ActorRow;
    topTopic: string;
    postIndex: number;
  }> = [];

  for (const actorId of actorIds) {
    const actor = store.getActor(actorId);
    if (!actor || actor.cognition_tier !== "A") continue;
    for (let p = 0; p < seedPostsPerKeyActor; p++) {
      const topics = actorTopicsMap.get(actorId) ?? [];
      const topTopic = topics.length > 0 ? topics[0].topic : "general";
      seedJobs.push({ actorId, actor, topTopic, postIndex: p });
    }
  }

  const seedContents = await mapWithConcurrency(
    seedJobs,
    concurrency,
    async (job) => generateSeedPostContent(llm, job.actor, job.topTopic, hypothesis, platform)
  );

  let seedPostsCreated = 0;
  for (let i = 0; i < seedJobs.length; i++) {
    const job = seedJobs[i];
    const content = seedContents[i];
    const postId = stableId(runId, "seed-post", job.actorId, String(job.postIndex));
    store.addPost({
      id: postId,
      run_id: runId,
      author_id: job.actorId,
      content,
      round_num: 0,
      sim_timestamp: simStartTime,
      likes: 0,
      reposts: 0,
      comments: 0,
      reach: 0,
      sentiment: job.actor.sentiment_bias,
    });
    store.addPostTopic(postId, job.topTopic);
    seedPostsCreated++;
  }

  return {
    actorsCreated: actorIds.length,
    communitiesCreated,
    followsCreated,
    seedPostsCreated,
  };
}

function buildProfileCandidates(
  store: GraphStore,
  focusActors: string[],
  maxActors: number,
  castSeeds?: Array<{ name: string; type: string; role: string; stance?: string; community?: string }>
): ProfileCandidate[] {
  // Rank graph entities by claim count (more claims = more relevant)
  const rankedEntities = store
    .getAllActiveEntities()
    .map((entity) => {
      const provenance = store.queryProvenance(entity.id);
      const claimTexts = provenance.claims.map(
        (claim) => `${claim.subject} ${claim.predicate} ${claim.object}`
      );
      return {
        entity,
        entityId: entity.id,
        claimTexts,
        rank: claimTexts.length,
      };
    })
    .sort((a, b) => b.rank - a.rank || a.entity.name.localeCompare(b.entity.name));

  const candidates: ProfileCandidate[] = [];
  const seen = new Set<string>();

  // Priority 1: focusActors (user-specified)
  for (const focusActor of focusActors) {
    const normalized = normalizeCandidateName(focusActor);
    if (!normalized || seen.has(normalized)) continue;

    const matchedEntity = rankedEntities.find(
      (candidate) => normalizeCandidateName(candidate.entity.name) === normalized
    );
    if (matchedEntity) {
      candidates.push({
        entity: matchedEntity.entity,
        entityId: matchedEntity.entityId,
        claimTexts: matchedEntity.claimTexts,
      });
      seen.add(normalized);
      continue;
    }

    candidates.push({
      entity: createFocusActorSeedEntity(focusActor),
      entityId: null,
      claimTexts: [`Operator-designated focus actor: ${focusActor}`],
    });
    seen.add(normalized);
  }

  // Priority 2: castSeeds (LLM-proposed from cast-design)
  if (castSeeds) {
    for (const seed of castSeeds) {
      const normalized = normalizeCandidateName(seed.name);
      if (!normalized || seen.has(normalized)) continue;

      const matchedEntity = rankedEntities.find(
        (candidate) => normalizeCandidateName(candidate.entity.name) === normalized
      );
      if (matchedEntity) {
        // Use the graph entity but inherit the cast seed's type if available
        const entity = { ...matchedEntity.entity };
        if (seed.type) entity.type = seed.type;
        candidates.push({
          entity,
          entityId: matchedEntity.entityId,
          claimTexts: matchedEntity.claimTexts,
        });
      } else {
        candidates.push({
          entity: {
            id: stableId("cast-seed", seed.name),
            type: seed.type || "person",
            name: seed.name,
            attributes: JSON.stringify({ role: seed.role, stance: seed.stance, source: "cast_seed" }),
            merged_into: null,
          },
          entityId: null,
          claimTexts: [`Cast-design seed: ${seed.role}`],
        });
      }
      seen.add(normalized);
    }
  }

  // Priority 3: graph entities ranked by relevance
  for (const candidate of rankedEntities) {
    const normalized = normalizeCandidateName(candidate.entity.name);
    if (!normalized || seen.has(normalized)) continue;
    candidates.push({
      entity: candidate.entity,
      entityId: candidate.entityId,
      claimTexts: candidate.claimTexts,
    });
    seen.add(normalized);
  }

  // Priority 4: actorCount cap
  return maxActors > 0 ? candidates.slice(0, maxActors) : candidates;
}

function createFocusActorSeedEntity(label: string): Entity {
  const normalizedLabel = label.trim();
  const entityType = inferFocusActorEntityType(normalizedLabel);
  return {
    id: stableId("focus-actor", normalizedLabel),
    type: entityType,
    name: normalizedLabel,
    attributes: JSON.stringify({
      requested_role: normalizedLabel,
      source: "focus_actor_seed",
    }),
    merged_into: null,
  };
}

function inferFocusActorEntityType(label: string): string {
  const normalized = label.toLowerCase();
  if (/\b(journalist|journalists|media|commentator|commentators|editor|editors|outlet)\b/.test(normalized)) {
    return "media";
  }
  if (/\b(regulator|regulators|government|ministry|agency|institution|institutions|etf ecosystem)\b/.test(normalized)) {
    return "institution";
  }
  if (/\b(company|companies|organization|organizations|market makers|market maker|miners)\b/.test(normalized)) {
    return "organization";
  }
  return "person";
}

function normalizeCandidateName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

// ═══════════════════════════════════════════════════════
// INTERNAL: Generate seed post content via LLM
// ═══════════════════════════════════════════════════════

const SEED_POST_SYSTEM = [
  "You are generating an initial social media post for a simulated actor.",
  "Write a realistic first post that this actor would publish, matching their personality, stance, and topics of interest.",
  "The post should feel natural and authentic to the actor's voice.",
  "Output valid JSON only. No markdown code fences.",
].join("\n");

async function generateSeedPostContent(
  llm: LLMClient,
  actor: ActorRow,
  topTopic: string,
  hypothesis: string,
  platform: string
): Promise<string> {
  const charLimit = platform === "x" ? 280 : 500;
  try {
    const prompt = [
      `Generate an initial ${platform} post for this actor.`,
      "",
      `Actor: ${actor.name}`,
      `Personality: ${actor.personality}`,
      `Bio: ${actor.bio ?? ""}`,
      `Stance: ${actor.stance}`,
      `Profession: ${actor.profession ?? ""}`,
      `Main topic: ${topTopic}`,
      `Scenario: ${hypothesis}`,
      "",
      `The post must be at most ${charLimit} characters.`,
      `Respond with: {"content": "the post text"}`,
    ].join("\n");

    const { data } = await llm.completeJSON<{ content?: unknown }>("generation", prompt, {
      system: SEED_POST_SYSTEM,
      temperature: 0.5,
      maxTokens: 512,
    });

    const content = typeof data?.content === "string" ? data.content.trim() : "";
    if (content.length >= 10 && content.length <= charLimit * 1.2) {
      return content;
    }
  } catch {
    // Fallback below
  }
  return `[Seed post about ${topTopic} by ${actor.name}]`;
}

// ═══════════════════════════════════════════════════════
// INTERNAL: Generate a single profile via LLM
// ═══════════════════════════════════════════════════════

/**
 * Generate a profile for a single entity via LLM.
 */
export async function generateSingleProfile(
  llm: LLMClient,
  entity: Entity,
  claimTexts: string[],
  hypothesis: string,
  platform: string
): Promise<GeneratedProfile> {
  const prompt = buildProfilePrompt(entity, claimTexts, hypothesis, platform);

  const result = await llm.completeJSON<GeneratedProfile>("generation", prompt, {
    system: PROFILE_SYSTEM,
    temperature: 0.3, // Some creativity for personality generation
    maxTokens: 2048,
  });

  return {
    personality: result.data.personality ?? "A social media user.",
    bio: result.data.bio ?? "",
    age: result.data.age ?? null,
    gender: result.data.gender ?? null,
    profession: result.data.profession ?? null,
    region: result.data.region ?? null,
    language: result.data.language ?? "es",
    stance: result.data.stance ?? "neutral",
    sentiment_bias: result.data.sentiment_bias ?? 0,
    activity_level: result.data.activity_level ?? 0.5,
    influence_weight: result.data.influence_weight ?? 0.5,
    handle: result.data.handle ?? `@${entity.name.toLowerCase().replace(/\s+/g, "_")}`,
    topics: result.data.topics ?? [],
    beliefs: result.data.beliefs ?? [],
  };
}

// ═══════════════════════════════════════════════════════
// COMMUNITY DETECTION
// ═══════════════════════════════════════════════════════

/**
 * Simple community detection by topic clustering.
 * Groups actors that share the most topics.
 * Assign actors to communities based on cast-design proposals.
 * Actors not matched by any proposal fall back to topic-based detection.
 */
function assignCommunitiesFromProposals(
  actorIds: string[],
  actorNameMap: Map<string, string>,
  proposals: Array<{ name: string; description: string; memberLabels: string[] }>,
  runId: string,
  actorTopicsMap: Map<string, Array<{ topic: string; weight: number }>>
): Map<string, string[]> {
  const communities = new Map<string, string[]>();
  const assigned = new Set<string>();

  // Build label → community mapping
  const labelToCommunity = new Map<string, string>();
  for (const proposal of proposals) {
    const communityId = stableId("community", runId, proposal.name);
    communities.set(communityId, []);
    for (const label of proposal.memberLabels) {
      labelToCommunity.set(label.toLowerCase().trim(), communityId);
    }
  }

  // Assign actors by name match against memberLabels
  for (const actorId of actorIds) {
    const actorName = actorNameMap.get(actorId) ?? "";
    const normalized = actorName.toLowerCase().trim();
    const communityId = labelToCommunity.get(normalized);
    if (communityId) {
      communities.get(communityId)!.push(actorId);
      assigned.add(actorId);
    }
  }

  // Unassigned actors fall back to topic-based detection
  const unassigned = actorIds.filter((id) => !assigned.has(id));
  if (unassigned.length > 0) {
    const fallback = detectCommunities(unassigned, actorTopicsMap);
    for (const [communityId, members] of fallback) {
      communities.set(communityId, members);
    }
  }

  return communities;
}

/**
 * Uses greedy assignment: first actor defines a community,
 * subsequent actors join if they share enough topics.
 */
function detectCommunities(
  actorIds: string[],
  topicsMap: Map<string, Array<{ topic: string; weight: number }>>
): Map<string, string[]> {
  const communities = new Map<string, string[]>();
  const communityTopics = new Map<string, Set<string>>();
  const assigned = new Set<string>();

  // Sort actors by number of topics (most topical first), with stable tiebreaker by ID
  const sorted = [...actorIds].sort((a, b) => {
    const aTopics = topicsMap.get(a)?.length ?? 0;
    const bTopics = topicsMap.get(b)?.length ?? 0;
    if (bTopics !== aTopics) return bTopics - aTopics;
    return a.localeCompare(b); // stable tiebreaker
  });

  for (const actorId of sorted) {
    if (assigned.has(actorId)) continue;

    const actorTopics = new Set(
      (topicsMap.get(actorId) ?? []).map((t) => t.topic)
    );

    // Find best matching community
    let bestCommunity: string | null = null;
    let bestOverlap = 0;

    for (const [comId, comTopics] of communityTopics) {
      const overlap = setIntersectionSize(actorTopics, comTopics);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestCommunity = comId;
      }
    }

    // Join existing community if overlap >= 1 topic, else create new
    if (bestCommunity && bestOverlap >= 1) {
      communities.get(bestCommunity)!.push(actorId);
      // Expand community topics
      for (const t of actorTopics) {
        communityTopics.get(bestCommunity)!.add(t);
      }
    } else {
      // Derive community ID from the founding actor's topics (sorted for stability)
      const sortedTopics = [...actorTopics].sort().join(",");
      const newId = stableId("community", actorId, sortedTopics);
      communities.set(newId, [actorId]);
      communityTopics.set(newId, new Set(actorTopics));
    }

    assigned.add(actorId);
  }

  return communities;
}

/**
 * Compute topic overlap between two communities (Jaccard similarity).
 */
function computeTopicOverlap(
  membersA: string[],
  membersB: string[],
  topicsMap: Map<string, Array<{ topic: string; weight: number }>>
): number {
  const topicsA = new Set<string>();
  const topicsB = new Set<string>();

  for (const id of membersA) {
    for (const t of topicsMap.get(id) ?? []) topicsA.add(t.topic);
  }
  for (const id of membersB) {
    for (const t of topicsMap.get(id) ?? []) topicsB.add(t.topic);
  }

  const intersection = setIntersectionSize(topicsA, topicsB);
  const union = topicsA.size + topicsB.size - intersection;

  return union > 0 ? intersection / union : 0;
}

function setIntersectionSize<T>(a: Set<T>, b: Set<T>): number {
  let count = 0;
  for (const item of a) {
    if (b.has(item)) count++;
  }
  return count;
}

// ═══════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════

function clamp(value: number, min: number, max: number): number {
  if (typeof value !== "number" || isNaN(value)) return (min + max) / 2;
  return Math.max(min, Math.min(max, value));
}

function estimateFollowers(archetype: string, influence: number): number {
  const base: Record<string, number> = {
    persona: 500,
    organization: 5000,
    media: 50000,
    institution: 20000,
  };
  return Math.round((base[archetype] ?? 500) * (0.5 + influence));
}

function estimateFollowing(archetype: string): number {
  const base: Record<string, number> = {
    persona: 200,
    organization: 100,
    media: 500,
    institution: 50,
  };
  return base[archetype] ?? 100;
}

/**
 * Simple deterministic hash → [0, 1) for follow graph generation.
 * Avoids Math.random() per PLAN.md PRNG policy.
 */
function simpleHash(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return Math.abs(hash % 10000) / 10000;
}

/**
 * Update actor's community_id via GraphStore interface.
 */
function updateActorCommunity(
  store: GraphStore,
  actorId: string,
  communityId: string
): void {
  store.updateActorCommunity(actorId, communityId);
}

/**
 * Get actor's community_id.
 */
function getActorCommunity(
  store: GraphStore,
  actorId: string
): string | null {
  const actor = store.getActor(actorId);
  return actor?.community_id ?? null;
}
