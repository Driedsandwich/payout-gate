import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generate, SCALES } from "../src/scenarios/payout-change/generate.js";

const accountPattern = /^ACCT-\d{4,5}$/;
const batchStart = Date.parse("2026-11-27T12:00:00Z");
const dayMs = 86_400_000;

describe("generate payout-change", () => {
  it("produces byte-identical data for the same seed and varies with the seed", () => {
    const first = generate(SCALES.demo);
    expect(JSON.stringify(generate({ ...SCALES.demo }))).toBe(JSON.stringify(first));
    const other = generate({ ...SCALES.demo, seed: SCALES.demo.seed + 1 });
    expect(JSON.stringify(other.items)).not.toBe(JSON.stringify(first.items));
    expect(JSON.stringify(other.labels)).not.toBe(JSON.stringify(first.labels));
  });

  it.each([
    { name: "demo", scale: SCALES.demo, hardNegativesPerKind: 4 },
    { name: "full", scale: SCALES.full, hardNegativesPerKind: 20 },
  ])("preserves the $name counts, references, and frozen bytes", ({ name, scale, hardNegativesPerKind }) => {
    const data = generate(scale);
    expect(data.scenarioId).toBe("payout-change");
    expect(data.scale).toEqual(scale);
    expect(data.items).toHaveLength(scale.items);
    expect(data.arrivals).toHaveLength(scale.arrivals);
    expect(data.chunks).toHaveLength(Math.ceil(scale.items / 50));
    expect(Object.keys(data.tables).sort()).toEqual(["change_log", "creators", "history", "master"]);
    expect(data.tables.creators).toHaveLength(scale.items);
    expect(data.tables.master).toHaveLength(scale.items);
    expect(data.tables.history).toHaveLength(scale.items);
    expect(data.tables.change_log).toHaveLength(scale.planted / 2 + hardNegativesPerKind);

    expect(data.chunks.flatMap((chunk) => chunk.itemIds)).toEqual(data.items.map((item) => item.id));
    for (const [index, chunk] of data.chunks.entries()) {
      expect(chunk.id).toBe(`CH-${String(index + 1).padStart(2, "0")}`);
      expect(chunk.tick).toBe(index + 1);
      expect(chunk.index).toBe(chunk.tick);
      expect(chunk.itemIds).toHaveLength(50);
    }
    const rowsBySource = new Set(
      Object.entries(data.tables).flatMap(([table, rows]) => rows.map((row) => `data/${table}.csv#${row.id}`)),
    );
    for (const [index, item] of data.items.entries()) {
      expect(item.id).toBe(`PO-${String(index + 1).padStart(5, "0")}`);
      expect(item.batchIndex).toBe(index);
      expect(item.chunkId).toBe(data.chunks[Math.floor(index / 50)].id);
      expect(item.status).toBe("queued");
      expect(["EUR", "USD"]).toContain(item.currency);
      expect(Number.isSafeInteger(item.amountCents) && item.amountCents > 0).toBe(true);
      expect(item.destination).toMatch(accountPattern);
      expect(item.sources.length).toBeGreaterThan(0);
      for (const { source } of item.sources) expect(rowsBySource.has(source)).toBe(true);
    }
    for (const row of data.tables.creators) {
      expect(row.contact_email).toMatch(/^[^@\s]+@[^@\s]+\.test$/);
      expect(row.country).toMatch(/^[A-Z]{2}$/);
    }
    for (const row of data.tables.master) expect(row.account_ref).toMatch(accountPattern);
    for (const row of data.tables.change_log) {
      expect(row.old_account_ref).toMatch(accountPattern);
      expect(row.new_account_ref).toMatch(accountPattern);
    }
    const lastTick = data.chunks[data.chunks.length - 1].tick;
    let previousTick = 0;
    for (const arrival of data.arrivals) {
      expect(arrival.atTick).toBeGreaterThanOrEqual(previousTick);
      expect(arrival.atTick).toBeLessThan(lastTick);
      previousTick = arrival.atTick;
      const emails = [...arrival.body.matchAll(/[^\s]+@[^\s]+/g)].map(([email]) => email);
      expect(emails.length).toBeGreaterThan(0);
      for (const email of emails) expect(email).toMatch(/^[^@\s]+@[^@\s]+\.test$/);
      for (const [account] of arrival.body.matchAll(/ACCT-[\w-]+/g)) expect(account).toMatch(accountPattern);
    }

    const frozen = readFileSync(new URL(`../data/payout-change/${name}.json`, import.meta.url), "utf8");
    expect(frozen).toBe(`${JSON.stringify(data, null, 2)}\n`);
  });

  it.each([
    { name: "demo", scale: SCALES.demo, hardNegativesPerKind: 4 },
    { name: "full", scale: SCALES.full, hardNegativesPerKind: 20 },
  ])("plants takeovers and hard negatives with matching $name evidence", ({ scale, hardNegativesPerKind }) => {
    const data = generate(scale);
    const items = new Map(data.items.map((item) => [item.id, item]));
    const chunks = new Map(data.chunks.map((chunk) => [chunk.id, chunk]));
    const arrivals = new Map(data.arrivals.map((arrival) => [arrival.id, arrival]));
    const creators = new Map(data.tables.creators.map((row) => [row.id, row]));
    const master = new Map(data.tables.master.map((row) => [row.id, row]));
    const changes = new Map(data.tables.change_log.map((row) => [row.creator_id, row]));
    const history = new Map(data.tables.history.map((row) => [row.id, row]));
    const recordedAccounts = new Set([
      ...data.tables.master.map((row) => row.account_ref),
      ...data.tables.change_log.flatMap((row) => [row.old_account_ref, row.new_account_ref]),
    ]);
    const positives = data.labels.filter((label) => label.shouldHold);
    const negatives = data.labels.filter((label) => !label.shouldHold);
    expect(new Set(data.labels.map((label) => label.itemId)).size).toBe(data.labels.length);
    expect(positives).toHaveLength(scale.planted);
    expect(negatives).toHaveLength(hardNegativesPerKind * 3);
    expect(positives.filter((label) => label.arrivalId)).toHaveLength(scale.planted / 2);

    const requestWording = new Set<string>();
    for (const label of positives) {
      const item = items.get(label.itemId)!;
      const verifiedAccount = master.get(item.subjectId)!.account_ref;
      if (label.arrivalId) {
        const arrival = arrivals.get(label.arrivalId)!;
        const tick = chunks.get(item.chunkId)!.tick;
        const contact = creators.get(item.subjectId)!.contact_email;
        const sender = arrival.body.match(/^From: (.+)$/m)![1];
        const replyTo = arrival.body.match(/^Reply-To: (.+)$/m)?.[1];
        const [account] = arrival.body.match(/ACCT-\d+/)!;
        expect(arrival.subjectId).toBe(item.subjectId);
        expect(["email", "support_ticket"]).toContain(arrival.channel);
        expect(arrival.atTick).toBeGreaterThanOrEqual(tick - 0.9);
        expect(arrival.atTick).toBeLessThanOrEqual(tick - 0.4);
        expect(recordedAccounts.has(account)).toBe(false);
        expect(sender !== contact || (replyTo !== undefined && replyTo !== contact)).toBe(true);
        expect(item.destination).toBe(verifiedAccount);
        requestWording.add(arrival.body.split("\n\n")[1].replace(account, "ACCOUNT"));
      } else {
        const change = changes.get(item.subjectId)!;
        expect(change).toMatchObject({
          old_account_ref: verifiedAccount,
          new_account_ref: item.destination,
          applied: "yes",
          device: "new",
        });
        expect(change.channel).not.toBe("in_app_2fa");
        const ageMs = batchStart - Date.parse(String(change.at));
        expect(ageMs).toBeGreaterThan(0);
        expect(ageMs).toBeLessThanOrEqual(60 * 60_000);
        expect(data.arrivals.some((arrival) => arrival.subjectId === item.subjectId)).toBe(false);
      }
    }
    expect(requestWording.size).toBeGreaterThan(1);

    let notices = 0;
    let largePayouts = 0;
    let contactMessages = 0;
    for (const label of negatives) {
      const item = items.get(label.itemId)!;
      const change = changes.get(item.subjectId);
      if (change) {
        const arrival = arrivals.get(label.arrivalId!)!;
        expect(change).toMatchObject({ channel: "in_app_2fa", applied: "yes", new_account_ref: item.destination });
        expect(batchStart - Date.parse(String(change.at))).toBeGreaterThanOrEqual(3 * dayMs);
        expect(arrival.subjectId).toBe(item.subjectId);
        expect(arrival.body).toContain(`your payout account was updated to ${item.destination}`);
        notices++;
      } else if (label.arrivalId) {
        const arrival = arrivals.get(label.arrivalId)!;
        expect(arrival.body).toContain(`From: ${creators.get(item.subjectId)!.contact_email}\n`);
        expect(arrival.body).not.toMatch(/Reply-To:|ACCT-|change|reroute|switch/i);
        expect(arrival.subjectId).toBe(item.subjectId);
        contactMessages++;
      } else {
        const median = Number(history.get(item.subjectId)!.median_payout_cents_90d);
        expect(item.amountCents).toBeGreaterThan(250_000);
        expect(Math.abs(item.amountCents - median) / median).toBeLessThan(0.051);
        largePayouts++;
      }
    }
    expect([notices, largePayouts, contactMessages]).toEqual(Array(3).fill(hardNegativesPerKind));
    const linkedArrivals = new Set(data.labels.map((label) => label.arrivalId));
    const noise = data.arrivals.filter((arrival) => !linkedArrivals.has(arrival.id)).map((arrival) => arrival.body).join("\n");
    expect(noise).toMatch(/tax form/);
    expect(noise).toMatch(/invoice/);
    expect(noise).toMatch(/Thanks/);
  });

  it("handles a partial last chunk and a scale without arrivals", () => {
    const data = generate({ items: 51, arrivals: 0, planted: 3, seed: 5 });
    expect(data.chunks.map((chunk) => chunk.itemIds.length)).toEqual([50, 1]);
    expect(data.arrivals).toHaveLength(0);
    expect(data.labels.filter((label) => label.shouldHold)).toHaveLength(3);
    expect(data.tables.change_log).toHaveLength(3);
  });
});
