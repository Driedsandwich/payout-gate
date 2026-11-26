import type { Arrival, ScenarioData, SourceRef, WorkItem } from "../../core/types.js";
import {
  distinctSources, invoiceRow, matchesFingerprint, receivable, rowSources, submission,
  type Receivable, type Row, type Submission,
} from "./rules.js";

type Message =
  | { kind: "unrelated" | "incomplete"; sources: SourceRef[] }
  | { kind: "submission"; invoice: Submission; row?: Row; sources: SourceRef[] }
  | { kind: "registry"; invoice: Receivable; lender: string; sources: SourceRef[] }
  | { kind: "debtor"; invoice: Receivable; sources: SourceRef[] };

function party(data: ScenarioData, table: "sellers" | "debtors", text: string | undefined): Row | undefined {
  if (!text) return undefined;
  const normalized = text.trim().toLowerCase();
  return data.tables[table]?.find(({ id, name }) =>
    normalized === id.toLowerCase() || normalized === String(name).toLowerCase()
      || normalized === `${name} (${id})`.toLowerCase());
}

export function readPledgeMessage(data: ScenarioData, { id, body, sources }: Arrival): Message {
  body = body.trim();
  const evidence = distinctSources([...sources, { source: `scenario:double-pledge#arrivals/${id}`, field: "id", value: id }]);
  const submissionHeader = body.match(/^To (LENDER-[\w-]+) intake\s*:/im);
  const registryHeader = /^Registry notice\b/i.test(body);
  const debtorHeader = /\bchecked its accounts payable ledger\b/i.test(body);
  if (!submissionHeader && !registryHeader && !debtorHeader) return { kind: "unrelated", sources: evidence };

  const line = (name: string) => body.match(new RegExp(`^${name}:[ \\t]*([^\\r\\n]+)`, "im"))?.[1].trim();
  const registry = registryHeader ? body.match(
    /^Registry notice\s+(\S+)\.\s+(LENDER-[\w-]+) registered a pledge for (.+?) from (\S+) to (\S+) for (\d+) cents ([A-Z]{3}) at (\S+)\.$/i,
  ) : null;
  const debtor = debtorHeader ? body.match(
    /^(\S+) checked its accounts payable ledger for (\S+)\.\s+We found no invoice numbered (.+?) for (\d+) cents ([A-Z]{3})\.$/i,
  ) : null;
  const seller = party(data, "sellers", submissionHeader ? line("Seller") : registry?.[4] ?? debtor?.[2]);
  const obligor = party(data, "debtors", submissionHeader ? line("Debtor") : registry?.[5] ?? debtor?.[1]);
  const amount = line("Invoice amount")?.match(/^(\d+) cents ([A-Z]{3})$/i);
  const fields = {
    id, seller_id: seller?.id ?? "", debtor_id: obligor?.id ?? "",
    invoice_number: line("Invoice number") ?? registry?.[3] ?? debtor?.[3] ?? "",
    amount_cents: Number(amount?.[1] ?? registry?.[6] ?? debtor?.[4]),
    currency: (amount?.[2] ?? registry?.[7] ?? debtor?.[5] ?? "").toUpperCase(),
  };
  const incomplete = { kind: "incomplete", sources: evidence } as const;
  if (!seller || !obligor) return incomplete;
  evidence.push(...rowSources(data, "sellers", seller, ["name"]), ...rowSources(data, "debtors", obligor, ["name"]));

  if (submissionHeader) {
    const advance = line("Requested advance")?.match(/^(\d+) cents ([A-Z]{3})$/i);
    const invoice = submission({
      ...fields, lender: submissionHeader[1].toUpperCase(), issue_date: line("Issue date") ?? "",
      advance_cents: advance?.[2].toUpperCase() === fields.currency ? Number(advance?.[1]) : NaN,
    });
    if (!invoice) return incomplete;

    const matchingRows = data.tables.invoices?.filter((row) =>
      Object.entries(invoice).every(([field, value]) => row[field] === value));
    const row = matchingRows?.length === 1 ? matchingRows[0] : undefined;
    if (row) evidence.push(...rowSources(data, "invoices", row, Object.keys(invoice)));
    return { kind: "submission", invoice, row, sources: distinctSources(evidence) };
  }

  const invoice = receivable(fields);
  if (!invoice) return incomplete;
  if (registry) {
    const lender = registry[2].toUpperCase();
    const row = data.tables.registry?.find((row) => row.id === registry[1] && row.lender === lender
      && row.registered_at === registry[8] && row.seller_id === invoice.seller_id && row.debtor_id === invoice.debtor_id
      && row.invoice_number === invoice.invoice_number && row.amount_cents === invoice.amount_cents
      && row.currency === invoice.currency);
    const pledge = row && receivable(row);
    if (row && pledge) {
      return { kind: "registry", invoice: pledge, lender, sources: distinctSources([...evidence, ...rowSources(data, "registry", row)]) };
    }
    return { kind: "registry", invoice, lender, sources: distinctSources(evidence) };
  }
  return { kind: "debtor", invoice, sources: distinctSources(evidence) };
}

export function fingerprintMessage(data: ScenarioData, arrival: Arrival, items: WorkItem[]) {
  const message = readPledgeMessage(data, arrival);
  const matches = "invoice" in message ? items.flatMap((item) => {
    const row = invoiceRow(data, item);
    const invoice = row && submission(row);
    if (!row || !invoice || !matchesFingerprint(invoice, message.invoice)) return [];
    return {
      itemId: item.id, subjectId: item.subjectId,
      sources: rowSources(data, "invoices", row, ["seller_id", "debtor_id", "invoice_number", "amount_cents", "issue_date", "currency"]),
    };
  }) : [];
  const lender = message.kind === "submission" ? message.invoice.lender : message.kind === "registry" ? message.lender : undefined;
  return { kind: message.kind, matches, lender, sources: distinctSources([...message.sources, ...matches.flatMap(({ sources }) => sources)]) };
}
