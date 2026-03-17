/**
 * ontology.ts — LLM-powered extraction of entity types, edge types, and claims
 *
 * Source of truth: PLAN.md §Ontology tables (lines 209-223),
 *                  §Project Structure (line 111)
 *
 * Pipeline:
 * 1. Collect all chunks from the database
 * 2. Extract entity_types and edge_types from representative chunks (schema discovery)
 * 3. Extract claims (subject-predicate-object triples) from each chunk
 *
 * Uses LLMClient with "analysis" provider (Anthropic native SDK).
 * All extraction uses completeJSON() for structured output.
 */

import type { GraphStore, Chunk, EntityType, EdgeType, Claim } from "./db.js";
import { stableId } from "./db.js";
import type { LLMClient } from "./llm.js";
import { mapWithConcurrency } from "./concurrency.js";

// ═══════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════

/** Raw entity type extracted by LLM before normalization */
export interface ExtractedEntityType {
  name: string;
  description: string;
  attributes: string[];
}

/** Raw edge type extracted by LLM before normalization */
export interface ExtractedEdgeType {
  name: string;
  description: string;
  source_type: string;
  target_type: string;
}

/** Raw claim extracted by LLM from a single chunk */
export interface ExtractedClaim {
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
  valid_from?: string | null;
  valid_to?: string | null;
  topics: string[];
}

export interface OntologyOptions {
  /** Max chunks to sample for schema discovery (default: 10) */
  schemaSampleSize?: number;
  /** Max chunks to process for claim extraction (0 = all, default: 0) */
  maxClaimsChunks?: number;
  /** Max concurrent LLM calls for claim extraction (default: 1) */
  pipelineConcurrency?: number;
}

export interface OntologyResult {
  entityTypes: EntityType[];
  edgeTypes: EdgeType[];
  claimsExtracted: number;
  chunksProcessed: number;
}

// ═══════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════

const DEFAULT_SCHEMA_SAMPLE_SIZE = 10;

// ═══════════════════════════════════════════════════════
// PROMPTS
// ═══════════════════════════════════════════════════════

const SCHEMA_DISCOVERY_SYSTEM = `You are an ontology extraction expert. Given text chunks from documents about a social scenario, identify the types of entities and relationships present.

Output valid JSON only. No markdown code fences.`;

function buildSchemaDiscoveryPrompt(chunkTexts: string[]): string {
  const combined = chunkTexts
    .map((t, i) => `--- Chunk ${i + 1} ---\n${t}`)
    .join("\n\n");

  return `Analyze the following document chunks and extract the ontology schema.

Identify:
1. Entity types (e.g., "person", "organization", "university", "media_outlet", "government_body")
2. Edge types (relationships between entities, e.g., "works_at", "member_of", "opposes", "supports")

For each entity type, list the relevant attributes (e.g., for "person": ["name", "role", "age", "affiliation"]).
For each edge type, specify which entity types it connects (source_type → target_type).

${combined}

Respond with this exact JSON structure:
{
  "entity_types": [
    {
      "name": "lowercase_snake_case",
      "description": "What this entity type represents",
      "attributes": ["attr1", "attr2"]
    }
  ],
  "edge_types": [
    {
      "name": "lowercase_snake_case",
      "description": "What this relationship means",
      "source_type": "entity_type_name",
      "target_type": "entity_type_name"
    }
  ]
}`;
}

const CLAIMS_EXTRACTION_SYSTEM = `You are a knowledge extraction expert. Given text chunks, extract factual claims as subject-predicate-object triples.

Each claim should be:
- Specific and verifiable
- Grounded in the source text
- Include temporal information (valid_from/valid_to) when dates are mentioned
- Include a confidence score (0.0-1.0) based on how explicit the claim is

Output valid JSON only. No markdown code fences.`;

function buildClaimsExtractionPrompt(
  chunkTexts: string[],
  entityTypes: string[]
): string {
  const combined = chunkTexts
    .map((t, i) => `--- Chunk ${i + 1} ---\n${t}`)
    .join("\n\n");

  return `Extract all factual claims from the following text chunks.

Known entity types: ${entityTypes.join(", ")}

For each claim, identify:
- subject: The entity performing the action or being described
- predicate: The action, relationship, or attribute
- object: The target entity, value, or description
- confidence: 0.0-1.0 (1.0 = explicitly stated, 0.5 = implied)
- valid_from: ISO date string if temporal start is mentioned (null otherwise)
- valid_to: ISO date string if temporal end is mentioned (null otherwise)
- topics: Array of relevant topic keywords

${combined}

Respond with this exact JSON structure:
{
  "claims": [
    {
      "subject": "Entity name",
      "predicate": "action or relationship",
      "object": "target or value",
      "confidence": 0.9,
      "valid_from": "2025-03-15" or null,
      "valid_to": null,
      "topics": ["education", "tuition"]
    }
  ]
}`;
}

// ═══════════════════════════════════════════════════════
// CORE: extractOntology
// ═══════════════════════════════════════════════════════

/**
 * Run the ontology extraction pipeline.
 *
 * Steps:
 * 1. Load all chunks from the database (from all documents)
 * 2. Schema discovery: sample representative chunks → LLM → entity_types + edge_types
 * 3. Claim extraction: process chunks in batches → LLM → claims
 * 4. Persist everything to GraphStore
 *
 * @param store - GraphStore instance with documents and chunks already ingested
 * @param llm - LLMClient configured with "analysis" provider
 * @param options - Extraction options
 * @returns OntologyResult with counts
 */
export async function extractOntology(
  store: GraphStore,
  llm: LLMClient,
  options: OntologyOptions = {}
): Promise<OntologyResult> {
  // 1. Gather all chunks
  const allDocs = store.getAllDocuments();
  const allChunks: Chunk[] = [];
  for (const doc of allDocs) {
    const chunks = store.getChunksByDocument(doc.id);
    allChunks.push(...chunks);
  }

  if (allChunks.length === 0) {
    return {
      entityTypes: [],
      edgeTypes: [],
      claimsExtracted: 0,
      chunksProcessed: 0,
    };
  }

  // 2. Schema discovery from a sample of chunks
  const sampleSize = options.schemaSampleSize ?? DEFAULT_SCHEMA_SAMPLE_SIZE;
  const sampleChunks = selectRepresentativeSample(allChunks, sampleSize);
  const sampleTexts = sampleChunks.map((c) => c.content);

  const { entityTypes, edgeTypes } = await discoverSchema(llm, sampleTexts);

  // Persist entity types and edge types
  for (const et of entityTypes) {
    store.addEntityType(et);
  }
  for (const et of edgeTypes) {
    store.addEdgeType(et);
  }

  // 3. Claim extraction — each chunk gets its own LLM call for precise provenance.
  //    Chunks are processed with bounded concurrency for performance.
  const maxChunks = options.maxClaimsChunks ?? 0;
  const chunksToProcess =
    maxChunks > 0 ? allChunks.slice(0, maxChunks) : allChunks;

  const entityTypeNames = entityTypes.map((et) => et.name);
  const concurrency = Math.max(1, options.pipelineConcurrency ?? 1);

  const chunkClaims = await mapWithConcurrency(
    chunksToProcess,
    concurrency,
    async (chunk) => {
      const claims = await extractClaims(llm, [chunk.content], entityTypeNames);
      return { chunk, claims };
    }
  );

  let totalClaims = 0;
  for (const { chunk, claims } of chunkClaims) {
    for (let ci = 0; ci < claims.length; ci++) {
      const claim = claims[ci];
      store.addClaim({
        id: stableId("claim", chunk.id, claim.subject, claim.predicate, claim.object, String(ci)),
        source_chunk_id: chunk.id,
        subject: claim.subject,
        predicate: claim.predicate,
        object: claim.object,
        confidence: clampConfidence(claim.confidence),
        valid_from: claim.valid_from ?? undefined,
        valid_to: claim.valid_to ?? undefined,
        observed_at: new Date().toISOString(),
        topics: claim.topics.length > 0
          ? JSON.stringify(claim.topics)
          : undefined,
      });

      totalClaims++;
    }
  }

  return {
    entityTypes,
    edgeTypes,
    claimsExtracted: totalClaims,
    chunksProcessed: chunksToProcess.length,
  };
}

// ═══════════════════════════════════════════════════════
// INTERNAL: Schema discovery
// ═══════════════════════════════════════════════════════

interface SchemaDiscoveryResponse {
  entity_types: ExtractedEntityType[];
  edge_types: ExtractedEdgeType[];
}

/**
 * Use LLM to discover entity types and edge types from sample chunks.
 */
export async function discoverSchema(
  llm: LLMClient,
  chunkTexts: string[]
): Promise<{ entityTypes: EntityType[]; edgeTypes: EdgeType[] }> {
  const prompt = buildSchemaDiscoveryPrompt(chunkTexts);

  const result = await llm.completeJSON<SchemaDiscoveryResponse>("analysis", prompt, {
    system: SCHEMA_DISCOVERY_SYSTEM,
    temperature: 0.0,
    maxTokens: 4096,
  });

  const entityTypes: EntityType[] = (result.data.entity_types ?? []).map(
    (et) => ({
      name: normalizeTypeName(et.name),
      description: et.description,
      attributes: JSON.stringify(et.attributes ?? []),
    })
  );

  const edgeTypes: EdgeType[] = (result.data.edge_types ?? []).map((et) => ({
    name: normalizeTypeName(et.name),
    description: et.description,
    source_type: normalizeTypeName(et.source_type),
    target_type: normalizeTypeName(et.target_type),
  }));

  return { entityTypes, edgeTypes };
}

// ═══════════════════════════════════════════════════════
// INTERNAL: Claim extraction
// ═══════════════════════════════════════════════════════

interface ClaimsExtractionResponse {
  claims: ExtractedClaim[];
}

/**
 * Use LLM to extract claims from a batch of chunk texts.
 */
export async function extractClaims(
  llm: LLMClient,
  chunkTexts: string[],
  entityTypeNames: string[]
): Promise<ExtractedClaim[]> {
  const prompt = buildClaimsExtractionPrompt(chunkTexts, entityTypeNames);

  const result = await llm.completeJSON<ClaimsExtractionResponse>(
    "analysis",
    prompt,
    {
      system: CLAIMS_EXTRACTION_SYSTEM,
      temperature: 0.0,
      maxTokens: 4096,
    }
  );

  return result.data.claims ?? [];
}

// ═══════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════

/**
 * Select a representative sample of chunks.
 * Spreads selection evenly across available chunks.
 */
function selectRepresentativeSample(chunks: Chunk[], sampleSize: number): Chunk[] {
  if (chunks.length <= sampleSize) return chunks;

  const step = chunks.length / sampleSize;
  const sample: Chunk[] = [];
  for (let i = 0; i < sampleSize; i++) {
    const idx = Math.floor(i * step);
    sample.push(chunks[idx]);
  }
  return sample;
}

/**
 * Normalize a type name to lowercase_snake_case.
 */
export function normalizeTypeName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}

/**
 * Clamp confidence to [0.0, 1.0].
 */
function clampConfidence(value: number): number {
  if (typeof value !== "number" || isNaN(value)) return 0.5;
  return Math.max(0.0, Math.min(1.0, value));
}
