/**
 * The four seams every part of this project shares.
 *
 *   1. RunEvent      — one line of the run log (runs/<run-id>/events.jsonl)
 *   2. Ledger types  — the shared state all agents read and write (lives on the Mozaik RuntimeState)
 *   3. ScenarioPack  — a swappable scenario (data generator, agents, gated tools, scripted policy)
 *   4. InferenceMode — how agents think: scripted (no key), live (a real model), replay (read a log)
 *
 * Rules that come from measuring @mozaik-ai/core 6.0.0 (see docs/design/MOZAIK_6_NOTES.md):
 *   - One task = one runLoop with a FRESH ModelContext. Two loops on the same agent memory mix
 *     their messages, so never pass agent.getMemory().getContext() to more than one live loop.
 *   - A runner that throws produces no event (only an unhandled rejection). Every runner is
 *     wrapped so a failure becomes an `inference.failed` RunEvent and a model message.
 *   - The end of a loop is the `model.answer` event (payload carries the loopId).
 *   - Model notices may cite numbers and dates returned as tool output values.
 *
 * Data is synthetic. Account references look like ACCT-0001 on purpose (never a real IBAN shape).
 * Nothing here moves money: "release" only writes a row in the ledger.
 */

/* ------------------------------------------------------------------ 1. run log */

export type RunEventKind =
  // Mozaik runtime events, copied as they are published (type string kept verbatim)
  | "participant.joined"
  | "message_received.started"
  | "message_received.completed"
  | "inference.started"
  | "inference.completed"
  | "function_call.started"
  | "function_call.completed"
  | "model.answer"
  | "interception.started"
  | "interception.finished"
  // added by this project
  | "inference.failed"   // a runner threw; data.error holds the message (keys are never logged)
  | "arrival"            // an external input arrived (e.g. an account-change request); data.arrival
  | "ledger.write"       // a shared-state write; data.table, data.rowId, data.after
  | "gate.wait"          // the gate is waiting for verdicts on item ids
  | "gate.pass"          // the gate let a gated tool call run
  | "gate.hold"          // the gate rewrote a gated tool call into a hold notice
  | "gate.unread"        // a message was unread at the cut-off and named no subject
  | "gate.retry_triage"  // late review retries an unread arrival tied to a timeout hold
  | "hold.resolved"      // late review confirmed the hold or cleared the item for late payment
  | "hold.unresolved"    // late review could not complete, with the reason recorded
  | "citation.reject"    // an agent text contained an unsupported numeric fact
  | "citation.fallback"  // the gate wrote a notice from recorded hold evidence
  | "run.started"
  | "run.finished";

export interface SourceRef {
  /** where the value came from: a synthetic data file + row id, or a public URL */
  source: string;        // e.g. "data/master.csv#CR-0042" or "https://... (retrieved 2026-11-26)"
  field?: string;        // e.g. "account_ref"
  value?: string | number;
}

export interface RunEvent {
  runId: string;
  seq: number;             // strictly increasing within a run
  tMs: number;             // milliseconds since run.started (wall clock in live mode)
  kind: RunEventKind;
  agent?: string;          // participant name (not the random id)
  loopId?: string;
  itemIds?: string[];      // work items this event is about
  data?: Record<string, unknown>;
  sources?: SourceRef[];
}

/* ------------------------------------------------------------- 2. shared ledger */

export type ItemStatus = "queued" | "checking" | "released" | "held" | "approved" | "rejected";

/** One unit of gated work: a payout (scenario A) or a funding request (scenario B). */
export interface WorkItem {
  id: string;              // "PO-00017" / "FR-0003"
  subjectId: string;       // who it is about: creator id / invoice fingerprint
  amountCents: number;
  currency: string;        // "EUR", "USD"
  destination: string;     // ACCT-0001 style (synthetic)
  batchIndex: number;      // position in the batch (release order)
  chunkId: string;         // "CH-01": released together on the chunk's tick
  status: ItemStatus;
  sources: SourceRef[];    // where every field of this row came from
}

export type VerdictValue = "clear" | "suspicious" | "unknown";

export interface Verdict {
  itemId: string;
  by: string;              // agent name
  value: VerdictValue;
  reason: string;          // short, no invented numbers
  sources: SourceRef[];    // rows that support the verdict
  atMs: number;
}

export interface Hold {
  itemId: string;
  atMs: number;
  reasons: string[];
  sources: SourceRef[];
  notice?: string;
  outcome?: "confirmed" | "cleared_late";
  unresolvedReason?: string;
  resolvedBy?: string;     // human reviewer name when approved/rejected
}

/** An external input that arrives while the batch is running. */
export interface Arrival {
  id: string;              // "IN-0007"
  /** arrival time in release ticks: chunk k is due at tick k (k = 1..n). The runner turns ticks into
   *  milliseconds with the tick length of the run (short for scripted runs, longer for live runs). */
  atTick: number;
  channel: string;         // "email" | "support_ticket" | "in_app" | "lender_api" ...
  subjectId?: string;      // may be unknown until an agent reads it
  body: string;            // synthetic text the intake agent reads
  sources: SourceRef[];
}

export interface LedgerSnapshot {
  items: WorkItem[];
  verdicts: Verdict[];
  holds: Hold[];
  arrivals: Arrival[];
}

/* ------------------------------------------------------------ 3. scenario packs */

export interface Scale {
  items: number;           // e.g. 2000 payouts
  arrivals: number;        // e.g. 60 inbound requests
  planted: number;         // e.g. 12 takeovers planted among the arrivals
  seed: number;
}

/** Ground truth used ONLY by the evaluator (never shown to agents). */
export interface Label {
  itemId: string;
  shouldHold: boolean;
  why: string;             // e.g. "planted takeover IN-0007 changed CR-0042 at 37s"
  arrivalId?: string;
}

export interface Chunk {
  id: string;              // "CH-01"
  index: number;           // 1..n
  tick: number;            // the release is due at this tick (= index)
  itemIds: string[];
}

export interface ScenarioData {
  scenarioId: string;
  scale: Scale;
  items: WorkItem[];
  chunks: Chunk[];
  arrivals: Arrival[];
  /** reference tables the tools read, keyed by table name, each row has an `id` */
  tables: Record<string, Array<Record<string, string | number> & { id: string }>>;
  labels: Label[];
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;   // JSON schema
  /** pure w.r.t. the ledger passed in; returns JSON-serialisable output with sources */
  invoke(args: any, ctx: ToolContext): Promise<unknown>;
}

export interface ToolContext {
  data: ScenarioData;
  ledger: LedgerApi;
  nowMs(): number;
  emit(e: Omit<RunEvent, "runId" | "seq" | "tMs">): void;
}

export interface LedgerApi {
  snapshot(): LedgerSnapshot;
  setStatus(itemId: string, status: ItemStatus, by: string): void;
  addVerdict(v: Verdict): void;
  addHold(h: Hold): void;
  verdictsFor(itemId: string): Verdict[];
}

export interface AgentSpec {
  name: string;                    // "Dispatcher", "InboxWatcher", ...
  role: string;                    // one line for the README / UI
  instruction: string;             // developer message
  tools: ToolSpec[];
  /** what starts a loop for this agent: arrivals, a batch chunk, a new suspicious verdict ... */
  trigger: "arrival" | "chunk" | "verdict" | "start";
}

export interface ScriptedPolicy {
  /** deterministic stand-in for a model: given the agent, the task message and the context so far,
   *  return the next tool call or a final answer. Used when no API key is set and in tests. */
  next(agent: string, task: string, history: Array<{ type: string; name?: string; output?: string }>):
    | { call: { name: string; args: Record<string, unknown> } }
    | { answer: string };
  /** simulated think time in ms (so the timeline shows overlap); NEVER reported as performance */
  latencyMs(agent: string): number;
}

export interface ScenarioPack {
  id: string;                      // "payout-change" | "double-pledge"
  title: string;
  generate(scale: Scale): ScenarioData;
  agents(): AgentSpec[];
  gatedTools: string[];            // tool names the InterceptionHandler guards, e.g. ["release_chunk"]
  /** which verdict-producing agents the gate waits for, per gated call */
  requiredVerdicts: string[];
  /** Match subjects named in unread message text using the same logic as the intake tool. */
  matchArrivalSubjects?(data: Pick<ScenarioData, "tables">, text: string): Array<{ subjectId: string; sources: SourceRef[] }>;
  scripted: ScriptedPolicy;
}

/* ---------------------------------------------------------- 4. inference modes */

export type InferenceMode =
  | { kind: "scripted" }                                        // no key, deterministic
  | { kind: "live"; provider: "openrouter" | "anthropic" | "openai"; model: string }
  | { kind: "replay"; eventsPath: string };                     // read a committed run log

/** Result of one run, written to runs/<run-id>/summary.json. Every number is measured. */
export interface RunSummary {
  runId: string;
  scenarioId: string;
  mode: "concurrent" | "sequential";
  inference: string;               // "scripted" | "live:openrouter:deepseek/deepseek-v4.1-flash-1017" ...
  scale: Scale;
  wallMs: number;
  tickMs: number;                  // length of one release tick in this run
  failPolicy: "hold" | "release";  // what the gate does when verdicts are not in by the tick
  items: number;
  released: number;
  held: number;
  plantedHeld: number;             // labels.shouldHold && held
  plantedMissed: number;           // labels.shouldHold && released  (money would have gone to the wrong account)
  falseHolds: number;              // !labels.shouldHold && held (a clean creator is paid late)
  heldByTimeout: number;           // holds caused by verdicts not arriving before the tick
  maxConcurrentLoops: number;      // measured from the event log
  modelCalls: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;                // from provider usage when available; otherwise omitted
  citationRejects: number;
}
