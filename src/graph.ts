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
  /** Type hints from cast-design pass for graph entity typing */
  entityTypeHints?: Array<{ name: string; type: string }>;
  /** Whether to validate extracted entities with the LLM (default: true) */
  validateEntities?: boolean;
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
      entityTypeHints: options.entityTypeHints ?? [],
      validateEntities: options.validateEntities ?? true,
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
  llm: LLMClient,
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

  // 3. Extract unique entities from claims (with optional type hints from cast-design)
  let entityMap = extractEntitiesFromClaims(allClaims, entityTypeNames, options.entityTypeHints);

  // 3b. Validate entities with LLM (unless disabled)
  if (options.validateEntities !== false) {
    // Gather source document text from chunks for context
    const allChunks = allDocs.flatMap((doc) => store.getChunksByDocument(doc.id));
    const sourceText = allChunks.map((c) => c.content).join("\n").slice(0, 2000);
    entityMap = await validateEntitiesWithLLM(entityMap, llm, sourceText);
  }

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
// ENTITY VALIDATION
// ═══════════════════════════════════════════════════════

interface EntityValidationEvaluation {
  original_name: string;
  verdict: "KEEP" | "REVISE" | "REMOVE";
  corrected_name?: string;
  reason?: string;
}

interface EntityValidationResponse {
  evaluations: EntityValidationEvaluation[];
}

/**
 * Validate extracted entities using the LLM.
 * Asks the LLM to evaluate each entity as KEEP/REVISE/REMOVE.
 * Filters out REMOVE entities and applies REVISE corrections.
 */
async function validateEntitiesWithLLM(
  entityMap: Map<string, RawEntity>,
  llm: LLMClient,
  sourceText: string,
): Promise<Map<string, RawEntity>> {
  if (entityMap.size === 0) return entityMap;

  const entityNames = [...entityMap.values()].map((e) => e.name);
  const entityList = entityNames.map((name, i) => `${i + 1}. "${name}"`).join("\n");

  const prompt = `You are reviewing entities extracted from a document for use in a social simulation.
Your job is to ensure only real, identifiable actors pass through.

For each entity, decide:
- KEEP: This is a real, identifiable entity that could be a social media actor
- REVISE: The entity is real but the name needs correction (provide corrected name)
- REMOVE: This is not a real entity (concept, description, generic group, etc.)

Important: be balanced in your judgments.
- Not every short name is valid (e.g., "Trading" is too generic)
- Not every long name is invalid (e.g., "International Monetary Fund" is perfectly fine)
- Organizations ARE valid entities even if they aren't people
- Generic groups without specific identity are NOT valid ("Critics", "Analysts")
- Descriptions of dynamics are NOT valid ("a supply shock as ETF demand...")

Source document context:
${sourceText.slice(0, 1500)}

Entities to evaluate:
${entityList}

Return JSON:
{
  "evaluations": [
    {"original_name": "...", "verdict": "KEEP|REVISE|REMOVE", "corrected_name": "only if REVISE", "reason": "..."}
  ]
}`;

  let response: EntityValidationResponse;
  try {
    const result = await llm.completeJSON<EntityValidationResponse>("analysis", prompt, {
      temperature: 0.0,
      maxTokens: 2048,
    });
    response = result.data;
  } catch {
    // If LLM call fails, return the original entityMap unchanged
    return entityMap;
  }

  if (!response.evaluations || !Array.isArray(response.evaluations)) {
    return entityMap;
  }

  // Build a lookup from original_name → evaluation
  const evalMap = new Map<string, EntityValidationEvaluation>();
  for (const evaluation of response.evaluations) {
    if (evaluation.original_name) {
      evalMap.set(evaluation.original_name, evaluation);
    }
  }

  const validated = new Map<string, RawEntity>();
  for (const [normalizedName, rawEntity] of entityMap) {
    const evaluation = evalMap.get(rawEntity.name);

    if (evaluation?.verdict === "REMOVE") {
      continue; // Filter out removed entities
    }

    if (evaluation?.verdict === "REVISE" && evaluation.corrected_name) {
      // Apply name correction
      const correctedNorm = evaluation.corrected_name.trim().toLowerCase().replace(/\s+/g, " ");
      validated.set(correctedNorm, {
        ...rawEntity,
        name: evaluation.corrected_name.trim(),
      });
    } else {
      // KEEP or no evaluation found — pass through unchanged
      validated.set(normalizedName, rawEntity);
    }
  }

  return validated;
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
  entityTypeNames: Set<string>,
  entityTypeHints?: Array<{ name: string; type: string }>
): Map<string, RawEntity> {
  // Build hint lookup: normalized name → type
  const hintMap = new Map<string, string>();
  if (entityTypeHints) {
    for (const hint of entityTypeHints) {
      const key = hint.name.trim().toLowerCase().replace(/\s+/g, " ");
      if (key && hint.type) hintMap.set(key, hint.type);
    }
  }

  function resolveEntityType(name: string): string {
    const normalized = name.trim().toLowerCase().replace(/\s+/g, " ");
    const hinted = hintMap.get(normalized);
    if (hinted) {
      // If the hint type is a known entity type, use it; otherwise try to match
      if (entityTypeNames.has(hinted)) return hinted;
      // Fallback: use the hint as-is if we can register it
      return hinted;
    }
    return guessEntityType(name, entityTypeNames);
  }

  const entityMap = new Map<string, RawEntity>();

  for (const claim of claims) {
    // Subject entity
    const subjectNorm = normalizeName(claim.subject);
    if (!entityMap.has(subjectNorm)) {
      entityMap.set(subjectNorm, {
        name: claim.subject,
        type: resolveEntityType(claim.subject),
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
          type: resolveEntityType(claim.object),
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
