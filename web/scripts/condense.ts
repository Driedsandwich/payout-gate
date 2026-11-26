import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Hold, RunSummary, ScenarioData, SourceRef, Verdict, WorkItem } from "../../src/core/types.js";
import { readRunMetadata } from "../../src/eval/evaluate.js";
import { countHoldOutcomes } from "../../src/eval/hold-outcomes.js";
import { generate as generatePayouts } from "../../src/scenarios/payout-change/generate.js";
import { generate as generatePledges } from "../../src/scenarios/double-pledge/generate.js";
import type { GateDecision, GateWait, HeldItem, HoldResolution, Lane, ReplayRun, RowValues, ScenarioWords, Segment } from "../run-data.js";
import { modelLatency } from "./model-latency.js";
import { readRunEvents } from "./read-events.js";

const generators = {
  "payout-change": generatePayouts,
  "double-pledge": generatePledges,
} satisfies Record<string, (scale: RunSummary["scale"]) => ScenarioData>;

const scenarios = {
  "payout-change": {
    title: "Black Friday payouts",
    words: { item: "payout", items: "payouts", subject: "creator", cutoff: "Bank cut-off" },
    labels: {
      Dispatcher: "Payout runner",
      InboxWatcher: "Inbox reader",
      BatchAuditor: "Batch auditor",
      RecordChecker: "Source verifier",
      PolicyAgent: "Policy checker",
      Explainer: "Hold explainer",
    },
  },
  "double-pledge": {
    title: "Double pledge",
    words: { item: "funding request", items: "funding requests", subject: "seller", cutoff: "Funding cut-off" },
    labels: {},
  },
} satisfies Record<keyof typeof generators, { title: string; words: ScenarioWords; labels: Record<string, string> }>;

type Request = { arrivalId: string; creatorId: string; requestedAccount: string };

function jsonFields(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return;
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === "object") return value as Record<string, unknown>;
  } catch {
    // A malformed tool call cannot be attributed to an item through its arguments.
  }
}

function append<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function sourceLookup(data: ScenarioData) {
  const tables = new Map(Object.entries(data.tables).map(([table, rows]) => [
    table, new Map<string, RowValues>(rows.map((row) => [row.id, row])),
  ]));
  tables.set("arrivals", new Map(data.arrivals.map(({ sources: _sources, ...row }) => [row.id, row])));
  if (!tables.has("batch")) {
    tables.set("batch", new Map(data.items.map(({ sources: _sources, ...row }) => [row.id, row])));
  }

  const sourceRows: ReplayRun["sourceRows"] = Object.create(null);
  function cite(refs: SourceRef[]): string[] {
    const keys = new Set<string>();
    for (const ref of refs) {
      keys.add(ref.source);
      const file = /(?:^|\/)([\w-]+)\.(?:csv|jsonl|json)#([^/]+)$/.exec(ref.source);
      const path = /#([\w-]+)\/([^/]+)$/.exec(ref.source);
      const location = file ?? path;
      const row = location && tables.get(location[1])?.get(location[2]);
      // Keep the regenerated row separate from fields quoted in the event.
      if (row) sourceRows[ref.source] = row;
    }
    return [...keys];
  }
  return { tables, sourceRows, cite };
}

export async function condenseRun(runDirectory: string): Promise<ReplayRun> {
  const [events, summaryFile] = await Promise.all([
    readRunEvents(runDirectory),
    readFile(join(runDirectory, "summary.json"), "utf8"),
  ]);
  const summary: RunSummary = JSON.parse(summaryFile);
  const metadata = readRunMetadata(events);
  if (!Object.hasOwn(generators, metadata.scenarioId)) {
    throw new Error(`No generator for ${metadata.scenarioId}`);
  }
  const scenarioId = metadata.scenarioId as keyof typeof generators;
  const generate = generators[scenarioId];
  const { title: scenarioTitle, words } = scenarios[scenarioId];
  const labels: Record<string, string> = scenarios[scenarioId].labels;
  const { scale, ...identity } = metadata;
  if (Object.entries(identity).some(([key, value]) => summary[key as keyof RunSummary] !== value) ||
      Object.entries(scale).some(([key, value]) => summary.scale[key as keyof RunSummary["scale"]] !== value)) {
    throw new Error("Run log and summary have different metadata");
  }
  const data = generate(metadata.scale);
  const items = new Map(data.items.map((item) => [item.id, item]));
  const arrivalsById = new Map(data.arrivals.map((arrival) => [arrival.id, arrival]));
  const { tables, sourceRows, cite } = sourceLookup(data);
  const duration = Math.max(summary.wallMs, events.at(-1)?.tMs ?? 0);
  const lanes = new Map<string, Lane>();
  const segments = new Map<string, Segment>();
  const waits: GateWait[] = [];
  const unread: ReplayRun["unread"] = [];
  const decidedAt = new Map<string, number>();
  const decisions: GateDecision[] = [];
  const arrivals: ReplayRun["arrivals"] = [];
  const statuses: ReplayRun["statuses"] = [];
  const heldAt = new Map<string, number>();
  const holdRows = new Map<string, Hold>();
  const resolutions = new Map<string, HoldResolution>();
  const holdDecisions = new Map<string, Extract<GateDecision, { type: "hold" }> & { citations: SourceRef[] }>();
  const verdicts = new Map<string, HeldItem["verdicts"]>();
  const notices = new Map<string, HeldItem["notices"]>();
  const noticeChecks = new Map<string, HeldItem["noticeChecks"]>();
  const noticeCalls = new Map<string, { itemId: string; callId: string }>();
  const requests = new Map<string, HeldItem["requests"]>();

  const laneFor = (agent: string) => {
    if (!lanes.has(agent)) lanes.set(agent, { agent, label: labels[agent] ?? agent, segments: [] });
    return lanes.get(agent)!;
  };

  for (const { kind, agent, loopId, tMs: time, data: eventData, itemIds = [], sources = [] } of events) {
    const payload = eventData?.payload as {
      role?: string; content?: unknown;
      call?: { name: string; args: string; callId: string };
      callId?: string; output?: { text?: string };
    } | undefined;
    switch (kind) {
      case "participant.joined":
        if (agent && payload?.role === "agent") laneFor(agent);
        break;
      case "message_received.started":
        if (agent && loopId && !segments.has(loopId)) {
          const task = typeof payload?.content === "string" ? payload.content : JSON.stringify(payload?.content ?? "");
          const segment = { start: time, end: duration, loopId, task };
          laneFor(agent).segments.push(segment);
          segments.set(loopId, segment);
        }
        break;
      case "inference.failed":
      case "model.answer": {
        const segment = loopId && segments.get(loopId);
        if (segment) {
          segment.end = time;
          segments.delete(segment.loopId);
        }
        if (loopId) noticeCalls.delete(loopId);
        break;
      }
      case "function_call.started": {
        const call = payload?.call;
        if (!loopId || call?.name !== "write_hold_notice") break;
        const itemId = jsonFields(call.args)?.itemId;
        if (typeof itemId === "string") noticeCalls.set(loopId, { itemId, callId: call.callId });
        break;
      }
      case "function_call.completed": {
        const call = loopId ? noticeCalls.get(loopId) : undefined;
        if (loopId && call && call.callId === payload?.callId) {
          noticeCalls.delete(loopId);
          if (jsonFields(payload.output?.text)?.written === true) {
            append(noticeChecks, call.itemId, { time, outcome: "accepted" });
          }
        }
        break;
      }
      case "citation.reject": {
        const call = loopId ? noticeCalls.get(loopId) : undefined;
        const numbers = eventData?.numbers;
        if (call && Array.isArray(numbers)) {
          append(noticeChecks, call.itemId, { time, outcome: "rejected", numbers });
        }
        break;
      }
      case "citation.fallback": {
        const { itemId, attempts } = eventData ?? {};
        if (typeof itemId === "string" && typeof attempts === "number") {
          append(noticeChecks, itemId, { time, outcome: "fallback", attempts });
          const notice = notices.get(itemId)?.at(-1);
          if (notice) notice.origin = "fallback";
        }
        break;
      }
      case "arrival": {
        const arrival = arrivalsById.get(String(eventData?.arrivalId));
        if (arrival) arrivals.push({ ...arrival, time });
        break;
      }
      case "gate.wait":
        waits.push({ chunkId: String(eventData?.chunkId), dueMs: Number(eventData?.dueMs), start: time, end: duration, loopId, agent });
        break;
      case "gate.unread":
        if (typeof eventData?.arrivalId === "string") unread.push({ time, agent, arrivalId: eventData.arrivalId });
        break;
      case "hold.resolved": {
        const { itemId, outcome } = eventData ?? {};
        if (typeof itemId === "string" && (outcome === "confirmed" || outcome === "cleared_late")) {
          const previous = resolutions.get(itemId);
          const citations = sources.length ? sources : previous?.citations ?? [];
          resolutions.set(itemId, { time, outcome, reasons: previous?.reasons ?? [], sources: cite(citations), citations });
        }
        break;
      }
      case "hold.unresolved": {
        const { itemId, reason } = eventData ?? {};
        if (typeof itemId === "string" && typeof reason === "string") {
          resolutions.set(itemId, { time, outcome: "unresolved", reasons: [reason], sources: cite(sources), citations: sources });
        }
        break;
      }
      case "gate.pass":
      case "gate.hold": {
        const chunkId = String(eventData?.chunkId);
        if (!decidedAt.has(chunkId)) decidedAt.set(chunkId, time);
        if (kind === "gate.pass") {
          decisions.push({ type: "pass", chunkId, time, itemIds });
        } else {
          const decision = {
            type: "hold" as const, chunkId, time, itemIds, timeout: eventData?.timeout === true,
            reasons: (eventData?.reasons ?? []) as string[], sources: cite(sources),
          };
          decisions.push(decision);
          for (const itemId of itemIds) holdDecisions.set(itemId, { ...decision, citations: sources });
        }
        break;
      }
      case "ledger.write": {
        const rowId = String(eventData?.rowId);
        const after = eventData?.after;
        if (!after) break;
        switch (eventData?.table) {
          case "items": {
            const { status } = after as WorkItem;
            statuses.push({ itemId: rowId, time, status });
            if (status === "held" && !heldAt.has(rowId)) heldAt.set(rowId, time);
            break;
          }
          case "holds": {
            const row = after as Hold;
            if (!holdRows.has(rowId)) holdRows.set(rowId, row);
            if (row.outcome && !resolutions.has(rowId)) {
              const citations = row.sources ?? sources;
              resolutions.set(rowId, { time, outcome: row.outcome, reasons: row.reasons ?? [], sources: cite(citations), citations });
            }
            if (row.unresolvedReason && !resolutions.has(rowId)) {
              const citations = row.sources ?? sources;
              resolutions.set(rowId, {
                time, outcome: "unresolved", reasons: [row.unresolvedReason], sources: cite(citations), citations,
              });
            }
            if (row.notice && notices.get(rowId)?.at(-1)?.text !== row.notice) {
              const origin = row.outcome === "cleared_late" ? "resolution" : undefined;
              append(notices, rowId, origin ? { time, text: row.notice, origin } : { time, text: row.notice });
            }
            break;
          }
          case "verdicts": {
            const verdict = after as Verdict;
            append(verdicts, verdict.itemId, { ...verdict, time });
            break;
          }
          case "links": {
            const link = after as Partial<Request>;
            if (link.creatorId && link.requestedAccount) {
              append(requests, link.creatorId, { time, arrivalId: rowId, account: link.requestedAccount });
            }
            break;
          }
        }
        break;
      }
    }
  }

  for (const wait of waits) wait.end = Math.max(wait.start, decidedAt.get(wait.chunkId) ?? duration);
  const holds = [...heldAt].map(([itemId, time]): HeldItem => {
    const item = items.get(itemId);
    if (!item) throw new Error(`Unknown held item ${itemId}`);
    const row = holdRows.get(itemId);
    const decision = holdDecisions.get(itemId);
    const itemVerdicts = verdicts.get(itemId) ?? [];
    for (const verdict of itemVerdicts) cite(verdict.sources);
    const master = tables.get("master")?.get(item.subjectId);
    const creator = tables.get("creators")?.get(item.subjectId)?.handle;
    const sellerId = tables.get("invoices")?.get(item.subjectId)?.seller_id;
    const seller = typeof sellerId === "string" ? tables.get("sellers")?.get(sellerId)?.name : undefined;
    const citations = decision?.citations ?? row?.sources ?? [];
    const masterSources = master ? [{ source: `data/master.csv#${item.subjectId}` }] : [];
    const sourceKeys = cite([...masterSources, ...citations]);
    const hasRowValue = (key: string) => Object.entries(sourceRows[key] ?? {}).some(([field, value]) => field !== "id" && value !== "");
    if (!sourceKeys.some(hasRowValue)) sourceKeys.push(...cite(item.sources));
    if (!sourceKeys.some(hasRowValue)) {
      throw new Error(`No data row found for held item ${itemId}`);
    }
    const itemNotices = notices.get(itemId) ?? [];
    if (decision?.timeout && row?.notice && itemNotices[0]?.text === row.notice) itemNotices[0].origin = "cutoff";
    return {
      itemId, time,
      subjectId: item.subjectId, chunkId: item.chunkId,
      subjectName: String(creator ?? seller ?? sellerId ?? item.subjectId), amountCents: item.amountCents, currency: item.currency,
      batchAccount: item.destination, accountOnFile: typeof master?.account_ref === "string" ? master.account_ref : undefined,
      requests: requests.get(item.subjectId) ?? [],
      timeout: decision?.timeout ?? false, reasons: decision?.reasons ?? row?.reasons ?? [],
      sources: [...new Set(sourceKeys)], citations, verdicts: itemVerdicts, notices: itemNotices,
      noticeChecks: noticeChecks.get(itemId) ?? [],
      resolution: resolutions.get(itemId),
    };
  });

  return {
    scenarioId, scenarioTitle, words, summary, duration, lanes: [...lanes.values()],
    started: { inference: metadata.inference, tickMs: metadata.tickMs },
    holdOutcomes: countHoldOutcomes(events),
    modelLatencyMs: modelLatency(events),
    ticks: data.chunks.map(({ id, tick, itemIds }) => ({ chunkId: id, tick, cutoff: tick * metadata.tickMs, itemIds })),
    waits, unread, decisions, arrivals, statuses, holds, sourceRows,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) throw new Error("Usage: npm run web:condense -- <path under runs/> [...]");
  for (const path of args) {
    if (!/^[\w-]+(?:\/[\w-]+)*$/.test(path)) throw new Error(`Invalid run path: ${path}`);
    const directory = fileURLToPath(new URL(`../../runs/${path}/`, import.meta.url));
    const run = await condenseRun(directory);
    if (run.summary.runId !== basename(path)) throw new Error(`Unexpected run ID for ${path}`);
    const output = fileURLToPath(new URL(`../public/runs/${path}.json`, import.meta.url));
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(run) + "\n");
    console.log(`Condensed ${path}: ${run.lanes.length} lanes, ${run.holds.length} holds.`);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
