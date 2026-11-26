# Design seams (read this before changing code)

This file fixes the shapes that the core, the scenarios, the evaluator, the replay UI and the MCP server share.
The types live in `src/core/types.ts`. If you need to change a type, say so in your report; do not change it silently.

## Product in one paragraph

A fictional creator marketplace pays thousands of creators in one Black Friday payout batch.
While the batch is running, requests to change a creator's payout account keep arriving (email, support tickets, in-app).
Some are account takeovers. Six agents run at the same time on Mozaik: one releases payouts chunk by chunk,
the others read the inbox, check the source records, audit the batch ahead of release, apply the payout policy and
explain verdict-based holds. A gate (Mozaik `InterceptionHandler`) sits in front of the release tool: clean payouts keep flowing,
a payout whose account is in doubt is held with the rows that prove why. The same agents run one loop at a time
(the sequential baseline) to measure what concurrency changes. All data is synthetic; nothing moves money.

## Scenario A: `payout-change` (main)

Batch: `scale.items` payouts (`PO-00001`…), each to a creator (`CR-0001`…), released in chunks of 50 (`CH-01`…) in `batchIndex` order.
Reference tables (`ScenarioData.tables`):

| table | row id | fields |
|---|---|---|
| `creators` | `CR-0001` | handle, contact_email (fictional domain `example-creators.test`), country, joined_at |
| `master` | `CR-0001` | account_ref (ACCT-0001 style), verified_at, verified_channel (`in_app_2fa`, `support_verified`) |
| `change_log` | `CL-0001` | creator_id, old_account_ref, new_account_ref, channel, device (`known`/`new`), at (ISO), applied (`yes`/`no`) |
| `history` | `CR-0001` | payouts_90d, median_payout_cents_90d |

Release schedule: chunk `CH-k` is due at tick `k` (the bank cut-off for that chunk). The run turns ticks into milliseconds with
`--tick-ms` (defaults: 1500 for scripted runs, 20000 for live runs). The Dispatcher cannot move the schedule: a payout either
leaves on its tick or is held (paid late). This is what makes the comparison fair: both modes face the same clock.

Arrivals (`Arrival[]`, spread over the batch run, `atTick` in release ticks):
- planted takeover requests: email or support ticket asking to change the payout account "before today's payout",
  from a look-alike domain or a reply-to mismatch, to an `ACCT-` not in `master` or `change_log`.
- planted in-batch takeovers: the account in the batch row itself was changed shortly before the batch from a `new` device,
  with no `in_app_2fa` verification (detectable from `change_log` + `master`, no arrival needed).
- legitimate notices: "your payout account was updated" for changes already in `change_log` with `in_app_2fa` → clear.
- noise: tax form questions, invoice questions, thank-you notes → no action.

Labels (`Label[]`) are produced by the generator and used only by `src/eval/`. Agents never see them.

### Agents (each task = one `runLoop` with a fresh `ModelContext`)

| agent | trigger | tools | writes |
|---|---|---|---|
| Dispatcher | start | `release_chunk(chunkId)` (gated) | item status released / held via the gate |
| InboxWatcher | arrival (one loop per arrival, fan-out) | `read_arrival(id)`, `find_creator(text)`, `link_request(arrivalId, creatorId, requestedAccount, channel)` or `mark_no_action(arrivalId, reason)` | links an arrival to items |
| BatchAuditor | chunk (runs ahead of the Dispatcher) | `scan_chunk(chunkId)` → rows whose destination differs from the last verified account or changed recently | verdicts on flagged items |
| RecordChecker | linked request or audit flag | `get_master(creatorId)`, `get_change_log(creatorId)`, `submit_verdict(itemId, value, reason, sources)` | verdicts |
| PolicyAgent | linked request or audit flag | `policy_check(itemId)` → rule hits computed by code (amount vs 90-day median, account age, channel) with sources, `submit_verdict` | verdicts |
| Explainer | verdict-based hold | `get_hold_facts(itemId)`, `write_hold_notice(itemId, text)` | hold notice (citation-checked) |
| OpsReviewer (Human participant) | hold | approves or rejects a hold (scripted in the demo) | hold.resolvedBy |

Packs can declare their dispatcher, intake, auditor, checkers, and explainer in the optional `roles` map on
`ScenarioPackWithRoles`. Packs without the map use their agent triggers and `requiredVerdicts`.

### Gate (the `InterceptionHandler` on `release_chunk`)

Before `release_chunk(CH-k)` runs, the gate emits `gate.wait` and waits (at most until tick `k`) until:
1. BatchAuditor has scanned `CH-k`;
2. every arrival that has arrived so far is triaged (linked or no-action);
3. every item of `CH-k` that is linked or flagged has a verdict from both RecordChecker and PolicyAgent.

Then it rewrites the call: clear items are released, suspicious items are held (`gate.hold` with reasons + sources).
When tick `k` comes and an item is still uncertain, the product policy is `--fail-policy hold` (held, paid late, counted in
`heldByTimeout`). The gate writes a notice listing the pending work at the tick when it holds a payout for review.
`--fail-policy release` exists only to measure what an unchecked release would have paid out.
The wait is per chunk, so the rest of the batch keeps flowing.

### Sequential baseline (`--mode sequential`)

The same agents, tools, prompts and gate, but only one loop runs at a time, in this order per chunk:
InboxWatcher for each arrival received so far → RecordChecker and PolicyAgent for each linked/flagged item → BatchAuditor scan → Dispatcher release.
Arrivals that land while these steps run are only seen at the next chunk. The baseline writes verdict-based explanations
after the release rounds and the final inbox and evidence review. The same release clock and the same fail policy apply,
so a sequential run that cannot keep up shows it as late payouts (`hold`) or paid-out takeovers (`release`). Nothing else is weakened.

## Scenario B: `double-pledge` (second)

A fictional invoice-financing marketplace with three lenders. Sellers submit invoices for funding; the fraud is the same receivable
(or a lightly altered copy: invoice number formatting, rounded amount, shifted date) submitted to two lenders within minutes,
or an invoice already pledged in the synthetic receivables registry. Gated tool: `fund_batch(batchId)`.
Agents: Dispatcher, Intake (fan-out per submission), Fingerprinter (normalises and fingerprints), RegistryChecker, DebtorChecker, Explainer.
Same gate rules, same baseline rule.

## Run log and summary

- `runs/<run-id>/events.jsonl`: one `RunEvent` per line, `seq` strictly increasing. Mozaik events are copied with their type.
- `runs/<run-id>/summary.json`: a `RunSummary`; every number is computed from the log and the labels by `src/eval/`.
- `npm run sweep -- --scale demo --ticks 500,1000,1500,3000,6000 --out runs/payout-sweep` runs both modes per tick length
  on the same data. Each `<mode>-<tick>` folder has its own log and summary. `sweep.json` contains the table under `rows`
  and the simulated-latency notice under `note` in scripted mode. For live inference, pass `--inference live --provider`
  and `--model` with their values. Use `--scale mini` for the mini fixture.
- Scripted think time is simulated so the timeline shows overlap. It is never reported as performance.
  Only live runs (real model, wall clock) are used for any time or cost claim.
- Never write API keys, absolute local paths or personal data into logs.

## Inference

- `scripted` (default, no key): `ScenarioPack.scripted` decides each step; deterministic for a seed.
- `live`: provider from `--provider` (`openrouter` uses Mozaik's `OpenAIChatCompletions` with base URL `https://openrouter.ai/api/v1`;
  `anthropic` and `openai` use Mozaik's built-in endpoints). Keys come only from the environment variables
  `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and are never logged or written to disk.
- Concurrent runs cap all loops with `--max-loops` (default 8), recorded in `run.started`. A queued explanation starts
  when a slot is available and no release-critical task is queued.
  Gemini's built-in endpoint in core 6.0.0 fails on the second tool round trip (missing thought signature), so it is not offered.
- Every runner is wrapped: a throw becomes `inference.failed` + a model message, never a silent stop.

## Event data shapes (the core emits these; the evaluator and the UI read them)

| kind | itemIds | data | sources |
|---|---|---|---|
| `run.started` | — | `{ scenarioId, mode, inference, tickMs, failPolicy, scale }` | — |
| `arrival` | — | `{ arrivalId, channel }` | the arrival's sources |
| `ledger.write` | `[rowId]` when the row is an item | `{ table: "items" \| "verdicts" \| "holds" \| "links", rowId, after }` (`after` = the row after the write; for items it has `status`) | row sources |
| `gate.wait` | the chunk's item ids | `{ chunkId, dueMs }` | — |
| `gate.pass` | released item ids | `{ chunkId }` | — |
| `gate.hold` | held item ids | `{ chunkId, timeout: boolean, reasons: string[] }` | the rows behind the reasons |
| `inference.completed` | — | `{ usage?: { input: number, output: number } }` (copied from Mozaik's token usage when present) | — |
| `inference.failed` | — | `{ error: string }` | — |
| `citation.reject` | — | `{ agent, text, numbers: string[] }` | — |
| `run.finished` | — | `{ wallMs }` | — |

Mozaik events keep their payload under `data.payload` (trimmed to what is JSON-safe) and their `loopId` in `loopId`.
The final status of an item is the `after.status` of its last `ledger.write` on table `items`.
A loop is active from its `message_received.started` to its `model.answer` or `inference.failed` (same `loopId`).

## The agent-facing door (MCP)

Other AI agents that are about to pay someone should be able to ask the gate first. `mcp/server.ts` is a stdio MCP server
(`@modelcontextprotocol/sdk`) with these tools; every answer carries the SourceRefs behind it and the line "Not financial advice."

| tool | input | output |
|---|---|---|
| `check_payout_batch` | `{ scenario?: "payout-change", scale?: "mini" \| "demo", batch?: WorkItem[], arrivals?: Arrival[], inference?: "scripted" }` | `{ runId, released: string[], held: [{ itemId, reasons, sources }], summary: RunSummary }` |
| `explain_hold` | `{ runId, itemId }` | `{ itemId, notice, verdicts: Verdict[], sources: SourceRef[] }` |
| `get_run_summary` | `{ runId }` | `RunSummary` |

The server never takes credentials as tool input and defaults to scripted inference, so a caller cannot make it spend money.
