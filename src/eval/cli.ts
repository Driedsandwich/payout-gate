import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunEvent } from "../core/types.js";
import { generate } from "../scenarios/payout-change/generate.js";
import { evaluate, readRunMetadata } from "./evaluate.js";

async function main(): Promise<void> {
  const [directory, ...extraArgs] = process.argv.slice(2);
  if (!directory || extraArgs.length) throw new Error("Usage: tsx src/eval/cli.ts runs/<run-id>");

  const log = await readFile(join(directory, "events.jsonl"), "utf8");
  const events: RunEvent[] = [];
  for (const [index, line] of log.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event === null || typeof event !== "object" || typeof event.kind !== "string") {
        throw new Error("Expected a run event");
      }
      events.push(event);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`events.jsonl line ${index + 1}: ${message}`);
    }
  }

  const { scenarioId, scale } = readRunMetadata(events);
  if (scenarioId !== "payout-change") throw new Error(`Unsupported scenario "${scenarioId}"`);

  const summary = evaluate(events, generate(scale));
  const json = `${JSON.stringify(summary, null, 2)}\n`;
  await writeFile(join(directory, "summary.json"), json, "utf8");
  process.stdout.write(json);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
