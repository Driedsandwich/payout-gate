import type { Arrival, ItemStatus, RunSummary, SourceRef, Verdict } from "../src/core/types.js";

export type RowValues = Record<string, string | number>;
export type Timed<T> = T & { time: number };

export interface Segment {
  start: number;
  end: number;
  loopId: string;
  task: string;
}

export interface Lane {
  agent: string;
  segments: Segment[];
}

export interface ReleaseTick {
  chunkId: string;
  tick: number;
  cutoff: number;
  itemIds: string[];
}

export interface GateWait {
  chunkId: string;
  start: number;
  end: number;
  dueMs: number;
  loopId?: string;
}

export type GateDecision = Timed<{ chunkId: string; itemIds: string[] } & (
  { type: "pass" } | { type: "hold"; timeout: boolean; reasons: string[]; sources: string[] }
)>;

export interface HeldPayout {
  itemId: string;
  subjectId: string;
  creator: string;
  chunkId: string;
  amountCents: number;
  currency: string;
  batchAccount: string;
  accountOnFile?: string;
  requests: Timed<{ arrivalId: string; account: string }>[];
  time: number;
  timeout: boolean;
  reasons: string[];
  sources: string[];
  citations: SourceRef[];
  verdicts: Timed<Verdict>[];
  notices: Timed<{ text: string }>[];
}

export interface ReplayRun {
  summary: RunSummary;
  duration: number;
  lanes: Lane[];
  ticks: ReleaseTick[];
  waits: GateWait[];
  decisions: GateDecision[];
  arrivals: Timed<Arrival>[];
  statuses: Timed<{ itemId: string; status: ItemStatus }>[];
  holds: HeldPayout[];
  sourceRows: Record<string, RowValues>;
}
