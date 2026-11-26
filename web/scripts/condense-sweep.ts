import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readRunMetadata } from "../../src/eval/evaluate.js";
import { countHoldOutcomes } from "../../src/eval/hold-outcomes.js";
import { SWEEP_MODES, type CutoffSweep, type SweepPoint } from "../sweep-data.js";
import { readRunEvents } from "./read-events.js";

export async function condenseSweep(sweepFile: URL | string): Promise<CutoffSweep> {
  const { note, rows } = JSON.parse(await readFile(sweepFile, "utf8")) as CutoffSweep;
  if (!Array.isArray(rows) || !rows.length) throw new Error("Sweep has no rows");

  const ticks = new Map<number, Map<SweepPoint["mode"], SweepPoint>>();
  for (const { mode, tickMs, released, plantedHeld, clearedLate } of rows) {
    if (!SWEEP_MODES.includes(mode) || !Number.isSafeInteger(tickMs) || tickMs <= 0 ||
        ![released, plantedHeld, clearedLate].every((count) => Number.isSafeInteger(count) && count >= 0)) {
      throw new Error(`Invalid sweep row for ${mode} at ${tickMs} ms`);
    }
    const points = ticks.get(tickMs) ?? new Map<SweepPoint["mode"], SweepPoint>();
    if (points.has(mode)) throw new Error(`Duplicate sweep row for ${mode} at ${tickMs} ms`);
    points.set(mode, { mode, tickMs, released, plantedHeld, clearedLate });
    ticks.set(tickMs, points);
  }

  const points = [...ticks].sort(([a], [b]) => a - b).flatMap(([tickMs, modes]) =>
    SWEEP_MODES.map((mode) => {
      const point = modes.get(mode);
      if (!point) throw new Error(`Missing sweep row for ${mode} at ${tickMs} ms`);
      return point;
    }));
  const directory = dirname(sweepFile instanceof URL ? fileURLToPath(sweepFile) : sweepFile);
  const logs = await Promise.all(points.map(({ mode, tickMs }) =>
    readRunEvents(join(directory, `${mode}-${tickMs}`)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    })));
  // A standalone sweep.json is also supported.
  let started: CutoffSweep["started"];
  if (logs.some(Boolean)) {
    for (const [index, point] of points.entries()) {
      const events = logs[index];
      const label = `${point.mode} at ${point.tickMs} ms`;
      if (!events) throw new Error(`Missing sweep log for ${label}`);
      const metadata = readRunMetadata(events);
      const { scenarioId, inference } = metadata;
      started ??= { scenarioId, inference };
      if (metadata.mode !== point.mode || metadata.tickMs !== point.tickMs ||
          scenarioId !== started.scenarioId || inference !== started.inference ||
          countHoldOutcomes(events).clearedLate !== point.clearedLate) {
        throw new Error(`Sweep row and log disagree for ${label}`);
      }
    }
  }
  return started ? { note, started, rows: points } : { note, rows: points };
}

async function main(): Promise<void> {
  const inputs = process.argv.slice(2);
  if (!inputs.length) throw new Error("Usage: npm run web:condense-sweep -- <sweep-id|path/to/sweep.json> [...]");
  const output = new URL("../public/sweeps/", import.meta.url);
  await mkdir(output, { recursive: true });
  for (const input of inputs) {
    const file = basename(input) === "sweep.json"
      ? resolve(input)
      : fileURLToPath(new URL(`../../runs/${input}/sweep.json`, import.meta.url));
    const id = basename(input) === "sweep.json" ? basename(dirname(file)) : input;
    if (!/^[\w-]+$/.test(id)) throw new Error(`Invalid sweep ID: ${id}`);
    const sweep = await condenseSweep(file);
    await writeFile(new URL(`${id}.json`, output), JSON.stringify(sweep) + "\n");
    console.log(`Condensed ${id}: ${sweep.rows.length} sweep points.`);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
