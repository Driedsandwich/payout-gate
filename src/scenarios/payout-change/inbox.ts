import type { Arrival, ScenarioData } from "../../core/types.js";
import { rowSources } from "./rules.js";

// Frozen synthetic records also contain five-digit account references.
const accountPattern = /\bACCT-\d{4,5}\b/gi;
const emailPattern = /[a-z\d._%+-]+@(?:[a-z\d-]+\.)+[a-z\d-]+/gi;

export function readRequest(arrival: Arrival) {
  const accounts = [...arrival.body.matchAll(accountPattern)];
  const destination = arrival.body.match(/\b(?:to|use|as)\s+(?:account\s+)?(ACCT-\d{4,5})\b/i)?.[1];
  const requestedAccount = (destination ?? accounts.at(-1)?.[0])?.toUpperCase();
  const relevant = /\b(?:payout|payment|transfer|bank|account|destination)\b/i.test(arrival.body);
  const change = /\b(?:chang\w*|updat\w*|switch\w*|replac\w*|redirect\w*|rerout\w*|use|set|send)\b/i.test(arrival.body);
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

export function findCreator(data: ScenarioData, text: string, message = text) {
  const creators = data.tables.creators ?? [];
  const lower = text.toLowerCase();
  const emails = new Set(lower.match(emailPattern) ?? []);
  const words = new Set(lower.replace(emailPattern, " ").match(/[\p{L}\p{N}_]+(?:[.-]+[\p{L}\p{N}_]+)*/gu) ?? []);
  const explicit = creators.filter(({ id }) => words.has(id.toLowerCase()));
  const contacts = creators.filter(({ contact_email }) =>
    typeof contact_email === "string" && emails.has(contact_email.toLowerCase()));
  const handles = creators.filter(({ handle }) =>
    typeof handle === "string" && words.has(handle.toLowerCase().replace(/^@/, "")));
  const candidates = explicit.length ? explicit : contacts.length ? contacts : handles;
  const creator = candidates.length === 1 ? candidates[0] : undefined;
  if (!creator) return {};

  const from = message.match(/^[ \t]*from(?::[ \t]*|[ \t]+)([^\r\n]+)/im)?.[1];
  const senderDomain = from?.toLowerCase().match(emailPattern)?.[0]?.split("@")[1];
  const contactDomain = String(creator.contact_email ?? "").toLowerCase().split("@")[1];
  const signals = senderDomain && contactDomain && senderDomain !== contactDomain ? [{
    rule: "sender_domain_mismatch", senderDomain, contactDomain,
    sources: rowSources("creators", creator, ["contact_email"]),
  }] : [];
  return { creatorId: creator.id, signals, sources: rowSources("creators", creator, ["id", "handle", "contact_email"]) };
}
