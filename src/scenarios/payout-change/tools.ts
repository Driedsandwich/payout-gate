import { checkCitations, outputSources } from "../../core/citations.js";
import type { TaskTarget, TaskToolContext } from "../../core/task.js";
import type { SourceRef, ToolSpec, VerdictValue } from "../../core/types.js";
import { findCreator, readRequest } from "./inbox.js";
import { distinctSources, inspectPolicy, inspectRecords, ruleConstants } from "./rules.js";

type Args = Record<string, unknown>;
const string = { type: "string" };
const sourceSchema = {
  type: "array",
  items: {
    type: "object", required: ["source", "field", "value"], additionalProperties: false,
    properties: { source: string, field: { type: ["string", "null"] }, value: { type: ["number", "string", "null"] } },
  },
};

function tool(name: string, description: string, properties: Record<string, unknown>,
  invoke: (args: Args, ctx: TaskToolContext) => unknown): ToolSpec {
  return {
    name, description,
    parameters: { type: "object", properties, required: Object.keys(properties), additionalProperties: false },
    async invoke(args, ctx) {
      return invoke(args, ctx as TaskToolContext);
    },
  };
}

function textArg(args: Args, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Expected ${key}`);
  return value;
}

function taskId(args: Args, key: keyof TaskTarget, ctx: TaskToolContext): string {
  const id = textArg(args, key);
  if (id !== ctx.target[key]) throw new Error(`${key} does not match this task`);
  return id;
}

const releaseChunk = tool("release_chunk", "Request synthetic release for this task's chunk.", { chunkId: string },
  (args, ctx) => {
    const chunkId = taskId(args, "chunkId", ctx);
    const { itemIds } = args;
    if (!Array.isArray(itemIds) || !itemIds.every((id) => typeof id === "string")) {
      throw new Error("Release did not receive gated item ids");
    }
    return { chunkId, released: ctx.ledger.releaseAuthorized(chunkId, itemIds) };
  });

const readArrival = tool("read_arrival", "Read the delivered message and its account-change details.", { arrivalId: string },
  (args, ctx) => {
    const arrival = ctx.ledger.arrival(taskId(args, "arrivalId", ctx));
    const { id, atTick, channel, body } = arrival;
    return { id, atTick, channel, body, ...readRequest(arrival) };
  });

const findCreatorTool = tool("find_creator", "Find the creator by ID, handle, or contact email in the message text. Pass the full message including its signature.", { text: string },
  (args, ctx) => {
    const arrival = ctx.ledger.arrival(ctx.target.arrivalId!);
    return findCreator(ctx.data, textArg(args, "text"), arrival.body);
  });

const linkRequest = tool("link_request", "Link an actionable message and its requested account to the creator.",
  { arrivalId: string, creatorId: string, requestedAccount: string, channel: string }, (args, ctx) => {
    const arrival = ctx.ledger.arrival(taskId(args, "arrivalId", ctx));
    const request = readRequest(arrival);
    const creator = findCreator(ctx.data, arrival.body);
    if (!request.actionable || textArg(args, "creatorId") !== creator.creatorId ||
        textArg(args, "requestedAccount") !== request.requestedAccount || textArg(args, "channel") !== arrival.channel) {
      throw new Error("Link does not match the delivered message");
    }
    const sources = distinctSources([...request.sources, ...creator.sources]);
    ctx.ledger.triage({
      arrivalId: arrival.id, creatorId: creator.creatorId, requestedAccount: request.requestedAccount!,
      channel: arrival.channel, sources,
    });
    return { linked: true, signals: creator.signals, sources };
  });

const markNoAction = tool("mark_no_action", "Triage a message unrelated to an account change.",
  { arrivalId: string, reason: string }, (args, ctx) => {
    const arrival = ctx.ledger.arrival(taskId(args, "arrivalId", ctx));
    if (readRequest(arrival).actionable) throw new Error("The message describes an account change");
    ctx.ledger.triage({ arrivalId: arrival.id, reason: textArg(args, "reason"), sources: arrival.sources });
    return { triaged: true, sources: arrival.sources };
  });

const scanChunk = tool("scan_chunk", "Scan the chunk for payout policy hits and recent account changes.", { chunkId: string },
  (args, ctx) => {
    const chunkId = taskId(args, "chunkId", ctx);
    const chunk = ctx.data.chunks.find(({ id }) => id === chunkId);
    if (!chunk) throw new Error(`Unknown chunk ${chunkId}`);
    const flagged = chunk.itemIds.flatMap((itemId) => {
      const item = ctx.ledger.item(itemId);
      const facts = inspectPolicy(ctx.data, item, ctx.ledger.requestsFor(item.subjectId));
      return facts.hits.length || facts.recent || !facts.complete ? [{ itemId, ...facts }] : [];
    });
    ctx.ledger.scan(chunkId, flagged.map(({ itemId }) => itemId));
    for (const { itemId, hits, sources } of flagged) {
      ctx.ledger.addVerdict({
        itemId, by: ctx.agent, value: hits.length ? "suspicious" : "unknown",
        reason: hits.map(({ reason }) => reason).join(" ") || "The source records need a follow-up check.",
        sources: distinctSources(hits.length ? hits.flatMap((hit) => hit.sources) : sources), atMs: ctx.nowMs(),
      });
    }
    return { chunkId, flagged };
  });

function taskRecords(args: Args, ctx: TaskToolContext) {
  taskId(args, "creatorId", ctx);
  const item = ctx.ledger.item(ctx.target.itemId!);
  return inspectRecords(ctx.data, item, ctx.ledger.requestsFor(item.subjectId));
}

const getMaster = tool("get_master", "Read the creator's verified account and compare the batch and linked requests.",
  { creatorId: string }, (args, ctx) => {
    const { master, masterHits, masterSources, requestSources, complete } = taskRecords(args, ctx);
    return { master, hits: masterHits, complete, sources: distinctSources([
      ...masterSources, ...requestSources, ...masterHits.flatMap((hit) => hit.sources),
    ]) };
  });

const getChangeLog = tool("get_change_log", "Read the creator's change log and recent verification issues.",
  { creatorId: string }, (args, ctx) => {
    const { changes, changeHits, changeSources, complete } = taskRecords(args, ctx);
    return { changes, hits: changeHits, complete, sources: [...changeSources, ruleConstants.recentChangeHours] };
  });

const policyCheck = tool("policy_check", "Compute the payout rules from the batch, records, and linked requests.",
  { itemId: string }, (args, ctx) => {
    const item = ctx.ledger.item(taskId(args, "itemId", ctx));
    return inspectPolicy(ctx.data, item, ctx.ledger.requestsFor(item.subjectId));
  });

const submitVerdict = tool("submit_verdict", "Write this item's supported verdict. Cite sources returned by your tools.",
  { itemId: string, value: { type: "string", enum: ["clear", "suspicious", "unknown"] }, reason: string, sources: sourceSchema },
  (args, ctx) => {
    const itemId = taskId(args, "itemId", ctx);
    const { value } = args;
    if (value !== "clear" && value !== "suspicious" && value !== "unknown") throw new Error("Invalid verdict");
    if (!Array.isArray(args.sources)) throw new Error("Expected verdict sources");
    const sources: SourceRef[] = [];
    for (const raw of args.sources) {
      const candidate = { source: raw?.source, field: raw?.field ?? undefined, value: raw?.value ?? undefined };
      const [source] = outputSources(candidate);
      const matching = source && ctx.toolSources.find((known) => known.source === source.source &&
        (source.field === undefined || known.field === source.field) &&
        (source.value === undefined || known.value === source.value));
      if (!matching) throw new Error("Verdict sources must come from a tool in this loop");
      sources.push(source);
    }
    if (!sources.length && value !== "unknown") throw new Error("A conclusive verdict needs sources");
    ctx.ledger.addVerdict({
      itemId, by: ctx.agent, value: value satisfies VerdictValue, reason: textArg(args, "reason"),
      sources: distinctSources(sources), atMs: ctx.nowMs(),
    }, ctx.revision);
    return { recorded: true };
  });

const getHoldFacts = tool("get_hold_facts", "Read hold reasons and their sources.", { itemId: string },
  (args, ctx) => {
    const itemId = taskId(args, "itemId", ctx);
    const hold = ctx.ledger.holdFor(itemId);
    if (!hold) throw new Error(`No hold for ${itemId}`);
    return {
      itemId, reasons: hold.reasons,
      sources: distinctSources([...hold.sources, ...ctx.ledger.item(itemId).sources, ...Object.values(ruleConstants)]),
    };
  });

const writeHoldNotice = tool("write_hold_notice", 'Write the cited notice including "This is not financial advice".',
  { itemId: string, text: string }, (args, ctx) => {
    const itemId = taskId(args, "itemId", ctx);
    const text = textArg(args, "text");
    if (!checkCitations(text, ctx.toolSources, ctx, ctx.emit, ctx.toolOutputs)) {
      return { written: false, reason: "Unsupported number" };
    }
    if (!text.includes("This is not financial advice")) throw new Error("The notice is missing the required statement");
    ctx.ledger.addNotice(itemId, text);
    return { written: true };
  });

export const agentTools = {
  Dispatcher: [releaseChunk],
  InboxWatcher: [readArrival, findCreatorTool, linkRequest, markNoAction],
  BatchAuditor: [scanChunk],
  RecordChecker: [getMaster, getChangeLog, submitVerdict],
  PolicyAgent: [policyCheck, submitVerdict],
  Explainer: [getHoldFacts, writeHoldNotice],
};
