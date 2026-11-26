import { expect, it, vi } from "vitest";
import { checkCitations } from "../src/core/citations.js";
import type { SourceRef } from "../src/core/types.js";
import { ruleConstants } from "../src/scenarios/payout-change/pack.js";

const actor = { agent: "Explainer", loopId: "test-loop" };
const sources: SourceRef[] = [
  ...Object.values(ruleConstants),
  { source: "data/change_log.csv#CL-0001", field: "at", value: "2026-11-26T09:00:00.000Z" },
  { source: "scenario:double-pledge#invoices/IV-00001", field: "issue_date", value: "2026-10-22" },
  { source: "data/batch.csv#PO-00001", field: "amount", value: "1,234.50" },
  { source: "data/batch.csv#PO-00001", field: "adjustment", value: -1_250 },
];

it.each([
  "1) The account changed on 2026-11-26 09:00.\n2. Review changes within 72 hours.",
  "1) The account changed on 2026-11-26T09:00:00Z.\n2. The payout exceeds 3x the 90-day median.",
  "- 2. Review CL-0001 and ACCT-0998.\n> 1) Review IV-00001.",
  "Review: 1) Check the records; 2) Confirm the account.",
  "The invoice date was 2026-10-22 and the account changed at 2026-11-26T18:00:00+09:00.",
  "The amount is $1,234.50 and the adjustment is -$1,250.",
  "Verification channels include in_app_2fa, 2FA, 2fa, and support_v1.",
  "CR-0068 and ACCT-2407 appear in CL-0107 for amber.collage.0158 and amber.collage.0270.",
])("accepts sourced facts and formatting in %s", (notice) => {
  const emit = vi.fn();
  expect(checkCitations(notice, sources, actor, emit)).toBe(true);
  expect(emit).not.toHaveBeenCalled();
});

it("accepts standalone dates and numbers from nested JSON values in tool outputs", () => {
  const outputs = [
    JSON.stringify({ rows: [{ joined_at: "2025-02-20", history: [1234.5, "8"] }] }),
    JSON.stringify({ change: { at: "2025-02-21T09:30:00+09:00" } }),
  ];
  const notice = "Joined on 2025-02-20. Changed at 2025-02-21T00:30:00Z. There were 8 payouts totaling $1,234.50.";
  const emit = vi.fn();
  expect(checkCitations(notice, [], actor, emit, outputs)).toBe(true);
  expect(emit).not.toHaveBeenCalled();
});

it("accepts a tool's display amount or its numeric equivalent and rejects an invented number", () => {
  const source = "scenario:double-pledge#invoices/IV-00001";
  const outputs = [JSON.stringify({ sources: [
    { source, field: "amount_cents", value: 1_309_460 },
    { source, field: "amount_display", value: "EUR 13,094.60" },
  ] })];
  const emit = vi.fn();
  expect(checkCitations("The invoice total is EUR 13,094.60 or 13094.6 in decimal form.", [], actor, emit, outputs)).toBe(true);
  expect(emit).not.toHaveBeenCalled();
  expect(checkCitations("The invoice total is 13095.6.", [], actor, emit, outputs)).toBe(false);
  expect(emit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ data: expect.objectContaining({ numbers: ["13095.6"] }) }));
});

it("does not cite numbers embedded in tool output keys or prose", () => {
  const outputs = [JSON.stringify({ "2025-02-20": "row", note: "The amount is 24.", count: "five requests" })];
  const emit = vi.fn();
  expect(checkCitations("24 on 2025-02-20 with 5 requests.", [], actor, emit, outputs)).toBe(false);
  expect(emit).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
    numbers: ["24", "2025-02-20", "5"],
  }) }));
});

it.each([
  ["The payout was $5k.", "$5k", 5_000],
  ["We will review the hold within 72h.", "72h", 72],
  ["The payout was 3x the median.", "3x", 3],
  ["The change was on the 28th.", "28th", 28],
  ["The fee was 10%.", "10%", 10],
  ["The total was 2.5m.", "2.5m", 2_500_000],
  ["The payout was five thousand dollars.", "five thousand", 5_000],
  ["There were three requests.", "three", 3],
  ["There were twelve changes.", "twelve", 12],
  ["Review the one remaining request.", "one", 1],
  ["There were zero payouts.", "zero", 0],
  ["It took ninety-nine days.", "ninety-nine", 99],
  ["The total was one billion two million three thousand four hundred and twenty-one.",
    "one billion two million three thousand four hundred and twenty-one", 1_002_003_421],
  ["The payout was EUR1.001k.", "EUR1.001k", 1_001],
  ["The payout was 40 USD.", "40 USD", 40],
  ["The payout was €2bn.", "€2bn", 2_000_000_000],
  ["The review took 12hrs.", "12hrs", 12],
  ["The review took 4days.", "4days", 4],
])("requires a matching scalar tool value for %s", (notice, token, value) => {
  const emit = vi.fn();
  expect(checkCitations(notice, [], actor, emit)).toBe(false);
  expect(emit).toHaveBeenCalledExactlyOnceWith({
    ...actor, kind: "citation.reject", data: { agent: actor.agent, text: notice, numbers: [token] },
  });
  emit.mockClear();
  expect(checkCitations(notice, [], actor, emit, [JSON.stringify({ value })])).toBe(true);
  expect(emit).not.toHaveBeenCalled();
});

it("normalizes formatted scalar tool values the same way as notice quantities", () => {
  const outputs = ["€ 5k", JSON.stringify(["72hr", "2.5m", "five thousand", "twelve days"])];
  const emit = vi.fn();
  expect(checkCitations("$5,000, 72 hours, 2500000, five thousand euros, and 12d.", [], actor, emit, outputs)).toBe(true);
  expect(checkCitations("The amount was 5.", [], actor, emit, outputs)).toBe(false);
});

it("ignores identifiers, handles, and standalone pronouns without tool evidence", () => {
  const notice = "Use in_app_2fa or 2FA. CR-0068 and ACCT-2407 appear in CL-0107 for amber.collage.0158. " +
    "PO-00024 is the one that was held. See @2m or build-72h for the record.";
  const emit = vi.fn();
  expect(checkCitations(notice, [], actor, emit)).toBe(true);
  expect(emit).not.toHaveBeenCalled();
});

it.each([
  ["The amount was 987,654.25.", "987,654.25"],
  ["There were 8 requests.", "8"],
  ["The count was 8. Check the source records.", "8"],
  ["The amount was 1,250.", "1,250"],
  ["The invoice date was 2026-10-23.", "2026-10-23"],
  ["The account changed on 2026-11-26 09:01.", "2026-11-26 09:01"],
  ["The account changed on 2026-11-26T09:00:00+09:00.", "2026-11-26T09:00:00+09:00"],
  ["The account changed on 2026-11-26T09:00:00.0001Z.", "2026-11-26T09:00:00.0001Z"],
  ["2026 records were reviewed.", "2026"],
  ["1) Review the records.\n2. There were 8 requests.", "8"],
])("reports the full unsupported token in %s", (notice, token) => {
  const emit = vi.fn();
  expect(checkCitations(notice, sources, actor, emit)).toBe(false);
  expect(emit).toHaveBeenCalledExactlyOnceWith({
    ...actor, kind: "citation.reject", data: { agent: actor.agent, text: notice, numbers: [token] },
  });
});
