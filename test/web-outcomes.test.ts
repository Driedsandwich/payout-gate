import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { Hold, RunEvent, WorkItem } from "../src/core/types.js";
import { evaluate } from "../src/eval/evaluate.js";
import { generate } from "../src/scenarios/double-pledge/generate.js";
import { condenseRun } from "../web/scripts/condense.js";
import { outcomeLabel, snapshotAt } from "../web/state.js";

it("uses the logged scenario and agents, and preserves holds and unread events in replay order", async () => {
  const directory = await mkdtemp(join(tmpdir(), "web-outcomes-"));
  try {
    const scale = { items: 4, arrivals: 1, planted: 1, seed: 11 };
    const data = generate(scale);
    const [verdict, confirmed, cleared, pending] = data.items;
    const [arrival] = data.arrivals;
    const agents = ["Dispatcher", "Intake", "Fingerprinter", "RegistryChecker", "DebtorChecker", "Explainer", "ExtraAgent"];
    const status = (item: WorkItem, time: number) => ({
      kind: "ledger.write" as const, tMs: time,
      data: { table: "items", rowId: item.id, after: { ...item, status: "held" } },
    });
    const hold = (item: WorkItem, tMs: number, fields: Partial<Hold> = {}) => ({
      kind: "ledger.write" as const, tMs,
      data: { table: "holds", rowId: item.id, after: {
        itemId: item.id, atMs: 100, reasons: ["Evidence review"], sources: item.sources, ...fields,
      } },
    });
    const gate = (item: WorkItem, timeout: boolean) => ({
      kind: "gate.hold" as const, tMs: 100, itemIds: [item.id], sources: item.sources,
      data: { chunkId: item.chunkId, timeout, reasons: ["Evidence review"] },
    });
    const resolve = (item: WorkItem, outcome: "confirmed" | "cleared_late", tMs: number) => ({
      kind: "hold.resolved" as const, tMs, itemIds: [item.id], sources: item.sources, data: { itemId: item.id, outcome },
    });
    const cutoffNotice = { notice: "Funding request held for review." };
    const steps: Omit<RunEvent, "runId" | "seq">[] = [
      { kind: "run.started", tMs: 0, data: {
        scenarioId: data.scenarioId, mode: "concurrent", inference: "scripted", scale, tickMs: 100, failPolicy: "hold",
      } },
      ...agents.map((agent) => ({
        kind: "participant.joined" as const, tMs: 0, agent, data: { payload: { role: "agent" } },
      })),
      { kind: "gate.unread", tMs: 100, agent: "Dispatcher", data: { arrivalId: arrival.id } },
      status(verdict, 100), hold(verdict, 100), gate(verdict, false),
      status(confirmed, 100), hold(confirmed, 100, cutoffNotice), gate(confirmed, true),
      status(cleared, 100), hold(cleared, 100, cutoffNotice), gate(cleared, true),
      status(pending, 100), hold(pending, 100, cutoffNotice), gate(pending, true),
      hold(verdict, 110, { notice: "Explainer's verdict notice." }),
      hold(confirmed, 120, { outcome: "confirmed" }),
      resolve(confirmed, "confirmed", 121),
      hold(cleared, 122, { outcome: "cleared_late", notice: "Cleared and paid late." }),
      resolve(cleared, "cleared_late", 123),
      hold(confirmed, 130, { outcome: "confirmed", notice: "Explainer's confirmation notice." }),
      { kind: "run.finished", tMs: 140, data: { wallMs: 140 } },
    ];
    const events = steps.map((event, seq) => ({ ...event, runId: "web-outcomes", seq: seq + 1 }));
    const summary = evaluate(events, data);
    await Promise.all([
      writeFile(join(directory, "events.jsonl"), events.map((event) => JSON.stringify(event)).join("\n")),
      writeFile(join(directory, "summary.json"), JSON.stringify(summary)),
    ]);

    const run = await condenseRun(directory);
    expect(run.scenarioId).toBe("double-pledge");
    expect(run.scenarioTitle).toBe("Double pledge");
    expect(run.words).toMatchObject({ item: "funding request", subject: "seller" });
    expect(run.lanes.map(({ label }) => label)).toEqual(agents);
    expect(run.unread).toEqual([{ time: 100, agent: "Dispatcher", arrivalId: arrival.id }]);
    expect(run.summary).toEqual(summary);
    expect(snapshotAt(run, run.duration)).toMatchObject({ sent: summary.released, held: summary.held, waiting: 0 });
    expect(run.holds.map((entry) => outcomeLabel(entry, run.duration))).toEqual([
      "Held: evidence",
      "Held at cut-off → confirmed",
      "Held at cut-off → cleared, paid late",
      "Held at cut-off",
    ]);
    expect(outcomeLabel(run.holds[1], 120)).toBe("Held at cut-off");
    expect(outcomeLabel(run.holds[2], 122)).toBe("Held at cut-off");
    expect(run.holds[0].notices.map(({ text }) => text)).toEqual(["Explainer's verdict notice."]);
    expect(run.holds[1].notices).toEqual([
      { time: 100, origin: "cutoff", text: cutoffNotice.notice },
      { time: 130, text: "Explainer's confirmation notice." },
    ]);
    expect(run.holds[2].notices[1]).toMatchObject({ origin: "resolution", text: "Cleared and paid late." });
    for (const entry of run.holds) {
      expect(entry.subjectName).toMatch(/^seller_/);
      expect(entry.sources.some((source) => typeof run.sourceRows[source]?.advance_cents === "number")).toBe(true);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
