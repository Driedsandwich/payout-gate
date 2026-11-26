import type { InferenceRunner } from "@mozaik-ai/core";
import { EventLog } from "./eventlog.js";
import { createGate, waitUntil } from "./gate.js";
import { Ledger } from "./ledger.js";
import { createLoopRuntime } from "./loop-runtime.js";
import { scenarioRoles, type ScenarioPackWithRoles } from "./roles.js";
import type { Arrival, Chunk, InferenceMode, LedgerSnapshot, RunSummary, ScenarioData } from "./types.js";

export interface RunOptions {
  runId: string;
  out: string;
  pack: ScenarioPackWithRoles;
  data: ScenarioData;
  mode: RunSummary["mode"];
  inference: Exclude<InferenceMode, { kind: "replay" }>;
  tickMs: number;
  failPolicy: RunSummary["failPolicy"];
  maxLoops: number;
  runner?: InferenceRunner;
}

export interface RunResult {
  eventsPath: string;
  ledger: LedgerSnapshot;
  maxConcurrentLoops: number;
  wallMs: number;
}

export async function runScenario(options: RunOptions): Promise<RunResult> {
  const { data, pack, out, runId, mode, inference, maxLoops, tickMs, failPolicy } = options;
  if (!Number.isSafeInteger(tickMs) || tickMs < 1 || !Number.isSafeInteger(maxLoops) || maxLoops < 1) {
    throw new Error("tickMs and maxLoops must be positive integers");
  }
  const roles = scenarioRoles(pack);
  const log = new EventLog(runId, out);
  try {
    const ledger = new Ledger(data.items, log.nowMs, log.emit, roles);
    const loops = createLoopRuntime({ ...options, log, ledger, explainer: roles.explainer });
    const arrivals = [...data.arrivals].sort((a, b) => a.atTick - b.atTick);
    const chunks = [...data.chunks].sort((a, b) => a.index - b.index);
    const due = (chunk: Chunk) => chunk.tick * tickMs;
    const dispatchAt = (chunk: Chunk) => Math.max(0, due(chunk) - tickMs * 0.3);
    const until = (atMs: number) => waitUntil(atMs, log.nowMs);

    let nextArrival = 0;
    const inbox: Arrival[] = [];
    let onArrival = (arrival: Arrival) => { inbox.push(arrival); };
    function deliverThrough(atMs: number, inclusive = true): void {
      while (nextArrival < arrivals.length) {
        const arrivalMs = arrivals[nextArrival].atTick * tickMs;
        if (arrivalMs > atMs || (!inclusive && arrivalMs === atMs)) break;
        const arrival = arrivals[nextArrival++];
        ledger.addArrival(arrival, arrivalMs);
        onArrival(arrival);
      }
    }

    const gate = createGate({
      ledger, tickMs, failPolicy, roles, gatedTools: pack.gatedTools,
      nowMs: log.nowMs, emit: log.emit,
      deliverBefore: (atMs) => deliverThrough(atMs, false),
      matchArrivalSubjects: (text) => pack.matchArrivalSubjects?.({ tables: data.tables }, text) ?? [],
    });

    const dispatch = (chunk: Chunk) => loops.run(roles.dispatcher, { chunkId: chunk.id }, undefined,
      (loopId) => gate.handler(chunk, loopId));
    const scan = (chunk: Chunk) => loops.run(roles.auditor, { chunkId: chunk.id });
    const triage = (arrival: Arrival) => loops.run(roles.intake, { arrivalId: arrival.id });
    const explain = (itemId: string) => gate.explainHold(itemId,
      (handler) => loops.run(roles.explainer, { itemId }, undefined, () => handler));
    const check = (agent: string, itemId: string, revision: number) => {
      const { subjectId } = ledger.item(itemId);
      return loops.run(agent, { itemId, creatorId: subjectId }, revision);
    };

    async function deliverArrivals(): Promise<void> {
      while (nextArrival < arrivals.length) {
        await until(arrivals[nextArrival].atTick * tickMs);
        deliverThrough(log.nowMs());
      }
    }

    async function enforceTick(chunk: Chunk): Promise<void> {
      await until(due(chunk));
      const released = await gate.settle(chunk);
      if (!gate.hasCall(chunk.id)) ledger.releaseAuthorized(chunk.id, released);
    }

    async function retryTimeoutReviews(runBatch: (tasks: Array<() => Promise<void>>) => Promise<void>): Promise<void> {
      const reviews = gate.timeoutReviews();
      const unread = new Set(reviews.flatMap(({ unread }) => unread));
      const unscanned = new Set(reviews.filter(({ needsAudit }) => needsAudit).map(({ chunkId }) => chunkId));
      const auditChunks = chunks.filter(({ id }) => unscanned.has(id));
      await runBatch([
        ...[...unread].map((id) => () => triage(ledger.arrival(id))),
        ...auditChunks.map((chunk) => () => scan(chunk)),
      ]);
      // Retried intake and audit can start checks for a new evidence revision.
      await runBatch(gate.timeoutReviews().flatMap(({ itemId, missing, revision }) =>
        missing.map((agent) => () => check(agent, itemId, revision))));
      gate.resolveTimeoutHolds();
    }

    async function concurrent(): Promise<void> {
      const pending = new Set<Promise<void>>();
      const errors: unknown[] = [];
      function schedule(work: () => Promise<void>): void {
        const task = Promise.resolve().then(work).catch((error) => { errors.push(error); });
        pending.add(task);
        void task.then(() => pending.delete(task));
      }
      async function drain(): Promise<void> {
        while (pending.size) await Promise.all(pending);
      }
      onArrival = (arrival) => schedule(() => triage(arrival));
      const unsubscribe = ledger.subscribe((signal) => {
        if (signal?.kind === "hold") schedule(() => explain(signal.itemId));
        if (signal?.kind === "evidence") {
          for (const agent of roles.checkers) schedule(() => check(agent, signal.itemId, signal.revision));
        }
      });
      schedule(deliverArrivals);
      for (const chunk of chunks) {
        schedule(async () => {
          await until(Math.max(0, due(chunk) - 1.35 * tickMs));
          await scan(chunk);
        });
        schedule(async () => {
          await until(dispatchAt(chunk));
          await dispatch(chunk);
        });
        schedule(() => enforceTick(chunk));
      }
      try {
        await drain();
        await retryTimeoutReviews(async (tasks) => {
          for (const task of tasks) schedule(task);
          await drain();
        });
        await drain();
        if (errors.length) throw errors[0];
      } finally {
        unsubscribe();
      }
    }

    async function sequential(): Promise<void> {
      const evidence = new Map<string, number>();
      const holds: string[] = [];
      const unsubscribe = ledger.subscribe((signal) => {
        if (signal?.kind === "hold") holds.push(signal.itemId);
        if (signal?.kind === "evidence") evidence.set(signal.itemId, signal.revision);
      });
      async function reviewInbox(cutoff = Infinity): Promise<void> {
        while (log.nowMs() < cutoff) {
          deliverThrough(log.nowMs());
          const arrival = inbox.shift();
          if (!arrival) return;
          await triage(arrival);
        }
      }
      async function reviewEvidence(): Promise<void> {
        const entries = [...evidence];
        evidence.clear();
        for (const [itemId, revision] of entries) {
          for (const agent of roles.checkers) await check(agent, itemId, revision);
        }
      }
      async function rounds(): Promise<void> {
        for (const chunk of chunks) {
          const cutoff = due(chunk);
          await reviewInbox(cutoff);
          await reviewEvidence();
          await scan(chunk);
          while (log.nowMs() < cutoff) {
            await reviewInbox(cutoff);
            await reviewEvidence();
            if (inbox.length) continue;
            const nextArrivalMs = nextArrival < arrivals.length ? arrivals[nextArrival].atTick * tickMs : Infinity;
            await until(Math.min(cutoff, nextArrivalMs));
          }
          // Keep the single agent seat open for intake up to the cut-off.
          // The tick can settle the release even while another loop completes.
          await dispatch(chunk);
        }
      }
      try {
        const work = await Promise.allSettled([rounds(), deliverArrivals(), ...chunks.map(enforceTick)]);
        const failure = work.find((result) => result.status === "rejected");
        if (failure) throw failure.reason;
        await reviewInbox();
        await reviewEvidence();
        await retryTimeoutReviews(async (tasks) => {
          for (const task of tasks) await task();
          await reviewEvidence();
        });
        for (const itemId of holds) await explain(itemId);
      } finally {
        unsubscribe();
      }
    }

    log.emit({
      kind: "run.started",
      data: {
        scenarioId: data.scenarioId, mode, inference: inference.kind === "scripted"
          ? "scripted" : `live:${inference.provider}:${inference.model}`,
        tickMs, failPolicy, scale: data.scale, maxLoops,
      },
    });
    loops.join();
    await (mode === "concurrent" ? concurrent() : sequential());
    const snapshot = ledger.snapshot();
    if (snapshot.items.some(({ status }) => status !== "released" && status !== "held")) {
      throw new Error("Run ended with an unsettled item");
    }
    const wallMs = log.nowMs();
    log.emit({ kind: "run.finished", data: { wallMs } });
    return { eventsPath: log.path, ledger: snapshot, maxConcurrentLoops: loops.maxConcurrentLoops(), wallMs };
  } finally {
    log.close();
  }
}
