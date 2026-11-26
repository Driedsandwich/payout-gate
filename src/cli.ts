import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { makeScrubber } from "./core/eventlog.js";
import { runScenario } from "./core/orchestrator.js";
import type { RunEvent, RunSummary, ScenarioData, ScenarioPack, Scale } from "./core/types.js";
import { payoutChangePack } from "./scenarios/payout-change/pack.js";

const scales = ["demo", "full", "mini"] as const;
type ScaleName = typeof scales[number];
type GeneratorModule = { generate: ScenarioPack["generate"]; SCALES: Record<ScaleName, Scale> };
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
      "fail-policy": { type: "string", default: "hold" },
      "max-loops": { type: "string", default: "8" },
      out: { type: "string" },
    },
  });
  if (positionals.length !== 1 || positionals[0] !== "run") throw new Error("Expected the run command");
  const scenarioId = choice(values.scenario, ["payout-change"] as const, "scenario");
  const mode = choice(values.mode, ["concurrent", "sequential"] as const, "mode");
  const kind = choice(values.inference, ["scripted", "live"] as const, "inference");
  const provider = values.provider && choice(values.provider, ["openrouter", "anthropic", "openai"] as const, "provider");
  const model = values.model?.trim();
  if (kind === "live" && (!provider || !model)) throw new Error("Live inference requires --provider and --model");
  const inference = kind === "live" && provider && model ? { kind, provider, model } : { kind: "scripted" as const };
  const scaleName = choice(values.scale, scales, "scale");
  const tickMs = positiveInteger(values["tick-ms"] ?? (kind === "scripted" ? "1500" : "20000"), "tick-ms");
  const maxLoops = positiveInteger(values["max-loops"], "max-loops");
  const failPolicy = choice(values["fail-policy"], ["hold", "release"] as const, "fail-policy");

  let generator = await optionalModule<GeneratorModule>("./scenarios/payout-change/generate");
  if (!generator) {
    if (scaleName === "full") throw new Error("The full scale requires src/scenarios/payout-change/generate.ts");
    const { MINI_SCALE, payoutMini } = await import("../test/fixtures/payout-mini.js");
    console.log("Generator is missing. Using the mini fixture.");
    generator = { generate: payoutMini, SCALES: { demo: MINI_SCALE, mini: MINI_SCALE, full: MINI_SCALE } };
  }
  const pack = payoutChangePack(generator.generate);
  const data = pack.generate(generator.SCALES[scaleName]);
  const minute = new Date().toISOString().slice(0, 16).replace(/[-:]/g, "");
  const defaultId = `${scenarioId}-${mode}-${kind}-${minute}`;
  const out = resolve(values.out ?? join("runs", defaultId));
  const runId = basename(out);
  const result = await runScenario({ runId, out, pack, data, mode, inference, tickMs, failPolicy, maxLoops });

  const evaluator = await optionalModule<EvaluatorModule>("./eval/evaluate");
  if (evaluator) {
    const log = await readFile(result.eventsPath, "utf8");
    const events = log.trimEnd().split("\n").map((line) => JSON.parse(line) as RunEvent);
    const summary = await evaluator.evaluate(events, data);
    await writeFile(join(out, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
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
