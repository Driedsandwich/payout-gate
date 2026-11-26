import type { EventDraft } from "./eventlog.js";
import type { SourceRef } from "./types.js";

const date = /\b\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:?\d{2})?)?\b/;
const identifier = /\b(?!(?:EUR|USD)-)[A-Z][A-Z_]*-\d+\b(?![.,]\d)/;
const numeric = /(?:[+-]?\p{Sc}?|\p{Sc}[+-]?)(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?/u;
const tokens = new RegExp(`(?<date>${date.source})|(?<id>${identifier.source})|${numeric.source}`, "gu");
const listMarker = /^[ \t]*(?:(?:>|[-*+])[ \t]+)*\d+[.)](?=[ \t]+\S)|(?<=[:;])[ \t]*\d+\)(?=[ \t]+\S)/gm;

function factKey(value: string, isDate: boolean): number | string | undefined {
  if (!isDate) {
    const number = Number(value.replace(/[,\p{Sc}]/gu, ""));
    return Number.isFinite(number) ? number : undefined;
  }

  const day = value.slice(0, 10);
  const midnight = Date.parse(day);
  if (!Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== day) return;
  const timestamp = value.toUpperCase().replace(" ", "T");
  // Tool timestamps use UTC. Interpret a notice with an omitted offset in UTC as well.
  const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/.test(timestamp.slice(10));
  const instant = value.length === 10 ? midnight : Date.parse(hasOffset ? timestamp : `${timestamp}Z`);
  if (!Number.isFinite(instant)) return;
  const fraction = /\.(\d+)/.exec(timestamp)?.[1].replace(/0+$/, "") ?? "";
  return `date:${Math.floor(instant / 1000)}:${fraction}`;
}

export function outputSources(output: unknown): SourceRef[] {
  if (typeof output !== "object" || output === null) return [];
  if (Array.isArray(output)) return output.flatMap(outputSources);
  const row = output as Partial<SourceRef>;
  if (typeof row.source === "string" && (row.field === undefined || typeof row.field === "string") &&
      (row.value === undefined || typeof row.value === "string" || typeof row.value === "number")) {
    return [row as SourceRef];
  }
  return Object.values(output).flatMap(outputSources);
}

export function checkCitations(
  text: string,
  sources: SourceRef[],
  actor: { agent: string; loopId?: string },
  emit: (event: EventDraft) => void,
): boolean {
  const cited = new Set<number | string>();
  for (const { value } of sources) {
    if (typeof value === "number" && Number.isFinite(value)) cited.add(value);
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    const [match] = trimmed.matchAll(tokens);
    if (!match || match[0] !== trimmed || match.groups?.id) continue;
    const key = factKey(trimmed, Boolean(match.groups?.date));
    if (key !== undefined) cited.add(key);
  }

  const unsupported = new Set<string>();
  for (const match of text.replace(listMarker, " ").matchAll(tokens)) {
    if (match.groups?.id) continue;
    const key = factKey(match[0], Boolean(match.groups?.date));
    if (key === undefined || !cited.has(key)) unsupported.add(match[0]);
  }
  const numbers = [...unsupported];
  if (!numbers.length) return true;
  const { agent, loopId } = actor;
  emit({ agent, loopId, kind: "citation.reject", data: { agent, text, numbers } });
  return false;
}
