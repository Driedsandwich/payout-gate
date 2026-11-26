import type { Arrival, Hold, ItemStatus, RunSummary, SourceRef, Verdict } from "../src/core/types.js";

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
  label: string;
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
  agent?: string;
}

export type GateDecision = Timed<{ chunkId: string; itemIds: string[] } & (
  { type: "pass" } | { type: "hold"; timeout: boolean; reasons: string[]; sources: string[] }
)>;

export interface ScenarioWords {
  item: string;
  items: string;
  subject: string;
  cutoff: string;
}

export type HoldOutcome = NonNullable<Hold["outcome"]>;
export type HoldResolution = Timed<{ outcome: HoldOutcome; reasons: string[]; sources: string[]; citations: SourceRef[] }>;

export interface HeldItem {
  itemId: string;
  subjectId: string;
  subjectName: string;
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
  notices: Timed<{ text: string; origin?: "cutoff" | "resolution" }>[];
  resolution?: HoldResolution;
}

export interface ReplayRun {
  scenarioId: string;
  scenarioTitle: string;
  words: ScenarioWords;
  summary: RunSummary;
  duration: number;
  lanes: Lane[];
  ticks: ReleaseTick[];
  waits: GateWait[];
  unread: Timed<{ arrivalId: string; agent?: string }>[];
  decisions: GateDecision[];
  arrivals: Timed<Arrival>[];
  statuses: Timed<{ itemId: string; status: ItemStatus }>[];
  holds: HeldItem[];
  sourceRows: Record<string, RowValues>;
}
