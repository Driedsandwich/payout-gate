import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelMessageItem, TokenUsage, InputTokenDetails, OutputTokenDetails, type InferenceRunner } from "@mozaik-ai/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventLog } from "../src/core/eventlog.js";
import { Ledger } from "../src/core/ledger.js";
import { createLoopRuntime } from "../src/core/loop-runtime.js";
import { runScenario, type RunOptions } from "../src/core/orchestrator.js";
import type { ScenarioRoles } from "../src/core/roles.js";
import type { RunEvent, ScenarioData, ScenarioPack } from "../src/core/types.js";
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

function oneChunk(): ScenarioData & { batchAt: string } {
  const fixture = payoutMini();
  return {
    ...fixture, arrivals: [], items: fixture.items.slice(0, 1),
    chunks: [{ ...fixture.chunks[0], itemIds: [fixture.items[0].id] }],
  };
}

function cleanPair(body: string, atTick: number, subjectId?: string) {
  const data = oneChunk();
  data.items.push(payoutMini().items[2]);
  data.chunks[0].itemIds.push(data.items[1].id);
  data.arrivals = [{ id: "IN-0010", atTick, channel: "email", body, subjectId, sources: [] }];
  return { ...data, labels: [] };
}

describe("payout runtime", () => {
  it("logs unread noise without holding any payouts, even with subject metadata", async () => {
    const data = cleanPair("Where can I download my tax form?", 0.99, "CR-0001");
    const { ledger, events } = await run({ data });
    expect(ledger.items.map(({ status }) => status)).toEqual(["released", "released"]);
    expect(events.filter(({ kind }) => kind === "gate.unread")).toEqual([
      expect.objectContaining({ data: { arrivalId: "IN-0010" } }),
    ]);
    expect(events.some(({ kind }) => kind === "gate.hold")).toBe(false);
  });

  it.each(["CR-0001", "@Ada", "ada@example-creators.test"])(
    "pre-screens %s anywhere in unread text and holds only that creator's payout", async (name) => {
      const data = cleanPair(`Question for ${name} about my tax form.`, 0.99);
      const { events, ledger } = await run({ data });
      const gateHolds = events.filter(({ kind }) => kind === "gate.hold");
      expect(gateHolds).toEqual([expect.objectContaining({
        itemIds: ["PO-00001"],
        data: {
          chunkId: "CH-01", timeout: true, reasons: ["named in a message not read before the cut-off"],
        },
        sources: expect.arrayContaining([
          { source: "data/arrivals.jsonl#IN-0010" },
          { source: "data/creators.csv#CR-0001", field: "id", value: "CR-0001" },
        ]),
      })]);
      expect(ledger.items[1].status).toBe("released");
    },
  );

  it("excludes an arrival at the exact cut-off", async () => {
    const data = cleanPair("Please change CR-0001's payout to ACCT-01234.", 1);
    const { ledger, events } = await run({ data });
    expect(ledger.items.map(({ status }) => status)).toEqual(["released", "released"]);
    expect(events.some(({ kind }) => kind === "gate.hold" || kind === "gate.unread")).toBe(false);
  });

  it("upgrades a timeout hold when late suspicious verdicts arrive and waits for the Explainer", async () => {
    const data = cleanPair("Please change CR-0001's payout to ACCT-01234.", 0.99);
    const { events, ledger } = await run({ data });
    expect(events.find(({ kind }) => kind === "gate.hold")?.data?.timeout).toBe(true);
    expect(events.filter(({ kind }) => kind === "hold.resolved")).toEqual([
      expect.objectContaining({ data: { itemId: "PO-00001", outcome: "confirmed" } }),
    ]);
    expect(ledger.holds[0]).toMatchObject({
      itemId: "PO-00001", outcome: "confirmed",
      reasons: [expect.stringContaining("absent from the creator’s source records")],
      sources: expect.arrayContaining([
        expect.objectContaining({ source: "data/master.csv#CR-0001" }),
        expect.objectContaining({ source: "data/arrivals.jsonl#IN-0010" }),
      ]),
      notice: expect.stringMatching(/payout is on hold.*IN-0010/),
    });
    expect(events.find(({ kind, agent }) => kind === "ledger.write" && agent === "Explainer")?.data?.table).toBe("holds");
    expect(events.at(-1)?.kind).toBe("run.finished");
  });

  it("records late payment after both required checks clear a timeout hold", async () => {
    const data = cleanPair("Please use ACCT-0001 for CR-0001's payout.", 0.99);
    const { events, ledger } = await run({ data, mode: "sequential" });
    expect(ledger.verdicts.filter(({ value }) => value === "clear")).toHaveLength(2);
    expect(ledger.holds[0]).toMatchObject({
      itemId: "PO-00001", outcome: "cleared_late", reasons: ["cleared after cut-off"],
      notice: expect.stringContaining("paid late"),
    });
    expect(events.filter(({ kind }) => kind === "hold.resolved")).toEqual([
      expect.objectContaining({ data: { itemId: "PO-00001", outcome: "cleared_late" } }),
    ]);
    expect(events.at(-1)?.kind).toBe("run.finished");
  });

  it("triages a message delivered while a sequential round is already processing the inbox", async () => {
    const data = cleanPair("Please change CR-0001's payout to ACCT-01234.", 0.05);
    data.arrivals.unshift({
      id: "IN-0009", atTick: 0, channel: "email", body: "Where can I download my tax form?", sources: [],
    });
    const { events } = await run({ data, mode: "sequential", tickMs: 500 });
    const firstIntake = events.find(({ kind, agent }) => kind === "message_received.started" && agent === "InboxWatcher")!;
    const arrival = events.find(({ kind, data }) => kind === "arrival" && data?.arrivalId === "IN-0010")!;
    const link = events.find(({ kind, data }) => kind === "ledger.write" && data?.table === "links" && data.rowId === "IN-0010")!;
    expect(firstIntake.seq).toBeLessThan(arrival.seq);
    expect(link.tMs).toBeLessThan(500);
    expect(events.find(({ kind }) => kind === "gate.hold")).toMatchObject({
      itemIds: ["PO-00001"], data: { timeout: false },
    });
    expect(countLoops(events)).toBe(1);
  });

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
    const envValue = ["example", "private", "value", "in", "environment"].join("_");
    // Fake credential shapes are assembled at runtime so no key-like literal sits in the source.
    const fakeOr = ["sk", "or", "v1", "abcdef123456"].join("-");
    const fakeTest = ["sk", "test", "abcdefabcdefabcdef"].join("-");
    vi.stubEnv("OPENROUTER_API_KEY", envValue);
    vi.stubEnv("MOZAIK_PROJECT_KEY", fakeTest);
    const runner: InferenceRunner = {
      async run() {
        throw new Error(`Failed at /home/example/private/settings with ${fakeOr} or ${envValue}`);
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
      next: vi.fn((...args: Parameters<typeof pack.scripted.next>) =>
        args[0] === "BatchAuditor" ? { answer: "Scan unavailable." } : pack.scripted.next(...args)),
    };
    const { ledger, events } = await run({ pack: { ...pack, scripted }, failPolicy, data: oneChunk(), tickMs: 100 });
    expect(ledger.items[0].status).toBe(failPolicy === "hold" ? "held" : "released");
    if (failPolicy === "hold") {
      expect(events.find(({ kind }) => kind === "gate.hold")?.data?.timeout).toBe(true);
      expect(ledger.holds[0]).toMatchObject({
        notice: expect.stringMatching(/payout is held for review.*Batch audit was unfinished at the release tick/),
      });
      expect(scripted.next.mock.calls.map(([agent]) => agent)).not.toContain("Explainer");
      expect(events.some(({ agent, kind }) => agent === "Explainer" && kind === "message_received.started")).toBe(false);
      expect(events.find(({ kind }) => kind === "interception.finished")?.data?.payload)
        .toMatchObject({ nextStateId: "model_message" });
      expect(releasedByTool(events)).toEqual([]);
    } else {
      expect(events.some(({ kind }) => kind === "gate.hold")).toBe(false);
      expect(releasedByTool(events)).toEqual(["PO-00001"]);
    }
  });

  it("starts queued critical loops before older queued explanations and keeps the total cap", async () => {
    const data = oneChunk();
    const log = new EventLog("priority-test", out);
    const ledger = new Ledger(data.items, log.nowMs, log.emit);
    const scripted = { next: () => ({ answer: "Done." }), latencyMs: () => 5 };
    const runtime = createLoopRuntime({
      data, ledger, log, pack: { ...pack, scripted }, inference: { kind: "scripted" }, maxLoops: 1, explainer: "Explainer",
    });
    try {
      runtime.join();
      const blocker = runtime.run("BatchAuditor", {});
      const queuedExplanation = runtime.run("Explainer", {});
      const critical = ["InboxWatcher", "BatchAuditor", "RecordChecker", "PolicyAgent", "Dispatcher"];
      await Promise.all([blocker, queuedExplanation, ...critical.map((agent) => runtime.run(agent, {}))]);
      const events = (await readFile(log.path, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line) as RunEvent);
      const starts = events.filter(({ kind }) => kind === "message_received.started").map(({ agent }) => agent);
      expect(starts).toEqual(["BatchAuditor", ...critical, "Explainer"]);
      expect(countLoops(events)).toBe(1);
    } finally {
      log.close();
    }
  });

  it("links a creator by a signature handle and returns the sender domain mismatch with a citation", async () => {
    const data = payoutMini();
    const arrival = data.arrivals[0];
    arrival.body = "From: support@example-creat0rs.test\n\nPlease send today's payment to ACCT-0999 instead.\n\nRegards,\n@Emi.";
    arrival.subjectId = "CR-0001";
    arrival.sources = [{ source: "data/arrivals.jsonl#IN-0001", field: "body", value: arrival.body }];
    const seen = vi.fn(pack.scripted.next);
    const { events } = await run({ data, pack: { ...pack, scripted: { ...pack.scripted, next: seen } } });
    const output = seen.mock.calls.flatMap(([, , history]) => history).find(({ name }) => name === "find_creator")?.output;
    expect(JSON.parse(output!)).toMatchObject({
      creatorId: "CR-0005",
      signals: [{
        rule: "sender_domain_mismatch", senderDomain: "example-creat0rs.test", contactDomain: "example-creators.test",
        sources: [{ source: "data/creators.csv#CR-0005", field: "contact_email", value: "emi@example-creators.test" }],
      }],
    });
    const link = events.find(({ kind, data }) => kind === "ledger.write" && data?.table === "links" && data.rowId === arrival.id);
    expect(link?.data?.after).toMatchObject({ creatorId: "CR-0005", requestedAccount: "ACCT-0999" });
  });

  it.each(["concurrent", "sequential"] as const)("runs a renamed pack in %s mode using its declared roles", async (mode) => {
    const roles: ScenarioRoles = {
      dispatcher: "Sender", intake: "Reader", auditor: "Scanner", checkers: ["Verifier", "Rules"], explainer: "Writer",
    };
    const agentNames = [roles.dispatcher, roles.intake, roles.auditor, ...roles.checkers, roles.explainer];
    const originalAgents = pack.agents();
    const originals = new Map(agentNames.map((name, index) => [name, originalAgents[index].name]));
    const template = payoutMini();
    const item = { ...template.items[4], chunkId: "CH-01" };
    const data = {
      ...template, scenarioId: "renamed", items: [item], labels: [], arrivals: [template.arrivals[0]],
      chunks: [{ ...template.chunks[0], itemIds: [item.id] }],
    };
    const dummy = {
      ...pack, id: "renamed", roles, requiredVerdicts: [roles.auditor], generate: () => data,
      agents: () => originalAgents.map((agent, index) => ({ ...agent, name: agentNames[index], trigger: "start" as const })),
      scripted: {
        next: (agent, task, history) => pack.scripted.next(originals.get(agent)!, task, history),
        latencyMs: () => 5,
      },
    } satisfies ScenarioPack & { roles: ScenarioRoles };
    const { events, ledger } = await run({ data, mode, pack: dummy, tickMs: 180 });
    const starts = events.filter(({ kind }) => kind === "message_received.started").map(({ agent }) => agent);
    expect(new Set(starts)).toEqual(new Set(agentNames));
    expect(events.find(({ kind }) => kind === "gate.hold")).toMatchObject({
      agent: roles.dispatcher, data: { timeout: false },
    });
    expect(ledger.verdicts.filter(({ by }) => roles.checkers.includes(by)).map(({ by }) => by).sort())
      .toEqual([...roles.checkers].sort());
    expect(events.find(({ kind, agent }) => kind === "ledger.write" && agent === roles.explainer)?.data?.after)
      .toHaveProperty("notice");
  });

  it("still accepts packs that use triggers and requiredVerdicts without a roles map", async () => {
    const { roles: _roles, ...legacyPack } = pack;
    const { ledger, events } = await run({ data: oneChunk(), pack: legacyPack, tickMs: 100 });
    expect(ledger.items[0].status).toBe("released");
    expect(events.find(({ kind }) => kind === "gate.pass")?.agent).toBe("Dispatcher");
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
    expect(seen[firstCheck + 1]).toBe("PolicyAgent");
    expect(seen.indexOf("BatchAuditor")).toBeLessThan(seen.indexOf("Dispatcher"));
    const held = new Set(ledger.holds.map(({ itemId }) => itemId));
    expect(releasedByTool(events).every((id) => !held.has(id))).toBe(true);
  });

  it("copies provider token usage from the inference.completed payload", async () => {
    const runner: InferenceRunner = {
      async run() {
        return {
          items: [ModelMessageItem.rehydrate({ text: "Done" })],
          tokenUsage: new TokenUsage(7, 3, 10, new InputTokenDetails(0), new OutputTokenDetails(0)),
          rowResponse: { providerField: ["sk", "test", "never-write-this-raw-provider-response"].join("-") },
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
