import type { EventDraft } from "./eventlog.js";
import type { SourceRef } from "./types.js";

const date = /\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:?\d{2})?)?/;
const identifier = /\b(?!(?:EUR|USD)-)[A-Z][A-Z_]*-\d+\b(?![.,]\d)/;
const currency = String.raw`EUR|USD|\p{Sc}`;
const space = String.raw`[\t\p{Zs}]*`;
const magnitude = /(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?/;
const signedAmount = String.raw`(?:[+-]?(?:\p{Sc}${space})?|\p{Sc}${space}[+-]?)${magnitude.source}`;
const units = `hours?|hrs?|h|days?|d|x|×|%|percent|times|dollars?|euros?|${currency}`;
const scaleExponents: Record<string, number> = { k: 3, m: 6, bn: 9 };
const suffix = `(?:${space}(?:${Object.keys(scaleExponents).join("|")}|${units})|st|nd|rd|th)`;
const word = String.raw`[\p{L}\p{M}\p{N}_@]`;
// Block both whole and partial matches inside words and dotted or hyphenated identifiers.
const start = String.raw`(?<!${word}|${word}[.-]|\d,)`;
const end = String.raw`(?!${word}|\.${word}|,\d)`;

const small = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split(" ");
const tens = "twenty thirty forty fifty sixty seventy eighty ninety".split(" ");
const ones = small.slice(1, 10).join("|");
const gap = String.raw`\s+`;
const underHundred = `(?:${small.join("|")}|(?:${tens.join("|")})(?:(?:${gap}|-)(?:${ones}))?)`;
const remainder = `(?:${gap}(?:and${gap})?)`;
const hundreds = `(?:(?:a|${ones})${gap}hundred(?:${remainder}${underHundred})?|${underHundred})`;
const wordScales: Record<string, number> = { thousand: 1e3, million: 1e6, billion: 1e9 };
const cardinal = Object.keys(wordScales).reduce(
  (lower, scale) => `(?:(?:a|${hundreds})${gap}${scale}(?:${remainder}${lower})?|${lower})`,
  hundreds,
);
const numberWords = new Map<string, number>([
  ["a", 1],
  ...small.map((name, value): [string, number] => [name, value]),
  ...tens.map((name, index): [string, number] => [name, (index + 2) * 10]),
]);

const tokens = new RegExp([
  `(?<id>${identifier.source})`,
  `${start}(?:(?<date>${date.source})|(?:(?:EUR|USD)${space})?(?<digits>${signedAmount})(?<suffix>${suffix})?|(?<cardinal>${cardinal}))${end}`,
].join("|"), "giu");
const listMarker = /^[ \t]*(?:(?:>|[-*+])[ \t]+)*\d+[.)](?=[ \t]+\S)|(?<=[:;])[ \t]*\d+\)(?=[ \t]+\S)/gm;
const followingUnit = new RegExp(`^${space}(?:${units})${end}`, "iu");
const followingWord = /^(?:\s+|-)([\p{L}\p{M}]+)(?![\p{L}\p{M}\p{N}_'’])/u;
// A lone cardinal needs a following noun or unit. Filter common words that instead follow a pronoun or subject.
const nonQuantityFollowers = new Set([
  "a", "an", "the", "another", "and", "or", "but", "as", "if",
  "at", "by", "for", "from", "in", "into", "of", "on", "onto", "off", "out", "over", "to", "through", "under", "with", "without",
  "that", "which", "who", "whom", "whose", "where", "when", "whether", "i", "you", "we", "they", "he", "she", "it",
  "is", "am", "are", "was", "were", "be", "been", "being", "has", "have", "had", "does", "do", "did",
  "can", "could", "may", "might", "must", "shall", "should", "will", "would", "also", "already", "still", "then",
]);

function cardinalValue(value: string): number {
  let total = 0;
  let group = 0;
  for (const part of value.toLowerCase().split(/[\s-]+/u)) {
    const scale = wordScales[part];
    if (part === "hundred") {
      group *= 100;
    } else if (scale) {
      total += group * scale;
      group = 0;
    } else {
      group += numberWords.get(part) ?? 0;
    }
  }
  return total + group;
}

function factKey(match: RegExpMatchArray): number | string | undefined {
  const { date: value, digits, suffix, cardinal } = match.groups!;
  if (cardinal) return cardinalValue(cardinal);
  if (digits) {
    const raw = digits.replace(/[,\s\p{Sc}]/gu, "");
    const shift = scaleExponents[suffix?.trim().toLowerCase() ?? ""];
    const [significand, exponent = "0"] = raw.split(/[eE]/);
    // Apply the scale as a decimal exponent to avoid rounding before comparing values.
    const number = Number(shift ? `${significand}e${Number(exponent) + shift}` : raw);
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

function collectFacts(value: unknown, cited: Set<number | string>): void {
  if (typeof value === "number" && Number.isFinite(value)) cited.add(value);
  if (typeof value === "string") {
    const trimmed = value.trim();
    const [match] = trimmed.matchAll(tokens);
    if (match?.index !== 0 || match.groups?.id) return;
    const rest = trimmed.slice(match[0].length);
    if (rest && !(match.groups?.cardinal && followingUnit.exec(rest)?.[0] === rest)) return;
    const key = factKey(match);
    if (key !== undefined) cited.add(key);
  } else if (typeof value === "object" && value !== null) {
    for (const entry of Object.values(value)) collectFacts(entry, cited);
  }
}

export function checkCitations(
  text: string,
  sources: SourceRef[],
  actor: { agent: string; loopId?: string },
  emit: (event: EventDraft) => void,
  toolOutputs: readonly string[] = [],
): boolean {
  const cited = new Set<number | string>();
  for (const { value } of sources) collectFacts(value, cited);
  for (const output of toolOutputs) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(output);
    } catch {
      // Core leaves string results unquoted.
      parsed = output;
    }
    collectFacts(parsed, cited);
  }

  const unsupported = new Set<string>();
  const notice = text.replace(listMarker, " ");
  for (const match of notice.matchAll(tokens)) {
    const [token] = match;
    const { id, cardinal } = match.groups!;
    if (id) continue;
    if (cardinal && !/[\s-]/u.test(cardinal)) {
      const after = notice.slice(match.index! + token.length);
      const follower = followingWord.exec(after)?.[1].toLowerCase();
      if (!followingUnit.test(after) && (!follower || nonQuantityFollowers.has(follower))) continue;
    }
    const key = factKey(match);
    if (key === undefined || !cited.has(key)) unsupported.add(token);
  }
  const numbers = [...unsupported];
  if (!numbers.length) return true;
  const { agent, loopId } = actor;
  emit({ agent, loopId, kind: "citation.reject", data: { agent, text, numbers } });
  return false;
}
