import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelMessageItem, TokenUsage, InputTokenDetails, OutputTokenDetails, type InferenceRunner } from "@mozaik-ai/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runScenario, type RunOptions } from "../src/core/orchestrator.js";
import type { RunEvent } from "../src/core/types.js";
import { payoutChangePack } from "../src/scenarios/payout-change/pack.js";
import { payoutMini } from "./fixtures/payout-mini.js";

const pack = payoutChangePack(payoutMini);
const planted = ["PO-00002", "PO-00005"];
let out: string;
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  out = await mkdtemp(join(tmpdir(), "payout-runtime-"));
  fetchSpy = vi.fn(async () => { throw new Error("Network is disabled for this test"); });
  vi.stubGlobal("fetch", fetchSpy);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  try {
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await rm(out, { recursive: true, force: true });
  }
});

async function run(overrides: Partial<RunOptions> = {}) {
  const result = await runScenario({
    runId: "mini-test", out, pack, data: payoutMini(), mode: "concurrent",
    inference: { kind: "scripted" }, tickMs: 280, failPolicy: "hold", maxLoops: 8, ...overrides,
  });
  const raw = await readFile(result.eventsPath, "utf8");
  const events = raw.trimEnd().split("\n").map((line) => JSON.parse(line) as RunEvent);
  return { ...result, events, raw };
}

function countLoops(events: RunEvent[]): number {
  const active = new Set<string>();
  let peak = 0;
  for (const event of events) {
    if (!event.loopId) continue;
    if (event.kind === "message_received.started") active.add(event.loopId);
    if (event.kind === "model.answer" || event.kind === "inference.failed") active.delete(event.loopId);
    peak = Math.max(peak, active.size);
  }
  expect(active.size).toBe(0);
  return peak;
}

function releasedByTool(events: RunEvent[]): string[] {
  return events.flatMap((event) => {
    if (event.kind !== "function_call.started") return [];
    const { call } = event.data?.payload as { call: { name: string; args: string } };
    return call.name === "release_chunk" ? (JSON.parse(call.args).itemIds as string[]) : [];
  });
}

function oneChunk() {
  const fixture = payoutMini();
  return {
    ...fixture, arrivals: [], items: fixture.items.slice(0, 1),
    chunks: [{ ...fixture.chunks[0], itemIds: [fixture.items[0].id] }],
  };
}

describe("payout runtime", () => {
  it("holds both planted takeovers, releases all other items, and overlaps loops", async () => {
    const data = payoutMini();
    const { ledger, events, maxConcurrentLoops } = await run({ data });
    expect(ledger.holds.map(({ itemId }) => itemId).sort()).toEqual(planted);
    const clear = data.items.map(({ id }) => id).filter((id) => !planted.includes(id));
    expect(ledger.items.filter(({ status }) => status === "released").map(({ id }) => id)).toEqual(clear);
    expect(releasedByTool(events)).toEqual(clear);
    expect(ledger.items.find(({ id }) => id === "PO-00004")?.status).toBe("released");
    expect(countLoops(events)).toBe(maxConcurrentLoops);
    expect(maxConcurrentLoops).toBeGreaterThanOrEqual(3);
    expect(maxConcurrentLoops).toBeLessThanOrEqual(8);

    const gateHolds = events.filter(({ kind }) => kind === "gate.hold");
    expect(gateHolds.map(({ data }) => data?.timeout)).toEqual([false, false]);
    expect(gateHolds[0].sources?.map(({ source }) => source)).toContain("data/change_log.csv#CL-0001");
    expect(gateHolds[1].sources?.map(({ source }) => source)).toContain("data/arrivals.jsonl#IN-0001");
    const notices = events.flatMap((event) => {
      const row = event.data?.after as { notice?: string } | undefined;
      return event.kind === "ledger.write" && row?.notice ? [row.notice] : [];
    });
    expect(notices).toHaveLength(2);
    expect(notices[0]).toContain("CL-0001");
    expect(notices[1]).toContain("IN-0001");
    expect(notices.every((notice) => notice.includes("This is not financial advice"))).toBe(true);

    expect(events[0]).toMatchObject({ kind: "run.started", seq: 1, tMs: 0 });
    expect(events.at(-1)?.kind).toBe("run.finished");
    for (let i = 1; i < events.length; i++) {
      expect(events[i].seq).toBe(i + 1);
      expect(events[i].tMs).toBeGreaterThan(events[i - 1].tMs);
    }
    const joins = events.filter(({ kind }) => kind === "participant.joined");
    expect(joins.map(({ agent }) => agent)).toEqual([
      "OpsReviewer", "Dispatcher", "InboxWatcher", "BatchAuditor", "RecordChecker", "PolicyAgent", "Explainer",
    ]);
    expect(joins[0].data?.payload).toMatchObject({ role: "human" });
    const arrivalEvents = events.filter(({ kind }) => kind === "arrival");
    expect(arrivalEvents).toHaveLength(data.arrivals.length);
    for (const event of arrivalEvents) {
      const arrival = data.arrivals.find(({ id }) => id === event.data?.arrivalId)!;
      expect(event.tMs).toBeGreaterThanOrEqual(arrival.atTick * 280);
    }
    for (const event of events.filter(({ kind }) => kind === "gate.pass")) {
      const chunk = data.chunks.find(({ id }) => id === event.data?.chunkId)!;
      expect(event.tMs).toBeGreaterThanOrEqual(chunk.tick * 280);
    }
  });

  it("logs a scrubbed runner failure, answers the loop, and settles the run", async () => {
    const token = "example_private_value_in_environment";
    vi.stubEnv("OPENROUTER_API_KEY", token);
    vi.stubEnv("MOZAIK_PROJECT_KEY", "sk-test-abcdefabcdefabcdef");
    const runner: InferenceRunner = {
      async run() {
        throw new Error(`Failed at /home/example/private/settings with sk-or-v1-abcdef123456 or ${token}`);
      },
      async *stream() {},
    };
    const { ledger, events, raw } = await run({ runner, data: oneChunk(), tickMs: 60 });
    const failures = events.filter(({ kind }) => kind === "inference.failed");
    expect(failures.length).toBeGreaterThan(0);
    for (const failure of failures) {
      expect(failure.data?.error).toContain("[redacted]");
      expect(failure.loopId).toBeTruthy();
      expect(events.some((event) => event.loopId === failure.loopId && event.kind === "model.answer")).toBe(true);
    }
    expect(raw).not.toMatch(/\/home\/example|settings|sk-or-v1-|example_private_value_in_environment|sk-test-/);
    expect(events.at(-1)?.kind).toBe("run.finished");
    expect(ledger.items[0].status).toBe("held");
    expect(releasedByTool(events)).toEqual([]);
    expect(countLoops(events)).toBeGreaterThan(0);
  });

  it.each(["hold", "release"] as const)("uses the %s fail policy when the chunk scan never arrives", async (failPolicy) => {
    const scripted = {
      ...pack.scripted,
      next: (...args: Parameters<typeof pack.scripted.next>) =>
        args[0] === "BatchAuditor" ? { answer: "Scan unavailable." } : pack.scripted.next(...args),
    };
    const { ledger, events } = await run({ pack: { ...pack, scripted }, failPolicy, data: oneChunk(), tickMs: 100 });
    expect(ledger.items[0].status).toBe(failPolicy === "hold" ? "held" : "released");
    if (failPolicy === "hold") {
      expect(events.find(({ kind }) => kind === "gate.hold")?.data?.timeout).toBe(true);
      expect(events.find(({ kind }) => kind === "interception.finished")?.data?.payload)
        .toMatchObject({ nextStateId: "model_message" });
      expect(releasedByTool(events)).toEqual([]);
    } else {
      expect(events.some(({ kind }) => kind === "gate.hold")).toBe(false);
      expect(releasedByTool(events)).toEqual(["PO-00001"]);
    }
  });

  it("runs the sequential baseline with at most one active loop", async () => {
    const { events, maxConcurrentLoops, ledger } = await run({ mode: "sequential" });
    expect(countLoops(events)).toBe(1);
    expect(maxConcurrentLoops).toBe(1);
    expect(ledger.items.every(({ status }) => status === "released" || status === "held")).toBe(true);
    const seen = events.filter(({ kind }) => kind === "message_received.started").map(({ agent }) => agent);
    const firstCheck = seen.indexOf("RecordChecker");
    expect(firstCheck).toBeGreaterThan(0);
    expect(seen.slice(0, firstCheck).every((name) => name === "InboxWatcher")).toBe(true);
    expect(seen.slice(firstCheck, firstCheck + 4)).toEqual(["RecordChecker", "PolicyAgent", "BatchAuditor", "Dispatcher"]);
    const held = new Set(ledger.holds.map(({ itemId }) => itemId));
    expect(releasedByTool(events).every((id) => !held.has(id))).toBe(true);
  });

  it("copies provider token usage from the inference.completed payload", async () => {
    const runner: InferenceRunner = {
      async run() {
        return {
          items: [ModelMessageItem.rehydrate({ text: "Done" })],
          tokenUsage: new TokenUsage(7, 3, 10, new InputTokenDetails(0), new OutputTokenDetails(0)),
          rowResponse: { apiKey: "sk-test-never-write-this-raw-provider-response" },
        };
      },
      async *stream() {},
    };
    const { events, raw } = await run({ runner, data: oneChunk(), tickMs: 30 });
    const event = events.find(({ kind }) => kind === "inference.completed");
    expect(event?.data?.usage).toEqual({ input: 7, output: 3 });
    expect(event?.loopId).toBeTruthy();
    expect(raw).not.toContain("rowResponse");
    expect(raw).not.toContain("sk-test-");
  });

  it("refuses to write a notice with an unsupported number", async () => {
    const scripted = {
      ...pack.scripted,
      next: (...args: Parameters<typeof pack.scripted.next>) => {
        const next = pack.scripted.next(...args);
        if ("call" in next && next.call.name === "write_hold_notice") {
          next.call.args.text = `${next.call.args.text} The unsupported amount is 987,654.`;
        }
        return next;
      },
    };
    const data = oneChunk();
    data.items[0].destination = "ACCT-0777";
    const { events } = await run({ data, pack: { ...pack, scripted } });
    const rejection = events.find(({ kind }) => kind === "citation.reject");
    expect(rejection).toMatchObject({ agent: "Explainer", data: { numbers: ["987,654"] } });
    expect(rejection?.loopId).toBeTruthy();
    const lastHold = events.filter((event) => event.kind === "ledger.write" && event.data?.table === "holds").at(-1);
    expect(lastHold?.data?.after).not.toHaveProperty("notice");
  });
});
