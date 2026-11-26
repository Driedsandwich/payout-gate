import type { EventDraft } from "./eventlog.js";
import type { SourceRef } from "./types.js";

const identifier = /\b[A-Z][A-Z_]*-\d+\b/g;
const numeric = /[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:e[+-]?\d+)?|[+-]?\.\d+(?:e[+-]?\d+)?/gi;

const normalize = (value: string | number) => Number(String(value).replaceAll(",", ""));

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
  const cited = new Set(sources.flatMap(({ value }) => {
    if (typeof value === "number" || (typeof value === "string" && value.trim() &&
        (value.trim().match(numeric)?.[0] === value.trim()))) {
      return [normalize(value)];
    }
    return [];
  }));
  const sourcedIds = new Set(sources.flatMap(({ source, value }) => [source.split("#")[1], value]));
  // A sourced row or account ID can be cited verbatim without treating its suffix as a quantity.
  const prose = text.replace(identifier, (id) => sourcedIds.has(id) ? " " : id);
  const numbers = [...new Set(prose.match(numeric) ?? [])]
    .filter((number) => !cited.has(normalize(number)));
  if (!numbers.length) return true;
  const { agent, loopId } = actor;
  emit({ agent, loopId, kind: "citation.reject", data: { agent, text, numbers } });
  return false;
}
