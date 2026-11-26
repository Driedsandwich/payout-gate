import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import type { RunEvent, RunSummary } from "../src/core/types.js";
import { MINI_SCALE } from "./fixtures/payout-mini.js";

const exec = promisify(execFile);
const noFetch = "data:text/javascript," + encodeURIComponent(
  "globalThis.fetch = () => { throw new Error('Network is disabled for this test'); };",
);
const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const cli = ["--import", tsx, "--import", noFetch,
  fileURLToPath(new URL("../src/cli.ts", import.meta.url))];

it.each(["payout-change", "double-pledge"])("writes an evaluated %s sweep for both modes and ticks", async (scenarioId) => {
  const out = await mkdtemp(join(tmpdir(), `${scenarioId}-sweep-`));
  try {
    const { stdout } = await exec(process.execPath, [
      ...cli, "sweep", "--scenario", scenarioId, "--scale", "mini", "--ticks", "20,40", "--inference", "scripted", "--out", out,
    ]);
    const { note, rows } = JSON.parse(await readFile(join(out, "sweep.json"), "utf8")) as {
      note: string; rows: Array<RunSummary & { confirmedLate: number; clearedLate: number }>;
    };
    expect(note).toBe("Scripted latency is simulated; these numbers show the mechanism, not performance.");
    expect(stdout).toContain(note);
    expect(stdout).toContain("plantedMissed");
    expect(rows.map(({ mode, tickMs }) => [mode, tickMs])).toEqual([
      ["concurrent", 20], ["sequential", 20], ["concurrent", 40], ["sequential", 40],
    ]);
    for (const row of rows) {
      const directory = join(out, `${row.mode}-${row.tickMs}`);
      const summary = JSON.parse(await readFile(join(directory, "summary.json"), "utf8")) as RunSummary;
      expect(summary.scenarioId).toBe(scenarioId);
      expect(summary.scale).toEqual(MINI_SCALE);
      const {
        mode, tickMs, released, held, plantedHeld, plantedMissed, falseHolds, heldByTimeout,
        maxConcurrentLoops, modelCalls, wallMs,
      } = summary;
      const log = await readFile(join(directory, "events.jsonl"), "utf8");
      const resolutions = log.trimEnd().split("\n").map((line) => JSON.parse(line) as RunEvent)
        .filter(({ kind }) => kind === "hold.resolved");
      expect(row).toEqual({
        mode, tickMs, released, held, plantedHeld, plantedMissed, falseHolds, heldByTimeout,
        confirmedLate: resolutions.filter(({ data }) => data?.outcome === "confirmed").length,
        clearedLate: resolutions.filter(({ data }) => data?.outcome === "cleared_late").length,
        maxConcurrentLoops, modelCalls, wallMs,
      });
      expect(released + held).toBe(MINI_SCALE.items);
      expect(log).toContain('"kind":"run.finished"');
    }
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

it("resolves a relative run output under the repository from another working directory", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cli-cwd-"));
  const root = fileURLToPath(new URL("../", import.meta.url));
  const out = await mkdtemp(join(root, ".cli-output-"));
  const relativeOut = join(basename(out), "run");
  try {
    await exec(process.execPath, [
      ...cli, "run", "--scenario", "double-pledge", "--scale", "mini", "--tick-ms", "30",
      "--mode", "sequential", "--inference", "scripted", "--fail-policy", "release", "--max-loops", "2",
      "--out", relativeOut,
    ], { cwd });
    const summaryPath = join(relativeOut, "summary.json");
    const summary = JSON.parse(await readFile(join(root, summaryPath), "utf8")) as RunSummary;
    expect(summary).toMatchObject({
      scenarioId: "double-pledge", mode: "sequential", inference: "scripted", failPolicy: "release", tickMs: 30,
    });
    await expect(readFile(join(root, relativeOut, "events.jsonl"), "utf8")).resolves.toContain('"maxLoops":2');
    await expect(readFile(join(cwd, summaryPath), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await Promise.all([rm(out, { recursive: true, force: true }), rm(cwd, { recursive: true, force: true })]);
  }
});
