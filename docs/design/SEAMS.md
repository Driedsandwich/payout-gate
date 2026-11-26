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

The gate emits `gate.wait` and settles each chunk at its scheduled cut-off. It uses the audit and checker verdicts
available at the tick. A suspicious checker verdict holds the payout with its reasons and source rows.

For arrivals before the tick that are still untriaged, the gate uses the same creator matcher as `find_creator`.
It checks the message text for creator IDs, handles and contact emails. An unread message can hold only payouts in
the chunk for creators it names, with the reason “named in a message not read before the cut-off” and the arrival
ID and matched creator rows as sources. The gate logs `gate.unread` for an unread message with no matches.
Messages arriving at or after the tick belong to the next chunk.

With `--fail-policy hold`, a missing audit, inconclusive required checks, or an unread message naming the creator
causes a timeout hold with a notice about the pending work. With `--fail-policy release`, the gate releases those
uncertain payouts. Decisions apply per chunk.

Before the run finishes, it waits for intake, audit and checker loops to finish and reviews the timeout holds.
It retries incomplete work for those holds once. Once the relevant intake and required checks conclude, suspicious
verdicts convert a timeout hold to a verdict hold with the verdict source rows and an Explainer notice.
When the audit and relevant intake are complete and all required checks are clear, the hold is recorded as
“cleared after cut-off” and the payout is counted as paid late. The hold row and `hold.resolved` record the outcome.
An inconclusive review leaves the payout held and records the reason in `hold.unresolved`. The sweep counts
`confirmedLate` and `clearedLate` alongside the original cut-off counts.

The Explainer can attempt up to three writes per hold. Standalone numbers and dates in its notice must match a
scalar value returned by a tool in the same loop. If the loop ends without a valid notice, the gate writes one
from the recorded hold reasons and sources.

### Sequential baseline (`--mode sequential`)

The same agents, tools, prompts and gate run one loop at a time. Before each release, InboxWatcher triages newly
arrived messages one at a time until none is untriaged or the tick comes. RecordChecker and PolicyAgent then check
linked items, and BatchAuditor scans the chunk. The baseline checks flagged items and returns to intake as new
messages arrive during the round. Only the tick closes intake for that release. The Dispatcher loop follows
pre-release work, and the gate settles the release at the scheduled tick even if a loop is still running.
The baseline finishes pending inbox and evidence review and writes verdict-based explanations before the run ends.

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
| `gate.unread` | — | `{ arrivalId }` | the unread arrival that named no creator |
| `gate.retry_triage` | — | `{ arrivalId, attempt: 2 }` | — |
| `hold.resolved` | `[itemId]` | `{ itemId, outcome: "confirmed" \| "cleared_late" }` | the rows supporting the outcome |
| `hold.unresolved` | `[itemId]` | `{ itemId, reason }` | the rows supporting the cut-off hold |
| `inference.completed` | — | `{ usage?: { input: number, output: number } }` (copied from Mozaik's token usage when present) | — |
| `inference.failed` | — | `{ error: string }` | — |
| `citation.reject` | — | `{ agent, text, numbers: string[] }` | — |
| `citation.fallback` | `[itemId]` | `{ itemId, attempts }` | the rows used to build the notice |
| `run.finished` | — | `{ wallMs }` | — |

Mozaik events keep their payload under `data.payload` (trimmed to what is JSON-safe) and their `loopId` in `loopId`.
The cut-off status of an item is the `after.status` of its last `ledger.write` on table `items`.
The optional `Hold.outcome` field records what happened to a timeout hold after the cut-off.
The optional `Hold.unresolvedReason` field records why a timeout hold could not be resolved.
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
