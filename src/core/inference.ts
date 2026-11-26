import { setTimeout as delay } from "node:timers/promises";
import {
  AnthropicMessages, defineRuntime, FunctionCallItem, FunctionCallOutputItem, ModelMessageItem,
  OpenAIChatCompletions, OpenAIResponses, SemanticEvent, supportedModels, UserMessageItem,
  type InferenceInput, type InferenceOutput, type InferenceRunner, type RuntimeState,
} from "@mozaik-ai/core";
import type { EventDraft } from "./eventlog.js";
import type { InferenceMode, ScriptedPolicy } from "./types.js";

export interface InferenceTask {
  agent: string;
  loopId?: string;
}

function answer(text: string): InferenceOutput {
  return { items: [ModelMessageItem.rehydrate({ text })], tokenUsage: undefined, rowResponse: null };
}

export function scriptedRunner(
  policy: ScriptedPolicy,
  taskFor: (contextId: string) => InferenceTask | undefined,
): InferenceRunner {
  return {
    async run({ context }) {
      const task = taskFor(context.id);
      if (!task) throw new Error("Scripted inference has no task");
      await delay(policy.latencyMs(task.agent));
      const items = context.getItems();
      const message = items.find((item) => item instanceof UserMessageItem);
      if (!message) throw new Error("Scripted inference has no task message");
      const calls = new Map(items.flatMap((item) => item instanceof FunctionCallItem ? [[item.callId, item.name]] : []));
      const history = items.map((item) => item instanceof FunctionCallOutputItem
        ? { type: item.type, name: calls.get(item.callId), output: item.output.text }
        : { type: item.type });
      const next = policy.next(task.agent, message.content.text, history);
      if ("answer" in next) return answer(next.answer);
      return {
        items: [FunctionCallItem.rehydrate({
          callId: `call-${calls.size + 1}`, name: next.call.name, args: JSON.stringify(next.call.args),
        })],
        tokenUsage: undefined,
        rowResponse: null,
      };
    },
    async *stream() {},
  };
}

const credentialNames = {
  openrouter: "OPENROUTER_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
} as const;

export function withEnvironmentValue<T>(name: string, value: string | undefined, run: () => T): T {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

export function liveRunner(mode: Extract<InferenceMode, { kind: "live" }>, state: RuntimeState): InferenceRunner {
  const { provider, model } = mode;
  const envName = credentialNames[provider];
  const apiKey = process.env[envName];
  if (!apiKey) throw new Error(`Live inference requires ${envName}`);
  const base = provider === "openrouter"
    ? supportedModels.find(({ specification }) => specification.name === "deepseek-v4-flash")
    : supportedModels.find(({ specification }) => specification.provider === provider && specification.name === model)
      ?? supportedModels.find(({ specification }) => specification.provider === provider && specification.supportsFunctionCalling);
  if (!base) throw new Error(`Mozaik has no base specification for ${provider}`);
  const endpoint = {
    openrouter: () => new OpenAIChatCompletions(undefined, { baseURL: "https://openrouter.ai/api/v1", apiKey }),
    anthropic: () => new AnthropicMessages(undefined, { baseURL: "https://api.anthropic.com", apiKey }),
    openai: () => new OpenAIResponses(undefined, { baseURL: "https://api.openai.com/v1", apiKey }),
  }[provider]();
  const runner = defineRuntime().initializeRuntime({
    state,
    inferenceRunnerConfig: {
      supportedModels: [{ endpoint, specification: { ...base.specification, provider, name: model } }],
    },
  }).getInferenceRunner();
  if (provider !== "anthropic") return runner;
  // Mozaik lazily constructs the SDK client, whose bearer-token fallback is independent of apiKey.
  return {
    run: (input) => withEnvironmentValue("ANTHROPIC_AUTH_TOKEN", undefined, () => runner.run(input)),
    async *stream(input) {
      const stream = runner.stream(input);
      let next = await withEnvironmentValue("ANTHROPIC_AUTH_TOKEN", undefined, () => stream.next());
      try {
        while (!next.done) {
          yield next.value;
          next = await stream.next();
        }
      } finally {
        if (!next.done) await stream.return(undefined);
      }
    },
  };
}

export function wrapRunner(
  runner: InferenceRunner,
  taskFor: (contextId: string) => InferenceTask | undefined,
  emit: (event: EventDraft) => void,
): InferenceRunner {
  function failed(input: InferenceInput, error: unknown): InferenceOutput {
    const task = taskFor(input.context.id);
    emit({
      kind: "inference.failed", agent: task?.agent, loopId: task?.loopId,
      data: { error: error instanceof Error ? error.message : String(error) },
    });
    return answer("Inference failed. This task could not be completed.");
  }

  function checked(output: InferenceOutput): InferenceOutput {
    if (!output.items.some((item) => item.type === "function_call" || item.type === "message")) {
      throw new Error("Inference returned no call or answer");
    }
    return output;
  }

  return {
    async run(input) {
      try {
        return checked(await runner.run(input));
      } catch (error) {
        return failed(input, error);
      }
    },
    async *stream(input) {
      try {
        let completed = false;
        for await (const event of runner.stream(input)) {
          if (event.type === "inference.output") {
            checked(event.payload as InferenceOutput);
            completed = true;
          }
          yield event;
        }
        if (!completed) throw new Error("Inference stream returned no output");
      } catch (error) {
        const output = failed(input, error);
        yield SemanticEvent.create("inference.output", "", output);
      }
    },
  };
}
