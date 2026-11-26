import type { SourceRef } from "./types.js";

const wholeUnits = new Intl.NumberFormat("en-US");

function displayField(field: string | undefined): string | undefined {
  const stem = field?.replace(/Cents$|_cents(?=_|$)/, "");
  if (stem !== field) return `${stem}_display`;
}

export function withAmountDisplay(ref: SourceRef, currency?: string): SourceRef[] {
  const field = displayField(ref.field);
  if (!field || typeof ref.value !== "number" || !Number.isSafeInteger(ref.value)) return [ref];
  const cents = Math.abs(ref.value);
  const sign = ref.value < 0 ? "-" : "";
  const amount = `${sign}${wholeUnits.format(Math.trunc(cents / 100))}.${String(cents % 100).padStart(2, "0")}`;
  return [ref, { source: ref.source, field, value: currency ? `${currency} ${amount}` : amount }];
}

export function citedAmountDisplays(sources: SourceRef[], toolSources: SourceRef[]): SourceRef[] {
  return sources.flatMap((ref) => {
    const field = displayField(ref.field);
    if (!field) return [];
    return toolSources.filter((known) => known.source === ref.source && known.field === field);
  });
}
