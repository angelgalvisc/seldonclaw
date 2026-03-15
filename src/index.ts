#!/usr/bin/env node
/**
 * index.ts — CLI entry point for SeldonClaw
 *
 * Source of truth: PLAN.md §CLI, CLAUDE.md Phase 5.2
 *
 * Commander-based CLI with subcommands:
 *   simulate — run simulation rounds
 *   stats    — show run metrics
 *   (stubs for future phases: run, ingest, analyze, generate, etc.)
 */

import { Command } from "commander";
import { SQLiteGraphStore } from "./db.js";
import { loadConfig, defaultConfig } from "./config.js";
import type { SimConfig } from "./config.js";
import { MockCognitionBackend } from "./cognition.js";
import { runSimulation } from "./engine.js";
import { getTierStats } from "./telemetry.js";

const program = new Command()
  .name("seldonclaw")
  .version("0.1.0")
  .description("Social simulation engine on CKP");

// ═══════════════════════════════════════════════════════
// SIMULATE
// ═══════════════════════════════════════════════════════

program
  .command("simulate")
  .description("Run simulation rounds on an existing database")
  .option("--db <path>", "SQLite database path", "simulation.db")
  .option("--rounds <n>", "override number of rounds")
  .option("--seed <n>", "PRNG seed (0=random)")
  .option("--config <path>", "config YAML file")
  .option("--run <id>", "run ID (auto-generated if omitted)")
  .action(async (opts) => {
    let config: SimConfig;
    if (opts.config) {
      config = loadConfig(opts.config);
    } else {
      config = defaultConfig();
    }

    if (opts.rounds) {
      const rounds = parseInt(opts.rounds, 10);
      config.simulation.totalHours = (rounds * config.simulation.minutesPerRound) / 60;
    }

    if (opts.seed !== undefined) {
      config.simulation.seed = parseInt(opts.seed, 10);
    }

    const store = new SQLiteGraphStore(opts.db);

    // Use MockCognitionBackend for now (DirectLLMBackend requires API key)
    const backend = new MockCognitionBackend();

    try {
      const result = await runSimulation({
        store,
        config,
        backend,
        runId: opts.run,
      });

      console.log(`Simulation ${result.status}`);
      console.log(`  Run ID: ${result.runId}`);
      console.log(`  Rounds: ${result.totalRounds}`);
      console.log(`  Wall time: ${(result.wallTimeMs / 1000).toFixed(1)}s`);
    } finally {
      store.close();
    }
  });

// ═══════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════

program
  .command("stats")
  .description("Show simulation metrics")
  .requiredOption("--db <path>", "SQLite database path")
  .option("--tiers", "show cognition tier breakdown")
  .option("--run <id>", "specific run ID")
  .action((opts) => {
    const store = new SQLiteGraphStore(opts.db);

    try {
      // Find run ID
      let runId = opts.run;
      if (!runId) {
        const row = (store as any).db
          .prepare("SELECT id FROM run_manifest ORDER BY started_at DESC LIMIT 1")
          .get() as { id: string } | undefined;
        if (!row) {
          console.error("No runs found in database.");
          process.exit(1);
        }
        runId = row.id;
      }

      const run = store.getRun(runId);
      if (!run) {
        console.error(`Run ${runId} not found.`);
        process.exit(1);
      }

      // Run summary
      console.log(`Run: ${runId}`);
      console.log(`  Status: ${run.status}`);
      console.log(`  Seed: ${run.seed}`);
      console.log(`  Total rounds: ${run.total_rounds ?? "unknown"}`);
      console.log(`  Started: ${run.started_at}`);
      if (run.finished_at) console.log(`  Finished: ${run.finished_at}`);

      // Round stats
      const roundRows = (store as any).db
        .prepare(
          `SELECT COUNT(*) as rounds,
                  SUM(total_posts) as posts,
                  SUM(total_actions) as actions,
                  AVG(active_actors) as avg_active
           FROM rounds WHERE run_id = ?`
        )
        .get(runId) as {
        rounds: number;
        posts: number;
        actions: number;
        avg_active: number;
      };

      console.log(`  Rounds completed: ${roundRows.rounds}`);
      console.log(`  Total posts: ${roundRows.posts ?? 0}`);
      console.log(`  Total actions: ${roundRows.actions ?? 0}`);
      console.log(`  Avg active actors/round: ${(roundRows.avg_active ?? 0).toFixed(1)}`);

      // Tier breakdown
      if (opts.tiers) {
        const stats = getTierStats(store, runId);
        console.log(`  Tier breakdown:`);
        console.log(`    A (always LLM): ${stats.tierA} actors`);
        console.log(`    B (salient LLM): ${stats.tierB} actors`);
        console.log(`    C (rules only): ${stats.tierC} actors`);

        const tierCalls = (store as any).db
          .prepare(
            `SELECT SUM(tier_a_calls) as a, SUM(tier_b_calls) as b, SUM(tier_c_actions) as c
             FROM rounds WHERE run_id = ?`
          )
          .get(runId) as { a: number; b: number; c: number };
        console.log(`    Tier A calls: ${tierCalls.a ?? 0}`);
        console.log(`    Tier B calls: ${tierCalls.b ?? 0}`);
        console.log(`    Tier C actions: ${tierCalls.c ?? 0}`);
      }
    } finally {
      store.close();
    }
  });

// ═══════════════════════════════════════════════════════
// STUB COMMANDS (future phases)
// ═══════════════════════════════════════════════════════

const stubs = [
  { name: "run", desc: "Full pipeline: ingest → analyze → generate → simulate" },
  { name: "ingest", desc: "Ingest documents into knowledge graph" },
  { name: "analyze", desc: "Run ontology analysis on knowledge graph" },
  { name: "generate", desc: "Generate actor profiles from knowledge graph" },
  { name: "inspect", desc: "Inspect actor details" },
  { name: "resume", desc: "Resume simulation from last snapshot" },
  { name: "replay", desc: "Replay simulation from decision cache" },
];

for (const stub of stubs) {
  program
    .command(stub.name)
    .description(`${stub.desc} (not yet implemented)`)
    .action(() => {
      console.log(`"seldonclaw ${stub.name}" is not yet implemented.`);
      process.exit(0);
    });
}

program.parse();
