import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig, saveConfig } from "../src/config.js";
import {
  bootstrapAssistantWorkspace,
  resolveAssistantWorkspace,
  updateUserProfile,
} from "../src/assistant-workspace.js";
import { startAssistantOperator } from "../src/assistant-operator.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("assistant-operator.ts", () => {
  it("reuses remembered name and context instead of asking for them again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "publicmachina-assistant-operator-"));
    tempDirs.push(dir);

    const config = defaultConfig();
    config.assistant.workspaceDir = join(dir, "workspace");
    const configPath = join(dir, "publicmachina.config.yaml");
    saveConfig(configPath, config);

    const workspace = resolveAssistantWorkspace(config, { configPath });
    bootstrapAssistantWorkspace(workspace, config);
    updateUserProfile(workspace, {
      preferredName: "Angel",
      lastContext: "Crypto markets and AI narrative analysis",
    });

    const questions: string[] = [];
    const answers = ["yes", "/exit"];
    const outputs: string[] = [];
    const statuses: string[] = [];

    await startAssistantOperator({
      config,
      configPath,
      mock: true,
      io: {
        stdout: (text) => outputs.push(text),
        stderr: (text) => outputs.push(text),
        status: (text) => statuses.push(text),
      },
      prompt: {
        ask: async (question) => {
          questions.push(question);
          return answers.shift() ?? "";
        },
      },
    });

    const combined = outputs.join("");
    const statusText = statuses.join("");

    expect(questions).toContain("Are you ready to simulate?");
    expect(questions).toContain("[Angel]");
    expect(questions).not.toContain("What should I call you?");
    expect(
      questions.some((question) => question.startsWith("What context should I keep in mind?"))
    ).toBe(false);

    expect(combined).toContain("Welcome back, Angel.");
    expect(combined).toContain("What would you like to work on today, Angel?");
    expect(statusText).toContain("I will keep using your last context unless you tell me to change it");
    expect(combined).toContain("Goodbye.");
  });

  it("emits completed design results immediately and records structured operator traces", async () => {
    const dir = mkdtempSync(join(tmpdir(), "publicmachina-assistant-operator-"));
    tempDirs.push(dir);

    const config = defaultConfig();
    config.assistant.workspaceDir = join(dir, "workspace");
    const configPath = join(dir, "publicmachina.config.yaml");
    saveConfig(configPath, config);

    const workspace = resolveAssistantWorkspace(config, { configPath });
    bootstrapAssistantWorkspace(workspace, config);
    updateUserProfile(workspace, {
      preferredName: "Angel",
      lastContext: "Crypto markets and AI narrative analysis",
    });

    const outputs: string[] = [];
    const statuses: string[] = [];
    const answers = [
      "yes",
      [
        "Design a new simulation from scratch and replace any previous design.",
        "",
        "Title:",
        "Narrative impact of the NVIDIA NemoClaw WIRED report on Bitcoin",
        "",
        "Objective:",
        "Assess whether the WIRED report can materially change Bitcoin sentiment.",
        "",
        "Primary source:",
        "https://es.wired.com/articulos/nvidia-lanzara-una-plataforma-de-agentes-de-ia-de-codigo-abierto",
        "",
        "Configuration:",
        "- 10 actors",
        "- 16 rounds",
        "- web search enabled",
      ].join("\n"),
      "/exit",
    ];

    await startAssistantOperator({
      config,
      configPath,
      mock: true,
      io: {
        stdout: (text) => outputs.push(text),
        stderr: (text) => outputs.push(text),
        status: (text) => statuses.push(text),
      },
      prompt: {
        ask: async () => answers.shift() ?? "",
      },
    });

    const combined = outputs.join("");
    expect(combined).toContain('Designed "Narrative impact of the NVIDIA NemoClaw WIRED report on Bitcoin"');
    expect(combined).toContain("Simulation Plan");
    expect(combined).toContain("Rounds: 16");

    const sessionFiles = readdirSync(workspace.sessionsDir).filter((file) => file.endsWith(".jsonl")).sort();
    const latestSession = sessionFiles.at(-1);
    expect(latestSession).toBeTruthy();
    const sessionText = readFileSync(join(workspace.sessionsDir, latestSession!), "utf-8");
    expect(sessionText).toContain('"type":"trace"');
    expect(sessionText).toContain('"name":"input_received"');
    expect(sessionText).toContain('"name":"planner_decision"');
    expect(sessionText).toContain('"name":"tool_call"');
    expect(sessionText).toContain('"name":"tool_result"');
    expect(statuses.join("")).toContain("I will keep using your last context unless you tell me to change it");
  });
});
