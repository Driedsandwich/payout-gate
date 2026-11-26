import { mkdir, writeFile } from "node:fs/promises";
import { generate, SCALES } from "./generate.js";

const output = new URL("../../../data/double-pledge/", import.meta.url);
await mkdir(output, { recursive: true });
await Promise.all(Object.entries(SCALES).map(([name, scale]) => {
  const json = JSON.stringify(generate(scale), null, 2);
  return writeFile(new URL(`${name}.json`, output), `${json}\n`, "utf8");
}));
