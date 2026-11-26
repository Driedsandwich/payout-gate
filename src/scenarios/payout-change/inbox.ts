import type { Arrival, ScenarioData } from "../../core/types.js";
import { rowSources } from "./rules.js";

const accountPattern = /\bACCT-\d{4}\b/gi;

export function readRequest(arrival: Arrival) {
  const accounts = [...arrival.body.matchAll(accountPattern)];
  const destination = arrival.body.match(/\b(?:to|use|as)\s+(?:account\s+)?(ACCT-\d{4})\b/i)?.[1];
  const requestedAccount = (destination ?? accounts.at(-1)?.[0])?.toUpperCase();
  const relevant = /payout|bank|account|destination/i.test(arrival.body);
  const change = /chang|updat|switch|replac|redirect|\buse\b|\bset\b/i.test(arrival.body);
  return {
    actionable: Boolean(requestedAccount && relevant && change),
    requestedAccount,
    sources: [
      ...arrival.sources,
      ...(requestedAccount ? [{
        source: arrival.sources[0]?.source ?? `data/arrivals.jsonl#${arrival.id}`,
        field: "requestedAccount",
        value: requestedAccount,
      }] : []),
    ],
  };
}

export function findCreator(data: ScenarioData, text: string, subjectId?: string) {
  const creators = data.tables.creators ?? [];
  const lower = text.toLowerCase();
  const explicitIds = new Set(text.toUpperCase().match(/\bCR-\d+\b/g) ?? []);
  const explicit = creators.filter(({ id }) => explicitIds.has(id));
  const contacts = creators.filter(({ contact_email }) =>
    typeof contact_email === "string" && contact_email && lower.includes(contact_email.toLowerCase()));
  const words = new Set(lower.match(/[\w.-]+/g) ?? []);
  const handles = creators.filter(({ handle }) => {
    if (typeof handle !== "string" || !handle) return false;
    const name = handle.toLowerCase().replace(/^@/, "");
    return words.has(name) || lower.includes(`@${name}`);
  });
  const candidates = explicit.length ? explicit : contacts.length ? contacts
    : subjectId ? creators.filter(({ id }) => id === subjectId) : handles;
  const creator = candidates.length === 1 ? candidates[0] : undefined;
  return creator ? { creatorId: creator.id, sources: rowSources("creators", creator, ["id", "handle"]) } : {};
}
