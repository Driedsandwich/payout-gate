import { setTimeout as delay } from "node:timers/promises";
import { FunctionCallItem, ModelMessageItem, type InterceptionHandler } from "@mozaik-ai/core";
import type { EventDraft } from "./eventlog.js";
import type { Ledger } from "./ledger.js";
import type { Chunk, RunSummary, SourceRef } from "./types.js";

interface GateOptions {
  ledger: Ledger;
  tickMs: number;
  failPolicy: RunSummary["failPolicy"];
  requiredVerdicts: string[];
  gatedTools: string[];
  nowMs(): number;
  deliverThrough(ms: number): void;
  emit(event: EventDraft): void;
}

export async function waitUntil(deadline: number, nowMs: () => number): Promise<void> {
  while (nowMs() < deadline) await delay(Math.ceil(deadline - nowMs()));
}

function holdAnswer(text: string): Awaited<ReturnType<InterceptionHandler["handle"]>> {
  return { nextStateId: "model_message", input: { answer: ModelMessageItem.rehydrate({ text }) } };
}

export function createGate(options: GateOptions) {
  const { ledger, nowMs, emit } = options;
  const decisions = new Map<string, Promise<string[]>>();
  const intercepted = new Set<string>();

  function readiness(chunk: Chunk, cutoff: number) {
    const scanned = ledger.scannedAt(chunk.id, cutoff);
    const pending = ledger.untriagedAt(cutoff);
    const items = chunk.itemIds.map((itemId) => {
      const required = ledger.revisionAt(itemId, cutoff) > 0 ? options.requiredVerdicts : [];
      const verdicts = ledger.verdictsAt(itemId, cutoff);
      const missing = required.filter((by) => !verdicts.some((v) => v.by === by && v.value !== "unknown"));
      const suspicious = verdicts.filter((v) => required.includes(v.by) && v.value === "suspicious");
      return { itemId, missing, suspicious };
    });
    return { scanned, pending, items };
  }

  function waitForEvidence(chunk: Chunk, dueMs: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        unsubscribe();
        resolve();
      };
      const check = () => {
        const state = readiness(chunk, Math.min(nowMs(), dueMs));
        if (state.scanned && !state.pending.length && state.items.every(({ missing }) => !missing.length)) done();
      };
      const timer = setTimeout(done, Math.max(0, Math.ceil(dueMs - nowMs())));
      const unsubscribe = ledger.subscribe(check);
      check();
    });
  }

  async function decide(chunk: Chunk, loopId: string | undefined): Promise<string[]> {
    const dueMs = chunk.tick * options.tickMs;
    const actor = { agent: "Dispatcher", loopId };
    emit({ ...actor, kind: "gate.wait", itemIds: chunk.itemIds, data: { chunkId: chunk.id, dueMs } });
    if (nowMs() < dueMs) await waitForEvidence(chunk, dueMs);
    // Readiness can change as more arrivals come in before the release tick.
    await waitUntil(dueMs, nowMs);
    options.deliverThrough(dueMs);
    const { scanned, pending, items } = readiness(chunk, dueMs);
    const released: string[] = [];
    for (const { itemId, missing, suspicious } of items) {
      const uncertain = !scanned || pending.length > 0 || missing.length > 0;
      const timeout = suspicious.length === 0 && uncertain && options.failPolicy === "hold";
      if (!suspicious.length && !timeout) {
        released.push(itemId);
        continue;
      }
      const reasons = suspicious.length ? [...new Set(suspicious.map((v) => v.reason))] : [
        ...(!scanned ? ["Batch audit was unfinished at the release tick."] : []),
        ...(pending.length ? ["Inbox triage was unfinished at the release tick."] : []),
        ...missing.map((by) => `${by} had no conclusive verdict at the release tick.`),
      ];
      const sources: SourceRef[] = suspicious.length
        ? suspicious.flatMap((v) => v.sources)
        : [...ledger.item(itemId).sources, ...pending.flatMap((arrival) => arrival.sources)];
      const uniqueSources = [...new Map(sources.map((s) => [JSON.stringify(s), s])).values()];
      ledger.addHold({ itemId, atMs: nowMs(), reasons, sources: uniqueSources });
      emit({
        ...actor, kind: "gate.hold", itemIds: [itemId], sources: uniqueSources,
        data: { chunkId: chunk.id, timeout, reasons },
      });
    }
    ledger.authorizeRelease(chunk.id, released);
    if (released.length) emit({ ...actor, kind: "gate.pass", itemIds: released, data: { chunkId: chunk.id } });
    return released;
  }

  function settle(chunk: Chunk, loopId?: string): Promise<string[]> {
    let result = decisions.get(chunk.id);
    if (!result) {
      result = decide(chunk, loopId);
      decisions.set(chunk.id, result);
    }
    return result;
  }

  function handler(chunk: Chunk, loopId: () => string | undefined): InterceptionHandler {
    return {
      isSatisfiedBy: (transition) =>
        transition.nextStateId === "function_call" && options.gatedTools.includes(transition.input.call.name),
      async handle(transition) {
        if (transition.nextStateId !== "function_call") return transition;
        const { call, inferenceInput } = transition.input;
        let requestedChunk: unknown;
        try {
          requestedChunk = JSON.parse(call.args)?.chunkId;
        } catch {
          return holdAnswer("The release request was malformed.");
        }
        if (requestedChunk !== chunk.id) return holdAnswer("The release request named the wrong chunk.");
        intercepted.add(chunk.id);
        const itemIds = (await settle(chunk, loopId())).filter((id) => ledger.item(id).status !== "released");
        if (!itemIds.length) return holdAnswer("There are no payouts to release for this chunk.");
        return {
          nextStateId: "function_call",
          input: {
            inferenceInput,
            call: FunctionCallItem.rehydrate({
              callId: call.callId, name: call.name, args: JSON.stringify({ chunkId: chunk.id, itemIds }),
            }),
          },
        };
      },
    };
  }

  return { handler, settle, hasCall: (chunkId: string) => intercepted.has(chunkId) };
}
