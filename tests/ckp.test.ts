/**
 * ckp.test.ts — Tests for CKP export/import module
 *
 * Covers scrubSecrets, exportAgent, importAgent.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";
import { SQLiteGraphStore } from "../src/db.js";
import { scrubSecrets, scrubSecretsInText, exportAgent, importAgent } from "../src/ckp.js";

// ═══════════════════════════════════════════════════════
// TEST HELPERS
// ═══════════════════════════════════════════════════════

function setupTestStore(): {
  store: SQLiteGraphStore;
  runId: string;
  actorId: string;
} {
  const store = new SQLiteGraphStore(":memory:");
  const runId = "test-run";
  store.createRun({
    id: runId,
    started_at: new Date().toISOString(),
    seed: 42,
    config_snapshot: "{}",
    graph_revision_id: "test",
    status: "completed",
    total_rounds: 10,
  });
  const actorId = "actor-1";
  store.addActor({
    id: actorId,
    run_id: runId,
    entity_id: null,
    archetype: "persona",
    cognition_tier: "A",
    name: "Test Actor",
    handle: "testactor",
    personality: "A curious researcher who values data. Backup key sk-secret123. Auth header Bearer tok_abc.",
    bio: "Test bio",
    age: 30,
    gender: "non-binary",
    profession: "researcher",
    region: "US",
    language: "en",
    stance: "neutral",
    sentiment_bias: 0.1,
    activity_level: 0.7,
    influence_weight: 0.5,
    community_id: null,
    active_hours: JSON.stringify([9, 10, 11, 14, 15, 16]),
    follower_count: 100,
    following_count: 50,
  });
  store.addActor({
    id: "actor-2",
    run_id: runId,
    entity_id: null,
    archetype: "media",
    cognition_tier: "B",
    name: "Other Actor",
    handle: "otheractor",
    personality: "A skeptical local journalist.",
    bio: "Other bio",
    age: 41,
    gender: "female",
    profession: "journalist",
    region: "US",
    language: "en",
    stance: "critical",
    sentiment_bias: -0.4,
    activity_level: 0.6,
    influence_weight: 0.4,
    community_id: null,
    active_hours: JSON.stringify([8, 9, 10, 18, 19]),
    follower_count: 80,
    following_count: 40,
  });
  store.addActorBelief(actorId, "education", 0.3);
  store.addActorBelief(actorId, "climate", -0.5);
  store.addActorTopic(actorId, "education", 0.8);
  store.addActorTopic(actorId, "climate", 0.6);
  store.addPost({
    id: "post-1",
    run_id: runId,
    author_id: actorId,
    content: "Tuition policy needs public scrutiny before the vote.",
    post_kind: "post",
    round_num: 2,
    sim_timestamp: "2026-03-01T10:00:00.000Z",
    likes: 4,
    reposts: 2,
    comments: 1,
    reach: 18,
    sentiment: 0.2,
  });
  store.addPostTopic("post-1", "education");
  store.addPost({
    id: "post-2",
    run_id: runId,
    author_id: "actor-2",
    content: "Budget cuts could backfire politically if they hit students first.",
    post_kind: "quote",
    round_num: 3,
    sim_timestamp: "2026-03-01T11:00:00.000Z",
    likes: 3,
    reposts: 1,
    comments: 2,
    reach: 12,
    sentiment: -0.4,
  });
  store.addPostTopic("post-2", "education");
  store.addExposure({
    actor_id: actorId,
    post_id: "post-2",
    round_num: 3,
    run_id: runId,
    reaction: "liked",
  });
  store.cacheDecision({
    id: "decision-1",
    run_id: runId,
    round_num: 4,
    actor_id: actorId,
    request_hash: "hash-1",
    raw_response: "{\"action\":\"post\",\"reasoning\":\"Escalate the issue carefully.\"}",
    parsed_decision: JSON.stringify({
      action: "post",
      content: "Public pressure is building around tuition policy.",
      reasoning: "Escalate the issue carefully.",
    }),
    model_id: "claude-test",
    prompt_version: "v1",
    tokens_input: 120,
    tokens_output: 40,
    duration_ms: 900,
  });
  store.addActorMemory({
    id: "memory-1",
    run_id: runId,
    actor_id: actorId,
    round_num: 3,
    kind: "reflection",
    summary: "You decided to challenge the official narrative after repeated criticism.",
    salience: 0.9,
    topic: "education",
  });
  return { store, runId, actorId };
}

// ═══════════════════════════════════════════════════════
// TEMP DIR MANAGEMENT
// ═══════════════════════════════════════════════════════

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ckp-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true });
    }
  }
  tempDirs.length = 0;
});

// ═══════════════════════════════════════════════════════
// scrubSecrets
// ═══════════════════════════════════════════════════════

describe("scrubSecrets", () => {
  it("redacts API key values", () => {
    const input = { apiKey: "sk-12345" };
    const result = scrubSecrets(input);
    expect(result.apiKey).toBe("[REDACTED]");
  });

  it("redacts nested secret keys", () => {
    const input = { config: { token: "abc123", name: "safe" } };
    const result = scrubSecrets(input);
    expect(result.config.token).toBe("[REDACTED]");
    expect(result.config.name).toBe("safe");
  });

  it("does not mutate original", () => {
    const input = { apiKey: "sk-12345", nested: { secret: "value" } };
    const original = JSON.parse(JSON.stringify(input));
    scrubSecrets(input);
    expect(input).toEqual(original);
  });

  it("redacts string values with known prefixes", () => {
    const input = { value: "sk-abcdef1234567890abcdefgh" };
    const result = scrubSecrets(input);
    expect(result.value).toBe("[REDACTED]");
  });

  it("passes through safe values unchanged", () => {
    const input = { name: "test", count: 42 };
    const result = scrubSecrets(input);
    expect(result).toEqual({ name: "test", count: 42 });
  });

  it("redacts known secret patterns in plain text", () => {
    const text = "Use token sk-secret123 and header Bearer abc.def";
    expect(scrubSecretsInText(text)).toContain("[REDACTED]");
    expect(scrubSecretsInText(text)).not.toContain("sk-secret123");
    expect(scrubSecretsInText(text)).not.toContain("Bearer abc.def");
  });
});

// ═══════════════════════════════════════════════════════
// exportAgent
// ═══════════════════════════════════════════════════════

describe("exportAgent", () => {
  it("generates all expected files", () => {
    const { store, runId, actorId } = setupTestStore();
    const outDir = join(makeTempDir(), "export");

    const result = exportAgent(store, runId, actorId, outDir);

    expect(result.files).toHaveLength(11);
    expect(result.memoriesExported).toBe(1);
    expect(result.postsExported).toBe(1);
    expect(result.exposuresExported).toBe(1);
    expect(result.decisionsExported).toBe(1);
    const expectedFiles = [
      "claw.yaml",
      "actor_state.json",
      "beliefs.json",
      "topics.json",
      "memories.json",
      "posts.json",
      "exposures.json",
      "decisions.json",
      "provenance.json",
      "persona.md",
      "manifest.meta.json",
    ];
    for (const file of expectedFiles) {
      expect(existsSync(join(outDir, file))).toBe(true);
    }
    expect(result.actorId).toBe(actorId);
    expect(result.outDir).toBe(outDir);
  });

  it("creates valid CKP agent card in claw.yaml", () => {
    const { store, runId, actorId } = setupTestStore();
    const outDir = join(makeTempDir(), "export");

    exportAgent(store, runId, actorId, outDir);

    const clawYaml = YAML.parse(
      readFileSync(join(outDir, "claw.yaml"), "utf-8"),
    );
    expect(clawYaml).toHaveProperty("name");
    expect(clawYaml).toHaveProperty("version");
    expect(clawYaml.apiVersion).toBe("ckp/v1alpha1");
    expect(clawYaml.kind).toBe("AgentCard");
  });

  it("exports correct beliefs", () => {
    const { store, runId, actorId } = setupTestStore();
    const outDir = join(makeTempDir(), "export");

    exportAgent(store, runId, actorId, outDir);

    const beliefs = JSON.parse(
      readFileSync(join(outDir, "beliefs.json"), "utf-8"),
    );
    expect(beliefs).toHaveLength(2);

    const education = beliefs.find(
      (b: { topic: string }) => b.topic === "education",
    );
    const climate = beliefs.find(
      (b: { topic: string }) => b.topic === "climate",
    );
    expect(education).toBeDefined();
    expect(education.sentiment).toBe(0.3);
    expect(climate).toBeDefined();
    expect(climate.sentiment).toBe(-0.5);
  });

  it("exports actor memories when present", () => {
    const { store, runId, actorId } = setupTestStore();
    const outDir = join(makeTempDir(), "export");

    exportAgent(store, runId, actorId, outDir);

    const memories = JSON.parse(
      readFileSync(join(outDir, "memories.json"), "utf-8"),
    );
    expect(memories).toHaveLength(1);
    expect(memories[0].kind).toBe("reflection");
    expect(memories[0].summary).toContain("official narrative");
    expect(memories[0].topic).toBe("education");
  });

  it("exports posts, exposures, and decision traces", () => {
    const { store, runId, actorId } = setupTestStore();
    const outDir = join(makeTempDir(), "export");

    exportAgent(store, runId, actorId, outDir);

    const posts = JSON.parse(
      readFileSync(join(outDir, "posts.json"), "utf-8"),
    );
    const exposures = JSON.parse(
      readFileSync(join(outDir, "exposures.json"), "utf-8"),
    );
    const decisions = JSON.parse(
      readFileSync(join(outDir, "decisions.json"), "utf-8"),
    );

    expect(posts).toHaveLength(1);
    expect(posts[0].post_kind).toBe("post");
    expect(posts[0].topics).toEqual(["education"]);

    expect(exposures).toHaveLength(1);
    expect(exposures[0].reaction).toBe("liked");
    expect(exposures[0].post_author_id).toBe("actor-2");

    expect(decisions).toHaveLength(1);
    expect(decisions[0].action).toBe("post");
    expect(decisions[0].reasoning).toContain("Escalate");
    expect(decisions[0].tokens_input).toBe(120);
  });

  it("scrubs secrets from exported JSON", () => {
    const { store, runId, actorId } = setupTestStore();
    const outDir = join(makeTempDir(), "export");

    exportAgent(store, runId, actorId, outDir);

    // Verify none of the JSON files contain known secret patterns
    const jsonFiles = [
      "actor_state.json",
      "beliefs.json",
      "topics.json",
      "provenance.json",
      "manifest.meta.json",
    ];
    for (const file of jsonFiles) {
      const content = readFileSync(join(outDir, file), "utf-8");
      expect(content).not.toMatch(/sk-[a-zA-Z0-9]/);
      expect(content).not.toMatch(/^Bearer /m);
      expect(content).not.toMatch(/ghp_/);
      expect(content).not.toMatch(/xoxb-/);
    }
  });

  it("throws on missing actor", () => {
    const { store, runId } = setupTestStore();
    const outDir = join(makeTempDir(), "export");

    expect(() => exportAgent(store, runId, "nonexistent", outDir)).toThrow(
      "Actor not found: nonexistent",
    );
  });

  it("scrubs secrets from persona.md and claw.yaml", () => {
    const { store, runId, actorId } = setupTestStore();
    const outDir = join(makeTempDir(), "export");
    exportAgent(store, runId, actorId, outDir);

    const persona = readFileSync(join(outDir, "persona.md"), "utf-8");
    const clawYaml = readFileSync(join(outDir, "claw.yaml"), "utf-8");

    expect(persona).toContain("[REDACTED]");
    expect(persona).not.toContain("sk-secret123");
    expect(clawYaml).not.toContain("sk-secret123");
    expect(clawYaml).not.toContain("Bearer tok_abc");
  });
});

// ═══════════════════════════════════════════════════════
// importAgent
// ═══════════════════════════════════════════════════════

describe("importAgent", () => {
  it("reconstitutes actor with beliefs and topics", () => {
    const { store, runId, actorId } = setupTestStore();
    const outDir = join(makeTempDir(), "export");

    // Export first
    exportAgent(store, runId, actorId, outDir);

    // Import into a fresh run
    const importRunId = "import-run";
    store.createRun({
      id: importRunId,
      started_at: new Date().toISOString(),
      seed: 99,
      config_snapshot: "{}",
      graph_revision_id: "import-test",
      status: "completed",
      total_rounds: 5,
    });

    const result = importAgent(store, importRunId, outDir);

    expect(result.name).toBe("Test Actor");
    expect(result.beliefsImported).toBe(2);
    expect(result.topicsImported).toBe(2);
    expect(result.memoriesImported).toBe(1);
    expect(result.postsImported).toBe(1);
    expect(result.exposuresImported).toBe(1);
    expect(result.decisionsImported).toBe(1);

    // Verify the actor exists in the store
    const importedActor = store.getActor(result.actorId);
    expect(importedActor).not.toBeNull();
    expect(importedActor!.name).toBe("Test Actor");
    expect(importedActor!.run_id).toBe(importRunId);

    // Verify beliefs and topics were imported
    const context = store.queryActorContext(result.actorId, importRunId);
    expect(context.beliefs).toHaveLength(2);
    expect(context.topics).toHaveLength(2);

    const educationBelief = context.beliefs.find((b) => b.topic === "education");
    expect(educationBelief).toBeDefined();
    expect(educationBelief!.sentiment).toBe(0.3);

    const memories = store.getActorMemories(result.actorId, importRunId, 10);
    expect(memories).toHaveLength(4);
    expect(memories.some((memory) => memory.summary.includes("official narrative"))).toBe(true);
    expect(memories.some((memory) => memory.summary.includes("authored a post"))).toBe(true);
    expect(memories.some((memory) => memory.summary.includes("liked a quote from actor-2"))).toBe(true);
    expect(memories.some((memory) => memory.summary.includes("Decision trace"))).toBe(true);
  });

  it("generates new UUID for imported actor", () => {
    const { store, runId, actorId } = setupTestStore();
    const outDir = join(makeTempDir(), "export");

    exportAgent(store, runId, actorId, outDir);

    const importRunId = "import-run-2";
    store.createRun({
      id: importRunId,
      started_at: new Date().toISOString(),
      seed: 77,
      config_snapshot: "{}",
      graph_revision_id: "import-test-2",
      status: "completed",
      total_rounds: 5,
    });

    const result = importAgent(store, importRunId, outDir);

    expect(result.actorId).not.toBe(actorId);
    // Verify it looks like a UUID
    expect(result.actorId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("throws on missing required files", () => {
    const { store } = setupTestStore();
    const bundleDir = makeTempDir();

    // Create only partial files (missing claw.yaml, beliefs.json, topics.json)
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(
      join(bundleDir, "actor_state.json"),
      JSON.stringify({ stance: "neutral" }),
    );

    expect(() => importAgent(store, "test-run", bundleDir)).toThrow(
      "Missing required file: claw.yaml",
    );
  });

  it("imports older bundles that do not include memories.json", () => {
    const { store, runId, actorId } = setupTestStore();
    const outDir = join(makeTempDir(), "export");

    exportAgent(store, runId, actorId, outDir);
    rmSync(join(outDir, "memories.json"));
    rmSync(join(outDir, "posts.json"));
    rmSync(join(outDir, "exposures.json"));
    rmSync(join(outDir, "decisions.json"));

    const importRunId = "import-run-legacy";
    store.createRun({
      id: importRunId,
      started_at: new Date().toISOString(),
      seed: 55,
      config_snapshot: "{}",
      graph_revision_id: "import-test-legacy",
      status: "completed",
      total_rounds: 5,
    });

    const result = importAgent(store, importRunId, outDir);
    expect(result.memoriesImported).toBe(0);
    expect(result.postsImported).toBe(0);
    expect(result.exposuresImported).toBe(0);
    expect(result.decisionsImported).toBe(0);
    expect(store.getActorMemories(result.actorId, importRunId, 10)).toHaveLength(0);
  });
});
