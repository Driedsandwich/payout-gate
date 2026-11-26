import type { RequestLink } from "../../core/ledger.js";
import type { ScenarioData, SourceRef, WorkItem } from "../../core/types.js";

type Row = ScenarioData["tables"][string][number];
// The shared scenario type has no wall-clock batch timestamp.
type DatedScenario = ScenarioData & { batchAt?: string };
export const DEFAULT_BATCH_AT = "2026-11-27T12:00:00.000Z";

export interface RuleHit {
  rule: string;
  reason: string;
  sources: SourceRef[];
}

export function rowSources(table: string, row: Row, fields = Object.keys(row)): SourceRef[] {
  return fields.flatMap((field) => row[field] === undefined ? [] : [
    { source: `data/${table}.csv#${row.id}`, field, value: row[field] },
  ]);
}

export function itemSource(item: WorkItem, field: keyof WorkItem, value: string | number): SourceRef {
  return item.sources.find((source) => source.field === field && source.value === value)
    ?? { source: item.sources[0]?.source ?? `data/batch.csv#${item.id}`, field, value };
}

export function distinctSources(sources: SourceRef[]): SourceRef[] {
  return [...new Map(sources.map((source) => [JSON.stringify(source), source])).values()];
}

export function inspectRecords(data: DatedScenario, item: WorkItem, requests: RequestLink[]) {
  const master = data.tables.master?.find(({ id }) => id === item.subjectId);
  const changes = (data.tables.change_log ?? []).filter((row) => row.creator_id === item.subjectId);
  const batchAt = Date.parse(data.batchAt ?? DEFAULT_BATCH_AT);
  const recent = changes.filter(({ at }) => {
    const age = batchAt - Date.parse(String(at));
    return age >= 0 && age <= 72 * 60 * 60 * 1_000;
  });
  const masterSources = master ? rowSources("master", master) : [];
  const changeSources = changes.flatMap((row) => rowSources("change_log", row));
  const requestSources = requests.flatMap(({ sources }) => sources);
  const masterHits: RuleHit[] = [];
  if (master && item.destination !== master.account_ref) {
    masterHits.push({
      rule: "destination_mismatch",
      reason: "The batch destination differs from the verified master account.",
      sources: [itemSource(item, "destination", item.destination), ...rowSources("master", master, ["account_ref"])],
    });
  }
  const onFile = new Set([master?.account_ref, ...changes.flatMap((row) => [row.old_account_ref, row.new_account_ref])]);
  for (const request of requests) {
    if (!onFile.has(request.requestedAccount)) {
      masterHits.push({
        rule: "request_off_file",
        reason: "A linked request names an account absent from the creator’s source records.",
        sources: [...request.sources, ...masterSources, ...changeSources],
      });
    }
  }
  const changeHits: RuleHit[] = recent
    .filter((row) => row.device === "new" || row.channel !== "in_app_2fa")
    .map((row) => ({
      rule: "unverified_recent_change",
      reason: "A recent account change came from a new device or lacked in-app verification.",
      sources: rowSources("change_log", row, ["at", "device", "channel", "new_account_ref"]),
    }));
  return {
    master, changes, recent, masterHits, changeHits, masterSources, changeSources, requestSources,
    complete: typeof master?.account_ref === "string" && Number.isFinite(batchAt),
  };
}

export function inspectPolicy(data: ScenarioData, item: WorkItem, requests: RequestLink[]) {
  const records = inspectRecords(data, item, requests);
  const history = data.tables.history?.find(({ id }) => id === item.subjectId);
  const median = history?.median_payout_cents_90d;
  const hits = [...records.masterHits, ...records.changeHits];
  if (history && typeof median === "number" && item.amountCents > 3 * median) {
    hits.push({
      rule: "amount_above_median",
      reason: "The payout exceeds the policy multiple of the creator’s historical median.",
      sources: [itemSource(item, "amountCents", item.amountCents),
        ...rowSources("history", history, ["median_payout_cents_90d"])],
    });
  }
  return {
    hits, recent: records.recent.length > 0,
    complete: records.complete && typeof median === "number" && Number.isFinite(median),
    sources: distinctSources([
      ...item.sources, ...records.masterSources, ...records.changeSources, ...records.requestSources,
      ...(history ? rowSources("history", history) : []),
    ]),
  };
}
