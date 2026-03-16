import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
const repoRoot = process.cwd();
const distEntry = resolve(repoRoot, "dist", "index.js");

function runBinary(
  args: string[],
  options: { cwd?: string; input?: string; env?: NodeJS.ProcessEnv } = {}
): string {
  return execFileSync(process.execPath, [distEntry, ...args], {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf-8",
    env: { ...process.env, ...options.env },
    input: options.input,
  });
}

beforeAll(() => {
  execFileSync("npm", ["run", "build"], {
    cwd: repoRoot,
    stdio: "pipe",
    env: { ...process.env },
  });
});

afterAll(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("published binary smoke test", () => {
  it("prints the CLI version through dist/index.js", () => {
    const output = runBinary(["--version"]);
    expect(output.trim()).toBe("0.1.0");
  });

  it("runs design through the built binary and writes output files", () => {
    const dir = mkdtempSync(join(tmpdir(), "publicmachina-bin-smoke-"));
    tempDirs.push(dir);

    const outConfig = join(dir, "generated.config.yaml");
    const outSpec = join(dir, "simulation.spec.json");

    const output = runBinary([
      "design",
      "--brief",
      "Create a 10-round simulation about a global consumer electronics recall. Only journalists, analysts, and institutions may search the web. Allow up to 4 search-enabled actors per round. Enable embedding-aware feed ranking.",
      "--docs",
      "./docs/product-recall",
      "--out-config",
      outConfig,
      "--out-spec",
      outSpec,
      "--mock",
      "--yes",
    ]);

    const spec = JSON.parse(readFileSync(outSpec, "utf-8")) as {
      title: string;
      docsPath: string;
    };
    const config = readFileSync(outConfig, "utf-8");

    expect(output).toContain("Simulation Plan");
    expect(output).toContain(`Wrote ${outSpec}`);
    expect(spec.title).toBe("Global Product Recall Response");
    expect(spec.docsPath).toBe("./docs/product-recall");
    expect(config).toContain("search:");
    expect(config).toContain("embeddingEnabled: true");
  });

  it("runs shell in mock mode without a configured provider", () => {
    const dir = mkdtempSync(join(tmpdir(), "publicmachina-shell-smoke-"));
    tempDirs.push(dir);

    const dbPath = join(dir, "shell-smoke.db");

    runBinary([
      "run",
      "--docs",
      "./tests/fixtures/sample-docs",
      "--db",
      dbPath,
      "--run",
      "shell-smoke",
      "--mock",
    ]);

    const output = runBinary(
      [
        "shell",
        "--db",
        dbPath,
        "--run",
        "shell-smoke",
        "--mock",
      ],
      {
        input: "how many actors\nexit\n",
        env: {
          ANTHROPIC_API_KEY: "",
          TEST_PROVIDER_KEY: "",
        },
      }
    );

    expect(output).toContain("PublicMachina Shell");
    expect(output).toContain("SQL: SELECT COUNT(*) as total FROM actors");
    expect(output).toContain("total");
    expect(output).toContain("2");
  });
});
