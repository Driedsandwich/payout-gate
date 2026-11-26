import { RuntimeState } from "@mozaik-ai/core";
import type { EventDraft } from "./eventlog.js";
import type { ScenarioRoles } from "./roles.js";
import type { Arrival, Hold, ItemStatus, LedgerApi, LedgerSnapshot, SourceRef, Verdict, WorkItem } from "./types.js";

export interface RequestLink {
  arrivalId: string;
  creatorId: string;
  requestedAccount: string;
  channel: string;
  sources: SourceRef[];
}

type Triage = RequestLink | { arrivalId: string; reason: string; sources: SourceRef[] };
type LedgerHold = Hold & { notice?: string };

export type LedgerSignal =
  | { kind: "evidence"; itemId: string; revision: number }
  | { kind: "hold"; itemId: string };

export class Ledger extends RuntimeState implements LedgerApi {
  private readonly items = new Map<string, WorkItem>();
  private readonly itemsBySubject = new Map<string, string[]>();
  private readonly arrivals = new Map<string, { row: Arrival; atMs: number }>();
  private readonly links = new Map<string, { row: Triage; atMs: number }>();
  private readonly verdicts = new Map<string, Array<{ row: Verdict; revision: number }>>();
  private readonly holds = new Map<string, LedgerHold>();
  private readonly scans = new Map<string, number>();
  private readonly evidence = new Map<string, number[]>();
  private readonly releaseLists = new Map<string, Set<string>>();
  private readonly listeners = new Set<(signal?: LedgerSignal) => void>();

  constructor(
    items: WorkItem[],
    private readonly nowMs: () => number,
    private readonly emit: (event: EventDraft) => void,
    private readonly roles?: Pick<ScenarioRoles, "dispatcher" | "explainer" | "intake">,
  ) {
    super();
    for (const raw of items) {
      const item = structuredClone(raw);
      this.items.set(item.id, item);
      const subjectItems = this.itemsBySubject.get(item.subjectId) ?? [];
      subjectItems.push(item.id);
      this.itemsBySubject.set(item.subjectId, subjectItems);
    }
  }

  snapshot(): LedgerSnapshot {
    return structuredClone({
      items: [...this.items.values()],
      verdicts: [...this.verdicts.values()].flatMap((entries) => entries.map(({ row }) => row)),
      holds: [...this.holds.values()],
      arrivals: [...this.arrivals.values()].map(({ row }) => row),
    });
  }

  item(id: string): WorkItem {
    const item = this.items.get(id);
    if (!item) throw new Error(`Unknown item ${id}`);
    return structuredClone(item);
  }

  setStatus(itemId: string, status: ItemStatus, by: string | undefined): void {
    const after = this.item(itemId);
    if (after.status === status) return;
    if (after.status === "held" || after.status === "released") {
      throw new Error(`Item ${itemId} is already ${after.status}`);
    }
    after.status = status;
    this.items.set(itemId, after);
    this.write("items", itemId, after, by, after.sources);
  }

  addVerdict(v: Verdict, revision = this.revisionAt(v.itemId)): void {
    this.item(v.itemId);
    const row = structuredClone(v);
    const entries = this.verdicts.get(row.itemId) ?? [];
    entries.push({ row, revision });
    this.verdicts.set(row.itemId, entries);
    this.write("verdicts", `${row.itemId}:${row.by}`, row, row.by, row.sources);
    this.notify();
  }

  verdictsFor(itemId: string): Verdict[] {
    return structuredClone((this.verdicts.get(itemId) ?? []).map(({ row }) => row));
  }

  verdictsAt(itemId: string, cutoff: number): Verdict[] {
    const revision = this.revisionAt(itemId, cutoff);
    const latest = new Map<string, Verdict>();
    for (const entry of this.verdicts.get(itemId) ?? []) {
      if (entry.revision === revision && entry.row.atMs <= cutoff) latest.set(entry.row.by, entry.row);
    }
    return [...latest.values()];
  }

  addHold(hold: LedgerHold): void {
    if (this.holds.has(hold.itemId)) return;
    const row = structuredClone(hold);
    this.holds.set(row.itemId, row);
    this.setStatus(row.itemId, "held", this.roles?.dispatcher);
    this.write("holds", row.itemId, row, this.roles?.dispatcher, row.sources);
    // The gate supplies a complete notice for a timeout hold.
    this.notify(row.notice === undefined ? { kind: "hold", itemId: row.itemId } : undefined);
  }

  holdFor(itemId: string): Hold | undefined {
    return structuredClone(this.holds.get(itemId));
  }

  addNotice(itemId: string, text: string): void {
    const hold = this.holds.get(itemId);
    if (!hold) throw new Error(`No hold for ${itemId}`);
    const after = { ...hold, notice: text };
    this.holds.set(itemId, after);
    this.write("holds", itemId, after, this.roles?.explainer, after.sources);
  }

  addArrival(row: Arrival, atMs: number): void {
    if (this.arrivals.has(row.id)) return;
    this.arrivals.set(row.id, { row: structuredClone(row), atMs });
    this.emit({ kind: "arrival", data: { arrivalId: row.id, channel: row.channel }, sources: row.sources });
    this.notify();
  }

  arrival(id: string): Arrival {
    const entry = this.arrivals.get(id);
    if (!entry) throw new Error(`Arrival ${id} has not been delivered`);
    return structuredClone(entry.row);
  }

  triage(row: Triage): void {
    this.arrival(row.arrivalId);
    if (this.links.has(row.arrivalId)) return;
    const atMs = this.nowMs();
    this.links.set(row.arrivalId, { row: structuredClone(row), atMs });
    this.write("links", row.arrivalId, row, this.roles?.intake, row.sources);
    if ("creatorId" in row) {
      for (const id of this.itemsBySubject.get(row.creatorId) ?? []) this.flag(id, atMs);
    }
    this.notify();
  }

  requestsFor(creatorId: string): RequestLink[] {
    return structuredClone([...this.links.values()].flatMap(({ row }) =>
      "creatorId" in row && row.creatorId === creatorId ? [row] : []));
  }

  untriagedAt(cutoff: number): Arrival[] {
    return [...this.arrivals.values()].flatMap(({ row, atMs }) => {
      const triagedAt = this.links.get(row.id)?.atMs ?? Infinity;
      return atMs <= cutoff && triagedAt > cutoff ? [row] : [];
    });
  }

  scan(chunkId: string, flaggedIds: string[]): void {
    if (this.scans.has(chunkId)) return;
    const atMs = this.nowMs();
    this.scans.set(chunkId, atMs);
    for (const id of flaggedIds) {
      // A link already starts both checks against these same reference tables.
      if (!this.evidence.has(id)) this.flag(id, atMs);
    }
    this.notify();
  }

  scannedAt(chunkId: string, cutoff: number): boolean {
    return (this.scans.get(chunkId) ?? Infinity) <= cutoff;
  }

  revisionAt(itemId: string, cutoff = this.nowMs()): number {
    return (this.evidence.get(itemId) ?? []).filter((atMs) => atMs <= cutoff).length;
  }

  authorizeRelease(chunkId: string, itemIds: string[]): void {
    this.releaseLists.set(chunkId, new Set(itemIds));
  }

  releaseAuthorized(chunkId: string, itemIds: string[]): string[] {
    const approved = this.releaseLists.get(chunkId);
    if (!approved || itemIds.some((id) => !approved.has(id))) throw new Error("Release requires gate approval");
    const released = itemIds.filter((id) => this.items.get(id)?.status !== "released");
    for (const id of released) this.setStatus(id, "released", this.roles?.dispatcher);
    return released;
  }

  subscribe(listener: (signal?: LedgerSignal) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private flag(itemId: string, atMs: number): void {
    const times = this.evidence.get(itemId) ?? [];
    times.push(atMs);
    this.evidence.set(itemId, times);
    this.notify({ kind: "evidence", itemId, revision: times.length });
  }

  private notify(signal?: LedgerSignal): void {
    for (const listener of this.listeners) listener(signal);
  }

  private write(table: string, rowId: string, after: unknown, agent: string | undefined, sources: SourceRef[]): void {
    this.emit({
      kind: "ledger.write", agent, itemIds: table === "items" ? [rowId] : undefined,
      data: { table, rowId, after }, sources,
    });
  }
}
