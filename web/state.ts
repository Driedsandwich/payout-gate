import type { HeldItem, ReplayRun } from "./run-data.js";

export function resolutionAt(hold: HeldItem, time: number) {
  return hold.resolution && hold.resolution.time <= time ? hold.resolution : undefined;
}

export function outcomeLabel(hold: HeldItem, time: number): string {
  if (!hold.timeout) return "Held: evidence";
  switch (resolutionAt(hold, time)?.outcome) {
    case "confirmed": return "Held at cut-off → confirmed";
    case "cleared_late": return "Held at cut-off → cleared, paid late";
    case "unresolved": return "Held at cut-off → unresolved";
    default: return "Held at cut-off";
  }
}

export function snapshotAt(run: ReplayRun, time: number) {
  const statuses = new Map<string, ReplayRun["statuses"][number]["status"]>();
  for (const event of run.statuses) {
    if (event.time > time) break;
    statuses.set(event.itemId, event.status);
  }
  let sent = 0;
  let held = 0;
  for (const status of statuses.values()) {
    if (status === "released") sent++;
    if (status === "held") held++;
  }
  return {
    sent, held, waiting: run.summary.items - sent - held,
    holds: run.holds.filter((hold) => hold.time <= time && statuses.get(hold.itemId) === "held"),
  };
}
