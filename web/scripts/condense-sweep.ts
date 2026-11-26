import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SWEEP_MODES, type CutoffSweep, type SweepPoint } from "../sweep-data.js";

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
  return { note, rows: points };
}

async function main(): Promise<void> {
  const ids = process.argv.slice(2);
  if (!ids.length) throw new Error("Usage: npm run web:condense-sweep -- <sweep-id> [<sweep-id> ...]");
  const output = new URL("../public/sweeps/", import.meta.url);
  await mkdir(output, { recursive: true });
  for (const id of ids) {
    if (!/^[\w-]+$/.test(id)) throw new Error(`Invalid sweep ID: ${id}`);
    const sweep = await condenseSweep(new URL(`../../runs/${id}/sweep.json`, import.meta.url));
    await writeFile(new URL(`${id}.json`, output), JSON.stringify(sweep) + "\n");
    console.log(`Condensed ${id}: ${sweep.rows.length} sweep points.`);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
