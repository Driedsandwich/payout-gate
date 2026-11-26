import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunSummary, SourceRef, Verdict } from "../src/core/types.js";
import { payoutMini } from "./fixtures/payout-mini.js";

const blockNetwork = `import { Socket } from "node:net";
const block = () => { throw new Error("Network is disabled in MCP tests"); };
globalThis.fetch = block;
Socket.prototype.connect = block;`;
const client = new Client({ name: "payout-gate-test", version: "0.1.0" });

type BatchResult = {
  runId: string;
  held: { itemId: string; reasons: string[]; sources: SourceRef[] }[];
  released: string[];
  summary: RunSummary;
  note: string;
};

async function call(name: string, args: Record<string, unknown>) {
  return CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
}

function expectError(result: CallToolResult, message: RegExp) {
  expect(result.isError).toBe(true);
  expect(result.content).toEqual([{ type: "text", text: expect.stringMatching(message) }]);
}

describe("payout MCP server over stdio", () => {
  beforeAll(async () => {
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [
        "--import", `data:text/javascript,${encodeURIComponent(blockNetwork)}`,
        "--import", "tsx", "mcp/server.ts",
      ],
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env: { TMPDIR: tmpdir(), TEMP: tmpdir() },
      stderr: "pipe",
    }));
  });

  afterAll(async () => {
    await client.close();
  });

  it("lists exactly three tools with JSON schemas and release guidance", async () => {
    const { tools } = await client.listTools();
    expect(tools.map(({ name }) => name).sort()).toEqual([
      "check_payout_batch", "explain_hold", "get_run_summary",
    ]);
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.description).toContain(
        "Call check_payout_batch before releasing a payout batch; do not release items it returns as held.",
      );
    }
    const [check, explain, summary] = tools;
    expect(check.inputSchema.anyOf).toEqual([
      expect.objectContaining({ additionalProperties: false, properties: expect.objectContaining({ seed: expect.any(Object) }) }),
      expect.objectContaining({ additionalProperties: false, required: ["data"] }),
    ]);
    expect(explain.inputSchema.required).toEqual(["runId", "itemId"]);
    expect(summary.inputSchema.required).toEqual(["runId"]);
  });

  it("checks a supplied batch with five-digit account references, explains a hold, and retrieves the summary", async () => {
    const { batchAt: _batchAt, ...data } = payoutMini();
    data.items[0].destination = "ACCT-00001";
    data.tables.master[0].account_ref = "ACCT-00001";
    data.arrivals[0].body = data.arrivals[0].body.replace("ACCT-0999", "ACCT-09999");
    const checked = await call("check_payout_batch", { data });
    expect(checked.isError).toBeFalsy();
    const batch = checked.structuredContent as BatchResult;
    expect(batch.note).toBe("Not financial advice. Synthetic data. Nothing moves.");
    expect(batch.held.length).toBeGreaterThan(0);
    expect(batch.held.every(({ sources }) => sources.length > 0)).toBe(true);
    expect(batch.held.length + batch.released.length).toBe(data.items.length);
    expect(batch.released).toContain("PO-00001");
    expect(batch.held.find(({ itemId }) => itemId === "PO-00005")?.sources).toContainEqual(
      expect.objectContaining({ field: "requestedAccount", value: "ACCT-09999" }),
    );

    const held = batch.held.find(({ itemId }) => itemId === "PO-00002")!;
    expect(held).toBeDefined();
    const explained = await call("explain_hold", { runId: batch.runId, itemId: held.itemId });
    expect(explained.isError).toBeFalsy();
    const explanation = explained.structuredContent as { itemId: string; notice: string; verdicts: Verdict[]; sources: SourceRef[] };
    expect(explanation.itemId).toBe(held.itemId);
    expect(explanation.notice).toMatch(/payout is on hold/i);
    expect(explanation.verdicts.some(({ value }) => value === "suspicious")).toBe(true);
    expect(explanation.sources).toEqual(held.sources);

    const summary = await call("get_run_summary", { runId: batch.runId });
    expect(summary.structuredContent).toEqual(batch.summary);
    expectError(await call("explain_hold", { runId: batch.runId, itemId: "PO-99999" }), /unknown item/i);
  });

  it("generates the demo and returns evidence for every hold", async () => {
    const result = await call("check_payout_batch", { scenario: "payout-change", scale: "demo", seed: 7 });
    expect(result.isError).toBeFalsy();
    const batch = result.structuredContent as BatchResult;
    expect(batch.summary).toMatchObject({ mode: "concurrent", inference: "scripted", scale: { seed: 7 } });
    expect(batch.held.some(({ reasons }) => reasons.some((reason) => reason.includes("A linked request")))).toBe(true);
    expect(batch.held.every(({ sources }) => sources.length > 0)).toBe(true);
  }, 10_000);

  it("rejects malformed data with a message, including invalid accounts and arrival ticks", async () => {
    expectError(await call("check_payout_batch", { data: {} }), /invalid data\./i);
    const { batchAt: _batchAt, ...data } = payoutMini();
    data.items[0].destination = "invalid";
    expectError(await call("check_payout_batch", { data }), /data\.items\.0\.destination.*ACCT-NNNN/i);
    data.items[0].destination = "ACCT-0001";
    data.arrivals[0].atTick = -1;
    expectError(await call("check_payout_batch", { data }), /data\.arrivals\.0\.atTick/i);
    data.arrivals[0].atTick = 0;
    data.chunks[0].itemIds.pop();
    expectError(await call("check_payout_batch", { data }), /schedule every item/i);
  });

  it("rejects credential fields at the tool boundary, including inside supplied data", async () => {
    expectError(await call("check_payout_batch", { apiKey: true }), /unexpected field/i);
    expectError(await call("explain_hold", { runId: "missing", itemId: "PO-00001", token: true }), /unexpected field/i);
    expectError(await call("get_run_summary", { runId: "missing", password: true }), /unexpected field/i);
    const { batchAt: _batchAt, ...data } = payoutMini();
    const master = [{ ...data.tables.master[0], accessToken: true }];
    expectError(await call("check_payout_batch", { data: { ...data, tables: { ...data.tables, master } } }), /unexpected field/i);
    expectError(await call("get_run_summary", { runId: "missing" }), /unknown run/i);
    expectError(await call("explain_hold", { runId: "missing", itemId: "PO-00001" }), /unknown run/i);
  });
});
