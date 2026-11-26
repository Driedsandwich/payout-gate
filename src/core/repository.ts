import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = fileURLToPath(new URL("../..", import.meta.url));
// Compiled entry points live under dist/src and use the same repository root.
const repositoryRoot = existsSync(join(sourceRoot, "package.json")) ? sourceRoot : dirname(sourceRoot);

export function resolveOutputPath(path: string): string {
  return resolve(repositoryRoot, path);
}
