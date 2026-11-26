import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { RunEvent } from "../../src/core/types.js";

export async function readRunEvents(directory: string): Promise<RunEvent[]> {
  let log: string;
  try {
    log = await readFile(join(directory, "events.jsonl"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    log = gunzipSync(await readFile(join(directory, "events.jsonl.gz"))).toString("utf8");
  }
  return log.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
}
