import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import type { RunSummary } from "../src/core/types.js";
import { MINI_SCALE } from "./fixtures/payout-mini.js";

it("writes a sweep row and evaluated run for each mode and tick on the mini fixture", async () => {
  const out = await mkdtemp(join(tmpdir(), "payout-sweep-"));
  const noFetch = "data:text/javascript," + encodeURIComponent(
    "globalThis.fetch = () => { throw new Error('Network is disabled for this test'); };",
  );
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [
      "--import", "tsx", "--import", noFetch, fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
      "sweep", "--scenario", "payout-change", "--scale", "mini", "--ticks", "20,40", "--inference", "scripted", "--out", out,
    ]);
    const { note, rows } = JSON.parse(await readFile(join(out, "sweep.json"), "utf8")) as { note: string; rows: RunSummary[] };
    expect(note).toBe("Scripted latency is simulated; these numbers show the mechanism, not performance.");
    expect(stdout).toContain(note);
    expect(stdout).toContain("plantedMissed");
    expect(rows.map(({ mode, tickMs }) => [mode, tickMs])).toEqual([
      ["concurrent", 20], ["sequential", 20], ["concurrent", 40], ["sequential", 40],
    ]);
    for (const row of rows) {
      const directory = join(out, `${row.mode}-${row.tickMs}`);
      const summary = JSON.parse(await readFile(join(directory, "summary.json"), "utf8")) as RunSummary;
      expect(summary.scale).toEqual(MINI_SCALE);
      const {
        mode, tickMs, released, held, plantedHeld, plantedMissed, falseHolds, heldByTimeout,
        maxConcurrentLoops, modelCalls, wallMs,
      } = summary;
      expect(row).toEqual({
        mode, tickMs, released, held, plantedHeld, plantedMissed, falseHolds, heldByTimeout,
        maxConcurrentLoops, modelCalls, wallMs,
      });
      expect(released + held).toBe(MINI_SCALE.items);
      expect(await readFile(join(directory, "events.jsonl"), "utf8")).toContain('"kind":"run.finished"');
    }
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
