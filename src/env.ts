/**
 * env.ts — lightweight .env loading and writing
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

export function loadEnvFile(filePath = ".env"): void {
  if (!existsSync(filePath)) return;

  const contents = readFileSync(filePath, "utf-8");
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (!(key in process.env)) {
      process.env[key] = stripQuotes(value);
    }
  }
}

export function upsertEnvVar(key: string, value: string, filePath = ".env"): void {
  const lines = existsSync(filePath)
    ? readFileSync(filePath, "utf-8").split(/\r?\n/)
    : [];

  let replaced = false;
  const nextLines = lines.map((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith(`${key}=`)) {
      replaced = true;
      return `${key}=${value}`;
    }
    return line;
  });

  if (!replaced) {
    if (nextLines.length > 0 && nextLines[nextLines.length - 1] !== "") {
      nextLines.push("");
    }
    nextLines.push(`${key}=${value}`);
  }

  writeFileSync(filePath, `${nextLines.join("\n").replace(/\n+$/, "")}\n`, "utf-8");
  process.env[key] = value;
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
