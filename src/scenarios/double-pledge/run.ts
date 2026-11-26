import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { makeScrubber } from "../../core/eventlog.js";
import { runScenario } from "../../core/orchestrator.js";
import { resolveOutputPath } from "../../core/repository.js";
import type { RunEvent } from "../../core/types.js";
import { evaluate } from "../../eval/evaluate.js";
import { SCALES } from "./generate.js";
import { doublePledgePack } from "./pack.js";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      mode: { type: "string", default: "concurrent" },
      scale: { type: "string", default: "demo" },
      "tick-ms": { type: "string", default: "1500" },
      out: { type: "string" },
    },
  });
  const { mode, scale } = values;
  if (mode !== "concurrent" && mode !== "sequential") throw new Error("--mode must be concurrent or sequential");
  if (scale !== "demo" && scale !== "full") throw new Error("--scale must be demo or full");
  const tickMs = Number(values["tick-ms"]);
  if (!/^\d+$/.test(values["tick-ms"]) || !Number.isSafeInteger(tickMs) || tickMs < 1) {
    throw new Error("--tick-ms must be a positive integer");
  }
  if (!values.out?.trim()) throw new Error("--out is required");

  const out = resolveOutputPath(values.out);
  const runId = basename(out);
  const data = doublePledgePack.generate(SCALES[scale]);
  const { eventsPath } = await runScenario({
    runId, out, pack: doublePledgePack, data, mode, tickMs,
    inference: { kind: "scripted" }, failPolicy: "hold", maxLoops: 8,
  });
  const events = (await readFile(eventsPath, "utf8")).trimEnd().split("\n")
    .map((line) => JSON.parse(line) as RunEvent);
  const summary = JSON.stringify(evaluate(events, data), null, 2);
  await writeFile(join(out, "summary.json"), summary + "\n");
  console.log(summary);
}

void main().catch((error: unknown) => {
  console.error(makeScrubber()(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
