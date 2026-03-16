import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.js";
import { bootstrapAssistantWorkspace, resolveAssistantWorkspace } from "../src/assistant-workspace.js";
import { createAssistantSession, resetAssistantSession } from "../src/assistant-session.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("assistant-session.ts", () => {
  it("creates and resets sessions with the requested mode", () => {
    const dir = mkdtempSync(join(tmpdir(), "publicmachina-assistant-session-"));
    tempDirs.push(dir);

    const config = defaultConfig();
    config.assistant.workspaceDir = join(dir, "workspace");
    const layout = resolveAssistantWorkspace(config);
    bootstrapAssistantWorkspace(layout, config);

    const designSession = createAssistantSession(layout, "design");
    const shellSession = resetAssistantSession(layout, "shell");

    expect(designSession.mode).toBe("design");
    expect(shellSession.mode).toBe("shell");
    expect(designSession.id).not.toBe(shellSession.id);
  });
});
