/**
 * index.test.ts — Tests for the actual Commander CLI wiring
 *
 * Covers:
 * - simulate command with MockCognitionBackend via --mock
 * - stats command output formatting and tier breakdown
 * - error path when no runs exist
 */

import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { SQLiteGraphStore } from "../src/db.js";
import type { ActorRow } from "../src/db.js";
import { runCli, runInitCommand } from "../src/index.js";
import { loadConfig } from "../src/config.js";
import { resolveProviderConfig } from "../src/provider-selection.js";
import { updateRound } from "../src/telemetry.js";

const tempDirs: string[] = [];

function makeTempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "publicmachina-cli-"));
  tempDirs.push(dir);
  return join(dir, "simulation.db");
}

function fixtureDocsDir(): string {
  return join(process.cwd(), "tests", "fixtures", "sample-docs");
}

function makeActor(overrides: Partial<ActorRow> = {}): ActorRow {
  return {
    id: "actor-1",
    run_id: "run-1",
    entity_id: null,
    archetype: "persona",
    cognition_tier: "B",
    name: "Test Actor",
    handle: "@test",
    personality: "A test persona",
    bio: null,
    age: 25,
    gender: "male",
    profession: null,
    region: null,
    language: "es",
    stance: "neutral",
    sentiment_bias: 0.0,
    activity_level: 1.0,
    influence_weight: 0.5,
    community_id: null,
    active_hours: null,
    follower_count: 50,
    following_count: 30,
    ...overrides,
  };
}

function makeIO() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: (text: string) => {
        stdout += text;
      },
      stderr: (text: string) => {
        stderr += text;
      },
    },
    getStdout: () => stdout,
    getStderr: () => stderr,
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("CLI simulate", () => {
  it("runs simulation through commander with --mock", async () => {
    const dbPath = makeTempDbPath();
    const store = new SQLiteGraphStore(dbPath);
    store.createRun({
      id: "run-1",
      started_at: "2024-01-01T00:00:00",
      seed: 42,
      config_snapshot: "{}",
      graph_revision_id: "rev-1",
      status: "running",
      total_rounds: 1,
    });
    store.addActor(makeActor({ id: "actor-a", run_id: "run-1", handle: "@a" }));
    store.addActorTopic("actor-a", "education", 1.0);
    store.addActorBelief("actor-a", "education", 0.2, 0);
    store.close();

    const capture = makeIO();
    await runCli(
      [
        "node",
        "publicmachina",
        "simulate",
        "--db",
        dbPath,
        "--run",
        "run-1",
        "--rounds",
        "1",
        "--mock",
      ],
      capture.io
    );

    expect(capture.getStdout()).toContain("Simulation completed");
    expect(capture.getStdout()).toContain("Run ID: run-1");

    const verifyStore = new SQLiteGraphStore(dbPath);
    const run = verifyStore.getRun("run-1");
    const summary = verifyStore.getRunRoundSummary("run-1");
    verifyStore.close();

    expect(run?.status).toBe("completed");
    expect(summary.roundsCompleted).toBe(1);
  });
});

describe("CLI pipeline", () => {
  it("ingests documents through commander", async () => {
    const dbPath = makeTempDbPath();
    const capture = makeIO();

    await runCli(
      ["node", "publicmachina", "ingest", "--db", dbPath, "--docs", fixtureDocsDir()],
      capture.io
    );

    expect(capture.getStdout()).toContain("Ingested documents");

    const store = new SQLiteGraphStore(dbPath);
    const docs = store.getAllDocuments();
    store.close();
    expect(docs.length).toBeGreaterThan(0);
  });

  it("analyzes the corpus and builds the graph with --mock", async () => {
    const dbPath = makeTempDbPath();
    const store = new SQLiteGraphStore(dbPath);
    store.close();

    await runCli(
      ["node", "publicmachina", "ingest", "--db", dbPath, "--docs", fixtureDocsDir()],
      makeIO().io
    );

    const capture = makeIO();
    await runCli(
      ["node", "publicmachina", "analyze", "--db", dbPath, "--mock"],
      capture.io
    );

    expect(capture.getStdout()).toContain("Analysis complete");

    const verifyStore = new SQLiteGraphStore(dbPath);
    const entities = verifyStore.getAllActiveEntities();
    verifyStore.close();
    expect(entities.length).toBeGreaterThan(0);
  });

  it("generates profiles for a run with --mock", async () => {
    const dbPath = makeTempDbPath();

    await runCli(
      ["node", "publicmachina", "ingest", "--db", dbPath, "--docs", fixtureDocsDir()],
      makeIO().io
    );
    await runCli(
      ["node", "publicmachina", "analyze", "--db", dbPath, "--mock"],
      makeIO().io
    );

    const capture = makeIO();
    await runCli(
      [
        "node",
        "publicmachina",
        "generate",
        "--db",
        dbPath,
        "--run",
        "pipeline-run",
        "--hypothesis",
        "Tuition protests intensify",
        "--mock",
      ],
      capture.io
    );

    expect(capture.getStdout()).toContain("Generated profiles for run pipeline-run");

    const verifyStore = new SQLiteGraphStore(dbPath);
    const actors = verifyStore.getActorsByRun("pipeline-run");
    verifyStore.close();
    expect(actors.length).toBeGreaterThan(0);
  });

  it("runs the full pipeline end-to-end with --mock", async () => {
    const dbPath = makeTempDbPath();
    const capture = makeIO();

    await runCli(
      [
        "node",
        "publicmachina",
        "run",
        "--db",
        dbPath,
        "--docs",
        fixtureDocsDir(),
        "--run",
        "e2e-run",
        "--hypothesis",
        "Negative sentiment spreads faster than positive",
        "--rounds",
        "2",
        "--mock",
      ],
      capture.io
    );

    const output = capture.getStdout();
    expect(output).toContain("Pipeline completed");
    expect(output).toContain("Run ID: e2e-run");

    const verifyStore = new SQLiteGraphStore(dbPath);
    const run = verifyStore.getRun("e2e-run");
    const actors = verifyStore.getActorsByRun("e2e-run");
    const summary = verifyStore.getRunRoundSummary("e2e-run");
    verifyStore.close();

    expect(run?.status).toBe("completed");
    expect(actors.length).toBeGreaterThan(0);
    expect(summary.roundsCompleted).toBe(2);
  });

  it("inspects an actor after generation", async () => {
    const dbPath = makeTempDbPath();

    await runCli(
      [
        "node",
        "publicmachina",
        "run",
        "--db",
        dbPath,
        "--docs",
        fixtureDocsDir(),
        "--run",
        "inspect-run",
        "--rounds",
        "1",
        "--mock",
      ],
      makeIO().io
    );

    const store = new SQLiteGraphStore(dbPath);
    const actor = store.getActorsByRun("inspect-run")[0];
    store.close();

    const capture = makeIO();
    await runCli(
      ["node", "publicmachina", "inspect", "--db", dbPath, "--run", "inspect-run", "--actor", actor.name],
      capture.io
    );

    expect(capture.getStdout()).toContain(actor.name);
    expect(capture.getStdout()).toContain("Personality:");
  });
});

describe("CLI stats", () => {
  it("prints run summary and tier breakdown", async () => {
    const dbPath = makeTempDbPath();
    const store = new SQLiteGraphStore(dbPath);
    store.createRun({
      id: "run-1",
      started_at: "2024-01-01T00:00:00",
      seed: 42,
      config_snapshot: "{}",
      graph_revision_id: "rev-1",
      status: "completed",
      total_rounds: 2,
      finished_at: "2024-01-01T02:00:00",
    });
    store.addActor(makeActor({ id: "a1", cognition_tier: "A" }));
    store.addActor(makeActor({ id: "a2", cognition_tier: "B" }));
    store.addActor(makeActor({ id: "a3", cognition_tier: "C" }));
    updateRound(store, {
      num: 0,
      runId: "run-1",
      totalPosts: 5,
      totalActions: 8,
      activeActors: 3,
      tierACalls: 1,
      tierBCalls: 2,
      tierCActions: 5,
    });
    updateRound(store, {
      num: 1,
      runId: "run-1",
      totalPosts: 7,
      totalActions: 11,
      activeActors: 2,
      tierACalls: 2,
      tierBCalls: 3,
      tierCActions: 6,
    });
    store.close();

    const capture = makeIO();
    await runCli(
      ["node", "publicmachina", "stats", "--db", dbPath, "--run", "run-1", "--tiers"],
      capture.io
    );

    const output = capture.getStdout();
    expect(output).toContain("Run: run-1");
    expect(output).toContain("Status: completed");
    expect(output).toContain("Rounds completed: 2");
    expect(output).toContain("Total posts: 12");
    expect(output).toContain("Total actions: 19");
    expect(output).toContain("A (always LLM): 1 actors");
    expect(output).toContain("Tier A calls: 3");
    expect(output).toContain("Tier B calls: 5");
    expect(output).toContain("Tier C actions: 11");
  });

  it("fails clearly when no runs exist", async () => {
    const dbPath = makeTempDbPath();
    const store = new SQLiteGraphStore(dbPath);
    store.close();

    const capture = makeIO();
    await expect(
      runCli(["node", "publicmachina", "stats", "--db", dbPath], capture.io)
    ).rejects.toThrow("No runs found in database.");
  });
});

describe("CLI report", () => {
  it("prints metrics and mock narrative", async () => {
    const dbPath = makeTempDbPath();
    const store = new SQLiteGraphStore(dbPath);
    store.createRun({
      id: "run-1",
      started_at: "2024-01-01T00:00:00",
      seed: 42,
      config_snapshot: "{}",
      hypothesis: "Test hypothesis",
      graph_revision_id: "rev-1",
      status: "completed",
      total_rounds: 1,
      finished_at: "2024-01-01T01:00:00",
    });
    store.addActor(makeActor({ id: "actor-a", run_id: "run-1", handle: "@a" }));
    store.addPost({
      id: "post-1",
      run_id: "run-1",
      author_id: "actor-a",
      content: "Test post",
      round_num: 0,
      sim_timestamp: "2024-01-01T00:00:00",
      likes: 5,
      reposts: 1,
      comments: 0,
      reach: 20,
      sentiment: 0.2,
    });
    store.upsertRound({
      num: 0,
      run_id: "run-1",
      active_actors: 1,
      total_posts: 1,
      total_actions: 1,
      events: JSON.stringify([{ type: "scheduled", content: "Event", topics: ["education"] }]),
    });
    store.close();

    const capture = makeIO();
    await runCli(
      ["node", "publicmachina", "report", "--db", dbPath, "--run", "run-1", "--mock"],
      capture.io
    );

    const output = capture.getStdout();
    expect(output).toContain("Report for run run-1");
    expect(output).toContain("Hypothesis: Test hypothesis");
    expect(output).toContain("Mock report narrative");
  });
});

describe("CLI init", () => {
  it("writes a guided config without storing secrets", async () => {
    const configPath = join(makeTempDbPath().replace("simulation.db", ""), "publicmachina.config.yaml");
    const capture = makeIO();

    await runInitCommand(
      { output: configPath },
      capture.io,
      {
        ask: async (question, defaultValue) => {
          if (question.includes("Choose provider")) return "openai";
          if (question.includes("Choose OpenAI model")) return "GPT-5 mini";
          if (question.includes("Advanced setup")) return "no";
          if (question.includes("Enable SearXNG web search")) return "yes";
          if (question.includes("SearXNG endpoint")) return "http://localhost:8888";
          if (question.includes("Search cutoff date")) return "2026-03-01";
          return defaultValue ?? "";
        },
        askSecret: async () => "",
        close: () => {},
      }
    );

    const contents = readFileSync(configPath, "utf-8");
    const config = loadConfig(configPath);
    expect(contents).toContain("default:");
    expect(contents).toContain('provider: "openai"');
    expect(contents).toContain('apiKeyEnv: "OPENAI_API_KEY"');
    expect(resolveProviderConfig(config.providers, "simulation").model).toBe("gpt-5-mini-2025-08-07");
    expect(contents).toContain('dir: "./output"');
    expect(contents).toContain("enabled: true");
    expect(contents).toContain('cutoffDate: "2026-03-01"');
    expect(contents).toContain("search:");
    expect(contents).toContain('endpoint: "http://localhost:8888"');
    expect(contents).not.toContain("sk-");
  });
});

describe("CLI design", () => {
  it("writes a simulation spec and generated config from a global brief", async () => {
    const dir = mkdtempSync(join(tmpdir(), "publicmachina-design-"));
    tempDirs.push(dir);
    const configPath = join(dir, "designed.config.yaml");
    const specPath = join(dir, "simulation.spec.json");
    const capture = makeIO();

    await runCli(
      [
        "node",
        "publicmachina",
        "design",
        "--brief",
        "Create a 10-round simulation about a global consumer electronics recall. Only journalists, analysts, and institutions may search the web. Allow up to 4 search-enabled actors per round. Enable embedding-aware feed ranking.",
        "--docs",
        "./docs/product-recall",
        "--out-config",
        configPath,
        "--out-spec",
        specPath,
        "--mock",
        "--yes",
      ],
      capture.io
    );

    const configContents = readFileSync(configPath, "utf-8");
    const specContents = JSON.parse(readFileSync(specPath, "utf-8")) as {
      title: string;
      docsPath: string;
      search: { enabled: boolean; maxActorsPerRound: number };
      feed: { embeddingEnabled: boolean };
    };

    expect(capture.getStdout()).toContain("Simulation Plan");
    expect(capture.getStdout()).toContain(`Wrote ${specPath}`);
    expect(capture.getStdout()).toContain(`Wrote ${configPath}`);
    expect(configContents).toContain("search:");
    expect(configContents).toContain("embeddingEnabled: true");
    expect(specContents.title).toBe("Global Product Recall Response");
    expect(specContents.docsPath).toBe("./docs/product-recall");
    expect(specContents.search.enabled).toBe(true);
    expect(specContents.search.maxActorsPerRound).toBe(4);
    expect(specContents.feed.embeddingEnabled).toBe(true);
  });
});

describe("CLI doctor", () => {
  it("prints actionable guidance when the default config file is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "publicmachina-doctor-missing-"));
    tempDirs.push(dir);

    const capture = makeIO();
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      await runCli(["node", "publicmachina", "doctor"], capture.io);
    } finally {
      process.chdir(cwd);
    }

    const output = capture.getStdout();
    expect(output).toContain("[FAIL] Config file not found: publicmachina.config.yaml");
    expect(output).toContain('Run "publicmachina setup" to create one, or pass --config <path>.');
  });

  it("checks search health when search is enabled", async () => {
    process.env.TEST_PROVIDER_KEY = "set";

    const server = await createSearchServer();
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("failed to acquire search server address");
      }

      const dir = mkdtempSync(join(tmpdir(), "publicmachina-doctor-"));
      tempDirs.push(dir);
      const configPath = join(dir, "publicmachina.config.yaml");
      writeFileSync(
        configPath,
        [
          "simulation:",
          '  platform: "x"',
          "providers:",
          "  analysis:",
          '    sdk: "anthropic"',
          '    model: "claude-sonnet-4-20250514"',
          '    apiKeyEnv: "TEST_PROVIDER_KEY"',
          "  generation:",
          '    sdk: "anthropic"',
          '    model: "claude-sonnet-4-20250514"',
          '    apiKeyEnv: "TEST_PROVIDER_KEY"',
          "  simulation:",
          '    model: "claude-haiku-4-20250414"',
          '    apiKeyEnv: "TEST_PROVIDER_KEY"',
          "  report:",
          '    sdk: "anthropic"',
          '    model: "claude-sonnet-4-20250514"',
          '    apiKeyEnv: "TEST_PROVIDER_KEY"',
          "search:",
          "  enabled: true",
          `  endpoint: "http://127.0.0.1:${address.port}"`,
          '  cutoffDate: "2026-03-01"',
          "  strictCutoff: true",
          '  enabledTiers: ["A", "B"]',
          "  maxResultsPerQuery: 5",
          "  maxQueriesPerActor: 2",
          '  categories: "news"',
          '  defaultLanguage: "auto"',
          "  timeoutMs: 3000",
          "output:",
          '  dir: "./output"',
          '  format: "both"',
          "",
        ].join("\n"),
        "utf-8"
      );

      const capture = makeIO();
      await runCli(
        ["node", "publicmachina", "doctor", "--config", configPath],
        capture.io
      );

      expect(capture.getStdout()).toContain("[PASS] search: SearXNG reachable");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      delete process.env.TEST_PROVIDER_KEY;
    }
  });
});

async function createSearchServer(): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/search")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        results: [
          {
            title: "Health check",
            url: "https://example.com/health",
            content: "Search endpoint is healthy.",
            publishedDate: "2026-02-28T00:00:00.000Z",
          },
        ],
      }));
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", (err?: Error) => (err ? reject(err) : resolve()));
  });

  return server;
}
