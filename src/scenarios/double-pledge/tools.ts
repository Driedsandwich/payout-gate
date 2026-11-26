import { checkCitations, outputSources } from "../../core/citations.js";
import type { TaskTarget, TaskToolContext } from "../../core/task.js";
import type { SourceRef, ToolSpec, WorkItem } from "../../core/types.js";
import { fingerprintMessage, readPledgeMessage } from "./inbox.js";
import { distinctSources, inspectDebtor, inspectRegistry, ruleConstants } from "./rules.js";

type Args = Record<string, unknown>;
const string = { type: "string" };
const verdictValues = ["clear", "suspicious", "unknown"] as const;

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

function registryFacts(ctx: TaskToolContext, item: WorkItem) {
  const incoming = ctx.ledger.requestsFor(item.subjectId).flatMap(({ arrivalId }) => {
    const message = readPledgeMessage(ctx.data, ctx.ledger.arrival(arrivalId));
    return message.kind === "submission" ? [message] : [];
  });
  return inspectRegistry(ctx.data, item, incoming);
}

const fundBatch = tool("fund_batch", "Request synthetic funding for this task's chunk.", { chunkId: string },
  (args, ctx) => {
    const chunkId = taskId(args, "chunkId", ctx);
    const { itemIds } = args;
    if (!Array.isArray(itemIds) || !itemIds.every((id) => typeof id === "string")) {
      throw new Error("Funding did not receive gated item ids");
    }
    return { chunkId, funded: ctx.ledger.releaseAuthorized(chunkId, itemIds) };
  });

const readArrival = tool("read_arrival", "Read the delivered message and identify what it reports.",
  { arrivalId: string }, (args, ctx) => {
    const arrival = ctx.ledger.arrival(taskId(args, "arrivalId", ctx));
    const { id, body } = arrival;
    const { kind, sources } = readPledgeMessage(ctx.data, arrival);
    return { id, body, kind, sources };
  });

function fingerprintArgs(args: Args, ctx: TaskToolContext) {
  const arrival = ctx.ledger.arrival(taskId(args, "arrivalId", ctx));
  return { arrival, ...fingerprintMessage(ctx.data, arrival, ctx.data.items) };
}

const fingerprintInvoice = tool("fingerprint_invoice", "Compare the message's invoice with funding requests, including held requests.",
  { arrivalId: string }, (args, ctx) => {
    const { kind, matches, lender, sources } = fingerprintArgs(args, ctx);
    return { kind, matches, lender, sources: [...sources, ...Object.values(ruleConstants)] };
  });

const linkRequest = tool("link_request", "Link the message to its fingerprint-matched funding requests and start evidence checks.",
  { arrivalId: string, subjectId: string }, (args, ctx) => {
    const { arrival, kind, matches, lender, sources } = fingerprintArgs(args, ctx);
    const subjectId = textArg(args, "subjectId");
    if (!matches.length) {
      if (kind !== "incomplete") {
        ctx.ledger.triage({ arrivalId: arrival.id, reason: "No funding request matches the invoice.", sources });
      }
      return { linked: [], sources };
    }
    if (!matches.every((match) => match.subjectId === subjectId)) throw new Error("Link does not match the fingerprint results");
    ctx.ledger.triage({
      arrivalId: arrival.id, creatorId: subjectId, requestedAccount: lender ?? "", channel: arrival.channel, sources,
    });
    return { linked: matches.map(({ itemId }) => itemId), sources };
  });

const markNoAction = tool("mark_no_action", "Record an unrelated message or a message with no matching funding request.",
  { arrivalId: string }, (args, ctx) => {
    const { arrival, kind, matches, sources } = fingerprintArgs(args, ctx);
    if (kind === "incomplete" || matches.length) return { triaged: false, sources };
    ctx.ledger.triage({
      arrivalId: arrival.id, sources,
      reason: kind === "unrelated" ? "The message does not report a pledge or submission." : "No funding request matches the invoice.",
    });
    return { triaged: true, sources };
  });

const scanChunk = tool("scan_chunk", "Scan the chunk's funding requests and flag those that need checker verdicts.",
  { chunkId: string }, (args, ctx) => {
    const chunkId = taskId(args, "chunkId", ctx);
    const chunk = ctx.data.chunks.find(({ id }) => id === chunkId);
    if (!chunk) throw new Error(`Unknown chunk ${chunkId}`);
    const flagged = chunk.itemIds.flatMap((itemId) => {
      const item = ctx.ledger.item(itemId);
      const checks = [registryFacts(ctx, item), inspectDebtor(ctx.data, item)];
      const sources = checks.flatMap(({ hits, complete, sources }) => complete ? hits.flatMap((hit) => hit.sources) : sources);
      return checks.some(({ hits, complete }) => hits.length || !complete) ? [{ itemId, sources: distinctSources(sources) }] : [];
    });
    ctx.ledger.scan(chunkId, flagged.map(({ itemId }) => itemId));
    return { chunkId, flagged };
  });

const lookupRegistry = tool("lookup_registry", "Look up pre-run registry pledges and compare active request fingerprints.",
  { itemId: string }, (args, ctx) => registryFacts(ctx, ctx.ledger.item(taskId(args, "itemId", ctx))));

const lookupDebtor = tool("lookup_debtor_ledger", "Look up this seller's invoice number in the debtor's open ledger.",
  { itemId: string }, (args, ctx) => inspectDebtor(ctx.data, ctx.ledger.item(taskId(args, "itemId", ctx))));

const submitVerdict = tool("submit_verdict", "Record the verdict supported by the checked rows.",
  {
    itemId: string, value: { type: "string", enum: verdictValues }, reason: string,
    sources: {
      type: "array", items: {
        type: "object", properties: { source: string, field: string, value: { type: ["number", "string"] } },
        required: ["source"], additionalProperties: false,
      },
    },
  }, (args, ctx) => {
    const itemId = taskId(args, "itemId", ctx);
    const value = verdictValues.find((verdict) => verdict === args.value);
    if (!value) throw new Error("Invalid verdict");
    if (!Array.isArray(args.sources)) throw new Error("Expected verdict sources");
    const sources: SourceRef[] = args.sources.map((raw) => {
      const [ref] = outputSources({ source: raw?.source, field: raw?.field, value: raw?.value });
      if (!ref || !ctx.toolSources.some((known) => known.source === ref.source
        && (ref.field === undefined || ref.field === known.field)
        && (ref.value === undefined || ref.value === known.value))) {
        throw new Error("Verdict sources must come from a tool in this loop");
      }
      return ref;
    });
    if (!sources.length && value !== "unknown") throw new Error("A conclusive verdict needs sources");
    const reason = textArg(args, "reason");
    if (!checkCitations(reason, ctx.toolSources, ctx, ctx.emit)) return { recorded: false, sources };
    const cited = distinctSources(sources);
    ctx.ledger.addVerdict({ itemId, by: ctx.agent, value, reason, sources: cited, atMs: ctx.nowMs() }, ctx.revision);
    return { recorded: true, sources: cited };
  });

const getHoldFacts = tool("get_hold_facts", "Read the hold reasons and the row IDs that support them.",
  { itemId: string }, (args, ctx) => {
    const itemId = taskId(args, "itemId", ctx);
    const hold = ctx.ledger.holdFor(itemId);
    if (!hold) throw new Error(`No hold for ${itemId}`);
    const sources = distinctSources([...hold.sources, ...Object.values(ruleConstants)]);
    const rows = [...new Set(sources.filter(({ field }) => field === "id").map(({ value }) => String(value)))];
    return { reasons: hold.reasons, rows, sources };
  });

const writeHoldNotice = tool("write_hold_notice", 'Write a cited funding hold notice including "This is not financial advice".',
  { itemId: string, text: string }, (args, ctx) => {
    const itemId = taskId(args, "itemId", ctx);
    const text = textArg(args, "text");
    if (!checkCitations(text, ctx.toolSources, ctx, ctx.emit)) return { written: false };
    if (!text.includes("This is not financial advice")) throw new Error("The notice is missing the required statement");
    ctx.ledger.addNotice(itemId, text);
    return { written: true };
  });

export const agentTools = {
  Dispatcher: [fundBatch],
  Intake: [readArrival, fingerprintInvoice, linkRequest, markNoAction],
  Fingerprinter: [scanChunk],
  RegistryChecker: [lookupRegistry, submitVerdict],
  DebtorChecker: [lookupDebtor, submitVerdict],
  Explainer: [getHoldFacts, writeHoldNotice],
};
