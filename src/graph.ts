/**
 * graph.ts — Knowledge graph construction + entity resolution/dedup
 *
 * Source of truth: PLAN.md §Knowledge Graph (lines 225-249),
 *                  §Entity Resolution (lines 257-282, 809-828)
 *
 * Responsibilities:
 * - Build entities and edges from claims (extracted by ontology.ts)
 * - Entity resolution: normalize, find duplicates, merge, alias
 * - Provenance links: entity_claims, edge_claims
 * - FTS5 sync (handled by GraphStore.addEntity/mergeEntities)
 * - graph_revision_id generation (hash of entities+edges+merges)
 *
 * Entity resolution is P0 (not P2) per PLAN.md:
 * "If the graph is born dirty, everything downstream is bad."
 */

import type {
  GraphStore,
  Claim,
  Entity,
  Edge,
  RawEntity,
  MergeCandidate,
  EntityType,
  EdgeType,
} from "./db.js";
import { stableId } from "./db.js";
import type { LLMClient } from "./llm.js";

// ═══════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════

export interface GraphBuildOptions {
  /** Similarity threshold for name-based dedup (0.0-1.0, default: 0.75) */
  similarityThreshold?: number;
  /** Whether to use LLM for merge confirmation (default: false in v1) */
  llmConfirmMerges?: boolean;
  /** Max entity name length for normalization (default: 200) */
  maxNameLength?: number;
}

export interface GraphBuildResult {
  entitiesCreated: number;
  edgesCreated: number;
  mergesPerformed: number;
  aliasesAdded: number;
  graphRevisionId: string;
}

// ═══════════════════════════════════════════════════════
// ENTITY RESOLVER
// ═══════════════════════════════════════════════════════

/**
 * EntityResolver — normalize, find duplicates, merge entities.
 *
 * Per PLAN.md §Entity Resolution:
 * - Normalization of names
 * - Find duplicates by name similarity
 * - Merge entities with audit trail
 * - Resolve aliases
 */
export class EntityResolver {
  private readonly store: GraphStore;
  private readonly options: Required<GraphBuildOptions>;

  constructor(store: GraphStore, options: GraphBuildOptions = {}) {
    this.store = store;
    this.options = {
      similarityThreshold: options.similarityThreshold ?? 0.75,
      llmConfirmMerges: options.llmConfirmMerges ?? false,
      maxNameLength: options.maxNameLength ?? 200,
    };
  }

  /**
   * Normalize an entity name for comparison.
   * Lowercase, trim, remove honorifics, normalize whitespace.
   */
  normalize(name: string): string {
    let n = name.trim().toLowerCase();

    // Remove common honorifics/prefixes
    const prefixes = [
      "dr\\.", "dra\\.", "prof\\.", "ing\\.",
      "sr\\.", "sra\\.", "lic\\.", "msc\\.", "phd\\.",
    ];
    for (const prefix of prefixes) {
      n = n.replace(new RegExp(`^${prefix}\\s*`, "i"), "");
    }

    // Normalize whitespace
    n = n.replace(/\s+/g, " ").trim();

    // Truncate
    if (n.length > this.options.maxNameLength) {
      n = n.slice(0, this.options.maxNameLength);
    }

    return n;
  }

  /**
   * Find duplicate entity pairs among a list of entities.
   * Uses normalized name similarity (Sørensen–Dice coefficient on bigrams).
   */
  findDuplicates(entities: Entity[]): MergeCandidate[] {
    const candidates: MergeCandidate[] = [];
    const seen = new Set<string>();

    for (let i = 0; i < entities.length; i++) {
      for (let j = i + 1; j < entities.length; j++) {
        const a = entities[i];
        const b = entities[j];

        // Skip if different types
        if (a.type !== b.type) continue;

        // Skip already absorbed entities
        if (a.merged_into || b.merged_into) continue;

        const pairKey = [a.id, b.id].sort().join(":");
        if (seen.has(pairKey)) continue;
        seen.add(pairKey);

        const normA = this.normalize(a.name);
        const normB = this.normalize(b.name);

        // Exact match after normalization
        if (normA === normB) {
          candidates.push({
            entityA: a,
            entityB: b,
            confidence: 1.0,
            reason: "name_exact_match",
            reason_detail: `Normalized names match: "${normA}"`,
          });
          continue;
        }

        // Bigram similarity
        const sim = diceCoefficient(normA, normB);
        if (sim >= this.options.similarityThreshold) {
          candidates.push({
            entityA: a,
            entityB: b,
            confidence: sim,
            reason: "name_similarity",
            reason_detail: `Dice similarity=${sim.toFixed(3)} between "${normA}" and "${normB}"`,
          });
        }
      }
    }

    // Sort by confidence descending (merge most confident first)
    candidates.sort((a, b) => b.confidence - a.confidence);
    return candidates;
  }

  /**
   * Merge a pair of entities. The entity with the longer name is kept
   * (it's usually more descriptive).
   *
   * Returns the kept entity ID, or null if merge was skipped.
   */
  merge(candidate: MergeCandidate): string | null {
    const { entityA, entityB, confidence, reason, reason_detail } = candidate;

    // Keep the entity with the longer (more descriptive) name
    const [kept, merged] =
      entityA.name.length >= entityB.name.length
        ? [entityA, entityB]
        : [entityB, entityA];

    // Perform merge via GraphStore (handles edges, claims, aliases, FTS, merged_into)
    this.store.mergeEntities(
      kept.id,
      merged.id,
      confidence,
      reason,
      reason_detail
    );

    return kept.id;
  }
}

// ═══════════════════════════════════════════════════════
// CORE: buildKnowledgeGraph
// ═══════════════════════════════════════════════════════

/**
 * Build the knowledge graph from claims.
 *
 * Pipeline:
 * 1. Load all claims from DB
 * 2. Extract unique entities from claim subjects and objects
 * 3. Create entities (with type matching against entity_types)
 * 4. Create edges from claims (subject → predicate → object)
 * 5. Link claims to entities and edges (provenance)
 * 6. Run entity resolution (dedup)
 * 7. Add aliases from normalized variants
 * 8. Compute graph_revision_id
 *
 * @param store - GraphStore with claims and entity_types already present
 * @param llm - LLMClient (for optional LLM-confirmed merges, v2)
 * @param options - Graph build options
 */
export async function buildKnowledgeGraph(
  store: GraphStore,
  _llm: LLMClient,
  options: GraphBuildOptions = {}
): Promise<GraphBuildResult> {
  // 1. Load all claims
  const allDocs = store.getAllDocuments();
  const allClaims: Claim[] = [];
  for (const doc of allDocs) {
    const chunks = store.getChunksByDocument(doc.id);
    for (const chunk of chunks) {
      const claims = getClaimsByChunk(store, chunk.id);
      allClaims.push(...claims);
    }
  }

  if (allClaims.length === 0) {
    return {
      entitiesCreated: 0,
      edgesCreated: 0,
      mergesPerformed: 0,
      aliasesAdded: 0,
      graphRevisionId: store.computeGraphRevisionId(),
    };
  }

  // 2. Load entity types for type matching
  const entityTypes = getEntityTypes(store);
  const entityTypeNames = new Set(entityTypes.map((et) => et.name));

  // 3. Extract unique entities from claims
  const entityMap = extractEntitiesFromClaims(allClaims, entityTypeNames);

  // 4. Create entities in DB
  let entitiesCreated = 0;
  const nameToEntityId = new Map<string, string>();

  for (const [normalizedName, rawEntity] of entityMap) {
    const entityId = store.addEntity({
      id: stableId("entity", rawEntity.type, normalizedName),
      type: rawEntity.type,
      name: rawEntity.name,
      attributes: rawEntity.attributes
        ? JSON.stringify(rawEntity.attributes)
        : undefined,
    });

    nameToEntityId.set(normalizedName, entityId);

    // Add the original name as an alias
    store.addAlias(entityId, rawEntity.name, "llm_extraction");

    // Link claims to entity
    if (rawEntity.source_claim_ids) {
      for (const claimId of rawEntity.source_claim_ids) {
        store.linkClaimToEntity(entityId, claimId);
      }
    }

    entitiesCreated++;
  }

  // 5. Create edges from claims
  let edgesCreated = 0;
  const edgeTypes = getEdgeTypes(store);
  const edgeTypeNames = new Set(edgeTypes.map((et) => et.name));

  for (const claim of allClaims) {
    const subjectNorm = normalizeName(claim.subject);
    const objectNorm = normalizeName(claim.object);

    const sourceId = nameToEntityId.get(subjectNorm);
    const targetId = nameToEntityId.get(objectNorm);

    // Only create edge if both subject and object are known entities
    if (sourceId && targetId) {
      const edgeType = normalizeEdgeType(claim.predicate);
      // Register edge type if not already known
      if (!edgeTypeNames.has(edgeType)) {
        store.addEdgeType({
          name: edgeType,
          description: claim.predicate,
        });
        edgeTypeNames.add(edgeType);
      }

      const edgeId = store.addEdge({
        id: stableId("edge", edgeType, sourceId, targetId, claim.id),
        type: edgeType,
        source_id: sourceId,
        target_id: targetId,
        confidence: claim.confidence,
        valid_from: claim.valid_from,
        valid_to: claim.valid_to,
      });

      store.linkClaimToEdge(edgeId, claim.id);
      edgesCreated++;
    }
  }

  // 6. Entity resolution (dedup)
  const resolver = new EntityResolver(store, options);

  // Get all active entities for dedup
  const allEntities = getAllActiveEntities(store);
  const duplicates = resolver.findDuplicates(allEntities);

  let mergesPerformed = 0;
  const mergedIds = new Set<string>();

  for (const candidate of duplicates) {
    // Skip if either entity was already merged in this pass
    if (mergedIds.has(candidate.entityA.id) || mergedIds.has(candidate.entityB.id)) {
      continue;
    }

    const keptId = resolver.merge(candidate);
    if (keptId) {
      const mergedId =
        keptId === candidate.entityA.id
          ? candidate.entityB.id
          : candidate.entityA.id;
      mergedIds.add(mergedId);
      mergesPerformed++;
    }
  }

  // 7. Add aliases from normalized name variants
  let aliasesAdded = 0;
  const remainingEntities = getAllActiveEntities(store);
  for (const entity of remainingEntities) {
    const normalized = normalizeName(entity.name);
    if (normalized !== entity.name.toLowerCase()) {
      store.addAlias(entity.id, normalized, "normalization");
      aliasesAdded++;
    }
  }

  // 8. Compute graph revision
  const graphRevisionId = store.computeGraphRevisionId();

  return {
    entitiesCreated,
    edgesCreated,
    mergesPerformed,
    aliasesAdded,
    graphRevisionId,
  };
}

// ═══════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════

/**
 * Extract unique entities from claims.
 * Groups by normalized name, accumulates claim IDs.
 */
function extractEntitiesFromClaims(
  claims: Claim[],
  entityTypeNames: Set<string>
): Map<string, RawEntity> {
  const entityMap = new Map<string, RawEntity>();

  for (const claim of claims) {
    // Subject entity
    const subjectNorm = normalizeName(claim.subject);
    if (!entityMap.has(subjectNorm)) {
      entityMap.set(subjectNorm, {
        name: claim.subject,
        type: guessEntityType(claim.subject, entityTypeNames),
        source_claim_ids: [claim.id],
      });
    } else {
      entityMap.get(subjectNorm)!.source_claim_ids!.push(claim.id);
    }

    // Object entity — only if it looks like a named entity (not a generic value)
    if (looksLikeEntity(claim.object)) {
      const objectNorm = normalizeName(claim.object);
      if (!entityMap.has(objectNorm)) {
        entityMap.set(objectNorm, {
          name: claim.object,
          type: guessEntityType(claim.object, entityTypeNames),
          source_claim_ids: [claim.id],
        });
      } else {
        entityMap.get(objectNorm)!.source_claim_ids!.push(claim.id);
      }
    }
  }

  return entityMap;
}

/**
 * Guess entity type from a name string.
 * Uses simple heuristics. LLM-based typing can be added in v2.
 */
function guessEntityType(
  name: string,
  knownTypes: Set<string>
): string {
  const lower = name.toLowerCase();

  // Check for organization indicators
  const orgIndicators = [
    "universidad", "university", "asociación", "association",
    "ministerio", "ministry", "federación", "federation",
    "sindicato", "union", "consejo", "council", "congreso",
    "unesco", "onu", "un", "organización", "organization",
    "radio", "tv", "periódico", "newspaper",
  ];
  for (const indicator of orgIndicators) {
    if (lower.includes(indicator)) {
      if (knownTypes.has("university") && lower.includes("universidad")) return "university";
      if (knownTypes.has("government_body") && (lower.includes("ministerio") || lower.includes("congreso"))) return "government_body";
      if (knownTypes.has("media_outlet") && (lower.includes("radio") || lower.includes("tv"))) return "media_outlet";
      if (knownTypes.has("organization")) return "organization";
      return resolveFallbackEntityType(knownTypes);
    }
  }

  // Default to person (most common entity in social scenarios)
  if (knownTypes.has("person")) return "person";
  return resolveFallbackEntityType(knownTypes);
}

function resolveFallbackEntityType(knownTypes: Set<string>): string {
  const preferred = [
    "person",
    "organization",
    "institution",
    "entity",
  ];
  for (const candidate of preferred) {
    if (knownTypes.has(candidate)) return candidate;
  }
  const first = knownTypes.values().next();
  return first.done ? "person" : first.value;
}

/**
 * Check if a claim object looks like a named entity (not a generic value).
 * Named entities typically start with uppercase or are multi-word.
 */
function looksLikeEntity(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 2) return false;

  // Purely numeric values are not entities
  if (/^\d+[\d.,% ]*$/.test(trimmed)) return false;

  // Very short single-word values are likely attribute values, not entities
  if (!trimmed.includes(" ") && trimmed.length < 5) return false;

  // Starts with uppercase → likely a proper noun / entity
  if (/^[A-ZÁÉÍÓÚÑÜ]/.test(trimmed)) return true;

  // Contains multiple words with at least one capitalized → likely entity
  const words = trimmed.split(/\s+/);
  if (words.length >= 2 && words.some((w) => /^[A-ZÁÉÍÓÚÑÜ]/.test(w))) return true;

  return false;
}

/**
 * Normalize a name for dedup comparison.
 */
function normalizeName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/**
 * Normalize a predicate into an edge type name.
 */
function normalizeEdgeType(predicate: string): string {
  return predicate
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-záéíóúñü0-9_]/g, "");
}

/**
 * Sørensen–Dice coefficient on character bigrams.
 * Returns similarity between 0.0 and 1.0.
 */
export function diceCoefficient(a: string, b: string): number {
  if (a === b) return 1.0;
  if (a.length < 2 || b.length < 2) return 0.0;

  const bigramsA = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const bigram = a.slice(i, i + 2);
    bigramsA.set(bigram, (bigramsA.get(bigram) ?? 0) + 1);
  }

  let intersectionSize = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const bigram = b.slice(i, i + 2);
    const count = bigramsA.get(bigram);
    if (count && count > 0) {
      bigramsA.set(bigram, count - 1);
      intersectionSize++;
    }
  }

  return (2.0 * intersectionSize) / (a.length - 1 + b.length - 1);
}

// ═══════════════════════════════════════════════════════
// DB QUERY HELPERS (via GraphStore interface)
// ═══════════════════════════════════════════════════════

/**
 * Get claims linked to a specific chunk.
 */
function getClaimsByChunk(store: GraphStore, chunkId: string): Claim[] {
  return store.getClaimsByChunk(chunkId);
}

/**
 * Get all entity types from DB.
 */
function getEntityTypes(store: GraphStore): EntityType[] {
  return store.getEntityTypes();
}

/**
 * Get all edge types from DB.
 */
function getEdgeTypes(store: GraphStore): EdgeType[] {
  return store.getEdgeTypes();
}

/**
 * Get all active (non-merged) entities from DB.
 */
function getAllActiveEntities(store: GraphStore): Entity[] {
  return store.getAllActiveEntities();
}
