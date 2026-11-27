import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Ledger } from "../src/core/ledger.js";
import { runScenario } from "../src/core/orchestrator.js";
import type { TaskToolContext } from "../src/core/task.js";
import type { Arrival, RunEvent } from "../src/core/types.js";
import { generate, SCALES } from "../src/scenarios/payout-change/generate.js";
import { readRequest } from "../src/scenarios/payout-change/inbox.js";
import { payoutChangePack } from "../src/scenarios/payout-change/pack.js";
import { payoutMini } from "./fixtures/payout-mini.js";

let out: string;

beforeEach(async () => {
  out = await mkdtemp(join(tmpdir(), "payout-account-message-"));
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Network is disabled for this test"); }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await rm(out, { recursive: true, force: true });
});

function arrival(body: string): Arrival {
  return { id: "IN-0099", atTick: 0.1, channel: "email", body, sources: [{ source: "data/arrivals.csv#IN-0099" }] };
}

const rephrased = "From: amber.stitches.0251@example-creators.test\n\n" +
  "Kindly remit today's earnings into ACCT-55555 from now on.\n\namber.stitches.0251";

describe("readRequest", () => {
  it("is actionable for any message that names an account reference", () => {
    expect(readRequest(arrival(rephrased))).toMatchObject({
      actionable: true, requestedAccount: "ACCT-55555",
    });
    expect(readRequest(arrival("Please change my payout account to ACCT-0999."))).toMatchObject({
      actionable: true, requestedAccount: "ACCT-0999",
    });
  });

  it("is not actionable when no account reference is named", () => {
    expect(readRequest(arrival("Please change my payout account before today's payment."))).toMatchObject({
      actionable: false, requestedAccount: undefined,
    });
    expect(readRequest(arrival("Where can I download my annual tax form?")).actionable).toBe(false);
  });
});

describe("InboxWatcher tools", () => {
  it("refuses mark_no_action for a rephrased account request and links it to the named creator", async () => {
    const data = payoutMini();
    const body = "From: ada@example-creators.test\n\nKindly remit today's earnings into ACCT-55555 from now on.\n\nada";
    const message: Arrival = {
      id: "IN-0099", atTick: 0.1, channel: "email", body, sources: [{ source: "data/arrivals.jsonl#IN-0099" }],
    };
    const ledger = new Ledger(data.items, () => 0, () => {});
    ledger.addArrival(message, 0);
    const tools = Object.fromEntries(
      payoutChangePack(() => data).agents().find(({ name }) => name === "InboxWatcher")!.tools.map((tool) => [tool.name, tool]));
    const ctx = {
      agent: "InboxWatcher", target: { arrivalId: message.id }, data, ledger, toolSources: [], toolOutputs: [],
      nowMs: () => 0, emit: () => {},
    } as TaskToolContext;

    await expect(tools.mark_no_action.invoke({ arrivalId: message.id, reason: "Not a change." }, ctx))
      .rejects.toThrow("The message describes an account change");
    expect(ledger.triageFor(message.id)).toBeUndefined();

    await expect(tools.link_request.invoke(
      { arrivalId: message.id, creatorId: "CR-0001", requestedAccount: "ACCT-55555", channel: "email" }, ctx,
    )).resolves.toMatchObject({ linked: true });
    expect(ledger.requestsFor("CR-0001")).toEqual([
      expect.objectContaining({ arrivalId: message.id, creatorId: "CR-0001", requestedAccount: "ACCT-55555" }),
    ]);
  });
});

describe("payout-change gate with a rephrased account request", () => {
  it("holds the named creator's payout in a later chunk", async () => {
    const data = structuredClone(generate(SCALES.demo));
    // CR-0251 (PO-00251, CH-06) has no planted label, no change-log row and appears in no other arrival,
    // so only this message can make the gate hold it.
    const target = data.items.find(({ id }) => id === "PO-00251")!;
    expect(target.subjectId).toBe("CR-0251");
    expect(data.chunks.find(({ id }) => id === target.chunkId)!.index).toBe(6);
    expect(data.labels.find(({ itemId }) => itemId === target.id)?.shouldHold ?? false).toBe(false);
    const index = data.arrivals.findIndex(({ id }) => id === "IN-0001");
    data.arrivals[index] = {
      ...data.arrivals[index], subjectId: undefined, body: rephrased,
      sources: [{ source: "data/arrivals.csv#IN-0001" }],
    };

    const result = await runScenario({
      runId: "rephrased-account", out, pack: payoutChangePack(generate), data, mode: "concurrent",
      inference: { kind: "scripted" }, tickMs: 500, failPolicy: "hold", maxLoops: 8,
    });
    const events = (await readFile(result.eventsPath, "utf8")).trimEnd().split("\n")
      .map((line) => JSON.parse(line) as RunEvent);

    expect(result.ledger.items.find(({ id }) => id === target.id)?.status).toBe("held");
    const link = events.find(({ kind, data }) => kind === "ledger.write" && data?.table === "links" && data.rowId === "IN-0001");
    expect(link?.data?.after).toMatchObject({ creatorId: "CR-0251", requestedAccount: "ACCT-55555" });
    expect(events.find(({ kind, itemIds }) => kind === "gate.hold" && itemIds?.includes(target.id)))
      .toMatchObject({ data: { timeout: false } });
    expect(result.ledger.holds.find(({ itemId }) => itemId === target.id)).toMatchObject({
      reasons: [expect.stringContaining("absent from the creator’s source records")],
      notice: expect.stringContaining("IN-0001"),
    });
  }, 60_000);
});
