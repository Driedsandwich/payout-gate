import type { RunEvent } from "../../src/core/types.js";
import type { ReplayRun } from "../run-data.js";

export function modelLatency(events: RunEvent[]): ReplayRun["modelLatencyMs"] {
  const starts = new Map<string, number>();
  const samples: number[] = [];
  for (const { kind, loopId, tMs } of events) {
    if (!loopId) continue;
    if (kind === "inference.started") starts.set(loopId, tMs);
    if (kind === "inference.failed") starts.delete(loopId);
    if (kind === "inference.completed") {
      const start = starts.get(loopId);
      if (start !== undefined) samples.push(tMs - start);
      starts.delete(loopId);
    }
  }
  if (!samples.length) return null;
  samples.sort((a, b) => a - b);
  // Interpolate between adjacent samples at a fractional rank.
  const percentile = (p: number) => {
    const rank = (samples.length - 1) * p;
    const lower = Math.floor(rank);
    return samples[lower] + (rank - lower) * (samples[Math.ceil(rank)] - samples[lower]);
  };
  return { median: percentile(0.5), p90: percentile(0.9) };
}
