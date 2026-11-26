import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { runScenario } from "../src/core/orchestrator.js";
import type { LedgerSnapshot, RunEvent, RunSummary, ScenarioData } from "../src/core/types.js";
import { evaluate } from "../src/eval/evaluate.js";
import { generate, SCALES } from "../src/scenarios/payout-change/generate.js";
import { payoutChangePack } from "../src/scenarios/payout-change/pack.js";

export const note = "Not financial advice. Synthetic data. Nothing moves.";
const pack = payoutChangePack(generate);

export function generateDemo(seed = SCALES.demo.seed): ScenarioData {
  return pack.generate({ ...SCALES.demo, seed });
}

interface RunRecord {
  ledger: LedgerSnapshot;
  summary: RunSummary;
  notices: Map<string, string>;
}

function readNotices(events: RunEvent[]): Map<string, string> {
  const notices = new Map<string, string>();
  for (const { kind, data } of events) {
    if (kind !== "ledger.write" || data?.table !== "holds" || typeof data.rowId !== "string") continue;
    const after = data.after as { notice?: unknown } | undefined;
    if (typeof after?.notice === "string") notices.set(data.rowId, after.notice);
  }
  return notices;
}

export function createRuns(workspace: string) {
  const runs = new Map<string, RunRecord>();

  function lookup(runId: string): RunRecord {
    const run = runs.get(runId);
    if (!run) throw new Error("Unknown run ID. Check a payout batch to start a new run.");
    return run;
  }

  return {
    async check(data: ScenarioData) {
      const runId = randomUUID();
      let run: RunRecord;
      try {
        const out = await mkdtemp(join(workspace, "run-"));
        try {
          const { eventsPath, ledger } = await runScenario({
            runId, out, pack, data, mode: "concurrent", inference: { kind: "scripted" },
            tickMs: 400, failPolicy: "hold", maxLoops: 32,
          });
          const log = await readFile(eventsPath, "utf8");
          const events = log.trimEnd().split("\n").map((line) => JSON.parse(line) as RunEvent);
          run = { ledger, summary: evaluate(events, data), notices: readNotices(events) };
        } finally {
          await rm(out, { recursive: true, force: true });
        }
      } catch {
        throw new Error("The scripted payout check failed.");
      }

      runs.set(runId, run);
      if (runs.size > 20) {
        const oldest = runs.keys().next();
        if (!oldest.done) runs.delete(oldest.value);
      }
      return {
        runId,
        released: run.ledger.items.filter(({ status }) => status === "released").map(({ id }) => id),
        held: run.ledger.holds.map(({ itemId, reasons, sources }) => ({ itemId, reasons, sources })),
        summary: run.summary,
        note,
      };
    },

    explain(runId: string, itemId: string) {
      const { ledger, notices } = lookup(runId);
      const item = ledger.items.find(({ id }) => id === itemId);
      if (!item) throw new Error("Unknown item ID for this run.");
      const hold = ledger.holds.find((entry) => entry.itemId === itemId);
      if (!hold) throw new Error("The requested item was released in this run.");
      return {
        itemId,
        notice: notices.get(itemId) ?? `Your payout is on hold. ${hold.reasons.join(" ")} ${note}`,
        verdicts: ledger.verdicts.filter((verdict) => verdict.itemId === itemId),
        sources: hold.sources,
      };
    },

    summary(runId: string) {
      return lookup(runId).summary;
    },
  };
}
