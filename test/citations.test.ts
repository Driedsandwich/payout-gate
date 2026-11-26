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

it("does not cite digits embedded in tool output keys or prose", () => {
  const outputs = [JSON.stringify({ "2025-02-20": "row", note: "The amount is 24." })];
  const emit = vi.fn();
  expect(checkCitations("24 on 2025-02-20.", [], actor, emit, outputs)).toBe(false);
  expect(emit).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
    numbers: ["24", "2025-02-20"],
  }) }));
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
