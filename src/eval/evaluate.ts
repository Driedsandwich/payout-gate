import type { RunEvent, RunSummary, Scale, ScenarioData, WorkItem } from "../core/types.js";

type RunMetadata = Pick<RunSummary, "runId" | "scenarioId" | "mode" | "inference" | "scale" | "tickMs" | "failPolicy">;

function isScale(value: unknown): value is Scale {
  if (typeof value !== "object" || value === null) return false;
  const scale = value as Partial<Scale>;
  return [scale.items, scale.arrivals, scale.planted, scale.seed].every(Number.isSafeInteger);
}

export function readRunMetadata(events: RunEvent[]): RunMetadata {
  const started = events.find((event) => event.kind === "run.started");
  if (!started?.data) throw new Error("Missing run.started metadata");

  const { scenarioId, mode, inference, scale, tickMs, failPolicy } = started.data;
  if (
    typeof scenarioId !== "string"
    || (mode !== "concurrent" && mode !== "sequential")
    || typeof inference !== "string"
    || !isScale(scale)
    || typeof tickMs !== "number"
    || !Number.isFinite(tickMs)
    || (failPolicy !== "hold" && failPolicy !== "release")
  ) {
    throw new Error("Invalid run.started metadata");
  }
  return { runId: started.runId, scenarioId, mode, inference, scale, tickMs, failPolicy };
}

export function evaluate(events: RunEvent[], data: ScenarioData): RunSummary {
  const metadata = readRunMetadata(events);
  const statuses = new Map(data.items.map((item) => [item.id, item.status]));
  const planted = new Set(data.labels.filter((label) => label.shouldHold).map((label) => label.itemId));
  const everHeld = new Set<string>();
  const timeoutHolds = new Set<string>();
  const activeLoops = new Set<string>();
  let maxConcurrentLoops = 0;
  let modelCalls = 0;
  let citationRejects = 0;
  let usage: { inputTokens: number; outputTokens: number } | undefined;
  let wallMs: number | undefined;

  for (const event of events) {
    switch (event.kind) {
      case "ledger.write": {
        const rowId = event.data?.rowId;
        if (event.data?.table === "items" && typeof rowId === "string" && statuses.has(rowId)) {
          const after = event.data.after as WorkItem | undefined;
          if (after?.status) {
            statuses.set(rowId, after.status);
            if (after.status === "held") everHeld.add(rowId);
          }
        }
        break;
      }
      case "gate.hold":
        for (const itemId of event.itemIds ?? []) {
          if (!statuses.has(itemId)) continue;
          everHeld.add(itemId);
          if (event.data?.timeout === true) timeoutHolds.add(itemId);
        }
        break;
      case "message_received.started":
        if (event.loopId !== undefined) {
          activeLoops.add(event.loopId);
          maxConcurrentLoops = Math.max(maxConcurrentLoops, activeLoops.size);
        }
        break;
      case "model.answer":
        if (event.loopId !== undefined) activeLoops.delete(event.loopId);
        break;
      case "inference.failed":
        modelCalls++;
        if (event.loopId !== undefined) activeLoops.delete(event.loopId);
        break;
      case "inference.completed": {
        modelCalls++;
        const tokens = event.data?.usage as { input?: number; output?: number } | undefined;
        if (typeof tokens?.input === "number" && typeof tokens?.output === "number") {
          usage ??= { inputTokens: 0, outputTokens: 0 };
          usage.inputTokens += tokens.input;
          usage.outputTokens += tokens.output;
        }
        break;
      }
      case "citation.reject":
        citationRejects++;
        break;
      case "run.finished":
        if (typeof event.data?.wallMs === "number" && Number.isFinite(event.data.wallMs)) {
          wallMs = event.data.wallMs;
        }
        break;
    }
  }

  if (wallMs === undefined) throw new Error("Missing run.finished wallMs");

  let released = 0;
  let held = 0;
  let plantedHeld = 0;
  let plantedMissed = 0;
  let falseHolds = 0;
  for (const [itemId, status] of statuses) {
    if (status === "released") released++;
    if (status === "held") held++;
    if (planted.has(itemId)) {
      if (status === "held" || everHeld.has(itemId)) plantedHeld++;
      else if (status === "released") plantedMissed++;
    } else if (status === "held") {
      falseHolds++;
    }
  }

  return {
    ...metadata,
    wallMs,
    items: data.items.length,
    released,
    held,
    plantedHeld,
    plantedMissed,
    falseHolds,
    heldByTimeout: timeoutHolds.size,
    maxConcurrentLoops,
    modelCalls,
    ...usage,
    citationRejects,
  };
}
