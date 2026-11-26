import type { ReplayRun } from "./run-data.js";

export function comparisonPair(concurrent: ReplayRun, sequential: ReplayRun) {
  const a = concurrent.summary;
  const b = sequential.summary;
  if (
    a.mode !== "concurrent" || b.mode !== "sequential" ||
    a.scenarioId !== b.scenarioId || a.tickMs !== b.tickMs ||
    a.scale.items !== b.scale.items || a.scale.arrivals !== b.scale.arrivals ||
    a.scale.planted !== b.scale.planted || a.scale.seed !== b.scale.seed
  ) return undefined;
  return [concurrent, sequential] as const;
}
