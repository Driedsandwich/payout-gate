import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runScenario } from "../src/core/orchestrator.js";
import type { Arrival, RunEvent, ScenarioData, WorkItem } from "../src/core/types.js";
import { doublePledgePack, ruleConstants } from "../src/scenarios/double-pledge/pack.js";
import { preparePledgeData } from "../src/scenarios/double-pledge/rules.js";

const origin = "scenario:double-pledge";
const seller = { id: "SL-0001", name: "seller_001" };
const debtor = { id: "DB-0001", name: "debtor_001" };

function invoice(id: string, number: string, fields = {}) {
  return {
    id, seller_id: seller.id, debtor_id: debtor.id, invoice_number: number,
    amount_cents: 10_024, advance_cents: 8_000, currency: "EUR", issue_date: "2026-10-22",
    lender: "LENDER-A", submitted_at: "2026-11-26T08:30:00.000Z", ...fields,
  };
}

function submission(id: string, row: ReturnType<typeof invoice>, atTick: number, unrelatedSubjectId: string): Arrival {
  return {
    id, atTick, channel: "lender_api", subjectId: unrelatedSubjectId, sources: [],
    body: [
      `To ${row.lender} intake: please advance funds against this unpaid invoice.`,
      `Seller: ${seller.name} (${seller.id})`,
      `Debtor: ${debtor.name} (${debtor.id})`,
      `Invoice number: ${row.invoice_number}`,
      `Invoice amount: ${row.amount_cents} cents ${row.currency}`,
      `Requested advance: ${row.advance_cents} cents ${row.currency}`,
      `Issue date: ${row.issue_date}`,
    ].join("\n"),
  };
}

function fixture(): ScenarioData {
  const original = invoice("IV-00001", "INV-00021");
  const prepledged = invoice("IV-00002", "INV-00022");
  const missing = invoice("IV-00003", "INV-00023");
  const clean = invoice("IV-00004", "INV-00024");
  const similar = invoice("IV-00011", "INV-00044", {
    amount_cents: 10_038, lender: "LENDER-C", submitted_at: "2026-11-26T09:00:02.000Z",
  });
  const splitA = invoice("IV-00005", "INV-00025", { advance_cents: 4_000 });
  const splitB = invoice("IV-00006", "INV-00025", { advance_cents: 6_024 });
  const resubmitted = invoice("IV-00007", "INV-00027");
  const cancelled = invoice("IV-00008", "INV-00027", {
    request_status: "cancelled", cancelled_at: "2026-11-26T08:10:00.000Z", submitted_at: "2026-11-26T08:00:00.000Z",
  });
  const altered = invoice("IV-00009", "00-21", {
    amount_cents: 10_000, lender: "LENDER-B", issue_date: "2026-10-23", submitted_at: "2026-11-26T09:00:02.000Z",
  });
  const registryRow = (row: ReturnType<typeof invoice>, id: string, lender: string, registered_at: string) => ({
    id, seller_id: seller.id, debtor_id: debtor.id, invoice_number: row.invoice_number,
    amount_cents: row.amount_cents, currency: row.currency, lender, registered_at,
  });
  const priorPledge = registryRow(prepledged, "RG-0001", "LENDER-C", "2026-11-25T17:00:00.000Z");
  const splitNotice = registryRow(splitA, "RG-0002", "LENDER-A", "2026-11-25T18:00:00.000Z");
  const afterRun = registryRow(clean, "RG-0003", "LENDER-C", "2026-11-26T09:01:00.000Z");
  const rows = [original, prepledged, missing, clean, splitA, splitB, resubmitted];
  const items = rows.map((row, index): WorkItem => ({
    id: `FR-${index + 1}`, subjectId: row.id, amountCents: row.advance_cents, currency: row.currency,
    destination: "ACCT-0001", batchIndex: index, chunkId: index < 4 ? "FB-1" : "FB-2", status: "queued",
    sources: [{ source: `${origin}#invoices/${row.id}`, field: "advance_cents", value: row.advance_cents }],
  }));
  const arrivals = [
    submission("IN-0001", altered, 0.2, missing.id),
    submission("IN-0002", similar, 0.22, clean.id),
    {
      id: "IN-0003", atTick: 1.2, channel: "registry_notice", subjectId: missing.id, sources: [],
      body: `Registry notice ${splitNotice.id}. ${splitNotice.lender} registered a pledge for ${splitA.invoice_number} from ${seller.name} to ${debtor.name} for ${splitA.amount_cents} cents EUR at ${splitNotice.registered_at}.`,
    },
  ];
  return preparePledgeData({
    scenarioId: "double-pledge", scale: { items: items.length, arrivals: arrivals.length, planted: 0, seed: 1 },
    items, arrivals, labels: [],
    chunks: [1, 2].map((tick) => ({
      id: `FB-${tick}`, tick, index: tick, itemIds: items.filter(({ chunkId }) => chunkId === `FB-${tick}`).map(({ id }) => id),
    })),
    tables: {
      invoices: [...rows, similar, cancelled, altered], registry: [priorPledge, splitNotice, afterRun],
      sellers: [seller], debtors: [debtor],
      debtor_ledger: [original, prepledged, clean, similar, splitA, resubmitted].map((row, index) => ({
        id: `DL-${index + 1}`, seller_id: seller.id, debtor_id: debtor.id, invoice_number: row.invoice_number,
        amount_cents: row.amount_cents, currency: row.currency, status: "open",
      })),
    },
  });
}

let out: string;
beforeEach(async () => {
  out = await mkdtemp(join(tmpdir(), "pledge-pack-"));
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Network is disabled for this test"); }));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(out, { recursive: true, force: true });
});

async function run(data: ScenarioData) {
  const result = await runScenario({
    runId: "pledge-pack-test", out, pack: doublePledgePack, data, mode: "concurrent",
    inference: { kind: "scripted" }, tickMs: 600, failPolicy: "hold", maxLoops: 8,
  });
  const events = (await readFile(result.eventsPath, "utf8")).trimEnd().split("\n")
    .map((line) => JSON.parse(line) as RunEvent);
  expect(fetch).not.toHaveBeenCalled();
  expect(events.filter(({ kind }) => kind === "inference.failed" || kind === "citation.reject")).toEqual([]);
  return { ...result, events };
}

function fundingCalls(events: RunEvent[]): string[][] {
  return events.flatMap(({ kind, data }) => {
    if (kind !== "function_call.started") return [];
    const { call } = data?.payload as { call: { name: string; args: string } };
    return call.name === "fund_batch" ? [JSON.parse(call.args).itemIds as string[]] : [];
  });
}

describe("double-pledge pack", () => {
  it("links the altered submission and holds the cross-lender, registry, and missing-ledger requests with evidence", async () => {
    const { ledger, events } = await run(fixture());
    expect(ledger.holds.map(({ itemId }) => itemId)).toEqual(["FR-1", "FR-2", "FR-3"]);
    expect(ledger.holds[0].sources).toEqual(expect.arrayContaining(Object.values(ruleConstants)));
    const link = events.find(({ data }) => data?.table === "links" && data.rowId === "IN-0001");
    expect(link?.sources?.map(({ source }) => source)).toEqual(expect.arrayContaining([
      `${origin}#invoices/IV-00001`, `${origin}#invoices/IV-00009`,
    ]));
    for (const [itemId, source] of [
      ["FR-1", "invoices/IV-00009"], ["FR-2", "registry/RG-0001"], ["FR-3", "debtors/DB-0001"],
    ]) {
      const hold = events.find(({ kind, itemIds }) => kind === "gate.hold" && itemIds?.includes(itemId));
      expect(hold?.data?.timeout).toBe(false);
      expect(hold?.sources?.map((ref) => ref.source)).toContain(`${origin}#${source}`);
    }
    const notices = events.flatMap(({ data }) => {
      const row = data?.after as { notice?: string } | undefined;
      return data?.table === "holds" && row?.notice ? [row.notice] : [];
    });
    expect(notices).toHaveLength(3);
    expect(notices.every((notice) => notice.includes("This is not financial advice"))).toBe(true);
    expect(notices.some((notice) => notice.includes("IV-00009"))).toBe(true);

    // The similar invoice, both halves of a same-lender split, and the resubmission are eligible.
    expect(ledger.items.filter(({ status }) => status === "released").map(({ id }) => id)).toEqual(["FR-4", "FR-5", "FR-6", "FR-7"]);
    const noMatch = events.find(({ data }) => data?.table === "links" && data.rowId === "IN-0002");
    expect(noMatch?.data?.after).toMatchObject({ reason: "No pending request matches the invoice." });
    for (const itemId of ["FR-5", "FR-6"]) {
      expect(ledger.verdicts.filter((v) => v.itemId === itemId).map(({ value }) => value)).toEqual(["clear", "clear"]);
    }
    expect(fundingCalls(events)).toEqual([["FR-4"], ["FR-5", "FR-6", "FR-7"]]);
  });

  it("never invokes the gated tool for an all-held chunk", async () => {
    const data = fixture();
    data.chunks = [{ ...data.chunks[0], itemIds: ["FR-2"] }];
    data.items = data.items.filter(({ id }) => id === "FR-2");
    data.arrivals = [];
    const { ledger, events } = await run(data);
    expect(ledger.holds).toHaveLength(1);
    expect(fundingCalls(events)).toEqual([]);
  });
});
