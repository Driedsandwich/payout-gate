import type { Ledger } from "./ledger.js";
import type { SourceRef, ToolContext } from "./types.js";

export interface TaskTarget {
  chunkId?: string;
  arrivalId?: string;
  itemId?: string;
  creatorId?: string;
}

export interface TaskToolContext extends ToolContext {
  agent: string;
  loopId?: string;
  target: TaskTarget;
  revision?: number;
  toolSources: SourceRef[];
  readonly toolOutputs: readonly string[];
  ledger: Ledger;
}
