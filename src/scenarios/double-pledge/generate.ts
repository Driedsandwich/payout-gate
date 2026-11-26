import type { Arrival, Chunk, Label, Scale, ScenarioData, SourceRef, WorkItem } from "../../core/types.js";

export const SCALES = {
  demo: { items: 200, arrivals: 30, planted: 8, seed: 11 },
  full: { items: 1000, arrivals: 120, planted: 24, seed: 11 },
} satisfies Record<string, Scale>;

const CHUNK_SIZE = 25;
const LENDERS = ["LENDER-A", "LENDER-B", "LENDER-C"] as const;
const COUNTRIES = ["DE", "FR", "NL", "US"] as const;
const GOODS = ["Carton dividers", "Aisle markers", "Packing slips", "Shelf label holders"] as const;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const TICK_MS = 10_000;
const RUN_START = Date.UTC(2026, 10, 26, 9);
const PLANTED_KINDS = ["second-submission", "registry", "fabricated"] as const;

type Lender = (typeof LENDERS)[number];
type Invoice = {
  id: string;
  seller_id: string;
  debtor_id: string;
  invoice_number: string;
  amount_cents: number;
  advance_cents: number;
  currency: "EUR" | "USD";
  issue_date: string;
  due_date: string;
  line_items: string;
  lender: Lender;
  submitted_at: string;
};
type Case =
  | { kind: (typeof PLANTED_KINDS)[number]; notify: boolean }
  | { kind: "similar" | "cancelled" }
  | { kind: "split"; firstIndex: number };

// Mulberry32, with all state local to one generation.
function seededRandom(seed: number): () => number {
  let state = (seed ^ Math.imul(Math.trunc(seed / 0x1_0000_0000), 0x9e3779b1)) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

function id(prefix: string, number: number, width = 5): string {
  return `${prefix}-${String(number).padStart(width, "0")}`;
}

function timeAtTick(tick: number): string {
  return new Date(RUN_START + Math.round(tick * TICK_MS)).toISOString();
}

function beforeRun(minutes: number): string {
  return new Date(RUN_START - minutes * MINUTE).toISOString();
}

function dateOnly(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

function roundedAmount(amount: number): number {
  return Math.round(amount / 100) * 100;
}

function invoiceBody(invoice: Invoice, sellerName: string, debtorName: string): string {
  return [
    `To ${invoice.lender} intake: please advance funds against this unpaid invoice.`,
    `Seller: ${sellerName} (${invoice.seller_id})`,
    `Debtor: ${debtorName} (${invoice.debtor_id})`,
    `Invoice number: ${invoice.invoice_number}`,
    `Invoice amount: ${invoice.amount_cents} cents ${invoice.currency}`,
    `Requested advance: ${invoice.advance_cents} cents ${invoice.currency}`,
    `Issue date: ${invoice.issue_date}`,
    `Due date: ${invoice.due_date}`,
    `Line items: ${invoice.line_items}`,
  ].join("\n");
}

export function generate(scale: Scale): ScenarioData {
  const { items: itemCount, arrivals: arrivalCount, planted, seed } = scale;
  if (![itemCount, arrivalCount, planted].every((count) => Number.isSafeInteger(count) && count >= 0)) {
    throw new RangeError("Scale counts must be non-negative integers.");
  }
  if (!Number.isSafeInteger(seed)) {
    throw new RangeError("Scale seed must be a safe integer.");
  }
  const secondCount = Math.ceil(planted / PLANTED_KINDS.length);
  if (planted > itemCount || secondCount > arrivalCount) {
    throw new RangeError("The scale needs one item per plant and one arrival per second submission.");
  }

  const preset = Object.entries(SCALES).find(([, candidate]) => candidate.items === itemCount
    && candidate.arrivals === arrivalCount && candidate.planted === planted && candidate.seed === seed)?.[0];
  const origin = preset ? `data/double-pledge/${preset}.json` : "scenario:double-pledge";
  const source = (table: string, rowId: string, field?: string, value?: string | number): SourceRef => ({
    source: `${origin}#${table}/${rowId}`,
    ...(field === undefined ? {} : { field, value }),
  });

  const random = seededRandom(seed);
  const integer = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));
  const pick = <T>(values: readonly T[]): T => values[integer(0, values.length - 1)];
  const otherLender = (lender: Lender) => pick(LENDERS.filter((candidate) => candidate !== lender));

  const order = Array.from({ length: itemCount }, (_, index) => index);
  for (let index = order.length - 1; index > 0; index--) {
    const swapIndex = integer(0, index);
    [order[index], order[swapIndex]] = [order[swapIndex], order[index]];
  }

  const cases = new Map<number, Case>();
  // Reserve room for the mandatory second submissions and both kinds of ordinary noise.
  let optionalArrivals = Math.max(0, arrivalCount - secondCount - 2);
  for (let index = 0; index < planted; index++) {
    const kind = PLANTED_KINDS[index % PLANTED_KINDS.length];
    const notify = kind !== "second-submission" && Math.floor(index / PLANTED_KINDS.length) % 2 === 0
      && optionalArrivals > 0;
    if (notify) optionalArrivals--;
    cases.set(order[index], { kind, notify });
  }

  const negativeGroups = Math.min(Math.max(1, Math.floor(planted / 3)), Math.floor((itemCount - planted) / 4));
  for (let group = 0; group < negativeGroups; group++) {
    const [similar, splitA, splitB, cancelled] = order.slice(planted + group * 4, planted + group * 4 + 4);
    const split = { kind: "split", firstIndex: Math.min(splitA, splitB) } as const;
    cases.set(similar, { kind: "similar" });
    cases.set(splitA, split);
    cases.set(splitB, split);
    cases.set(cancelled, { kind: "cancelled" });
  }

  const sellers = Array.from({ length: Math.min(80, itemCount) }, (_, index) => ({
    id: id("SL", index + 1, 4),
    name: `seller_${String(index + 1).padStart(3, "0")}`,
    country: pick(COUNTRIES),
    account_ref: id("ACCT", index + 1, 4),
  }));
  const debtors = Array.from({ length: Math.min(120, itemCount) }, (_, index) => ({
    id: id("DB", index + 1, 4),
    name: `debtor_${String(index + 1).padStart(3, "0")}`,
  }));
  const chunks: Chunk[] = Array.from({ length: Math.ceil(itemCount / CHUNK_SIZE) }, (_, index) => ({
    id: `FB-${index + 1}`,
    index: index + 1,
    tick: index + 1,
    itemIds: [],
  }));
  const items: WorkItem[] = [];
  const invoices: Invoice[] = [];
  const extraInvoices: Invoice[] = [];
  const arrivals: Arrival[] = [];
  const labels: Label[] = [];
  const registry: ScenarioData["tables"][string] = [];
  const debtorLedger: ScenarioData["tables"][string] = [];

  const extraInvoiceId = () => id("IV", itemCount + extraInvoices.length + 1);
  const printedNumber = (serial: number) => id("INV", 100 + serial * 17);
  const addArrival = (arrival: Omit<Arrival, "id">): string => {
    const arrivalId = id("IN", arrivals.length + 1, 4);
    arrivals.push({ id: arrivalId, ...arrival });
    return arrivalId;
  };
  const addLedgerEntry = (invoice: Invoice, status: "open" | "paid") => {
    debtorLedger.push({
      id: id("DL", debtorLedger.length + 1),
      debtor_id: invoice.debtor_id,
      seller_id: invoice.seller_id,
      invoice_number: invoice.invoice_number,
      amount_cents: invoice.amount_cents,
      currency: invoice.currency,
      status,
    });
  };
  const addRegistryEntry = (invoice: Invoice, lender: Lender, registeredAt: number) => {
    const row = {
      id: id("RG", registry.length + 1, 4),
      seller_id: invoice.seller_id,
      debtor_id: invoice.debtor_id,
      invoice_number: invoice.invoice_number,
      amount_cents: invoice.amount_cents,
      currency: invoice.currency,
      lender,
      registered_at: new Date(registeredAt).toISOString(),
    };
    registry.push(row);
    return row;
  };

  for (let index = 0; index < itemCount; index++) {
    const testCase = cases.get(index);
    const splitFirst = testCase?.kind === "split" && testCase.firstIndex === index;
    const firstHalf = testCase?.kind === "split" && !splitFirst ? invoices[testCase.firstIndex] : undefined;
    const seller = firstHalf ? sellers[Number(firstHalf.seller_id.slice(3)) - 1] : pick(sellers);
    const debtor = firstHalf ? debtors[Number(firstHalf.debtor_id.slice(3)) - 1] : pick(debtors);
    const invoiceId = id("IV", index + 1);
    let invoice: Invoice;
    if (firstHalf) {
      invoice = {
        ...firstHalf,
        id: invoiceId,
        advance_cents: Math.floor(firstHalf.amount_cents * 0.8) - firstHalf.advance_cents,
        submitted_at: new Date(Date.parse(firstHalf.submitted_at) + MINUTE).toISOString(),
      };
    } else {
      const amount = integer(500, 30_000) * 100 + integer(12, 38);
      const issue = RUN_START - integer(21, 45) * DAY;
      let submissionAge = integer(120, 480);
      if (testCase?.kind === "second-submission") submissionAge = integer(1, 3);
      if (testCase?.kind === "cancelled") submissionAge = 10;
      invoice = {
        id: invoiceId,
        seller_id: seller.id,
        debtor_id: debtor.id,
        invoice_number: printedNumber(index + 1),
        amount_cents: amount,
        advance_cents: Math.floor(amount * (splitFirst ? 0.4 : 0.8)),
        currency: seller.country === "US" ? "USD" : "EUR",
        issue_date: dateOnly(issue),
        due_date: dateOnly(issue + 60 * DAY),
        line_items: `${pick(GOODS)} x ${integer(20, 500)}`,
        lender: pick(LENDERS),
        submitted_at: beforeRun(submissionAge),
      };
    }
    invoices.push(invoice);

    const chunk = chunks[Math.floor(index / CHUNK_SIZE)];
    const itemId = id("FR", index + 1);
    items.push({
      id: itemId,
      subjectId: invoice.id,
      amountCents: invoice.advance_cents,
      currency: invoice.currency,
      destination: seller.account_ref,
      batchIndex: index,
      chunkId: chunk.id,
      status: "queued",
      sources: [
        source("invoices", invoice.id, "advance_cents", invoice.advance_cents),
        source("invoices", invoice.id, "currency", invoice.currency),
        source("sellers", seller.id, "account_ref", seller.account_ref),
      ],
    });
    chunk.itemIds.push(itemId);

    if (!firstHalf && testCase?.kind !== "fabricated") addLedgerEntry(invoice, "open");
    if (!testCase) {
      // Background history supplies paid rows and ordinary pledges at the submitting lender.
      if (index % 8 === 0) {
        addLedgerEntry({
          ...invoice,
          invoice_number: printedNumber(itemCount * 2 + index + 1),
          amount_cents: Math.floor(invoice.amount_cents / 2),
        }, "paid");
      }
      if (index % 11 === 0) addRegistryEntry(invoice, invoice.lender, Date.parse(invoice.submitted_at) + MINUTE);
      continue;
    }

    const beforeChunk = () => chunk.tick - integer(40, 90) / 100;
    const submit = (submission: Invoice, atTick: number): string => addArrival({
      atTick,
      channel: "lender_api",
      subjectId: submission.id,
      body: invoiceBody(submission, seller.name, debtor.name),
      sources: [source("invoices", submission.id)],
    });
    let arrivalId: string | undefined;
    let why: string;
    let shouldHold = true;
    switch (testCase.kind) {
      case "second-submission": {
        const atTick = beforeChunk();
        const copy: Invoice = {
          ...invoice,
          id: extraInvoiceId(),
          invoice_number: String(Number(invoice.invoice_number.slice(4))),
          amount_cents: roundedAmount(invoice.amount_cents),
          advance_cents: roundedAmount(invoice.advance_cents),
          issue_date: dateOnly(Date.parse(invoice.issue_date) + DAY),
          lender: otherLender(invoice.lender),
          submitted_at: timeAtTick(atTick),
        };
        extraInvoices.push(copy);
        arrivalId = submit(copy, atTick);
        why = "A second submission sent an altered copy of the pending receivable to another lender.";
        break;
      }
      case "registry": {
        const registeredAt = Date.parse(invoice.submitted_at) - integer(180, 720) * MINUTE;
        const pledge = addRegistryEntry(invoice, otherLender(invoice.lender), registeredAt);
        if (testCase.notify) {
          arrivalId = addArrival({
            atTick: beforeChunk(),
            channel: "registry_notice",
            subjectId: invoice.id,
            body: `Registry notice ${pledge.id}. ${pledge.lender} registered a pledge for ${invoice.invoice_number} from ${seller.name} to ${debtor.name} for ${invoice.amount_cents} cents ${invoice.currency} at ${pledge.registered_at}.`,
            sources: [source("registry", pledge.id)],
          });
        }
        why = "The receivable was already pledged to another lender in the registry before the run.";
        break;
      }
      case "fabricated": {
        if (testCase.notify) {
          arrivalId = addArrival({
            atTick: beforeChunk(),
            channel: "debtor_confirmation",
            subjectId: invoice.id,
            body: `${debtor.name} checked its accounts payable ledger for ${seller.name}. We found no invoice numbered ${invoice.invoice_number} for ${invoice.amount_cents} cents ${invoice.currency}.`,
            sources: [source("debtors", debtor.id), source("invoices", invoice.id)],
          });
        }
        why = "The invoice was fabricated and has no entry in the debtor ledger.";
        break;
      }
      case "similar": {
        const atTick = optionalArrivals > 0 ? beforeChunk() : undefined;
        const similar: Invoice = {
          ...invoice,
          id: extraInvoiceId(),
          invoice_number: printedNumber(itemCount + extraInvoices.length + 1),
          amount_cents: invoice.amount_cents + 10,
          issue_date: dateOnly(Date.parse(invoice.issue_date) + 7 * DAY),
          due_date: dateOnly(Date.parse(invoice.due_date) + 7 * DAY),
          line_items: "Return address label rolls x 75",
          lender: otherLender(invoice.lender),
          submitted_at: atTick === undefined ? beforeRun(30) : timeAtTick(atTick),
        };
        extraInvoices.push(similar);
        addLedgerEntry(similar, "open");
        if (atTick !== undefined) {
          optionalArrivals--;
          arrivalId = submit(similar, atTick);
        }
        shouldHold = false;
        why = "The similar invoice has the same seller and debtor but a different number, issue date and line items.";
        break;
      }
      case "split": {
        shouldHold = false;
        why = "The seller split the invoice into two partial requests at the same lender within the invoice total.";
        break;
      }
      case "cancelled": {
        const previous = {
          ...invoice,
          id: extraInvoiceId(),
          submitted_at: beforeRun(240),
          request_id: id("FR", itemCount + extraInvoices.length + 1),
          request_status: "cancelled",
          cancelled_at: beforeRun(25),
        };
        extraInvoices.push(previous);
        shouldHold = false;
        why = "The seller resubmitted to the same lender after the previous request was cancelled.";
        break;
      }
    }
    labels.push({ itemId, shouldHold, why, ...(arrivalId === undefined ? {} : { arrivalId }) });
  }

  const noiseCount = arrivalCount - arrivals.length;
  for (let index = 0; index < noiseCount; index++) {
    const kyc = index % 2 === 0;
    addArrival({
      atTick: (index + random()) * chunks.length / noiseCount,
      channel: kyc ? "support_ticket" : "email",
      body: kyc
        ? `Which identity documents are accepted when opening a seller profile with ${pick(LENDERS)}?`
        : `Does ${pick(LENDERS)} publish its current rates for advances in EUR and USD?`,
      sources: [],
    });
  }
  arrivals.sort((a, b) => a.atTick - b.atTick);

  return {
    scenarioId: "double-pledge",
    scale: { items: itemCount, arrivals: arrivalCount, planted, seed },
    items,
    chunks,
    arrivals,
    tables: { sellers, debtors, invoices: [...invoices, ...extraInvoices], registry, debtor_ledger: debtorLedger },
    labels,
  };
}
