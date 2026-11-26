import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { RunEvent, RunSummary, WorkItem } from "../src/core/types.js";
import { evaluate } from "../src/eval/evaluate.js";
import { generate } from "../src/scenarios/payout-change/generate.js";
import type { ReplayRun } from "../web/run-data.js";
import { condenseRun } from "../web/scripts/condense.js";
import { snapshotAt } from "../web/state.js";

function expectSummaryCounts(run: ReplayRun, summary: RunSummary) {
  const { sent, held, waiting } = snapshotAt(run, run.duration);
  expect(sent).toBe(summary.released);
  expect(held).toBe(summary.held);
  expect(waiting).toBe(summary.items - summary.released - summary.held);
  expect(run.holds).toHaveLength(summary.held);
  expect(run.holds.filter((hold) => hold.timeout)).toHaveLength(summary.heldByTimeout);

  const timedOut = new Set(run.decisions.flatMap((decision) =>
    decision.type === "hold" && decision.timeout ? decision.itemIds : []));
  expect(timedOut.size).toBe(summary.heldByTimeout);
}

function expectQuotedRows(run: ReplayRun) {
  for (const hold of run.holds) {
    expect(hold.sources.some((source) => {
      const row = run.sourceRows[source];
      return row && Object.entries(row).some(([field, value]) => field !== "id" && value !== "");
    }), hold.itemId).toBe(true);
  }
}

it("condenses log and summary files and regenerates the evidence from run.started", async () => {
  const directory = await mkdtemp(join(tmpdir(), "web-condense-"));
  try {
    const scale = { items: 3, arrivals: 1, planted: 1, seed: 7 };
    const data = generate(scale);
    const [clean, suspect, timedOut] = data.items;
    const [chunk] = data.chunks;
    const [input] = data.arrivals;
    const source = `data/master.csv#${suspect.subjectId}`;
    const status = (item: WorkItem, status: WorkItem["status"], tMs: number) => ({
      kind: "ledger.write" as const, tMs,
      data: { table: "items", rowId: item.id, after: { ...item, status } },
    });
    const entries: Omit<RunEvent, "runId" | "seq">[] = [
      {
        kind: "run.started", tMs: 0,
        data: { scenarioId: "payout-change", mode: "concurrent", inference: "scripted", scale, tickMs: 100, failPolicy: "hold" },
      },
      {
        kind: "message_received.started", agent: "Dispatcher", tMs: 5, loopId: "loop-1",
        data: { payload: { content: '{"chunkId":"CH-01"}' } },
      },
      { kind: "arrival", tMs: 7, data: { arrivalId: input.id, channel: input.channel } },
      { kind: "gate.wait", tMs: 10, loopId: "loop-1", itemIds: chunk.itemIds, data: { chunkId: chunk.id, dueMs: 100 } },
      status(suspect, "held", 100),
      {
        kind: "gate.hold", tMs: 101, itemIds: [suspect.id], sources: [{ source }],
        data: { chunkId: chunk.id, timeout: false, reasons: ["Account mismatch"] },
      },
      status(timedOut, "held", 102),
      {
        kind: "gate.hold", tMs: 103, itemIds: [timedOut.id], sources: [{ source: `data/arrivals.csv#${input.id}` }],
        data: { chunkId: chunk.id, timeout: true, reasons: ["Inbox triage was unfinished."] },
      },
      { kind: "gate.pass", tMs: 104, itemIds: [clean.id], data: { chunkId: chunk.id } },
      status(clean, "released", 105),
      { kind: "model.answer", tMs: 130, loopId: "loop-1" },
      {
        kind: "ledger.write", tMs: 140,
        data: { table: "holds", rowId: suspect.id, after: { itemId: suspect.id, notice: "Recorded hold notice." } },
      },
      { kind: "run.finished", tMs: 150, data: { wallMs: 150 } },
    ];
    const events = entries.map((entry, index) => ({ ...entry, runId: "web-test", seq: index + 1 }));
    const summaryPath = join(directory, "summary.json");
    await Promise.all([
      writeFile(join(directory, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n")),
      writeFile(summaryPath, JSON.stringify(evaluate(events, data))),
    ]);

    const run = await condenseRun(directory);
    const summary = JSON.parse(await readFile(summaryPath, "utf8")) as RunSummary;
    expect(run.summary).toEqual(summary);
    expectSummaryCounts(run, summary);
    expectQuotedRows(run);
    expect(run.sourceRows[source]).toEqual(data.tables.master.find((row) => row.id === suspect.subjectId));
    expect(run.sourceRows[`data/arrivals.csv#${input.id}`]?.body).toBe(input.body);
    expect(run.ticks[0]).toEqual({ chunkId: chunk.id, tick: 1, cutoff: 100, itemIds: chunk.itemIds });
    expect(run.waits[0]).toEqual({ chunkId: chunk.id, start: 10, end: 101, dueMs: 100, loopId: "loop-1" });
    expect(run.arrivals[0]).toMatchObject({ id: input.id, time: 7 });
    expect(run.lanes[0].segments).toEqual([{ start: 5, end: 130, task: '{"chunkId":"CH-01"}', loopId: "loop-1" }]);
    expect(run.holds[0].notices).toEqual([{ time: 140, text: "Recorded hold notice." }]);
    expect(snapshotAt(run, 0)).toMatchObject({ waiting: 3, sent: 0, held: 0, holds: [] });
    expect(snapshotAt(run, 102)).toMatchObject({ waiting: 1, sent: 0, held: 2 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
