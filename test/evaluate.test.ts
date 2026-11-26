import { expect, it } from "vitest";
import type { ItemStatus, RunEvent, ScenarioData } from "../src/core/types.js";
import { evaluate } from "../src/eval/evaluate.js";

const scale = { items: 8, arrivals: 2, planted: 3, seed: 12 };
const data: ScenarioData = {
  scenarioId: "payout-change",
  scale,
  items: Array.from({ length: scale.items }, (_, index) => ({
    id: `PO-0000${index + 1}`,
    subjectId: `CR-000${index + 1}`,
    chunkId: "CH-01",
    batchIndex: index,
    amountCents: 1_000,
    currency: "EUR",
    destination: "ACCT-4321",
    status: "queued",
    sources: [],
  })),
  chunks: [],
  arrivals: [],
  tables: {},
  labels: [
    { itemId: "PO-00001", shouldHold: true, why: "Takeover later approved" },
    { itemId: "PO-00002", shouldHold: true, why: "Missed takeover" },
    { itemId: "PO-00003", shouldHold: true, why: "Timed-out takeover" },
    { itemId: "PO-00004", shouldHold: false, why: "Legitimate notice" },
    { itemId: "PO-00006", shouldHold: false, why: "Large normal payout" },
  ],
};

type LogEntry = Omit<RunEvent, "runId" | "seq" | "tMs">;
const started: LogEntry = {
  kind: "run.started",
  data: { scenarioId: "payout-change", mode: "concurrent", inference: "scripted", scale, tickMs: 1500, failPolicy: "hold" },
};
const finished: LogEntry = { kind: "run.finished", data: { wallMs: 1777 } };

function itemWrite(itemNumber: number, status: ItemStatus): LogEntry {
  const item = data.items[itemNumber - 1];
  return {
    kind: "ledger.write",
    itemIds: [item.id],
    data: { table: "items", rowId: item.id, after: { ...item, status } },
  };
}

function log(entries: LogEntry[]): RunEvent[] {
  return entries.map((event, index) => ({ ...event, runId: "eval-test", seq: index + 1, tMs: index }));
}

it("scores final writes, hold history, timeouts, concurrent loops, calls, usage, and citations", () => {
  const events = log([
    started,
    { kind: "message_received.started", loopId: "one" },
    { kind: "message_received.started", loopId: "two" },
    { kind: "message_received.completed", loopId: "one" },
    { kind: "inference.completed", loopId: "one", data: { usage: { input: 10, output: 3 } } },
    { kind: "inference.failed", loopId: "two", data: { error: "synthetic runner error" } },
    { kind: "message_received.started", loopId: "three" },
    { kind: "model.answer", loopId: "one" },
    { kind: "message_received.started", loopId: "four" },
    { kind: "inference.completed", loopId: "three", data: { usage: { input: 6, output: 4 } } },
    { kind: "inference.completed", loopId: "four" },
    { kind: "model.answer", loopId: "three" },
    { kind: "model.answer", loopId: "four" },
    { kind: "gate.hold", itemIds: ["PO-00001"], data: { chunkId: "CH-01", timeout: false, reasons: ["Account mismatch"] } },
    { kind: "gate.hold", itemIds: ["PO-00003"], data: { chunkId: "CH-01", timeout: true, reasons: ["Pending verdict"] } },
    { kind: "gate.hold", itemIds: ["PO-00003"], data: { chunkId: "CH-01", timeout: true, reasons: ["Pending verdict"] } },
    itemWrite(1, "held"),
    itemWrite(1, "approved"),
    itemWrite(2, "checking"),
    itemWrite(2, "released"),
    itemWrite(3, "held"),
    itemWrite(4, "held"),
    itemWrite(5, "held"),
    itemWrite(6, "held"),
    itemWrite(6, "approved"),
    itemWrite(8, "released"),
    {
      kind: "ledger.write",
      data: { table: "verdicts", rowId: "PO-00002", after: { status: "held" } },
    },
    { kind: "citation.reject", data: { agent: "Explainer", text: "Unsupported amount", numbers: ["20"] } },
    finished,
  ]);

  expect(evaluate(events, data)).toEqual({
    runId: "eval-test",
    scenarioId: "payout-change",
    mode: "concurrent",
    inference: "scripted",
    scale,
    tickMs: 1500,
    failPolicy: "hold",
    wallMs: 1777,
    items: 8,
    released: 2,
    held: 3,
    plantedHeld: 2,
    plantedMissed: 1,
    falseHolds: 2,
    heldByTimeout: 1,
    maxConcurrentLoops: 2,
    modelCalls: 4,
    inputTokens: 16,
    outputTokens: 7,
    citationRejects: 1,
  });
});

it("leaves optional usage absent when the log provides none", () => {
  const summary = evaluate(log([started, { kind: "inference.completed" }, finished]), data);
  expect(summary.modelCalls).toBe(1);
  expect(summary).not.toHaveProperty("inputTokens");
  expect(summary).not.toHaveProperty("outputTokens");
  expect(summary).not.toHaveProperty("costUsd");
});
