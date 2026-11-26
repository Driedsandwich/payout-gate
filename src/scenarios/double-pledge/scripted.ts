import type { TaskTarget } from "../../core/task.js";
import type { ScriptedPolicy } from "../../core/types.js";
import { distinctSources, type Facts } from "./rules.js";

function call(name: string, args: Record<string, unknown>) {
  return { call: { name, args } };
}

export const scripted: ScriptedPolicy = {
  latencyMs(agent) {
    if (agent === "Dispatcher") return 8;
    if (agent === "RegistryChecker") return 18;
    return 14;
  },

  next(agent, task, history) {
    const { chunkId, arrivalId, itemId } = JSON.parse(task) as TaskTarget;
    const outputs = new Map(history.flatMap(({ name, output }) => name && output ? [[name, output]] : []));
    const read = <T,>(name: string): T => JSON.parse(outputs.get(name)!) as T;

    switch (agent) {
      case "Dispatcher":
        if (!outputs.has("fund_batch")) return call("fund_batch", { chunkId });
        break;
      case "Fingerprinter":
        if (!outputs.has("scan_chunk")) return call("scan_chunk", { chunkId });
        break;
      case "Intake": {
        if (outputs.has("link_request") || outputs.has("mark_no_action")) break;
        if (!outputs.has("read_arrival")) return call("read_arrival", { arrivalId });
        const { kind } = read<{ kind: string }>("read_arrival");
        if (kind === "incomplete") return { answer: "The message needs a follow-up to identify the invoice." };
        if (kind === "unrelated") return call("mark_no_action", { arrivalId });
        if (!outputs.has("fingerprint_invoice")) return call("fingerprint_invoice", { arrivalId });
        const { matches } = read<{ matches: { subjectId: string }[] }>("fingerprint_invoice");
        return matches.length
          ? call("link_request", { arrivalId, subjectId: matches[0].subjectId })
          : call("mark_no_action", { arrivalId });
      }
      case "RegistryChecker":
      case "DebtorChecker": {
        if (outputs.has("submit_verdict")) break;
        const lookup = agent === "RegistryChecker" ? "lookup_registry" : "lookup_debtor_ledger";
        if (!outputs.has(lookup)) return call(lookup, { itemId });
        const { hits, complete, sources } = read<Facts>(lookup);
        return call("submit_verdict", {
          itemId,
          value: hits.length ? "suspicious" : complete ? "clear" : "unknown",
          reason: [...new Set(hits.map(({ reason }) => reason))].join(" ") ||
            (complete ? "The checked rows support funding." : "The source records are incomplete."),
          sources: distinctSources(hits.length ? hits.flatMap((hit) => hit.sources) : sources),
        });
      }
      case "Explainer": {
        if (outputs.has("write_hold_notice")) break;
        if (!outputs.has("get_hold_facts")) return call("get_hold_facts", { itemId });
        const { reasons, rows } = read<{ reasons: string[]; rows: string[] }>("get_hold_facts");
        const citations = rows.length ? ` See source rows ${rows.join(", ")}.` : "";
        return call("write_hold_notice", {
          itemId, text: `Your funding request is on hold. ${reasons.join(" ")}${citations} This is not financial advice.`,
        });
      }
    }
    return { answer: "Task complete." };
  },
};
