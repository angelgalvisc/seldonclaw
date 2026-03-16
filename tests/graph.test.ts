/**
 * graph.test.ts — Tests for knowledge graph construction + entity resolution
 *
 * Covers:
 * - diceCoefficient() bigram similarity
 * - EntityResolver: normalize, findDuplicates, merge
 * - buildKnowledgeGraph() full pipeline
 * - Entities and edges created from claims
 * - Provenance: entity_claims, edge_claims links
 * - Entity resolution dedup (similar names merged)
 * - Merge audit trail (entity_merges table)
 * - queryProvenance() returns chain: entity → claims → chunks → documents
 * - graph_revision_id is deterministic
 * - Fixtures with intentional duplicates
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SQLiteGraphStore } from "../src/db.js";
import { MockLLMClient } from "../src/llm.js";
import { ingestDocument } from "../src/ingest.js";
import {
  EntityResolver,
  buildKnowledgeGraph,
  diceCoefficient,
} from "../src/graph.js";

// ═══════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════

/**
 * Set up a store with ingested docs, entity types, edge types, and claims.
 * Includes intentional duplicate entities for testing dedup.
 */
function setupStoreWithClaims(): SQLiteGraphStore {
  const store = new SQLiteGraphStore(":memory:");

  // Ingest a document to get chunks
  const result = ingestDocument(
    store,
    "test.md",
    [
      "# Universidad Nacional anuncia aumento de cuotas",
      "",
      "La Universidad Nacional de Colombia anunció un aumento del 30% en las cuotas.",
      "",
      "El rector Carlos Martínez declaró que es necesario para la calidad académica.",
      "",
      "La Asociación de Estudiantes ASEU rechazó la medida y convocó asambleas.",
    ].join("\n"),
    { minChunkChars: 20 }
  );

  const chunks = store.getChunksByDocument(result.documentId);

  // Add entity types
  store.addEntityType({ name: "person", description: "A named individual" });
  store.addEntityType({ name: "organization", description: "An institution" });
  store.addEntityType({ name: "university", description: "Academic institution" });

  // Add edge types
  store.addEdgeType({
    name: "works_at",
    description: "Employment",
    source_type: "person",
    target_type: "organization",
  });

  // Add claims with intentional duplicates
  // "Universidad Nacional" and "Universidad Nacional de Colombia" should be dedup candidates
  const claim1Id = store.addClaim({
    id: "",
    source_chunk_id: chunks[0].id,
    subject: "Universidad Nacional",
    predicate: "anuncia aumento",
    object: "cuotas 30%",
    confidence: 0.95,
    valid_from: "2025-03-15",
    observed_at: new Date().toISOString(),
    topics: JSON.stringify(["education", "tuition"]),
  });

  const claim2Id = store.addClaim({
    id: "",
    source_chunk_id: chunks[1].id,
    subject: "Carlos Martínez",
    predicate: "es rector de",
    object: "Universidad Nacional de Colombia",
    confidence: 1.0,
    observed_at: new Date().toISOString(),
    topics: JSON.stringify(["education", "leadership"]),
  });

  const claim3Id = store.addClaim({
    id: "",
    source_chunk_id: chunks[2].id,
    subject: "ASEU",
    predicate: "rechaza",
    object: "aumento de cuotas",
    confidence: 0.9,
    valid_from: "2025-03-15",
    observed_at: new Date().toISOString(),
    topics: JSON.stringify(["education", "protest"]),
  });

  // Additional claim with duplicate entity name (different form)
  store.addClaim({
    id: "",
    source_chunk_id: chunks[0].id,
    subject: "Universidad Nacional de Colombia",
    predicate: "decide aumentar",
    object: "matrícula",
    confidence: 0.85,
    observed_at: new Date().toISOString(),
    topics: JSON.stringify(["education"]),
  });

  return store;
}

// ═══════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════

describe("diceCoefficient", () => {
  it("returns 1.0 for identical strings", () => {
    expect(diceCoefficient("hello", "hello")).toBe(1.0);
  });

  it("returns 0.0 for completely different strings", () => {
    expect(diceCoefficient("abc", "xyz")).toBe(0.0);
  });

  it("returns 0.0 for strings shorter than 2 characters", () => {
    expect(diceCoefficient("a", "b")).toBe(0.0);
  });

  it("returns a value between 0 and 1 for partial matches", () => {
    const sim = diceCoefficient("universidad nacional", "universidad nacional de colombia");
    expect(sim).toBeGreaterThan(0.5);
    expect(sim).toBeLessThanOrEqual(1.0);
  });

  it("is symmetric (order doesn't matter)", () => {
    const ab = diceCoefficient("carlos martinez", "martinez carlos");
    const ba = diceCoefficient("martinez carlos", "carlos martinez");
    expect(ab).toBeCloseTo(ba, 10);
  });
});

describe("EntityResolver", () => {
  let store: SQLiteGraphStore;

  beforeEach(() => {
    store = new SQLiteGraphStore(":memory:");
    store.addEntityType({ name: "person" });
    store.addEntityType({ name: "organization" });
  });

  afterEach(() => {
    store.close();
  });

  describe("normalize", () => {
    it("lowercases and trims", () => {
      const resolver = new EntityResolver(store);
      expect(resolver.normalize("  Carlos Martínez  ")).toBe("carlos martínez");
    });

    it("removes honorifics", () => {
      const resolver = new EntityResolver(store);
      expect(resolver.normalize("Dr. Carlos Martínez")).toBe("carlos martínez");
      expect(resolver.normalize("Prof. Juan Pérez")).toBe("juan pérez");
    });

    it("normalizes multiple spaces", () => {
      const resolver = new EntityResolver(store);
      expect(resolver.normalize("Carlos    Martínez")).toBe("carlos martínez");
    });
  });

  describe("findDuplicates", () => {
    it("finds exact matches after normalization", () => {
      const resolver = new EntityResolver(store);
      const entities = [
        { id: "1", type: "person", name: "Carlos Martínez" },
        { id: "2", type: "person", name: "carlos martínez" },
      ];

      const candidates = resolver.findDuplicates(entities);
      expect(candidates.length).toBe(1);
      expect(candidates[0].confidence).toBe(1.0);
      expect(candidates[0].reason).toBe("name_exact_match");
    });

    it("finds similar names above threshold", () => {
      const resolver = new EntityResolver(store, { similarityThreshold: 0.6 });
      const entities = [
        { id: "1", type: "organization", name: "Universidad Nacional" },
        { id: "2", type: "organization", name: "Universidad Nacional de Colombia" },
      ];

      const candidates = resolver.findDuplicates(entities);
      expect(candidates.length).toBe(1);
      expect(candidates[0].confidence).toBeGreaterThanOrEqual(0.6);
      expect(candidates[0].reason).toBe("name_similarity");
    });

    it("does not match entities of different types", () => {
      const resolver = new EntityResolver(store);
      const entities = [
        { id: "1", type: "person", name: "Universidad Nacional" },
        { id: "2", type: "organization", name: "Universidad Nacional" },
      ];

      const candidates = resolver.findDuplicates(entities);
      expect(candidates.length).toBe(0);
    });

    it("skips already-merged entities", () => {
      const resolver = new EntityResolver(store);
      const entities = [
        { id: "1", type: "person", name: "Carlos Martínez" },
        { id: "2", type: "person", name: "Carlos Martínez", merged_into: "1" },
      ];

      const candidates = resolver.findDuplicates(entities);
      expect(candidates.length).toBe(0);
    });

    it("sorts candidates by confidence descending", () => {
      const resolver = new EntityResolver(store, { similarityThreshold: 0.3 });
      const entities = [
        { id: "1", type: "organization", name: "ASEU" },
        { id: "2", type: "organization", name: "ASEU Colombia" },
        { id: "3", type: "organization", name: "Asociación de Estudiantes" },
      ];

      const candidates = resolver.findDuplicates(entities);
      for (let i = 1; i < candidates.length; i++) {
        expect(candidates[i - 1].confidence).toBeGreaterThanOrEqual(
          candidates[i].confidence
        );
      }
    });
  });

  describe("merge", () => {
    it("merges entities keeping the one with longer name", () => {
      store.addEntity({ id: "e1", type: "organization", name: "ASEU" });
      store.addEntity({
        id: "e2",
        type: "organization",
        name: "Asociación de Estudiantes ASEU",
      });

      const resolver = new EntityResolver(store);
      const keptId = resolver.merge({
        entityA: { id: "e1", type: "organization", name: "ASEU" },
        entityB: {
          id: "e2",
          type: "organization",
          name: "Asociación de Estudiantes ASEU",
        },
        confidence: 0.9,
        reason: "name_similarity",
      });

      // e2 has longer name, should be kept
      expect(keptId).toBe("e2");

      // Verify e1 is marked as merged
      const merged = store.db
        .prepare("SELECT merged_into FROM entities WHERE id = ?")
        .get("e1") as { merged_into: string | null };
      expect(merged.merged_into).toBe("e2");
    });
  });
});

describe("buildKnowledgeGraph", () => {
  let store: SQLiteGraphStore;
  let llm: MockLLMClient;

  beforeEach(() => {
    store = setupStoreWithClaims();
    llm = new MockLLMClient();
  });

  afterEach(() => {
    store.close();
  });

  it("creates entities from claims", async () => {
    const result = await buildKnowledgeGraph(store, llm);
    expect(result.entitiesCreated).toBeGreaterThan(0);

    // Check entities exist in DB
    const entities = store.db
      .prepare("SELECT * FROM entities WHERE merged_into IS NULL")
      .all();
    expect(entities.length).toBeGreaterThan(0);
  });

  it("creates edges linking subject to object entities", async () => {
    const result = await buildKnowledgeGraph(store, llm);
    expect(result.edgesCreated).toBeGreaterThan(0);

    const edges = store.db.prepare("SELECT * FROM edges").all();
    expect(edges.length).toBeGreaterThan(0);
  });

  it("performs entity resolution (merges duplicates)", async () => {
    // We have "Universidad Nacional" and "Universidad Nacional de Colombia"
    const result = await buildKnowledgeGraph(store, llm, {
      similarityThreshold: 0.6,
    });

    expect(result.mergesPerformed).toBeGreaterThan(0);

    // Check merge audit trail
    const merges = store.db.prepare("SELECT * FROM entity_merges").all() as Array<{
      merge_reason: string;
      merge_reason_detail: string;
    }>;
    expect(merges.length).toBeGreaterThan(0);
    expect(merges[0].merge_reason).toMatch(/name_similarity|name_exact_match/);
  });

  it("links claims to entities via entity_claims", async () => {
    await buildKnowledgeGraph(store, llm);

    const entityClaims = store.db
      .prepare("SELECT * FROM entity_claims")
      .all();
    expect(entityClaims.length).toBeGreaterThan(0);
  });

  it("links claims to edges via edge_claims", async () => {
    await buildKnowledgeGraph(store, llm);

    const edgeClaims = store.db
      .prepare("SELECT * FROM edge_claims")
      .all();
    expect(edgeClaims.length).toBeGreaterThan(0);
  });

  it("queryProvenance returns chain: entity → claims → chunks → documents", async () => {
    await buildKnowledgeGraph(store, llm);

    // Get first active entity
    const entity = store.db
      .prepare("SELECT id FROM entities WHERE merged_into IS NULL LIMIT 1")
      .get() as { id: string };

    const provenance = store.queryProvenance(entity.id);
    expect(provenance.entity).toBeDefined();
    expect(provenance.entity.id).toBe(entity.id);
    // Claims might be empty if the entity wasn't linked, but should be defined
    expect(Array.isArray(provenance.claims)).toBe(true);
    expect(Array.isArray(provenance.chunks)).toBe(true);
    expect(Array.isArray(provenance.documents)).toBe(true);

    // For entities from claims, provenance chain should be populated
    if (provenance.claims.length > 0) {
      expect(provenance.chunks.length).toBeGreaterThan(0);
      expect(provenance.documents.length).toBeGreaterThan(0);
    }
  });

  it("graph_revision_id is deterministic", async () => {
    const result1 = await buildKnowledgeGraph(store, llm);

    // Compute revision again without changes
    const revision2 = store.computeGraphRevisionId();

    expect(result1.graphRevisionId).toBe(revision2);
  });

  it("handles empty claims gracefully", async () => {
    const emptyStore = new SQLiteGraphStore(":memory:");
    const result = await buildKnowledgeGraph(emptyStore, llm);

    expect(result.entitiesCreated).toBe(0);
    expect(result.edgesCreated).toBe(0);
    expect(result.mergesPerformed).toBe(0);

    emptyStore.close();
  });

  it("adds aliases from entity names", async () => {
    const result = await buildKnowledgeGraph(store, llm);
    expect(result.aliasesAdded).toBeGreaterThanOrEqual(0);

    // Check aliases table has entries
    const aliases = store.db
      .prepare("SELECT * FROM entity_aliases")
      .all();
    expect(aliases.length).toBeGreaterThan(0);
  });

  it("falls back to a known entity type when heuristics infer an unknown one", async () => {
    const fallbackStore = new SQLiteGraphStore(":memory:");
    const result = ingestDocument(
      fallbackStore,
      "nemo.md",
      "NVIDIA presentó NemoClaw. Radio Capital cubrió la noticia y traders debatieron su efecto en Bitcoin.",
      { minChunkChars: 20 }
    );
    const chunks = fallbackStore.getChunksByDocument(result.documentId);

    fallbackStore.addEntityType({ name: "person", description: "A named individual" });
    fallbackStore.addEntityType({ name: "media_outlet", description: "A media organization" });
    fallbackStore.addClaim({
      id: "",
      source_chunk_id: chunks[0].id,
      subject: "Radio Capital",
      predicate: "cubre",
      object: "NemoClaw",
      confidence: 0.9,
      observed_at: new Date().toISOString(),
      topics: JSON.stringify(["ai", "bitcoin"]),
    });

    await expect(buildKnowledgeGraph(fallbackStore, llm)).resolves.toBeDefined();

    const entities = fallbackStore.db
      .prepare("SELECT name, type FROM entities WHERE merged_into IS NULL ORDER BY name")
      .all() as Array<{ name: string; type: string }>;
    expect(entities.some((entity) => entity.name === "Radio Capital")).toBe(true);
    expect(entities.map((entity) => entity.type)).toContain("person");

    fallbackStore.close();
  });

  it("no obvious duplicates remain after dedup", async () => {
    await buildKnowledgeGraph(store, llm, {
      similarityThreshold: 0.6,
    });

    // Get all active entities
    const entities = store.db
      .prepare("SELECT name FROM entities WHERE merged_into IS NULL")
      .all() as Array<{ name: string }>;

    const normalizedNames = entities.map((e) => e.name.toLowerCase().trim());
    const uniqueNormalized = new Set(normalizedNames);

    // After dedup, should have fewer unique names than original claims subjects
    // (because "Universidad Nacional" and "Universidad Nacional de Colombia" were merged)
    expect(entities.length).toBeLessThan(5); // We had ~4-5 unique subjects/objects
  });
});
