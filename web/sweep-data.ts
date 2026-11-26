import type { RunSummary } from "../src/core/types.js";

export const SWEEP_MODES = ["concurrent", "sequential"] as const;

export type SweepPoint = Pick<RunSummary, "mode" | "tickMs" | "released" | "plantedHeld"> & {
  clearedLate: number;
};

export interface CutoffSweep {
  note?: string;
  rows: SweepPoint[];
}
