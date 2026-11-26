import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { makeScrubber } from "./core/eventlog.js";
import { runScenario, type RunOptions } from "./core/orchestrator.js";
import { resolveOutputPath } from "./core/repository.js";
import type { RunEvent, RunSummary, ScenarioData, ScenarioPack, Scale } from "./core/types.js";
import { countHoldOutcomes } from "./eval/hold-outcomes.js";
import { SCALES as pledgeScales } from "./scenarios/double-pledge/generate.js";
import { doublePledgePack } from "./scenarios/double-pledge/pack.js";
import { payoutChangePack } from "./scenarios/payout-change/pack.js";

const scenarios = ["payout-change", "double-pledge"] as const;
const scales = ["demo", "full", "mini"] as const;
const modes = ["concurrent", "sequential"] as const;
const pledgeMiniScale: Scale = { items: 12, arrivals: 4, planted: 2, seed: 1 };
const scriptedNote = "Scripted latency is simulated; these numbers show the mechanism, not performance.";
type ScenarioId = typeof scenarios[number];
type ScaleName = typeof scales[number];
type GeneratorModule = { generate: ScenarioPack["generate"]; SCALES: Record<Exclude<ScaleName, "mini">, Scale> };
type EvaluatorModule = { evaluate(events: RunEvent[], data: ScenarioData): RunSummary | Promise<RunSummary> };

async function optionalModule<T>(modulePath: string): Promise<T | undefined> {
  for (const extension of [".ts", ".js"]) {
    const entry = new URL(modulePath + extension, import.meta.url);
    if (existsSync(entry)) return import(entry.href) as Promise<T>;
  }
  return undefined;
}

function choice<T extends string>(value: string, choices: readonly T[], flag: string): T {
  const found = choices.find((option) => option === value);
  if (!found) throw new Error(`--${flag} must be one of ${choices.join(", ")}`);
  return found;
}

function positiveInteger(value: string, flag: string): number {
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < 1) {
    throw new Error(`--${flag} must be a positive integer`);
  }
  return number;
}

async function loadPayoutScale(scaleName: ScaleName) {
  if (scaleName !== "mini") {
    const generator = await optionalModule<GeneratorModule>("./scenarios/payout-change/generate");
    if (generator) return { generate: generator.generate, scale: generator.SCALES[scaleName] };
    if (scaleName === "full") throw new Error("The full scale requires src/scenarios/payout-change/generate.ts");
    console.log("Generator is missing. Using the mini fixture.");
  }
  const { MINI_SCALE, payoutMini } = await import("../test/fixtures/payout-mini.js");
  return { generate: payoutMini, scale: MINI_SCALE };
}

async function loadScenario(scenarioId: ScenarioId, scaleName: ScaleName) {
  if (scenarioId === "double-pledge") {
    return { pack: doublePledgePack, scale: scaleName === "mini" ? pledgeMiniScale : pledgeScales[scaleName] };
  }
  const { generate, scale } = await loadPayoutScale(scaleName);
  return { pack: payoutChangePack(generate), scale };
}

async function evaluateRun(evaluator: EvaluatorModule, eventsPath: string, data: ScenarioData, out: string) {
  const log = await readFile(eventsPath, "utf8");
  const events = log.trimEnd().split("\n").map((line) => JSON.parse(line) as RunEvent);
  const summary = await evaluator.evaluate(events, data);
  await writeFile(join(out, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  return { summary, holdOutcomes: countHoldOutcomes(events) };
}

function sweepRow({ summary, holdOutcomes }: Awaited<ReturnType<typeof evaluateRun>>) {
  const {
    mode, tickMs, released, held, plantedHeld, plantedMissed, falseHolds, heldByTimeout,
    maxConcurrentLoops, modelCalls, wallMs,
  } = summary;
  return {
    mode, tickMs, released, held, plantedHeld, plantedMissed, falseHolds, heldByTimeout,
    ...holdOutcomes, maxConcurrentLoops, modelCalls, wallMs,
  };
}

async function sweep(
  out: string, ticks: number[], options: Omit<RunOptions, "runId" | "out" | "mode" | "tickMs">,
  evaluator: EvaluatorModule,
): Promise<void> {
  const rows: ReturnType<typeof sweepRow>[] = [];
  const note = options.inference.kind === "scripted" ? scriptedNote : undefined;
  if (note) console.log(note);
  for (const tickMs of ticks) {
    for (const mode of modes) {
      const runId = `${mode}-${tickMs}`;
      const runOut = join(out, runId);
      const result = await runScenario({ ...options, mode, tickMs, runId, out: runOut });
      rows.push(sweepRow(await evaluateRun(evaluator, result.eventsPath, options.data, runOut)));
    }
  }
  await writeFile(join(out, "sweep.json"), JSON.stringify({ note, rows }, null, 2) + "\n");
  console.table(rows);
  console.log(`Sweep folder ${out}`);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      scenario: { type: "string", default: "payout-change" },
      mode: { type: "string", default: "concurrent" },
      inference: { type: "string", default: "scripted" },
      provider: { type: "string" },
      model: { type: "string" },
      scale: { type: "string", default: "demo" },
      "tick-ms": { type: "string" },
      ticks: { type: "string" },
      "fail-policy": { type: "string", default: "hold" },
      "max-loops": { type: "string", default: "8" },
      out: { type: "string" },
    },
  });
  const [command] = positionals;
  if (positionals.length !== 1 || (command !== "run" && command !== "sweep")) {
    throw new Error("Expected the run or sweep command");
  }
  const scenarioId = choice(values.scenario, scenarios, "scenario");
  const kind = choice(values.inference, ["scripted", "live"] as const, "inference");
  const provider = values.provider && choice(values.provider, ["openrouter", "anthropic", "openai"] as const, "provider");
  const model = values.model?.trim();
  if (kind === "live" && (!provider || !model)) throw new Error("Live inference requires --provider and --model");
  const inference = kind === "live" && provider && model ? { kind, provider, model } : { kind: "scripted" as const };
  const scaleName = choice(values.scale, scales, "scale");
  const maxLoops = positiveInteger(values["max-loops"], "max-loops");
  const failPolicy = choice(values["fail-policy"], ["hold", "release"] as const, "fail-policy");

  const { pack, scale } = await loadScenario(scenarioId, scaleName);
  const data = pack.generate(scale);
  const options = { pack, data, inference, failPolicy, maxLoops };
  const minute = new Date().toISOString().slice(0, 16).replace(/[-:]/g, "");
  const evaluator = await optionalModule<EvaluatorModule>("./eval/evaluate");
  if (command === "sweep") {
    if (!values.ticks) throw new Error("Sweep requires --ticks with comma-separated tick lengths");
    const ticks = values.ticks.split(",").map((tick) => positiveInteger(tick.trim(), "ticks"));
    if (new Set(ticks).size !== ticks.length) throw new Error("Sweep tick lengths must be distinct");
    if (!evaluator) throw new Error("Sweep requires src/eval/evaluate.ts");
    const out = resolveOutputPath(values.out ?? join("runs", `${scenarioId}-sweep-${kind}-${minute}`));
    await sweep(out, ticks, options, evaluator);
    return;
  }

  const mode = choice(values.mode, modes, "mode");
  const tickMs = positiveInteger(values["tick-ms"] ?? (kind === "scripted" ? "1500" : "20000"), "tick-ms");
  const defaultId = `${scenarioId}-${mode}-${kind}-${minute}`;
  const out = resolveOutputPath(values.out ?? join("runs", defaultId));
  const runId = basename(out);
  const result = await runScenario({ ...options, runId, out, mode, tickMs });

  if (evaluator) {
    await evaluateRun(evaluator, result.eventsPath, data, out);
  } else {
    console.log("Evaluator is missing. summary.json was skipped.");
  }

  const held = result.ledger.holds.length;
  console.log(`${scenarioId} ${mode}/${kind} — ${result.ledger.items.length - held} released, ${held} held, ${result.maxConcurrentLoops} peak active loops.`);
  console.log(`Run folder ${out}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const exists = (error as NodeJS.ErrnoException | undefined)?.code === "EEXIST";
  console.error(exists ? "This run already has an event log. Choose a new --out folder." : makeScrubber()(message));
  process.exitCode = 1;
});
