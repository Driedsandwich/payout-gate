import type { ScenarioData, SourceRef, WorkItem } from "../../core/types.js";

export type Row = ScenarioData["tables"][string][number];
export type Table = "invoices" | "registry" | "debtor_ledger" | "sellers" | "debtors";

export interface InvoiceIdentity {
  seller_id: string;
  debtor_id: string;
  invoice_number: string;
  currency: string;
}

export interface Receivable extends InvoiceIdentity {
  amount_cents: number;
  issue_date?: string;
}

export interface Submission extends Receivable {
  issue_date: string;
  lender: string;
  advance_cents: number;
}

export interface Finding {
  reason: string;
  sources: SourceRef[];
}

export interface Facts {
  hits: Finding[];
  complete: boolean;
  sources: SourceRef[];
}

type PledgeItem = WorkItem & { invoiceRowId?: string };
type PledgeData = ScenarioData & { runStartedAt?: string };
const generatedRunStart = "2026-11-26T09:00:00.000Z";
const dayMs = 86_400_000;

export function distinctSources(sources: SourceRef[]): SourceRef[] {
  return [...new Map(sources.map((ref) => [JSON.stringify([ref.source, ref.field, ref.value]), ref])).values()];
}

export function rowSources(data: ScenarioData, table: Table, row: Row, fields = Object.keys(row)): SourceRef[] {
  const origin = data.items[0]?.sources.find(({ source }) => source.includes("#invoices/"))?.source.split("#")[0]
    ?? "scenario:double-pledge";
  const source = `${origin}#${table}/${row.id}`;
  return [...new Set(["id", ...fields])].flatMap((field) =>
    row[field] === undefined ? [] : [{ source, field, value: row[field] }]);
}

export function normalizeInvoiceNumber(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^[A-Z]+/, "").replace(/^0+(?=[A-Z0-9])/, "");
}

function invoiceKey(row: InvoiceIdentity): string {
  const number = normalizeInvoiceNumber(row.invoice_number);
  return number && JSON.stringify([row.seller_id, row.debtor_id, number, row.currency]);
}

function dateDay(value: string): number {
  return Date.parse(value + "T00:00:00.000Z") / dayMs;
}

export function matchesFingerprint(left: Receivable, right: Receivable): boolean {
  const key = invoiceKey(left);
  return Boolean(key && key === invoiceKey(right)
    && Math.round(left.amount_cents / 100) === Math.round(right.amount_cents / 100)
    && (!left.issue_date || !right.issue_date || Math.abs(dateDay(left.issue_date) - dateDay(right.issue_date)) <= 1));
}

function identity(row: Row): InvoiceIdentity | undefined {
  const { seller_id, debtor_id, invoice_number, currency } = row;
  if (typeof seller_id === "string" && typeof debtor_id === "string" && typeof invoice_number === "string"
      && normalizeInvoiceNumber(invoice_number) && typeof currency === "string") {
    return { seller_id, debtor_id, invoice_number, currency };
  }
}

export function receivable(row: Row): Receivable | undefined {
  const party = identity(row);
  const { amount_cents, issue_date } = row;
  if (party && typeof amount_cents === "number" && Number.isSafeInteger(amount_cents) && amount_cents > 0
      && (issue_date === undefined || typeof issue_date === "string" && Number.isFinite(dateDay(issue_date)))) {
    return { ...party, amount_cents, issue_date: typeof issue_date === "string" ? issue_date : undefined };
  }
}

export function submission(row: Row): Submission | undefined {
  const invoice = receivable(row);
  const { lender, advance_cents } = row;
  if (invoice?.issue_date && typeof lender === "string" && lender && typeof advance_cents === "number"
      && Number.isSafeInteger(advance_cents) && advance_cents > 0) {
    return { ...invoice, issue_date: invoice.issue_date, lender, advance_cents };
  }
}

export function invoiceRow(data: ScenarioData, item: PledgeItem): Row | undefined {
  return data.tables.invoices?.find(({ id }) => id === (item.invoiceRowId ?? item.subjectId));
}

/** The ledger routes one subject per arrival. Group by exact identity before applying fuzzy comparisons. */
export function preparePledgeData(data: ScenarioData): ScenarioData {
  const invoices = new Map(data.tables.invoices?.map((row) => [row.id, row]));
  const subjects = new Map<string, string>();
  const items = data.items.map((item: PledgeItem): PledgeItem => {
    const invoiceId = item.invoiceRowId ?? item.subjectId;
    const row = invoices.get(invoiceId);
    const party = row && identity(row);
    if (!party) return item;
    const key = invoiceKey(party);
    const subjectId = subjects.get(key) ?? invoiceId;
    subjects.set(key, subjectId);
    return subjectId === item.subjectId ? item : { ...item, subjectId, invoiceRowId: invoiceId };
  });
  return { ...data, items };
}

function runStart(data: PledgeData): number {
  return Date.parse(data.runStartedAt ?? generatedRunStart);
}

function beforeCancellation(row: Row, cutoff: number): boolean {
  return row.request_status !== "cancelled" || !(Date.parse(String(row.cancelled_at)) <= cutoff);
}

function invoiceSources(data: ScenarioData, row?: Row): SourceRef[] {
  return row ? rowSources(data, "invoices", row, [
    "seller_id", "debtor_id", "invoice_number", "amount_cents", "currency", "issue_date",
    "lender", "advance_cents", "submitted_at", "request_status", "cancelled_at",
  ]) : [];
}

export interface LinkedSubmission {
  invoice: Submission;
  sources: SourceRef[];
  row?: Row;
}

export function inspectRegistry(data: ScenarioData, item: WorkItem, incoming: LinkedSubmission[]): Facts {
  const row = invoiceRow(data, item);
  const invoice = row && submission(row);
  const base = distinctSources([...item.sources, ...invoiceSources(data, row)]);
  const cutoff = runStart(data);
  if (!row || !invoice) return { hits: [], complete: false, sources: base };

  const pledges = data.tables.registry?.filter((record) => {
    const pledge = receivable(record);
    return pledge && matchesFingerprint(invoice, pledge) && typeof record.lender === "string"
      && Date.parse(String(record.registered_at)) < cutoff && beforeCancellation(record, cutoff);
  });
  const hits: Finding[] = (pledges ?? []).filter((record) => record.lender !== invoice.lender).map((record) => ({
    reason: "The registry shows a pledge to another lender before this funding run.",
    sources: [...base, ...rowSources(data, "registry", record)],
  }));

  const submittedAt = Date.parse(String(row.submitted_at));
  const batchRows = new Set(data.items.map((item: PledgeItem) => item.invoiceRowId ?? item.subjectId));
  const matches = new Map<string, LinkedSubmission>();
  const cancelled: SourceRef[] = [];
  for (const candidate of data.tables.invoices ?? []) {
    if (candidate.id === row.id || (!batchRows.has(candidate.id) && !(Date.parse(String(candidate.submitted_at)) < cutoff))) continue;
    const other = submission(candidate);
    if (!other || !matchesFingerprint(invoice, other)) continue;
    const sources = invoiceSources(data, candidate);
    if (!beforeCancellation(candidate, submittedAt)) {
      cancelled.push(...sources);
      continue;
    }
    matches.set(candidate.id, { invoice: other, sources });
  }
  for (const [index, candidate] of incoming.entries()) {
    if (!matchesFingerprint(invoice, candidate.invoice)) continue;
    if (candidate.row?.id === row.id ||
        (candidate.row && !beforeCancellation(candidate.row, submittedAt))) continue;
    const key = candidate.row?.id ?? `arrival:${index}`;
    const previous = matches.get(key);
    matches.set(key, { ...candidate, sources: distinctSources([...(previous?.sources ?? []), ...candidate.sources]) });
  }

  const sameLender: LinkedSubmission[] = [];
  for (const other of matches.values()) {
    if (other.invoice.lender === invoice.lender) {
      sameLender.push(other);
    } else {
      hits.push({
        reason: "Matching invoice fingerprints show active funding requests at different lenders.",
        sources: [...base, ...other.sources],
      });
    }
  }
  const totalAdvance = sameLender.reduce((total, { invoice: other }) => total + other.advance_cents, invoice.advance_cents);
  if (totalAdvance > invoice.amount_cents) {
    hits.push({
      reason: "Active requests at the same lender exceed the invoice total.",
      sources: [...base, ...sameLender.flatMap(({ sources }) => sources)],
    });
  }
  return {
    hits, complete: pledges !== undefined && Number.isFinite(cutoff),
    sources: distinctSources([
      ...base, ...(pledges ?? []).flatMap((record) => rowSources(data, "registry", record)),
      ...[...matches.values()].flatMap(({ sources }) => sources), ...cancelled,
    ]),
  };
}

export function inspectDebtor(data: ScenarioData, item: WorkItem): Facts {
  const row = invoiceRow(data, item);
  const invoice = row && identity(row);
  const base = distinctSources([...item.sources, ...invoiceSources(data, row)]);
  const ledger = data.tables.debtor_ledger;
  if (!invoice || !ledger) return { hits: [], complete: false, sources: base };

  const debtor = data.tables.debtors?.find(({ id }) => id === invoice.debtor_id);
  const searched = ledger.filter(({ debtor_id }) => debtor_id === invoice.debtor_id);
  const key = invoiceKey(invoice);
  const entries = searched.filter((entry) => {
    const party = identity(entry);
    return party && invoiceKey(party) === key;
  });
  const open = entries.find(({ status }) => status === "open");
  const sources = distinctSources([
    ...base, ...(debtor ? rowSources(data, "debtors", debtor) : []),
    ...(open ? [open] : entries.length ? entries : searched).flatMap((entry) => rowSources(data, "debtor_ledger", entry)),
  ]);
  return {
    complete: true, sources,
    hits: open ? [] : [{ reason: "The debtor ledger has no open entry for this seller and invoice number.", sources }],
  };
}
