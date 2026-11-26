import { setTimeout as delay } from "node:timers/promises";
import { FunctionCallItem, ModelMessageItem, type InterceptionHandler } from "@mozaik-ai/core";
import type { EventDraft } from "./eventlog.js";
import type { Ledger } from "./ledger.js";
import type { ScenarioRoles } from "./roles.js";
import type { Arrival, Chunk, RunSummary, ScenarioPack, SourceRef, Verdict } from "./types.js";

interface GateOptions {
  ledger: Ledger;
  tickMs: number;
  failPolicy: RunSummary["failPolicy"];
  roles: Pick<ScenarioRoles, "dispatcher" | "checkers">;
  gatedTools: string[];
  nowMs(): number;
  deliverBefore(ms: number): void;
  matchArrivalSubjects: (text: string) => ReturnType<NonNullable<ScenarioPack["matchArrivalSubjects"]>>;
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
  const screened = new Map<string, ReturnType<GateOptions["matchArrivalSubjects"]>>();
  const timeoutHolds = new Map<string, { chunkId: string; arrivals: string[] }>();

  function evidence(itemId: string, cutoff: number) {
    const required = ledger.revisionAt(itemId, cutoff) > 0 ? options.roles.checkers : [];
    const verdicts = ledger.verdictsAt(itemId, cutoff).filter((v) => required.includes(v.by));
    const missing = required.filter((by) => !verdicts.some((v) => v.by === by && v.value !== "unknown"));
    const suspicious = verdicts.filter((v) => v.value === "suspicious");
    return { verdicts, missing, suspicious };
  }

  function screen(arrival: Arrival, actor: Pick<EventDraft, "agent" | "loopId">) {
    let matches = screened.get(arrival.id);
    if (matches) return matches;
    const arrivalSource = { source: `data/arrivals.jsonl#${arrival.id}` };
    matches = options.matchArrivalSubjects(arrival.body).map(({ subjectId, sources }) => ({
      subjectId, sources: [arrivalSource, ...arrival.sources, ...sources],
    }));
    screened.set(arrival.id, matches);
    if (!matches.length) {
      emit({ ...actor, kind: "gate.unread", data: { arrivalId: arrival.id }, sources: [arrivalSource, ...arrival.sources] });
    }
    return matches;
  }

  function uniqueSources(sources: SourceRef[]): SourceRef[] {
    return [...new Map(sources.map((s) => [JSON.stringify(s), s])).values()];
  }

  function verdictHold(verdicts: Verdict[]) {
    return {
      reasons: [...new Set(verdicts.map((v) => v.reason))],
      sources: uniqueSources(verdicts.flatMap((v) => v.sources)),
    };
  }

  async function decide(chunk: Chunk, loopId: string | undefined): Promise<string[]> {
    const dueMs = chunk.tick * options.tickMs;
    const actor = { agent: options.roles.dispatcher, loopId };
    emit({ ...actor, kind: "gate.wait", itemIds: chunk.itemIds, data: { chunkId: chunk.id, dueMs } });
    await waitUntil(dueMs, nowMs);
    options.deliverBefore(dueMs);
    const scanned = ledger.scannedAt(chunk.id, dueMs);
    const unread = new Map<string, Array<{ arrivalId: string; sources: SourceRef[] }>>();
    for (const arrival of ledger.untriagedAt(dueMs)) {
      for (const { subjectId, sources } of screen(arrival, actor)) {
        const entries = unread.get(subjectId) ?? [];
        entries.push({ arrivalId: arrival.id, sources });
        unread.set(subjectId, entries);
      }
    }
    const released: string[] = [];
    for (const itemId of chunk.itemIds) {
      const item = ledger.item(itemId);
      const pending = unread.get(item.subjectId) ?? [];
      const { missing, suspicious } = evidence(itemId, dueMs);
      const uncertain = !scanned || pending.length > 0 || missing.length > 0;
      const timeout = suspicious.length === 0 && uncertain && options.failPolicy === "hold";
      if (!suspicious.length && !timeout) {
        released.push(itemId);
        continue;
      }
      const { reasons, sources } = suspicious.length ? verdictHold(suspicious) : {
        reasons: [
          ...(!scanned ? ["Batch audit was unfinished at the release tick."] : []),
          ...(pending.length ? ["named in a message not read before the cut-off"] : []),
          ...missing.map((by) => `${by} had no conclusive verdict at the release tick.`),
        ],
        sources: uniqueSources([...(!scanned || missing.length ? item.sources : []), ...pending.flatMap((entry) => entry.sources)]),
      };
      const notice = timeout
        ? `Your payout is held for review. ${reasons.join(" ")} This is not financial advice.`
        : undefined;
      ledger.addHold({ itemId, atMs: nowMs(), reasons, sources, notice });
      if (timeout) timeoutHolds.set(itemId, { chunkId: chunk.id, arrivals: pending.map(({ arrivalId }) => arrivalId) });
      emit({
        ...actor, kind: "gate.hold", itemIds: [itemId], sources,
        data: { chunkId: chunk.id, timeout, reasons },
      });
    }
    ledger.authorizeRelease(chunk.id, released);
    if (released.length) emit({ ...actor, kind: "gate.pass", itemIds: released, data: { chunkId: chunk.id } });
    return released;
  }

  function resolveTimeoutHolds(): void {
    const reviewedAt = nowMs();
    const unread = new Set(ledger.untriagedAt(reviewedAt).map(({ id }) => id));
    for (const [itemId, { chunkId, arrivals }] of timeoutHolds) {
      const { verdicts, missing, suspicious } = evidence(itemId, reviewedAt);
      if (suspicious.length) {
        ledger.resolveHold(itemId, { ...verdictHold(suspicious), outcome: "confirmed", notice: undefined });
      } else if (!missing.length && ledger.scannedAt(chunkId, reviewedAt) && arrivals.every((id) => !unread.has(id))) {
        ledger.resolveHold(itemId, {
          outcome: "cleared_late",
          reasons: ["cleared after cut-off"],
          sources: uniqueSources([...ledger.item(itemId).sources, ...verdicts.flatMap((v) => v.sources)]),
          notice: "Your payout was cleared after cut-off and paid late. This is not financial advice.",
        });
      }
    }
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
        if (!itemIds.length) return holdAnswer("There are no items to release for this chunk.");
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

  return { handler, settle, resolveTimeoutHolds, hasCall: (chunkId: string) => intercepted.has(chunkId) };
}
