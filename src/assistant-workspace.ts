/**
 * assistant-workspace.ts — Workspace, identity, memory, and simulation history
 * for the PublicMachina operator assistant.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { SimConfig } from "./config.js";

export interface AssistantWorkspaceLayout {
  rootDir: string;
  stateDir: string;
  sessionsDir: string;
  memoryDir: string;
  simulationsDir: string;
  indexDir: string;
  files: {
    agents: string;
    identity: string;
    soul: string;
    user: string;
    memory: string;
    permissions: string;
    profile: string;
    durableMemory: string;
    simulationsIndex: string;
  };
}

export interface AssistantUserProfile {
  preferredName: string | null;
  lastContext: string | null;
  notes: string[];
  updatedAt: string;
}

export interface AssistantMemoryRecord {
  id: string;
  timestamp: string;
  kind: "conversation" | "preference" | "simulation" | "context";
  summary: string;
  tags: string[];
}

export interface AssistantSimulationRecord {
  id: string;
  slug: string;
  title: string;
  objective: string | null;
  hypothesis: string | null;
  brief: string;
  context: string | null;
  createdAt: string;
  workspaceDir: string;
  specPath: string | null;
  configPath: string | null;
  docsPath: string | null;
  reportPath: string | null;
  dbPath: string | null;
  runId: string | null;
  tags: string[];
}

interface SimulationRecordInput {
  title: string;
  objective?: string | null;
  hypothesis?: string | null;
  brief: string;
  context?: string | null;
  specPath?: string | null;
  configPath?: string | null;
  docsPath?: string | null;
  reportPath?: string | null;
  dbPath?: string | null;
  runId?: string | null;
  tags?: string[];
}

const USER_BLOCK = "USER-PROFILE";
const MEMORY_BLOCK = "DURABLE-MEMORY";

export function resolveAssistantWorkspace(
  config: SimConfig,
  options: { configPath?: string; cwd?: string } = {}
): AssistantWorkspaceLayout {
  const baseDir = options.configPath
    ? dirname(resolve(options.configPath))
    : (options.cwd ?? process.cwd());
  const rootDir = isAbsolute(config.assistant.workspaceDir)
    ? config.assistant.workspaceDir
    : resolve(baseDir, config.assistant.workspaceDir);
  const stateDir = join(rootDir, ".publicmachina");
  const sessionsDir = join(stateDir, "sessions");
  const memoryDir = join(rootDir, "memory");
  const simulationsDir = join(rootDir, "simulations");
  const indexDir = join(stateDir, "index");

  return {
    rootDir,
    stateDir,
    sessionsDir,
    memoryDir,
    simulationsDir,
    indexDir,
    files: {
      agents: join(rootDir, "AGENTS.md"),
      identity: join(rootDir, "IDENTITY.md"),
      soul: join(rootDir, "SOUL.md"),
      user: join(rootDir, "USER.md"),
      memory: join(rootDir, "MEMORY.md"),
      permissions: join(stateDir, "permissions.json"),
      profile: join(indexDir, "profile.json"),
      durableMemory: join(indexDir, "durable-memory.json"),
      simulationsIndex: join(indexDir, "simulations.json"),
    },
  };
}

export function bootstrapAssistantWorkspace(
  layout: AssistantWorkspaceLayout,
  config: SimConfig
): void {
  if (!config.assistant.enabled) return;

  mkdirSync(layout.rootDir, { recursive: true });
  mkdirSync(layout.stateDir, { recursive: true });
  mkdirSync(layout.sessionsDir, { recursive: true });
  mkdirSync(layout.memoryDir, { recursive: true });
  mkdirSync(layout.simulationsDir, { recursive: true });
  mkdirSync(layout.indexDir, { recursive: true });

  writeFileSync(
    layout.files.permissions,
    `${JSON.stringify(config.assistant.permissions, null, 2)}\n`,
    "utf-8"
  );

  writeFileIfMissing(layout.files.agents, buildAgentsTemplate());
  writeFileIfMissing(layout.files.identity, buildIdentityTemplate());
  writeFileIfMissing(layout.files.soul, buildSoulTemplate());
  writeFileIfMissing(layout.files.user, buildUserTemplate());
  writeFileIfMissing(layout.files.memory, buildMemoryTemplate());

  const profile = loadUserProfile(layout);
  saveJsonIfMissing(layout.files.profile, profile);
  const durableMemory = loadDurableMemories(layout);
  saveJsonIfMissing(layout.files.durableMemory, durableMemory);
  const simulations = loadSimulationHistory(layout);
  saveJsonIfMissing(layout.files.simulationsIndex, simulations);

  syncWorkspaceDocs(layout);
}

export function loadUserProfile(layout: AssistantWorkspaceLayout): AssistantUserProfile {
  return readJsonFile(layout.files.profile, {
    preferredName: null,
    lastContext: null,
    notes: [],
    updatedAt: new Date(0).toISOString(),
  });
}

export function updateUserProfile(
  layout: AssistantWorkspaceLayout,
  updates: Partial<Pick<AssistantUserProfile, "preferredName" | "lastContext">> & { addNote?: string | null }
): AssistantUserProfile {
  const profile = loadUserProfile(layout);
  const next: AssistantUserProfile = {
    preferredName: updates.preferredName === undefined ? profile.preferredName : updates.preferredName,
    lastContext: updates.lastContext === undefined ? profile.lastContext : updates.lastContext,
    notes: [...profile.notes],
    updatedAt: new Date().toISOString(),
  };

  const note = updates.addNote?.trim();
  if (note) {
    const exists = next.notes.some((entry) => entry.toLowerCase() === note.toLowerCase());
    if (!exists) next.notes.push(note);
  }

  writeFileSync(layout.files.profile, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  syncWorkspaceDocs(layout);
  return next;
}

export function loadDurableMemories(layout: AssistantWorkspaceLayout): AssistantMemoryRecord[] {
  return readJsonFile(layout.files.durableMemory, []);
}

export function addDurableMemory(
  layout: AssistantWorkspaceLayout,
  record: Omit<AssistantMemoryRecord, "id" | "timestamp">
): AssistantMemoryRecord {
  const memories = loadDurableMemories(layout);
  const summary = record.summary.trim();
  const duplicate = memories.find((entry) =>
    entry.kind === record.kind && entry.summary.toLowerCase() === summary.toLowerCase()
  );
  if (duplicate) return duplicate;

  const next: AssistantMemoryRecord = {
    id: `${record.kind}-${Date.now()}-${memories.length + 1}`,
    timestamp: new Date().toISOString(),
    kind: record.kind,
    summary,
    tags: [...new Set((record.tags ?? []).map((tag) => tag.trim()).filter(Boolean))],
  };
  memories.push(next);
  writeFileSync(layout.files.durableMemory, `${JSON.stringify(memories, null, 2)}\n`, "utf-8");
  syncWorkspaceDocs(layout);
  return next;
}

export function appendDailyNote(
  layout: AssistantWorkspaceLayout,
  entry: {
    title: string;
    lines: string[];
    timestamp?: Date;
  }
): string {
  const when = entry.timestamp ?? new Date();
  const day = when.toISOString().slice(0, 10);
  const filePath = join(layout.memoryDir, `${day}.md`);
  const timestamp = when.toISOString();
  const block = [
    `## ${entry.title}`,
    `- Timestamp: ${timestamp}`,
    ...entry.lines.map((line) => `- ${line}`),
    "",
  ].join("\n");

  const existing = existsSync(filePath) ? readFileSync(filePath, "utf-8") : null;
  const prefix = existing === null ? `# Daily Memory — ${day}\n\n` : "";
  writeFileSync(
    filePath,
    `${prefix}${existing ?? ""}${block}`,
    "utf-8"
  );
  return filePath;
}

export function readRecentDailyNotes(
  layout: AssistantWorkspaceLayout,
  limit: number
): Array<{ path: string; content: string }> {
  if (limit <= 0 || !existsSync(layout.memoryDir)) return [];

  return readdirSync(layout.memoryDir)
    .filter((file) => file.endsWith(".md"))
    .sort()
    .reverse()
    .slice(0, limit)
    .map((file) => ({
      path: join(layout.memoryDir, file),
      content: readFileSync(join(layout.memoryDir, file), "utf-8"),
    }));
}

export function loadSimulationHistory(layout: AssistantWorkspaceLayout): AssistantSimulationRecord[] {
  return readJsonFile(layout.files.simulationsIndex, []);
}

export function recordSimulationHistory(
  layout: AssistantWorkspaceLayout,
  input: SimulationRecordInput
): AssistantSimulationRecord {
  const createdAt = new Date().toISOString();
  const timestampSlug = createdAt
    .slice(0, 19)
    .replace(/[:T]/g, "-")
    .replace(/-+/g, "-");
  const slug = `${timestampSlug}-${slugify(input.title)}`.replace(/-+/g, "-");
  const workspaceDir = join(layout.simulationsDir, slug);
  mkdirSync(workspaceDir, { recursive: true });

  const copiedSpecPath = maybeCopyArtifact(input.specPath, join(workspaceDir, "simulation.spec.json"));
  const copiedConfigPath = maybeCopyArtifact(
    input.configPath,
    join(workspaceDir, "publicmachina.generated.config.yaml")
  );
  const copiedReportPath = maybeCopyArtifact(input.reportPath, join(workspaceDir, "report.md"));

  writeFileSync(join(workspaceDir, "brief.md"), `${input.brief.trim()}\n`, "utf-8");
  writeFileSync(join(workspaceDir, "summary.md"), buildSimulationSummary(input, createdAt), "utf-8");

  const record: AssistantSimulationRecord = {
    id: `${slug}-${Date.now()}`,
    slug,
    title: input.title.trim(),
    objective: normalizeOptional(input.objective),
    hypothesis: normalizeOptional(input.hypothesis),
    brief: input.brief.trim(),
    context: normalizeOptional(input.context),
    createdAt,
    workspaceDir,
    specPath: copiedSpecPath,
    configPath: copiedConfigPath,
    docsPath: normalizeOptional(input.docsPath),
    reportPath: copiedReportPath,
    dbPath: normalizeOptional(input.dbPath),
    runId: normalizeOptional(input.runId),
    tags: [...new Set((input.tags ?? []).map((tag) => tag.trim()).filter(Boolean))],
  };

  const history = loadSimulationHistory(layout);
  history.unshift(record);
  writeFileSync(layout.files.simulationsIndex, `${JSON.stringify(history, null, 2)}\n`, "utf-8");
  return record;
}

export function listSimulationHistory(
  layout: AssistantWorkspaceLayout,
  options: { query?: string; limit?: number } = {}
): AssistantSimulationRecord[] {
  const history = loadSimulationHistory(layout);
  const limit = options.limit ?? history.length;
  const query = options.query?.trim();
  if (!query) return history.slice(0, limit);

  const tokens = tokenize(query);
  return history
    .map((record) => ({
      record,
      score: scoreSimulationRecord(record, tokens),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.record.createdAt.localeCompare(b.record.createdAt))
    .slice(0, limit)
    .map((entry) => entry.record);
}

export function readWorkspaceReferenceText(
  layout: AssistantWorkspaceLayout
): {
  identity: string;
  soul: string;
  user: string;
  memory: string;
} {
  return {
    identity: readTextFile(layout.files.identity),
    soul: readTextFile(layout.files.soul),
    user: readTextFile(layout.files.user),
    memory: readTextFile(layout.files.memory),
  };
}

function syncWorkspaceDocs(layout: AssistantWorkspaceLayout): void {
  const profile = loadUserProfile(layout);
  const memories = loadDurableMemories(layout);

  ensureManagedBlock(
    layout.files.user,
    USER_BLOCK,
    renderUserProfile(profile)
  );
  ensureManagedBlock(
    layout.files.memory,
    MEMORY_BLOCK,
    renderDurableMemory(memories)
  );
}

function writeFileIfMissing(filePath: string, contents: string): void {
  if (!existsSync(filePath)) {
    writeFileSync(filePath, contents, "utf-8");
  }
}

function saveJsonIfMissing(filePath: string, value: unknown): void {
  if (!existsSync(filePath)) {
    writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  }
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  if (!existsSync(filePath)) return fallback;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function readTextFile(filePath: string): string {
  return existsSync(filePath) ? readFileSync(filePath, "utf-8") : "";
}

function ensureManagedBlock(filePath: string, blockName: string, content: string): void {
  const start = `<!-- PUBLICMACHINA:${blockName}:START -->`;
  const end = `<!-- PUBLICMACHINA:${blockName}:END -->`;
  const current = existsSync(filePath) ? readFileSync(filePath, "utf-8") : "";
  const block = `${start}\n${content.trimEnd()}\n${end}`;

  if (!current.includes(start) || !current.includes(end)) {
    const prefix = current.trim().length > 0 ? `${current.trimEnd()}\n\n` : "";
    writeFileSync(filePath, `${prefix}${block}\n`, "utf-8");
    return;
  }

  const pattern = new RegExp(`${escapeForRegExp(start)}[\\s\\S]*?${escapeForRegExp(end)}`, "m");
  writeFileSync(filePath, `${current.replace(pattern, block).trimEnd()}\n`, "utf-8");
}

function renderUserProfile(profile: AssistantUserProfile): string {
  const lines = [
    "## Structured Profile",
    `- Preferred name: ${profile.preferredName ?? "unknown"}`,
    `- Last context: ${profile.lastContext ?? "none recorded"}`,
    `- Updated at: ${profile.updatedAt}`,
    "- Persistent notes:",
  ];

  if (profile.notes.length === 0) {
    lines.push("  - none");
  } else {
    for (const note of profile.notes) {
      lines.push(`  - ${note}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function renderDurableMemory(memories: AssistantMemoryRecord[]): string {
  if (memories.length === 0) {
    return "## Durable Memory\n- No durable memory recorded yet.\n";
  }

  const lines = ["## Durable Memory"];
  for (const memory of memories.slice(-12).reverse()) {
    const tags = memory.tags.length > 0 ? ` [${memory.tags.join(", ")}]` : "";
    lines.push(`- ${memory.timestamp} (${memory.kind})${tags}: ${memory.summary}`);
  }
  return `${lines.join("\n")}\n`;
}

function buildAgentsTemplate(): string {
  return `# PublicMachina Workspace

This workspace stores the operator assistant context for PublicMachina.

- Edit \`IDENTITY.md\` to clarify what PublicMachina is responsible for.
- Edit \`SOUL.md\` to shape the tone and temperament of the assistant.
- Use \`USER.md\` for durable collaboration preferences.
- Use \`MEMORY.md\` for long-term notes that should survive across sessions.
- Daily notes land under \`memory/\`.
- Simulation folders land under \`simulations/\`.
`;
}

function buildIdentityTemplate(): string {
  return `# Identity

PublicMachina is an auditable simulation operator for public narratives, institutional scenarios, and web-grounded agents.

Its job is to help the user frame scenarios clearly, preserve context, and turn messy public questions into simulations that can be inspected, rerun, and compared.
`;
}

function buildSoulTemplate(): string {
  return `# Soul

Be calm, direct, and analytically generous.

- Prefer clarity over theatrics.
- Ask only for information that changes the simulation outcome.
- Keep the user moving toward a runnable scenario.
- Remember prior work without becoming sentimental or vague.
`;
}

function buildUserTemplate(): string {
  return `# User

Use this file for durable collaboration notes that should stay visible to both the user and the assistant.

${managedBlock(USER_BLOCK, "No structured user profile captured yet.")}
`;
}

function buildMemoryTemplate(): string {
  return `# Memory

Use this file for durable notes and cross-simulation lessons.

${managedBlock(MEMORY_BLOCK, "No durable memory recorded yet.")}
`;
}

function managedBlock(blockName: string, content: string): string {
  return [
    `<!-- PUBLICMACHINA:${blockName}:START -->`,
    content,
    `<!-- PUBLICMACHINA:${blockName}:END -->`,
  ].join("\n");
}

function maybeCopyArtifact(sourcePath: string | null | undefined, destinationPath: string): string | null {
  if (!sourcePath || !existsSync(sourcePath)) return null;
  copyFileSync(sourcePath, destinationPath);
  return destinationPath;
}

function buildSimulationSummary(input: SimulationRecordInput, createdAt: string): string {
  const lines = [
    `# ${input.title.trim()}`,
    "",
    `- Created at: ${createdAt}`,
    `- Objective: ${normalizeOptional(input.objective) ?? "not captured"}`,
    `- Hypothesis: ${normalizeOptional(input.hypothesis) ?? "not captured"}`,
    `- Run ID: ${normalizeOptional(input.runId) ?? "not linked yet"}`,
    `- Database: ${normalizeOptional(input.dbPath) ?? "not linked yet"}`,
  ];
  if (input.context?.trim()) {
    lines.push("", "## Operator context", "", input.context.trim());
  }
  lines.push("", "## Brief", "", input.brief.trim(), "");
  return `${lines.join("\n")}\n`;
}

function normalizeOptional(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "simulation";
}

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function scoreSimulationRecord(record: AssistantSimulationRecord, tokens: string[]): number {
  const haystack = [
    record.title,
    record.objective ?? "",
    record.hypothesis ?? "",
    record.brief,
    record.context ?? "",
    ...record.tags,
  ].join(" ").toLowerCase();

  return tokens.reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
}

function escapeForRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
