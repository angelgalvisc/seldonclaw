/**
 * shell.ts — Conversational REPL for the PublicMachina social simulation engine
 *
 * Provides an interactive shell that supports:
 *   - Natural language queries (translated to SQL via LLM)
 *   - Raw SQL SELECT queries
 *   - Actor interviews (via cognition backend)
 *   - CKP agent export
 *
 * CRITICAL: All SQL goes through store.executeReadOnlySql().
 * Never access store.db directly.
 */

import type { GraphStore } from "./db.js";
import type { LLMClient } from "./llm.js";
import type { CognitionBackend } from "./cognition.js";
import { resolveActorByName, interviewActor } from "./interview.js";
import { exportAgent } from "./ckp.js";
import type { SimConfig } from "./config.js";
import { saveConfig } from "./config.js";
import {
  PROVIDER_ROLES,
  clearRoleProviderOverride,
  hasRoleOverride,
  resolveProviderConfig,
  setGlobalProviderSelection,
  setRoleProviderSelection,
  type ProviderRole,
} from "./provider-selection.js";
import {
  SUPPORTED_PROVIDERS,
  describeConfiguredModel,
  getProviderCatalog,
  normalizeModelId,
  parseProvider,
  resolveModelPreset,
  type SupportedProvider
} from "./model-catalog.js";

// ═══════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════

export interface ShellContext {
  store: GraphStore;
  runId: string;
  llm?: LLMClient;
  backend?: CognitionBackend;
  config?: SimConfig;
  configPath?: string;
  onConfigUpdate?: (config: SimConfig) => Promise<void>;
}

export interface ShellIO {
  prompt(text: string): void;
  output(text: string): void;
  error(text: string): void;
  readline(): Promise<string>;
  close(): void;
}

export interface TableSchema {
  name: string;
  columns: Array<{ name: string; type: string }>;
}

export type CommandType = "interview" | "export" | "help" | "exit" | "query" | "model";

export interface ParsedCommand {
  type: CommandType;
  args: string;
}

// ═══════════════════════════════════════════════════════
// classifyIntent
// ═══════════════════════════════════════════════════════

export function classifyIntent(input: string): ParsedCommand {
  const trimmed = input.trim();

  if (/^(interview|talk\s+to)\s+/i.test(trimmed)) {
    const args = trimmed.replace(/^(interview|talk\s+to)\s+/i, "").trim();
    return { type: "interview", args };
  }

  if (/^export\s+/i.test(trimmed)) {
    const args = trimmed.replace(/^export\s+/i, "").trim();
    return { type: "export", args };
  }

  if (/^(help|\?)$/i.test(trimmed)) {
    return { type: "help", args: "" };
  }

  if (/^\/model(?:\s+.*)?$/i.test(trimmed)) {
    const args = trimmed.replace(/^\/model/i, "").trim();
    return { type: "model", args };
  }

  if (/^(\/exit|quit|exit)$/i.test(trimmed)) {
    return { type: "exit", args: "" };
  }

  return { type: "query", args: trimmed };
}

// ═══════════════════════════════════════════════════════
// extractSchema
// ═══════════════════════════════════════════════════════

export function extractSchema(store: GraphStore): TableSchema[] {
  const tables = store.executeReadOnlySql(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ) as Array<{ name: string }>;

  const schemas: TableSchema[] = [];
  for (const table of tables) {
    const columns = store.executeReadOnlySql(
      `SELECT name, type FROM pragma_table_info('${table.name}') ORDER BY cid`
    ) as Array<{ name: string; type: string }>;
    schemas.push({ name: table.name, columns });
  }
  return schemas;
}

// ═══════════════════════════════════════════════════════
// executeQuery
// ═══════════════════════════════════════════════════════

export function executeQuery(
  store: GraphStore,
  sql: string
): { columns: string[]; rows: Array<Record<string, unknown>> } {
  const rows = store.executeReadOnlySql(sql);
  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
  return { columns, rows };
}

// ═══════════════════════════════════════════════════════
// formatTable
// ═══════════════════════════════════════════════════════

export function formatTable(
  columns: string[],
  rows: Array<Record<string, unknown>>
): string {
  if (columns.length === 0) return "(no results)\n";

  // Compute column widths
  const widths = columns.map((col) => {
    const maxDataWidth = rows.reduce((max, row) => {
      const val = String(row[col] ?? "");
      return Math.max(max, val.length);
    }, 0);
    return Math.max(col.length, maxDataWidth);
  });

  // Header
  const header = columns.map((col, i) => col.padEnd(widths[i])).join(" | ");
  const separator = widths.map((w) => "-".repeat(w)).join("-+-");

  // Rows
  const dataRows = rows.map((row) =>
    columns.map((col, i) => String(row[col] ?? "").padEnd(widths[i])).join(" | ")
  );

  return [header, separator, ...dataRows, ""].join("\n");
}

// ═══════════════════════════════════════════════════════
// nlToSql
// ═══════════════════════════════════════════════════════

export async function nlToSql(
  llm: LLMClient,
  schema: TableSchema[],
  question: string,
  history: Array<{ role: string; content: string }> = []
): Promise<string> {
  const schemaText = schema
    .map((t) => {
      const cols = t.columns.map((c) => `  ${c.name} ${c.type}`).join("\n");
      return `TABLE ${t.name}:\n${cols}`;
    })
    .join("\n\n");

  const system =
    `You are a SQL query generator for a social simulation database.\n\n` +
    `DATABASE SCHEMA:\n${schemaText}\n\n` +
    `RULES:\n` +
    `- Generate ONLY SELECT queries. Never INSERT, UPDATE, DELETE, DROP, or ALTER.\n` +
    `- Return ONLY the SQL query, no explanation, no markdown fences.\n` +
    `- Use appropriate JOINs when relating tables.\n` +
    `- Limit results to 50 rows unless asked otherwise.`;

  const response = await llm.complete("report", question, {
    system,
    temperature: 0.0,
    maxTokens: 512,
  });

  // Extract SQL — strip any accidental fences
  let sql = response.content.trim();
  if (sql.startsWith("```sql")) sql = sql.slice(6);
  else if (sql.startsWith("```")) sql = sql.slice(3);
  if (sql.endsWith("```")) sql = sql.slice(0, -3);
  sql = sql.trim();

  // Validate starts with SELECT
  if (!/^\s*SELECT\b/i.test(sql)) {
    throw new Error("LLM generated a non-SELECT query. Refusing to execute.");
  }

  return sql;
}

// ═══════════════════════════════════════════════════════
// startShell
// ═══════════════════════════════════════════════════════

export async function startShell(ctx: ShellContext, io: ShellIO): Promise<void> {
  const { store, runId } = ctx;

  const run = store.getRun(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);

  const summary = store.getRunRoundSummary(runId);
  const actors = store.getActorsByRun(runId);

  io.output(`PublicMachina Shell — Run ${runId}\n`);
  io.output(`  ${actors.length} actors, ${summary.roundsCompleted} rounds, ${summary.totalPosts} posts\n`);
  io.output(`  Type "help" for commands, "exit" to quit.\n\n`);

  const schema = extractSchema(store);

  while (true) {
    io.prompt("publicmachina> ");
    let input: string;
    try {
      input = await io.readline();
    } catch {
      break; // EOF or readline closed
    }

    if (!input.trim()) continue;

    const cmd = classifyIntent(input);

    try {
      switch (cmd.type) {
        case "exit":
          io.output("Goodbye.\n");
          io.close();
          return;

        case "help":
          io.output("Commands:\n");
          io.output("  interview <actor>  — Interview a simulated actor\n");
          io.output("  export <actor>     — Export actor as CKP bundle\n");
          io.output("  /model             — Show or change provider/model\n");
          io.output("  help               — Show this help\n");
          io.output("  exit               — Quit shell\n");
          io.output("  <anything else>    — Natural language query (→ SQL)\n");
          break;

        case "model":
          await handleModelCommand(ctx, io, cmd.args);
          break;

        case "interview": {
          if (!ctx.backend) {
            io.error("No cognition backend configured for interviews.\n");
            break;
          }
          const actor = resolveActorByName(store, runId, cmd.args);
          const result = await interviewActor(store, runId, actor.id, ctx.backend, "Tell me about yourself.");
          io.output(`${result.actorName}: ${result.response}\n`);
          break;
        }

        case "export": {
          const actor = resolveActorByName(store, runId, cmd.args);
          const exportResult = exportAgent(store, runId, actor.id, `./ckp-export-${actor.handle ?? actor.id}`);
          io.output(`Exported ${actor.name} to ${exportResult.outDir}\n`);
          break;
        }

        case "query": {
          if (ctx.llm && ctx.llm.hasProvider("report")) {
            const sql = await nlToSql(ctx.llm, schema, cmd.args);
            io.output(`SQL: ${sql}\n`);
            const { columns, rows } = executeQuery(store, sql);
            io.output(formatTable(columns, rows));
            io.output(`(${rows.length} rows)\n`);
          } else {
            // Try as raw SQL if it looks like SELECT
            if (/^\s*SELECT\b/i.test(cmd.args)) {
              const { columns, rows } = executeQuery(store, cmd.args);
              io.output(formatTable(columns, rows));
              io.output(`(${rows.length} rows)\n`);
            } else {
              io.error("No LLM configured for natural language queries. Use raw SQL (SELECT ...) or configure a report provider.\n");
            }
          }
          break;
        }
      }
    } catch (err) {
      io.error(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
}

async function handleModelCommand(
  ctx: ShellContext,
  io: ShellIO,
  args: string
): Promise<void> {
  if (!ctx.config || !ctx.configPath || !ctx.onConfigUpdate) {
    io.error('Model switching is unavailable in this shell. Run "publicmachina shell --config <path>" after setup.\n');
    return;
  }

  const { text: trimmed, role } = extractRoleOption(args);
  const currentResolved = resolveProviderConfig(
    ctx.config.providers,
    role ?? "simulation"
  );
  const currentProvider = currentResolved.provider;
  const currentModel = currentResolved.model;

  if (!trimmed || trimmed === "list") {
    io.output(`Default provider: ${getProviderCatalog(ctx.config.providers.default.provider).label}\n`);
    io.output(
      `Default model: ${describeConfiguredModel(
        ctx.config.providers.default.provider,
        ctx.config.providers.default.model
      )} (${ctx.config.providers.default.model})\n`
    );
    if (role) {
      io.output(
        `Resolved ${role} provider: ${getProviderCatalog(currentProvider).label}\n`
      );
      io.output(
        `Resolved ${role} model: ${describeConfiguredModel(currentProvider, currentModel)} (${currentModel})\n`
      );
    }
    const overriddenRoles = PROVIDER_ROLES.filter((candidate) =>
      hasRoleOverride(ctx.config!.providers, candidate)
    );
    if (overriddenRoles.length > 0) {
      io.output("Role overrides:\n");
      for (const overriddenRole of overriddenRoles) {
        const resolved = resolveProviderConfig(ctx.config.providers, overriddenRole);
        io.output(
          `  - ${overriddenRole}: ${getProviderCatalog(resolved.provider).label} / ${describeConfiguredModel(
            resolved.provider,
            resolved.model
          )} (${resolved.model})\n`
        );
      }
    }
    io.output("Configured provider commands:\n");
    io.output("  /model list\n");
    io.output("  /model use <model-id-or-label>\n");
    io.output("  /model provider <anthropic|openai|moonshot>\n");
    io.output("  /model use <model> --role <analysis|generation|simulation|report>\n");
    io.output("  /model provider <provider> --role <analysis|generation|simulation|report>\n");
    io.output("  /model reset --role <analysis|generation|simulation|report>\n");
    io.output("  /model setup\n");
    io.output("Available providers:\n");
    for (const provider of SUPPORTED_PROVIDERS) {
      const entry = getProviderCatalog(provider);
      io.output(`  - ${entry.label} (${provider})\n`);
    }
    io.output(`Available models for ${getProviderCatalog(currentProvider).label}:\n`);
    for (const preset of getProviderCatalog(currentProvider).models) {
      io.output(`  - ${preset.label} -> ${preset.persistedId ?? preset.id}\n`);
    }
    return;
  }

  if (trimmed === "setup") {
    io.error('Run "publicmachina setup" to configure a provider or add a new API key.\n');
    return;
  }

  if (trimmed === "reset") {
    if (!role) {
      io.error('Use "/model reset --role <role>" to clear a role-specific override.\n');
      return;
    }
    const next = structuredClone(ctx.config);
    next.providers = clearRoleProviderOverride(next.providers, role);
    saveConfig(ctx.configPath!, next);
    ctx.config = next;
    await ctx.onConfigUpdate!(next);
    io.output(`Cleared provider/model override for ${role}.\n`);
    return;
  }

  if (trimmed.startsWith("provider ")) {
    const requestedProvider = parseProvider(trimmed.slice("provider ".length));
    if (!requestedProvider) {
      io.error('Unknown provider. Use "anthropic", "openai", or "moonshot".\n');
      return;
    }
    await switchProvider(ctx, io, requestedProvider, role);
    return;
  }

  if (trimmed.startsWith("use ")) {
    await switchModel(ctx, io, trimmed.slice("use ".length).trim(), role);
    return;
  }

  io.error('Unknown /model command. Use "/model", "/model use <id>", or "/model provider <provider>".\n');
}

function extractRoleOption(input: string): { text: string; role?: ProviderRole } {
  const match = input.match(/(?:^|\s)--role\s+(analysis|generation|simulation|report)\b/i);
  if (!match) {
    return { text: input.trim() };
  }
  const role = match[1].toLowerCase() as ProviderRole;
  const start = match.index ?? 0;
  const end = start + match[0].length;
  return {
    text: `${input.slice(0, start)} ${input.slice(end)}`.trim(),
    role,
  };
}

async function switchProvider(
  ctx: ShellContext,
  io: ShellIO,
  provider: SupportedProvider,
  role?: ProviderRole
): Promise<void> {
  const entry = getProviderCatalog(provider);
  if (!process.env[entry.apiKeyEnv]) {
    io.error(
      `${entry.label} is not configured in this shell. Missing ${entry.apiKeyEnv}. Run "publicmachina setup".\n`
    );
    return;
  }

  const next = structuredClone(ctx.config!);
  const model = normalizeModelId(provider, entry.models.find((preset) => preset.tier === "recommended")?.id ?? entry.models[0].id);
  if (role) {
    next.providers = setRoleProviderSelection(next.providers, role, { provider, model });
  } else {
    next.providers = setGlobalProviderSelection(next.providers, provider, model);
  }
  saveConfig(ctx.configPath!, next);
  ctx.config = next;
  await ctx.onConfigUpdate!(next);
  io.output(
    role
      ? `Switched ${role} to ${entry.label} with ${describeConfiguredModel(provider, model)}.\n`
      : `Switched default provider to ${entry.label} with ${describeConfiguredModel(provider, model)}. Cleared role overrides.\n`
  );
}

async function switchModel(
  ctx: ShellContext,
  io: ShellIO,
  requestedModel: string,
  role?: ProviderRole
): Promise<void> {
  let provider = resolveProviderConfig(ctx.config!.providers, role ?? "simulation").provider;
  let normalizedModel = normalizeModelId(provider, requestedModel);
  let preset = resolveModelPreset(provider, requestedModel);

  if (!preset) {
    for (const candidateProvider of SUPPORTED_PROVIDERS) {
      const candidatePreset = resolveModelPreset(candidateProvider, requestedModel);
      if (candidatePreset) {
        provider = candidateProvider;
        preset = candidatePreset;
        normalizedModel = normalizeModelId(candidateProvider, requestedModel);
        break;
      }
    }
  }

  const providerEntry = getProviderCatalog(provider);
  if (!process.env[providerEntry.apiKeyEnv]) {
    io.error(
      `${providerEntry.label} is not configured in this shell. Missing ${providerEntry.apiKeyEnv}. Run "publicmachina setup".\n`
    );
    return;
  }

  const next = structuredClone(ctx.config!);
  if (role) {
    next.providers = setRoleProviderSelection(next.providers, role, {
      provider,
      model: normalizedModel,
      apiKeyEnv: providerEntry.apiKeyEnv,
      baseUrl: providerEntry.baseUrl,
    });
  } else {
    next.providers = setGlobalProviderSelection(next.providers, provider, normalizedModel);
  }

  saveConfig(ctx.configPath!, next);
  ctx.config = next;
  await ctx.onConfigUpdate!(next);
  io.output(
    role
      ? `Switched ${role} model to ${preset ? preset.label : normalizedModel} on ${providerEntry.label}.\n`
      : `Switched default model to ${preset ? preset.label : normalizedModel} on ${providerEntry.label}. Cleared role overrides.\n`
  );
}
