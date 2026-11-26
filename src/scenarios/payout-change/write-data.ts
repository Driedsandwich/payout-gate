import { mkdir, writeFile } from "node:fs/promises";
import { generate, SCALES } from "./generate.js";

const directory = new URL("../../../data/payout-change/", import.meta.url);
await mkdir(directory, { recursive: true });
for (const [name, scale] of Object.entries(SCALES)) {
  const path = new URL(`${name}.json`, directory);
  await writeFile(path, `${JSON.stringify(generate(scale), null, 2)}\n`, "utf8");
}
