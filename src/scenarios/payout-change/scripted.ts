import type { TaskTarget } from "../../core/task.js";
import type { ScriptedPolicy, SourceRef } from "../../core/types.js";
import { distinctSources, type RuleHit } from "./rules.js";

interface Facts {
  hits: RuleHit[];
  complete: boolean;
  sources: SourceRef[];
}

function nextCall(name: string, args: Record<string, unknown>) {
  return { call: { name, args } };
}

function verdict(itemId: string, facts: Facts[]) {
  const hits = facts.flatMap(({ hits }) => hits);
  const complete = facts.every((fact) => fact.complete);
  return nextCall("submit_verdict", {
    itemId,
    value: hits.length ? "suspicious" : complete ? "clear" : "unknown",
    reason: hits.map(({ reason }) => reason).join(" ") ||
      (complete ? "The checked source rows agree." : "The source rows are incomplete."),
    sources: distinctSources(hits.length ? hits.flatMap((hit) => hit.sources) : facts.flatMap((fact) => fact.sources)),
  });
}

export const scripted: ScriptedPolicy = {
  latencyMs(agent) {
    if (agent === "Dispatcher") return 8;
    if (agent === "RecordChecker") return 18;
    return 14;
  },

  next(agent, task, history) {
    const { chunkId, arrivalId, itemId, creatorId } = JSON.parse(task) as TaskTarget;
    const outputs = new Map(history.flatMap(({ name, output }) => name && output ? [[name, output]] : []));
    const read = <T,>(name: string): T => JSON.parse(outputs.get(name)!) as T;

    switch (agent) {
      case "Dispatcher":
        if (!outputs.has("release_chunk")) return nextCall("release_chunk", { chunkId });
        break;
      case "BatchAuditor":
        if (!outputs.has("scan_chunk")) return nextCall("scan_chunk", { chunkId });
        break;
      case "InboxWatcher": {
        if (outputs.has("link_request") || outputs.has("mark_no_action")) break;
        if (!outputs.has("read_arrival")) return nextCall("read_arrival", { arrivalId });
        const { body, actionable, requestedAccount, channel } = read<{
          body: string; actionable: boolean; requestedAccount: string; channel: string;
        }>("read_arrival");
        if (!actionable) return nextCall("mark_no_action", { arrivalId, reason: "No payout account change requested." });
        if (!outputs.has("find_creator")) return nextCall("find_creator", { text: body });
        const creator = read<{ creatorId?: string }>("find_creator");
        if (!creator.creatorId) return { answer: "The creator could not be identified." };
        return nextCall("link_request", { arrivalId, creatorId: creator.creatorId, requestedAccount, channel });
      }
      case "RecordChecker":
        if (outputs.has("submit_verdict")) break;
        if (!outputs.has("get_master")) return nextCall("get_master", { creatorId });
        if (!outputs.has("get_change_log")) return nextCall("get_change_log", { creatorId });
        return verdict(itemId!, [read("get_master"), read("get_change_log")]);
      case "PolicyAgent":
        if (outputs.has("submit_verdict")) break;
        if (!outputs.has("policy_check")) return nextCall("policy_check", { itemId });
        return verdict(itemId!, [read("policy_check")]);
      case "Explainer": {
        if (outputs.has("write_hold_notice")) break;
        if (!outputs.has("get_hold_facts")) return nextCall("get_hold_facts", { itemId });
        const { reasons, sources } = read<{ reasons: string[]; sources: SourceRef[] }>("get_hold_facts");
        const rows = [...new Set(sources.flatMap(({ source }) => source.includes("#") ? [source.split("#").at(-1)!] : []))];
        const evidence = rows.length ? ` Source rows: ${rows.join(", ")}.` : "";
        return nextCall("write_hold_notice", {
          itemId, text: `Your payout is on hold. ${reasons.join(" ")}${evidence} This is not financial advice.`,
        });
      }
    }
    return { answer: "Task complete." };
  },
};
