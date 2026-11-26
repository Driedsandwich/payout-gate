import {
  createAgent, createHuman, defineRuntime, DeveloperMessageItem, FunctionCallOutputItem, ModelContext, SituationSpecification,
  type InferenceRunner, type InterceptionHandler, type SemanticEvent, type Tool,
} from "@mozaik-ai/core";
import { outputSources } from "./citations.js";
import type { EventLog } from "./eventlog.js";
import { liveRunner, scriptedRunner, withEnvironmentValue, wrapRunner, type InferenceTask } from "./inference.js";
import type { Ledger } from "./ledger.js";
import type { TaskTarget, TaskToolContext } from "./task.js";
import type { AgentSpec, InferenceMode, ScenarioData, ScenarioPack } from "./types.js";

interface Task extends InferenceTask {
  finish(): void;
}

class ObserveAll extends SituationSpecification {
  isSatisfiedBy(): boolean {
    return true;
  }
}

export interface LoopOptions {
  pack: ScenarioPack;
  data: ScenarioData;
  ledger: Ledger;
  log: EventLog;
  inference: Exclude<InferenceMode, { kind: "replay" }>;
  runner?: InferenceRunner;
  maxLoops: number;
  explainer: string;
}

export function createLoopRuntime(options: LoopOptions) {
  const { pack, ledger, log, inference, maxLoops } = options;
  const data = { ...options.data, labels: [], arrivals: [] };
  const runtime = defineRuntime<Ledger>();
  const tasks = new Map<string, Task>();
  const tasksByLoop = new Map<string, Task>();
  const active = new Set<string>();
  const specs = new Map(pack.agents().map((spec) => [spec.name, spec]));
  const agents = new Map([...specs].map(([name, spec]) => [name, createAgent({
    name, instruction: spec.instruction, capabilities: [], handlers: [],
    tools: [],
  })]));
  const model = inference.kind === "scripted" ? "gpt-5.5" : inference.model;

  let peak = 0;
  const taskFor = (contextId: string) => tasks.get(contextId);
  const runner = options.runner ?? (inference.kind === "scripted"
    ? scriptedRunner(pack.scripted, taskFor)
    : liveRunner(inference, ledger));
  runtime.initializeRuntime({
    state: ledger,
    inferenceRunnerConfig: {
      runner: wrapRunner(runner, taskFor, (event) => {
        log.emit(event);
        if (event.loopId) active.delete(event.loopId);
      }),
    },
  });

  function observe(event: SemanticEvent): void {
    log.observe(event, ledger.getParticipant(event.producerId)?.getManifest().name);
    const payload = event.payload as { loopId?: string; input?: { context?: ModelContext } };
    const loopId = payload?.loopId;
    if (!loopId) return;

    if (event.type === "message_received.started") {
      const context = payload.input?.context;
      const task = context && taskFor(context.id);
      if (task) {
        task.loopId = loopId;
        tasksByLoop.set(loopId, task);
      }
      active.add(loopId);
      peak = Math.max(peak, active.size);
    }
    if (event.type === "model.answer") {
      active.delete(loopId);
      // A failed inference also receives a final Mozaik answer. Keep its seat until that event is copied.
      tasksByLoop.get(loopId)?.finish();
      tasksByLoop.delete(loopId);
    }
  }

  function join(): void {
    runtime.join(createHuman({
      name: "OpsReviewer", capabilities: [], handlers: [{
        specification: new ObserveAll(), processor: { apply: ({ event }) => observe(event) },
      }],
    }));
    for (const agent of agents.values()) runtime.join(agent);
  }

  let seats = maxLoops;
  const critical: Array<() => void> = [];
  const explanations: Array<() => void> = [];

  function startNext(): void {
    if (!seats) return;
    const start = critical.shift() ?? explanations.shift();
    if (start) {
      seats--;
      start();
    }
  }

  async function run(
    name: string,
    target: TaskTarget,
    revision?: number,
    makeHandler?: (loopId: () => string | undefined) => InterceptionHandler,
  ): Promise<void> {
    const agent = agents.get(name);
    const spec = specs.get(name);
    if (!agent || !spec) throw new Error(`Missing agent ${name}`);
    const queue = name === options.explainer ? explanations : critical;
    return new Promise<void>((resolve, reject) => {
      queue.push(() => {
        void runTask(agent, spec, target, revision, makeHandler).then(resolve, reject).finally(() => {
          seats++;
          startNext();
        });
      });
      startNext();
    });
  }

  async function runTask(
    agent: ReturnType<typeof createAgent>,
    spec: AgentSpec,
    target: TaskTarget,
    revision: number | undefined,
    makeHandler: ((loopId: () => string | undefined) => InterceptionHandler) | undefined,
  ): Promise<void> {
    const { name } = spec;
    const context = ModelContext.create().addContextItem(DeveloperMessageItem.create(agent.getDeveloperMessage()));
    try {
      await new Promise<void>((finish) => {
        const task: Task = { agent: name, finish };
        tasks.set(context.id, task);
        const toolSources: TaskToolContext["toolSources"] = [];
        const tools: Tool[] = spec.tools.map((tool) => ({
          type: "function", name: tool.name, description: tool.description, parameters: tool.parameters, strict: false,
          async invoke(args) {
            const actor = { agent: name, loopId: task.loopId };
            const ctx: TaskToolContext = {
              ...actor, data, ledger, target, revision, toolSources, nowMs: log.nowMs,
              get toolOutputs() {
                return context.getItems().flatMap((item) =>
                  item instanceof FunctionCallOutputItem ? [item.output.text] : []);
              },
              emit: (event) => log.emit({ ...actor, ...event }),
            };
            const output = await tool.invoke(args, ctx);
            toolSources.push(...outputSources(output));
            return output;
          },
        }));

        // Core constructs a Cloud client synchronously on every runLoop. An empty primary
        // key disables its environment, .env and paired-credentials fallbacks.
        withEnvironmentValue("MOZAIK_API_KEY", "", () => {
          runtime.runLoop(agent.getId(), JSON.stringify(target),
            { model, context, tools, maxOutputTokens: 4_096 }, makeHandler?.(() => task.loopId));
        });
      });
    } finally {
      tasks.delete(context.id);
    }
  }

  return { run, join, maxConcurrentLoops: () => peak };
}
