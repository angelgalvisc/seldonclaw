/**
 * embeddings.ts — Optional embedding-aware feed helpers
 *
 * v1.5 implementation:
 * - Deterministic local hash embeddings (no external dependency)
 * - Store-backed cache for actor interest and recent post embeddings
 * - Pure cosine similarity scoring consumed by feed.ts
 *
 * The provider interface is intentionally small so a real embedding API can
 * replace the hash implementation later without changing feed.ts or engine.ts.
 */

import { createHash } from "node:crypto";
import type {
  ActorRow,
  GraphStore,
  PlatformState,
  PostSnapshot,
} from "./db.js";
import type { FeedConfig } from "./config.js";

export interface EmbeddingProvider {
  modelId(): string;
  embedTexts(texts: string[]): Promise<number[][]>;
}

export class HashEmbeddingProvider implements EmbeddingProvider {
  constructor(
    private readonly model: string,
    private readonly dimensions: number
  ) {}

  modelId(): string {
    return this.model;
  }

  async embedTexts(texts: string[]): Promise<number[][]> {
    return texts.map((text) => hashEmbedding(text, this.dimensions));
  }
}

export function createEmbeddingProvider(config: FeedConfig): EmbeddingProvider {
  return new HashEmbeddingProvider(config.embeddingModel, config.embeddingDimensions);
}

export async function attachEmbeddingsToPlatformState(opts: {
  state: PlatformState;
  store: GraphStore;
  provider: EmbeddingProvider;
  actors: ActorRow[];
  actorTopicsMap: Map<string, string[]>;
  actorBeliefsMap: Map<string, Record<string, number>>;
}): Promise<PlatformState> {
  const postEmbeddings = await ensurePostEmbeddings(
    opts.store,
    opts.state.recentPosts,
    opts.provider
  );
  const actorInterestEmbeddings = await ensureActorInterestEmbeddings(
    opts.store,
    opts.actors,
    opts.actorTopicsMap,
    opts.actorBeliefsMap,
    opts.provider
  );

  return {
    ...opts.state,
    postEmbeddings,
    actorInterestEmbeddings,
  };
}

export async function ensurePostEmbeddings(
  store: GraphStore,
  posts: PostSnapshot[],
  provider: EmbeddingProvider
): Promise<Map<string, number[]>> {
  const postIds = posts.map((post) => post.id);
  const existing = store.getPostEmbeddings(postIds, provider.modelId());
  const missing = posts.filter((post) => !existing.has(post.id));

  if (missing.length > 0) {
    const vectors = await provider.embedTexts(
      missing.map((post) => buildPostEmbeddingText(post))
    );
    missing.forEach((post, index) => {
      const vector = vectors[index];
      store.upsertPostEmbedding({
        post_id: post.id,
        model_id: provider.modelId(),
        vector: JSON.stringify(vector),
        content_hash: hashString(buildPostEmbeddingText(post)),
      });
      existing.set(post.id, vector);
    });
  }

  return existing;
}

export async function ensureActorInterestEmbeddings(
  store: GraphStore,
  actors: ActorRow[],
  actorTopicsMap: Map<string, string[]>,
  actorBeliefsMap: Map<string, Record<string, number>>,
  provider: EmbeddingProvider
): Promise<Map<string, number[]>> {
  const actorIds = actors.map((actor) => actor.id);
  const existing = store.getActorInterestEmbeddings(actorIds, provider.modelId());
  const missing = actors.filter((actor) => !existing.has(actor.id));

  if (missing.length > 0) {
    const texts = missing.map((actor) =>
      buildActorInterestText(
        actor,
        actorTopicsMap.get(actor.id) ?? [],
        actorBeliefsMap.get(actor.id) ?? {}
      )
    );
    const vectors = await provider.embedTexts(texts);
    missing.forEach((actor, index) => {
      const profileText = texts[index];
      const vector = vectors[index];
      store.upsertActorInterestEmbedding({
        actor_id: actor.id,
        model_id: provider.modelId(),
        vector: JSON.stringify(vector),
        profile_hash: hashString(profileText),
      });
      existing.set(actor.id, vector);
    });
  }

  return existing;
}

export function embeddingSimilarity(
  actorId: string,
  postId: string,
  state: PlatformState
): number {
  const actorVector = state.actorInterestEmbeddings?.get(actorId);
  const postVector = state.postEmbeddings?.get(postId);
  if (!actorVector || !postVector) return 0;

  const cosine = cosineSimilarity(actorVector, postVector);
  return clamp((cosine + 1) / 2, 0, 1);
}

export function buildActorInterestText(
  actor: ActorRow,
  topics: string[],
  beliefs: Record<string, number>
): string {
  const beliefText = Object.entries(beliefs)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([topic, sentiment]) => `${topic}:${sentiment.toFixed(2)}`)
    .join(", ");

  return [
    actor.name,
    actor.personality,
    actor.stance,
    actor.region ?? "",
    actor.language,
    topics.slice().sort().join(", "),
    beliefText,
  ]
    .filter(Boolean)
    .join(" | ");
}

export function buildPostEmbeddingText(post: Pick<PostSnapshot, "content" | "topics" | "authorId">): string {
  return [post.authorId, post.topics.join(", "), post.content].filter(Boolean).join(" | ");
}

function hashEmbedding(text: string, dimensions: number): number[] {
  const buckets = new Array<number>(dimensions).fill(0);
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9áéíóúñü]+/i)
    .filter(Boolean);

  if (tokens.length === 0) return buckets;

  for (const token of tokens) {
    const digest = createHash("sha256").update(token).digest();
    for (let i = 0; i < digest.length; i += 2) {
      const bucket = digest[i] % dimensions;
      const signed = digest[i + 1] % 2 === 0 ? 1 : -1;
      buckets[bucket] += signed;
    }
  }

  const norm = Math.sqrt(buckets.reduce((sum, value) => sum + value * value, 0)) || 1;
  return buckets.map((value) => value / norm);
}

function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  if (length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
