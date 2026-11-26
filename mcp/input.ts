import { z } from "zod";

const payoutId = z.string().regex(/^PO-\d{5,}$/);
const creatorId = z.string().regex(/^CR-\d{4,}$/);
const chunkId = z.string().regex(/^CH-\d{2,}$/);
const arrivalId = z.string().regex(/^IN-\d{4,}$/);
const accountRef = z.string().regex(/^ACCT-\d{4}$/, "Expected a synthetic ACCT-NNNN reference");
const count = z.int().nonnegative();
const text = z.string().min(1);
const date = z.iso.datetime({ offset: true });

const source = z.strictObject({
  source: text,
  field: text.optional(),
  value: z.union([z.string(), z.number()]).optional(),
});

const tables = z.strictObject({
  creators: z.array(z.strictObject({
    id: creatorId, handle: text, contact_email: z.email(), country: text, joined_at: date,
  })),
  master: z.array(z.strictObject({
    id: creatorId, account_ref: accountRef, verified_at: date, verified_channel: text,
  })),
  change_log: z.array(z.strictObject({
    id: z.string().regex(/^CL-\d{4,}$/), creator_id: creatorId,
    old_account_ref: accountRef, new_account_ref: accountRef,
    channel: text, device: text, at: date, applied: text,
  })),
  history: z.array(z.strictObject({
    id: creatorId, payouts_90d: count, median_payout_cents_90d: count,
  })),
});

const scenarioData = z.strictObject({
  scenarioId: z.literal("payout-change"),
  scale: z.strictObject({ items: count, arrivals: count, planted: count, seed: z.int() }),
  items: z.array(z.strictObject({
    id: payoutId, subjectId: creatorId, amountCents: count,
    currency: z.string().regex(/^[A-Z]{3}$/), destination: accountRef,
    batchIndex: count, chunkId, status: z.enum(["queued", "checking"]), sources: z.array(source).min(1),
  })),
  chunks: z.array(z.strictObject({
    id: chunkId, index: z.int().positive(), tick: z.int().positive(), itemIds: z.array(payoutId).min(1),
  })),
  arrivals: z.array(z.strictObject({
    id: arrivalId,
    atTick: z.number().nonnegative().describe("Arrival time in release ticks. Fractions are allowed."),
    channel: text, subjectId: creatorId.optional(),
    body: text, sources: z.array(source),
  })),
  tables,
  labels: z.array(z.strictObject({
    itemId: payoutId, shouldHold: z.boolean(), why: text, arrivalId: arrivalId.optional(),
  })),
});

export const generatedInput = z.strictObject({
  scenario: z.literal("payout-change").optional(),
  scale: z.literal("demo").optional(),
  seed: z.int().optional(),
});
export const suppliedInput = z.strictObject({ data: scenarioData });
export const checkInput = z.union([generatedInput, suppliedInput]);
export const summaryInput = z.strictObject({ runId: text });
export const explainInput = summaryInput.extend({ itemId: text });

type PayoutData = z.infer<typeof scenarioData>;

function uniqueIds<Row extends { id: string }>(rows: Row[], field: string): Map<string, Row> {
  const byId = new Map(rows.map((row) => [row.id, row]));
  if (byId.size !== rows.length) throw new Error(`${field} contains duplicate IDs.`);
  return byId;
}

export function validateData(data: PayoutData): void {
  const { scale, items, chunks, arrivals, tables, labels } = data;
  if (scale.items !== items.length || scale.arrivals !== arrivals.length || scale.planted > scale.items) {
    throw new Error("data.scale must match the batch and arrival counts, with planted at most items.");
  }
  const itemsById = uniqueIds(items, "data.items");
  const arrivalsById = uniqueIds(arrivals, "data.arrivals");
  const creators = uniqueIds(tables.creators, "data.tables.creators");
  for (const table of ["master", "history", "change_log"] as const) {
    uniqueIds<{ id: string }>(tables[table], `data.tables.${table}`);
  }
  for (const { subjectId } of items) {
    if (!creators.has(subjectId)) throw new Error(`Unknown creator ${subjectId} in data.items.`);
  }
  for (const { subjectId, id, atTick, body } of arrivals) {
    if (subjectId !== undefined && !creators.has(subjectId)) {
      throw new Error(`Unknown creator ${subjectId} for arrival ${id}.`);
    }
    if (atTick > (chunks.length || 1)) throw new Error(`Arrival ${id} has atTick beyond the batch schedule.`);
    for (const [reference] of body.matchAll(/\bACCT-[\w-]*/gi)) {
      if (!accountRef.safeParse(reference.toUpperCase()).success) {
        throw new Error(`Arrival ${id} must use ACCT-NNNN account references.`);
      }
    }
  }

  const orderedChunks = [...chunks].sort((a, b) => a.index - b.index);
  let previousBatchIndex = -1;
  let scheduled = 0;
  for (const [offset, chunk] of orderedChunks.entries()) {
    const index = offset + 1;
    if (chunk.index !== index || chunk.tick !== index || Number(chunk.id.slice(3)) !== index) {
      throw new Error("data.chunks must have distinct, consecutive IDs, indexes, and ticks starting at one.");
    }
    for (const id of chunk.itemIds) {
      const item = itemsById.get(id);
      if (item?.chunkId !== chunk.id || item.batchIndex <= previousBatchIndex) {
        throw new Error(`Chunk ${chunk.id} must list distinct, assigned items in batchIndex order.`);
      }
      previousBatchIndex = item.batchIndex;
      scheduled++;
    }
  }
  if (scheduled !== items.length) throw new Error("data.chunks must schedule every item.");

  const labeled = new Set<string>();
  for (const label of labels) {
    if (labeled.has(label.itemId) || !itemsById.has(label.itemId)
      || (label.arrivalId !== undefined && !arrivalsById.has(label.arrivalId))) {
      throw new Error("data.labels must refer to known items and arrivals, with one label per item at most.");
    }
    labeled.add(label.itemId);
  }
}
