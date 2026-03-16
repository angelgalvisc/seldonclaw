/**
 * shell.test.ts — Tests for the conversational REPL shell
 *
 * Covers:
 * - classifyIntent: interview, export, help, exit, query
 * - extractSchema: reads table schemas from SQLite
 * - executeQuery: SELECT success and non-SELECT rejection
 * - formatTable: aligned ASCII output, empty results
 * - nlToSql: LLM-generated SELECT via MockLLMClient
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SQLiteGraphStore } from "../src/db.js";
import { MockLLMClient } from "../src/llm.js";
import { MockCognitionBackend } from "../src/cognition.js";
import { defaultConfig, saveConfig } from "../src/config.js";
import { resolveProviderConfig } from "../src/provider-selection.js";
import {
  classifyIntent,
  extractSchema,
  executeQuery,
  formatTable,
  nlToSql,
  startShell,
} from "../src/shell.js";

// ═══════════════════════════════════════════════════════
// TEST HELPER
// ═══════════════════════════════════════════════════════

function setupShellStore(): { store: SQLiteGraphStore; runId: string } {
  const store = new SQLiteGraphStore(":memory:");
  const runId = "shell-run";
  store.createRun({
    id: runId,
    started_at: new Date().toISOString(),
    seed: 42,
    config_snapshot: "{}",
    graph_revision_id: "test",
    status: "completed",
    total_rounds: 5,
  });
  // Add an actor
  store.addActor({
    id: "actor-1",
    run_id: runId,
    entity_id: null,
    archetype: "persona",
    cognition_tier: "B",
    name: "Test Actor",
    handle: "testactor",
    personality: "Test personality",
    bio: null,
    age: null,
    gender: null,
    profession: null,
    region: null,
    language: "en",
    stance: "neutral",
    sentiment_bias: 0,
    activity_level: 0.5,
    influence_weight: 0.3,
    community_id: null,
    active_hours: null,
    follower_count: 10,
    following_count: 5,
  });
  // Add some posts
  for (let round = 0; round < 3; round++) {
    store.addPost({
      id: `post-${round}`,
      run_id: runId,
      author_id: "actor-1",
      content: `Post in round ${round}`,
      round_num: round,
      sim_timestamp: "2024-01-01T00:00:00",
      likes: round,
      reposts: 0,
      comments: 0,
      reach: round * 10,
      sentiment: 0,
    });
  }
  // Add round data
  for (let round = 0; round < 3; round++) {
    store.upsertRound({
      num: round,
      run_id: runId,
      active_actors: 1,
      total_posts: 1,
      total_actions: 1,
    });
  }
  return { store, runId };
}

// ═══════════════════════════════════════════════════════
// classifyIntent
// ═══════════════════════════════════════════════════════

describe("classifyIntent", () => {
  it("classifies interview commands", () => {
    const result1 = classifyIntent("interview Sarah");
    expect(result1.type).toBe("interview");
    expect(result1.args).toBe("Sarah");

    const result2 = classifyIntent("talk to Sarah");
    expect(result2.type).toBe("interview");
    expect(result2.args).toBe("Sarah");
  });

  it("classifies export commands", () => {
    const result = classifyIntent("export actor-1");
    expect(result.type).toBe("export");
    expect(result.args).toBe("actor-1");
  });

  it("classifies help and exit", () => {
    expect(classifyIntent("help").type).toBe("help");
    expect(classifyIntent("?").type).toBe("help");
    expect(classifyIntent("/clear").type).toBe("clear");
    expect(classifyIntent("exit").type).toBe("exit");
    expect(classifyIntent("/exit").type).toBe("exit");
    expect(classifyIntent("quit").type).toBe("exit");
  });

  it("classifies everything else as query", () => {
    const result = classifyIntent("how many posts");
    expect(result.type).toBe("query");
    expect(result.args).toBe("how many posts");
  });
});

// ═══════════════════════════════════════════════════════
// extractSchema
// ═══════════════════════════════════════════════════════

describe("extractSchema", () => {
  let store: SQLiteGraphStore;

  afterEach(() => {
    store.close();
  });

  it("returns table schemas from database", () => {
    ({ store } = setupShellStore());
    const schemas = extractSchema(store);

    // Should return an array of table schemas
    expect(Array.isArray(schemas)).toBe(true);
    expect(schemas.length).toBeGreaterThan(0);

    // Should include known tables like actors and posts
    const tableNames = schemas.map((s) => s.name);
    expect(tableNames).toContain("actors");
    expect(tableNames).toContain("posts");

    // Each schema should have columns
    const actorsSchema = schemas.find((s) => s.name === "actors");
    expect(actorsSchema).toBeDefined();
    expect(actorsSchema!.columns.length).toBeGreaterThan(0);

    // Columns should have name and type
    const colNames = actorsSchema!.columns.map((c) => c.name);
    expect(colNames).toContain("id");
    expect(colNames).toContain("name");
  });
});

// ═══════════════════════════════════════════════════════
// executeQuery
// ═══════════════════════════════════════════════════════

describe("executeQuery", () => {
  let store: SQLiteGraphStore;

  afterEach(() => {
    store.close();
  });

  it("executes SELECT and returns columns + rows", () => {
    ({ store } = setupShellStore());
    const { columns, rows } = executeQuery(
      store,
      "SELECT id, name FROM actors WHERE run_id = 'shell-run'"
    );

    expect(columns).toContain("id");
    expect(columns).toContain("name");
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("actor-1");
    expect(rows[0].name).toBe("Test Actor");
  });

  it("rejects non-SELECT queries", () => {
    ({ store } = setupShellStore());
    expect(() => executeQuery(store, "DROP TABLE actors")).toThrow(
      "Only SELECT queries are allowed"
    );
  });
});

// ═══════════════════════════════════════════════════════
// formatTable
// ═══════════════════════════════════════════════════════

describe("formatTable", () => {
  it("formats aligned ASCII table", () => {
    const columns = ["id", "name"];
    const rows = [
      { id: "actor-1", name: "Test Actor" },
      { id: "actor-2", name: "Another" },
    ];
    const output = formatTable(columns, rows);

    // Header should be present
    expect(output).toContain("id");
    expect(output).toContain("name");

    // Separator line with dashes
    expect(output).toMatch(/-{2,}-\+-{2,}/);

    // Data rows
    expect(output).toContain("actor-1");
    expect(output).toContain("Test Actor");
    expect(output).toContain("actor-2");
    expect(output).toContain("Another");
  });

  it("returns '(no results)' for empty data", () => {
    const output = formatTable([], []);
    expect(output).toBe("(no results)\n");
  });
});

// ═══════════════════════════════════════════════════════
// nlToSql
// ═══════════════════════════════════════════════════════

describe("nlToSql", () => {
  it("generates SELECT query with MockLLMClient", async () => {
    const llm = new MockLLMClient();
    const expectedSql = "SELECT COUNT(*) as total FROM posts";
    llm.setResponse("how many posts", expectedSql);

    const schema = [
      {
        name: "posts",
        columns: [
          { name: "id", type: "TEXT" },
          { name: "content", type: "TEXT" },
          { name: "round_num", type: "INTEGER" },
        ],
      },
    ];

    const sql = await nlToSql(llm, schema, "how many posts");
    expect(sql).toBe(expectedSql);
  });
});

describe("startShell", () => {
  it("handles natural language queries when an LLM is configured", async () => {
    const { store, runId } = setupShellStore();
    const llm = new MockLLMClient();
    llm.setResponse("how many posts", "SELECT COUNT(*) as total FROM posts WHERE run_id = 'shell-run'");

    const outputs: string[] = [];
    const errors: string[] = [];
    const prompts: string[] = [];
    const inputs = ["how many posts", "exit"];

    await startShell(
      { store, runId, llm, backend: new MockCognitionBackend() },
      {
        prompt: (text) => prompts.push(text),
        output: (text) => outputs.push(text),
        error: (text) => errors.push(text),
        readline: async () => inputs.shift() ?? "exit",
        close: () => {},
      }
    );

    const combined = outputs.join("");
    expect(prompts).toContain("publicmachina> ");
    expect(errors).toHaveLength(0);
    expect(combined).toContain("SQL: SELECT COUNT(*) as total FROM posts WHERE run_id = 'shell-run'");
    expect(combined).toContain("total");
    expect(combined).toContain("3");

    store.close();
  });

  it("supports /model switching and persists the new provider/model", async () => {
    const { store, runId } = setupShellStore();
    const dir = mkdtempSync(join(tmpdir(), "publicmachina-shell-model-"));
    const configPath = join(dir, "publicmachina.config.yaml");
    const config = defaultConfig();
    saveConfig(configPath, config);
    process.env.OPENAI_API_KEY = "test-openai-key";

    const outputs: string[] = [];
    const errors: string[] = [];
    const prompts: string[] = [];
    const inputs = ["/model provider openai", "/model", "exit"];
    let lastConfig = config;

    await startShell(
      {
        store,
        runId,
        llm: new MockLLMClient(),
        backend: new MockCognitionBackend(),
        config,
        configPath,
        onConfigUpdate: async (next) => {
          lastConfig = next;
        },
      },
      {
        prompt: (text) => prompts.push(text),
        output: (text) => outputs.push(text),
        error: (text) => errors.push(text),
        readline: async () => inputs.shift() ?? "exit",
        close: () => {},
      }
    );

    const combined = outputs.join("");
    expect(prompts).toContain("publicmachina> ");
    expect(errors).toHaveLength(0);
    expect(lastConfig.providers.default.provider).toBe("openai");
    expect(lastConfig.providers.default.model).toBe("gpt-5.4-2026-03-05");
    expect(resolveProviderConfig(lastConfig.providers, "simulation").provider).toBe("openai");
    expect(combined).toContain("Switched default provider to OpenAI");
    expect(combined).toContain("Default provider: OpenAI");
    expect(combined).toContain("GPT-5.4");

    delete process.env.OPENAI_API_KEY;
    rmSync(dir, { recursive: true, force: true });
    store.close();
  });

  it("supports role-specific /model overrides without changing the default provider", async () => {
    const { store, runId } = setupShellStore();
    const dir = mkdtempSync(join(tmpdir(), "publicmachina-shell-model-role-"));
    const configPath = join(dir, "publicmachina.config.yaml");
    const config = defaultConfig();
    saveConfig(configPath, config);
    process.env.OPENAI_API_KEY = "test-openai-key";

    let lastConfig = config;
    const inputs = ["/model provider openai --role report", "exit"];

    await startShell(
      {
        store,
        runId,
        llm: new MockLLMClient(),
        backend: new MockCognitionBackend(),
        config,
        configPath,
        onConfigUpdate: async (next) => {
          lastConfig = next;
        },
      },
      {
        prompt: () => {},
        output: () => {},
        error: () => {},
        readline: async () => inputs.shift() ?? "exit",
        close: () => {},
      }
    );

    expect(lastConfig.providers.default.provider).toBe("anthropic");
    expect(resolveProviderConfig(lastConfig.providers, "report").provider).toBe("openai");
    expect(resolveProviderConfig(lastConfig.providers, "simulation").provider).toBe("anthropic");

    delete process.env.OPENAI_API_KEY;
    rmSync(dir, { recursive: true, force: true });
    store.close();
  });

  it("supports /clear by rotating the active assistant session", async () => {
    const { store, runId } = setupShellStore();
    const outputs: string[] = [];
    const sessionIds: string[] = [];
    const inputs = ["/clear", "exit"];
    let clearCalls = 0;

    await startShell(
      {
        store,
        runId,
        llm: new MockLLMClient(),
        backend: new MockCognitionBackend(),
        assistantSession: {
          id: "session-1",
          path: "/tmp/session-1.jsonl",
          createdAt: new Date().toISOString(),
          mode: "shell",
        },
        onAssistantClear: async () => {
          clearCalls += 1;
          const nextId = `session-${clearCalls + 1}`;
          sessionIds.push(nextId);
          return {
            id: nextId,
            path: `/tmp/${nextId}.jsonl`,
            createdAt: new Date().toISOString(),
            mode: "shell",
          };
        },
      },
      {
        prompt: () => {},
        output: (text) => outputs.push(text),
        error: () => {},
        readline: async () => inputs.shift() ?? "exit",
        close: () => {},
      }
    );

    expect(clearCalls).toBe(1);
    expect(sessionIds).toEqual(["session-2"]);
    expect(outputs.join("")).toContain("Started a fresh shell conversation");
    store.close();
  });
});
