import type { Hold, RunEvent } from "../core/types.js";

export function countHoldOutcomes(events: RunEvent[]) {
  const outcomes = new Map<string, NonNullable<Hold["outcome"]>>();
  for (const { kind, data } of events) {
    if (kind !== "hold.resolved" || typeof data?.itemId !== "string") continue;
    if (data.outcome === "confirmed" || data.outcome === "cleared_late") outcomes.set(data.itemId, data.outcome);
  }
  let confirmedLate = 0;
  let clearedLate = 0;
  for (const outcome of outcomes.values()) {
    if (outcome === "confirmed") confirmedLate++;
    else clearedLate++;
  }
  return { confirmedLate, clearedLate };
}
