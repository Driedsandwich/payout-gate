import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ScenarioData } from "../src/core/types.js";
import { generate, SCALES } from "../src/scenarios/double-pledge/generate.js";

type Row = ScenarioData["tables"][string][number];

function required<T>(value: T | undefined, id: string): T {
  if (value === undefined) throw new Error(`Missing fixture record ${id}`);
  return value;
}

function sameInvoice(a: Row, b: Row): boolean {
  return a.seller_id === b.seller_id
    && a.debtor_id === b.debtor_id
    && a.invoice_number === b.invoice_number
    && a.amount_cents === b.amount_cents
    && a.currency === b.currency;
}

function plainInvoiceNumber(number: string | number): string {
  return String(number).replace(/^INV[- ]?/i, "").replace(/^0+/, "");
}

function toHundreds(amount: string | number): number {
  return Math.round(Number(amount) / 100) * 100;
}

it("generates byte-identical JSON for one seed and changes the fixture for another", () => {
  const first = generate(SCALES.demo);
  const repeat = generate({ ...SCALES.demo });
  const different = generate({ ...SCALES.demo, seed: SCALES.demo.seed + 1 });
  expect(JSON.stringify(repeat)).toBe(JSON.stringify(first));
  expect(JSON.stringify(different)).not.toBe(JSON.stringify(first));
  expect(different.tables.invoices).not.toEqual(first.tables.invoices);
});

it("preserves exact counts with a partial funding chunk and only one arrival slot", () => {
  const data = generate({ items: 26, arrivals: 1, planted: 3, seed: 11 });
  expect(data.items).toHaveLength(26);
  expect(data.chunks.map((chunk) => chunk.itemIds.length)).toEqual([25, 1]);
  expect(data.arrivals.map((arrival) => arrival.channel)).toEqual(["lender_api"]);
  expect(data.labels.filter((label) => label.shouldHold)).toHaveLength(3);
});

describe.each(Object.entries(SCALES))("%s pledge fixture", (name, scale) => {
  const data = generate(scale);
  const { items, chunks, arrivals, tables, labels } = data;
  const plants = labels.filter((label) => label.shouldHold);
  const itemById = new Map(items.map((item) => [item.id, item]));
  const invoiceById = new Map(tables.invoices.map((invoice) => [invoice.id, invoice]));
  const arrivalById = new Map(arrivals.map((arrival) => [arrival.id, arrival]));
  const invoiceFor = (itemId: string) => {
    const item = required(itemById.get(itemId), itemId);
    return required(invoiceById.get(item.subjectId), item.subjectId);
  };

  it("matches the scale and assigns every queued request to the funding clock", () => {
    expect(data.scenarioId).toBe("double-pledge");
    expect(data.scale).toEqual(scale);
    expect(items).toHaveLength(scale.items);
    expect(arrivals).toHaveLength(scale.arrivals);
    expect(plants).toHaveLength(scale.planted);
    expect(chunks).toHaveLength(Math.ceil(scale.items / 25));
    expect(new Set(labels.map((label) => label.itemId)).size).toBe(labels.length);
    expect(new Set(arrivals.map((arrival) => arrival.id)).size).toBe(arrivals.length);
    expect(new Set(tables.invoices.map((invoice) => invoice.lender)))
      .toEqual(new Set(["LENDER-A", "LENDER-B", "LENDER-C"]));
    expect(new Set(arrivals.map(({ channel }) => channel))).toEqual(
      new Set(["lender_api", "registry_notice", "debtor_confirmation", "support_ticket", "email"]),
    );

    for (const [index, chunk] of chunks.entries()) {
      expect(chunk).toEqual({
        id: `FB-${index + 1}`,
        index: index + 1,
        tick: index + 1,
        itemIds: items.slice(index * 25, (index + 1) * 25).map((item) => item.id),
      });
    }
    for (const [index, item] of items.entries()) {
      const invoice = invoiceFor(item.id);
      expect(item.id).toBe(`FR-${String(index + 1).padStart(5, "0")}`);
      expect(item.batchIndex).toBe(index);
      expect(item.chunkId).toBe(chunks[Math.floor(index / 25)].id);
      expect(item.status).toBe("queued");
      expect(item.amountCents).toBe(invoice.advance_cents);
      expect(item.amountCents).toBeGreaterThan(0);
      expect(item.amountCents).toBeLessThanOrEqual(Number(invoice.amount_cents));
      expect(item.currency).toBe(invoice.currency);
      expect(["EUR", "USD"]).toContain(item.currency);
    }
    for (const [index, arrival] of arrivals.entries()) {
      expect(arrival.atTick).toBeGreaterThanOrEqual(arrivals[index - 1]?.atTick ?? 0);
      expect(arrival.atTick).toBeLessThan(chunks.length);
    }
    for (const label of labels) {
      expect(itemById.has(label.itemId)).toBe(true);
      expect(label.why).not.toBe("");
      if (label.arrivalId) expect(arrivalById.has(label.arrivalId)).toBe(true);
    }
  });

  it("uses fictional names and account references with resolvable sources", () => {
    for (const row of tables.sellers) expect(row.name).toMatch(/^seller_\d{3}$/);
    for (const row of tables.debtors) expect(row.name).toMatch(/^debtor_\d{3}$/);
    for (const item of items) {
      const invoice = invoiceFor(item.id);
      const seller = required(tables.sellers.find((row) => row.id === invoice.seller_id), String(invoice.seller_id));
      expect(item.destination).toMatch(/^ACCT-\d{4,5}$/);
      expect(item.destination).toBe(seller.account_ref);
      expect(item.sources.length).toBeGreaterThan(0);
    }
    for (const { sources } of [...items, ...arrivals]) {
      for (const { source, field, value } of sources) {
        const [path, fragment] = source.split("#");
        expect(path).toBe(`data/double-pledge/${name}.json`);
        const [table, rowId] = fragment.split("/");
        const row = required(tables[table]?.find(({ id }) => id === rowId), source);
        if (field !== undefined) expect(row[field]).toBe(value);
      }
    }
  });

  it("contains each planted kind with grounded evidence", () => {
    const seconds = plants.filter(({ why }) => why.includes("second submission"));
    const pledges = plants.filter(({ why }) => why.includes("already pledged"));
    const fabricated = plants.filter(({ why }) => why.includes("fabricated"));
    expect([seconds.length, pledges.length, fabricated.length]).toEqual(
      name === "demo" ? [3, 3, 2] : [8, 8, 8],
    );

    for (const label of seconds) {
      const item = required(itemById.get(label.itemId), label.itemId);
      const original = invoiceFor(item.id);
      const arrival = required(arrivalById.get(label.arrivalId ?? ""), label.itemId);
      const copy = required(invoiceById.get(arrival.subjectId ?? ""), arrival.id);
      const { tick } = required(chunks.find((chunk) => chunk.id === item.chunkId), item.chunkId);
      expect(arrival.channel).toBe("lender_api");
      expect(arrival.atTick).toBeGreaterThanOrEqual(tick - 0.9);
      expect(arrival.atTick).toBeLessThanOrEqual(tick - 0.4);
      expect(copy.id).not.toBe(original.id);
      expect(copy.lender).not.toBe(original.lender);
      for (const field of ["seller_id", "debtor_id", "line_items", "currency"]) {
        expect(copy[field]).toBe(original[field]);
      }
      for (const field of ["invoice_number", "amount_cents", "issue_date"]) {
        expect(copy[field]).not.toBe(original[field]);
        expect(arrival.body).toContain(String(copy[field]));
      }
      expect(plainInvoiceNumber(copy.invoice_number)).toBe(plainInvoiceNumber(original.invoice_number));
      expect(copy.amount_cents).toBe(toHundreds(original.amount_cents));
      expect(Math.abs(Date.parse(String(copy.issue_date)) - Date.parse(String(original.issue_date)))).toBe(86_400_000);
      const elapsed = Date.parse(String(copy.submitted_at)) - Date.parse(String(original.submitted_at));
      expect(elapsed).toBeGreaterThan(0);
      expect(elapsed).toBeLessThan(10 * 60_000);
      expect(tables.debtor_ledger.filter((entry) => sameInvoice(original, entry) && entry.status === "open"))
        .toHaveLength(1);
    }
    for (const label of pledges) {
      const invoice = invoiceFor(label.itemId);
      const pledge = required(tables.registry.find((row) => sameInvoice(invoice, row)), label.itemId);
      expect(pledge.lender).not.toBe(invoice.lender);
      expect(Date.parse(String(pledge.registered_at))).toBeLessThan(Date.parse(String(invoice.submitted_at)));
      if (label.arrivalId) expect(arrivalById.get(label.arrivalId)?.channel).toBe("registry_notice");
    }
    for (const label of fabricated) {
      const invoice = invoiceFor(label.itemId);
      expect(tables.debtor_ledger.some((row) => row.seller_id === invoice.seller_id
        && row.debtor_id === invoice.debtor_id
        && plainInvoiceNumber(row.invoice_number) === plainInvoiceNumber(invoice.invoice_number))).toBe(false);
      if (label.arrivalId) expect(arrivalById.get(label.arrivalId)?.channel).toBe("debtor_confirmation");
    }
  });

  it("labels similar invoices, same-lender splits and cancelled resubmissions as hard negatives", () => {
    const negatives = labels.filter(({ shouldHold }) => !shouldHold);
    const similar = negatives.filter(({ why }) => why.includes("similar invoice"));
    const split = negatives.filter(({ why }) => why.includes("partial requests"));
    const cancelled = negatives.filter(({ why }) => why.includes("cancelled"));
    expect(similar.length).toBeGreaterThan(0);
    expect(split).toHaveLength(similar.length * 2);
    expect(cancelled).toHaveLength(similar.length);
    expect(negatives).toHaveLength(similar.length + split.length + cancelled.length);

    for (const label of similar) {
      const invoice = invoiceFor(label.itemId);
      const arrival = required(arrivalById.get(label.arrivalId ?? ""), label.itemId);
      const other = required(invoiceById.get(arrival.subjectId ?? ""), arrival.id);
      expect(other.seller_id).toBe(invoice.seller_id);
      expect(other.debtor_id).toBe(invoice.debtor_id);
      expect(other.lender).not.toBe(invoice.lender);
      expect(toHundreds(other.amount_cents)).toBe(toHundreds(invoice.amount_cents));
      for (const field of ["invoice_number", "issue_date", "line_items"]) {
        expect(other[field]).not.toBe(invoice[field]);
      }
      for (const row of [invoice, other]) {
        expect(tables.debtor_ledger.some((entry) => sameInvoice(row, entry) && entry.status === "open")).toBe(true);
      }
    }
    for (const label of split) {
      const invoice = invoiceFor(label.itemId);
      const partials = items.filter((item) => sameInvoice(invoice, invoiceFor(item.id)));
      expect(partials).toHaveLength(2);
      expect(partials.reduce((total, item) => total + item.amountCents, 0)).toBeLessThanOrEqual(Number(invoice.amount_cents));
      for (const item of partials) {
        expect(item.amountCents).toBeLessThan(Number(invoice.amount_cents));
        expect(invoiceFor(item.id).lender).toBe(invoice.lender);
        expect(split.some((negative) => negative.itemId === item.id)).toBe(true);
      }
    }
    for (const label of cancelled) {
      const invoice = invoiceFor(label.itemId);
      const previous = required(tables.invoices.find((row) => row.id !== invoice.id && sameInvoice(invoice, row)), label.itemId);
      expect(previous.lender).toBe(invoice.lender);
      expect(previous.request_status).toBe("cancelled");
      expect(itemById.has(String(previous.request_id))).toBe(false);
      expect(Date.parse(String(previous.submitted_at))).toBeLessThan(Date.parse(String(previous.cancelled_at)));
      expect(Date.parse(String(previous.cancelled_at))).toBeLessThan(Date.parse(String(invoice.submitted_at)));
    }
  });

  it("matches the frozen pretty JSON byte for byte", () => {
    const file = new URL(`../data/double-pledge/${name}.json`, import.meta.url);
    expect(readFileSync(file, "utf8")).toBe(`${JSON.stringify(data, null, 2)}\n`);
  });
});
