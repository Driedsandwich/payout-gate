import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Hold, RunEvent, RunSummary, ScenarioData, SourceRef, Verdict, WorkItem } from "../../src/core/types.js";
import { readRunMetadata } from "../../src/eval/evaluate.js";
import { generate as generatePayouts } from "../../src/scenarios/payout-change/generate.js";
import { generate as generatePledges } from "../../src/scenarios/double-pledge/generate.js";
import type { GateDecision, GateWait, HeldPayout, Lane, ReplayRun, RowValues, Segment, Timed } from "../run-data.js";

const generators = {
  "payout-change": generatePayouts,
  "double-pledge": generatePledges,
} satisfies Record<string, (scale: RunSummary["scale"]) => ScenarioData>;

type Request = { arrivalId: string; creatorId: string; requestedAccount: string };

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
  const [log, summaryFile] = await Promise.all([
    readFile(join(runDirectory, "events.jsonl"), "utf8"),
    readFile(join(runDirectory, "summary.json"), "utf8"),
  ]);
  const events: RunEvent[] = log.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const summary: RunSummary = JSON.parse(summaryFile);
  const metadata = readRunMetadata(events);
  if (!Object.hasOwn(generators, metadata.scenarioId)) {
    throw new Error(`No generator for ${metadata.scenarioId}`);
  }
  const generate = generators[metadata.scenarioId as keyof typeof generators];
  if (metadata.runId !== summary.runId || metadata.scenarioId !== summary.scenarioId) {
    throw new Error("Run log and summary identify different runs");
  }
  const data = generate(metadata.scale);
  const items = new Map(data.items.map((item) => [item.id, item]));
  const arrivalsById = new Map(data.arrivals.map((arrival) => [arrival.id, arrival]));
  const { tables, sourceRows, cite } = sourceLookup(data);
  const duration = Math.max(summary.wallMs, events.at(-1)?.tMs ?? 0);
  const lanes = new Map<string, Lane>();
  const segments = new Map<string, Segment>();
  const waits: GateWait[] = [];
  const decidedAt = new Map<string, number>();
  const decisions: GateDecision[] = [];
  const arrivals: ReplayRun["arrivals"] = [];
  const statuses: ReplayRun["statuses"] = [];
  const heldAt = new Map<string, number>();
  const holdRows = new Map<string, Hold>();
  const holdDecisions = new Map<string, Extract<GateDecision, { type: "hold" }> & { citations: SourceRef[] }>();
  const verdicts = new Map<string, HeldPayout["verdicts"]>();
  const notices = new Map<string, HeldPayout["notices"]>();
  const requests = new Map<string, HeldPayout["requests"]>();

  const laneFor = (agent: string) => {
    if (!lanes.has(agent)) lanes.set(agent, { agent, segments: [] });
    return lanes.get(agent)!;
  };

  for (const { kind, agent, loopId, tMs: time, data: eventData, itemIds = [], sources = [] } of events) {
    const payload = eventData?.payload as { role?: string; content?: unknown } | undefined;
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
        break;
      }
      case "arrival": {
        const arrival = arrivalsById.get(String(eventData?.arrivalId));
        if (arrival) arrivals.push({ ...arrival, time });
        break;
      }
      case "gate.wait":
        waits.push({ chunkId: String(eventData?.chunkId), dueMs: Number(eventData?.dueMs), start: time, end: duration, loopId });
        break;
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
            const row = after as Hold & { notice?: string };
            if (!holdRows.has(rowId)) holdRows.set(rowId, row);
            if (row.notice) append(notices, rowId, { time, text: row.notice });
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
  const holds = [...heldAt].map(([itemId, time]): HeldPayout => {
    const item = items.get(itemId);
    if (!item) throw new Error(`Unknown held item ${itemId}`);
    const row = holdRows.get(itemId);
    const decision = holdDecisions.get(itemId);
    const itemVerdicts = verdicts.get(itemId) ?? [];
    for (const verdict of itemVerdicts) cite(verdict.sources);
    const master = tables.get("master")?.get(item.subjectId);
    const creator = tables.get("creators")?.get(item.subjectId)?.handle;
    const citations = decision?.citations ?? row?.sources ?? [];
    const masterSources = master ? [{ source: `data/master.csv#${item.subjectId}` }] : [];
    const sourceKeys = cite([...masterSources, ...citations]);
    if (!sourceKeys.some((key) => key in sourceRows)) sourceKeys.push(...cite(item.sources));
    if (!sourceKeys.some((key) => key in sourceRows)) {
      throw new Error(`No data row found for held item ${itemId}`);
    }
    return {
      itemId, time,
      subjectId: item.subjectId, chunkId: item.chunkId,
      creator: String(creator ?? item.subjectId), amountCents: item.amountCents, currency: item.currency,
      batchAccount: item.destination, accountOnFile: typeof master?.account_ref === "string" ? master.account_ref : undefined,
      requests: requests.get(item.subjectId) ?? [],
      timeout: decision?.timeout ?? false, reasons: decision?.reasons ?? row?.reasons ?? [],
      sources: [...new Set(sourceKeys)], citations, verdicts: itemVerdicts, notices: notices.get(itemId) ?? [],
    };
  });

  return {
    summary, duration, lanes: [...lanes.values()],
    ticks: data.chunks.map(({ id, tick, itemIds }) => ({ chunkId: id, tick, cutoff: tick * metadata.tickMs, itemIds })),
    waits, decisions, arrivals, statuses, holds, sourceRows,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) throw new Error("Usage: npm run web:condense -- <run-id> [<run-id> ...]");
  const output = new URL("../public/runs/", import.meta.url);
  await mkdir(output, { recursive: true });
  for (const id of args) {
    if (!/^[\w-]+$/.test(id)) throw new Error(`Invalid run ID: ${id}`);
    const directory = new URL(`../../runs/${id}/`, import.meta.url);
    const run = await condenseRun(fileURLToPath(directory));
    if (run.summary.runId !== id) throw new Error(`Unexpected run ID for ${id}`);
    await writeFile(new URL(`${id}.json`, output), JSON.stringify(run) + "\n");
    console.log(`Condensed ${id}: ${run.lanes.length} lanes, ${run.holds.length} holds.`);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
