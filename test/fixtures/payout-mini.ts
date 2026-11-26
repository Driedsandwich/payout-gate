import { DEFAULT_BATCH_AT } from "../../src/scenarios/payout-change/rules.js";
import type { Arrival, Scale, ScenarioData, WorkItem } from "../../src/core/types.js";

export const MINI_SCALE: Scale = { items: 12, arrivals: 4, planted: 2, seed: 1 };

const creators = [
  "ada", "bea", "chen", "dara", "emi", "finn", "gita", "hana", "ines", "jo", "kian", "luz",
].map((handle, index) => ({
  id: `CR-${String(index + 1).padStart(4, "0")}`,
  handle,
  contact_email: `${handle}@example-creators.test`,
  country: "IE",
  joined_at: "2024-01-01T00:00:00Z",
}));

const master = creators.map(({ id }, index) => ({
  id,
  account_ref: index === 3 ? "ACCT-0104" : id.replace("CR-", "ACCT-"),
  verified_at: index === 3 ? "2026-11-25T11:00:00Z" : "2026-10-01T00:00:00Z",
  verified_channel: "in_app_2fa",
}));

const changeLog = [{
  id: "CL-0001", creator_id: "CR-0002", old_account_ref: "ACCT-0002", new_account_ref: "ACCT-0998",
  channel: "support_ticket", device: "new", at: "2026-11-26T09:00:00Z", applied: "yes",
}, {
  id: "CL-0002", creator_id: "CR-0004", old_account_ref: "ACCT-0004", new_account_ref: "ACCT-0104",
  channel: "in_app_2fa", device: "known", at: "2026-11-25T11:00:00Z", applied: "yes",
}];

const arrivalRows = [
  {
    id: "IN-0001", atTick: 0, channel: "email",
    body: "From emi@example-creator.test. Please change CR-0005's payout to ACCT-0999 before today's payout.",
  },
  { id: "IN-0002", atTick: 0.025, channel: "support_ticket", body: "Where can I find my tax form?" },
  {
    id: "IN-0003", atTick: 0.12, channel: "in_app", subjectId: "CR-0004",
    body: "CR-0004, your payout account was updated to ACCT-0104 and verified in the app.",
  },
  { id: "IN-0004", atTick: 1.2, channel: "email", body: "Thanks for answering my invoice question." },
];
const arrivals: Arrival[] = arrivalRows.map((row) => ({
  ...row, sources: [{ source: `data/arrivals.jsonl#${row.id}`, field: "body", value: row.body }],
}));

export function payoutMini(): ScenarioData & { batchAt: string } {
  const items = creators.map(({ id }, i): WorkItem => {
    const itemId = `PO-${String(i + 1).padStart(5, "0")}`;
    const destination = i === 1 ? "ACCT-0998" : master[i].account_ref;
    const amountCents = i === 3 ? 12_000 : 4_000 + i * 100;
    const source = `data/batch.csv#${itemId}`;
    return {
      id: itemId, subjectId: id, amountCents, currency: "EUR", destination,
      batchIndex: i, chunkId: `CH-0${Math.floor(i / 4) + 1}`, status: "queued",
      sources: [{ source, field: "destination", value: destination }, { source, field: "amountCents", value: amountCents }],
    };
  });
  const labels = items.map(({ id }) => {
    if (id === "PO-00002") return { itemId: id, shouldHold: true, why: "Unverified in-batch takeover" };
    if (id === "PO-00005") return { itemId: id, shouldHold: true, why: "Off-file takeover request", arrivalId: "IN-0001" };
    if (id === "PO-00004") return { itemId: id, shouldHold: false, why: "Hard negative: verified recent change at the threshold" };
    return { itemId: id, shouldHold: false, why: "Clean" };
  });
  return {
    scenarioId: "payout-change", scale: { ...MINI_SCALE }, batchAt: DEFAULT_BATCH_AT,
    items,
    chunks: [1, 2, 3].map((index) => ({
      id: `CH-0${index}`, index, tick: index, itemIds: items.slice((index - 1) * 4, index * 4).map(({ id }) => id),
    })),
    arrivals: structuredClone(arrivals),
    tables: {
      creators: structuredClone(creators), master: structuredClone(master), change_log: structuredClone(changeLog),
      history: creators.map(({ id }) => ({ id, payouts_90d: 10, median_payout_cents_90d: 4_000 })),
    },
    labels,
  };
}
