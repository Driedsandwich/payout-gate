import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import publishedSweep from "../web/public/sweeps/web-sweep.json";
import { condenseSweep } from "../web/scripts/condense-sweep.js";

it("keeps one point per mode and tick, the exact note, and counts used by the sweep view", async () => {
  const directory = await mkdtemp(join(tmpdir(), "web-sweep-"));
  try {
    const file = join(directory, "sweep.json");
    const points = [
      { mode: "concurrent", tickMs: 300, released: 392, plantedHeld: 8, clearedLate: 0 },
      { mode: "sequential", tickMs: 300, released: 49, plantedHeld: 8, clearedLate: 343 },
      { mode: "concurrent", tickMs: 500, released: 392, plantedHeld: 8, clearedLate: 0 },
      { mode: "sequential", tickMs: 500, released: 390, plantedHeld: 8, clearedLate: 2 },
    ];
    const note = "Scripted latency is simulated.";
    const rows = points.map((point) => ({ ...point, modelCalls: 200, confirmedLate: 2 })).reverse();
    await writeFile(file, JSON.stringify({ note, rows }));
    expect(await condenseSweep(file)).toEqual({ note, rows: points });
    await writeFile(file, JSON.stringify({ note, rows: [...rows, rows[0]] }));
    await expect(condenseSweep(file)).rejects.toThrow("Duplicate sweep row");
    await writeFile(file, JSON.stringify({ note, rows: rows.slice(1) }));
    await expect(condenseSweep(file)).rejects.toThrow("Missing sweep row");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("publishes all four requested cut-off intervals for both modes", () => {
  expect(publishedSweep.note).toContain("Scripted latency is simulated");
  expect(publishedSweep.rows.map(({ mode, tickMs }) => [mode, tickMs])).toEqual(
    [300, 500, 1000, 1500].flatMap((tick) => [["concurrent", tick], ["sequential", tick]]),
  );
});
