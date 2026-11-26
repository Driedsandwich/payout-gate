import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { expect, it } from "vitest";
import type { RunEvent, RunSummary } from "../src/core/types.js";
import { comparisonPair } from "../web/compare.js";
import type { ReplayRun } from "../web/run-data.js";
import { condenseRun } from "../web/scripts/condense.js";
import { outcomeLabel, snapshotAt } from "../web/state.js";

const scenarios = ["payout-change", "double-pledge"] as const;
const modes = ["concurrent", "sequential"] as const;
const runs = scenarios.flatMap((scenario) => modes.map((mode) => ({
  scenario, mode, directory: `live/${scenario}-t20`, id: `${mode}-20000`,
})));

async function published(scenario: typeof scenarios[number], mode: typeof modes[number]) {
  const file = new URL(`../web/public/runs/live/${scenario}-t20/${mode}-20000.json`, import.meta.url);
  return JSON.parse(await readFile(file, "utf8")) as ReplayRun;
}

it.each(runs)("matches the $scenario $mode summary, logs and live sweep", async ({ directory, id, scenario, mode }) => {
  const runDirectory = new URL(`../runs/${directory}/${id}/`, import.meta.url);
  const [run, regenerated, summaryFile, log, sweepFile] = await Promise.all([
    published(scenario, mode),
    condenseRun(fileURLToPath(runDirectory)),
    readFile(new URL("summary.json", runDirectory), "utf8"),
    readFile(new URL("events.jsonl.gz", runDirectory)),
    readFile(new URL(`../runs/${directory}/sweep.json`, import.meta.url), "utf8"),
  ]);
  const summary = JSON.parse(summaryFile) as RunSummary;
  const events = gunzipSync(log).toString("utf8").trim().split("\n").map((line) => JSON.parse(line) as RunEvent);
  const sweep = JSON.parse(sweepFile).rows.find((row: RunSummary) => row.mode === mode && row.tickMs === summary.tickMs);
  expect(run).toEqual(JSON.parse(JSON.stringify(regenerated)));
  expect(run.summary).toEqual(summary);
  expect(run.holdOutcomes).toEqual({ confirmedLate: sweep.confirmedLate, clearedLate: sweep.clearedLate });
  const { inference, tickMs } = events.find(({ kind }) => kind === "run.started")!.data!;
  expect(run.started).toEqual({ inference, tickMs });
  expect(snapshotAt(run, run.duration)).toMatchObject({ sent: summary.released, held: summary.held, waiting: 0 });
  expect(run.holds).toHaveLength(summary.held);
  expect(run.holds.filter((hold) => hold.timeout)).toHaveLength(summary.heldByTimeout);
  for (const hold of run.holds) {
    expect(hold.sources.some((source) =>
      Object.entries(run.sourceRows[source] ?? {}).some(([field, value]) => field !== "id" && value !== ""),
    ), hold.itemId).toBe(true);
  }

  const starts = events.filter(({ kind }) => kind === "inference.started");
  const samples = events.filter(({ kind }) => kind === "inference.completed").map((completed) => {
    const start = starts.filter(({ seq, loopId }) => seq < completed.seq && loopId === completed.loopId).at(-1);
    return completed.tMs - start!.tMs;
  }).sort((a, b) => a - b);
  expect(samples).toHaveLength(summary.modelCalls);
  const middle = Math.floor(samples.length / 2);
  const median = samples.length % 2 ? samples[middle] : (samples[middle - 1] + samples[middle]) / 2;
  const rank = 9 * (samples.length - 1) / 10;
  const fraction = rank % 1;
  const p90 = samples[Math.floor(rank)] * (1 - fraction) + samples[Math.ceil(rank)] * fraction;
  expect(run.modelLatencyMs?.median).toBeCloseTo(median, 9);
  expect(run.modelLatencyMs?.p90).toBeCloseTo(p90, 9);
});

it("only compares opposite modes with the same scenario, cut-off and full scale", async () => {
  const [concurrent, sequential, pledge] = await Promise.all([
    published("payout-change", "concurrent"),
    published("payout-change", "sequential"),
    published("double-pledge", "sequential"),
  ]);
  expect(comparisonPair(concurrent, sequential)).toEqual([concurrent, sequential]);
  expect(comparisonPair(concurrent, concurrent)).toBeUndefined();
  expect(comparisonPair(concurrent, { ...pledge, summary: { ...pledge.summary, scale: concurrent.summary.scale } })).toBeUndefined();
  expect(comparisonPair(concurrent, { ...sequential, summary: { ...sequential.summary, tickMs: 500 } })).toBeUndefined();
  for (const key of Object.keys(sequential.summary.scale) as Array<keyof RunSummary["scale"]>) {
    const scale = { ...sequential.summary.scale, [key]: sequential.summary.scale[key] + 1 };
    expect(comparisonPair(concurrent, { ...sequential, summary: { ...sequential.summary, scale } })).toBeUndefined();
  }
});

it("keeps the logged unresolved reason and attributes citation outcomes to the notice", async () => {
  const run = await published("payout-change", "concurrent");
  const unresolved = run.holds.find((hold) => hold.itemId === "PO-00270")!;
  expect(unresolved.resolution).toMatchObject({
    outcome: "unresolved", reasons: ["Inbox triage did not complete for IN-0011."],
  });
  expect(outcomeLabel(unresolved, unresolved.resolution!.time - 1)).toBe("Held at cut-off");
  expect(outcomeLabel(unresolved, run.duration)).toBe("Held at cut-off → unresolved");
  const fallback = run.holds.find((hold) => hold.itemId === "PO-00068")!;
  expect(fallback.noticeChecks.map(({ outcome }) => outcome)).toEqual(["rejected", "rejected", "rejected", "fallback"]);
  expect(fallback.noticeChecks.at(-1)).toMatchObject({ attempts: 3 });
  expect(fallback.notices.at(-1)?.origin).toBe("fallback");
  expect(run.holds.find((hold) => hold.itemId === "PO-00024")?.noticeChecks).toEqual([
    expect.objectContaining({ outcome: "accepted" }),
  ]);
});
