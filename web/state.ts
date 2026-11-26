import type { ReplayRun } from "./run-data.js";

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
