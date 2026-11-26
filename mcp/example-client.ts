import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

const project = fileURLToPath(new URL("../", import.meta.url));
const client = new Client({ name: "payout-gate-example", version: "0.1.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", "tsx", "mcp/server.ts"],
  cwd: project,
  env: { TMPDIR: tmpdir(), TEMP: tmpdir() },
});

async function call(name: string, args: Record<string, unknown>) {
  const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
  if (result.isError || !result.structuredContent) throw new Error(JSON.stringify(result.content));
  return result.structuredContent;
}

try {
  await client.connect(transport);
  const batch = await call("check_payout_batch", { scenario: "payout-change", scale: "demo", seed: 11 });
  console.log(JSON.stringify(batch, null, 2));
  const held = batch.held as { itemId: string }[];
  if (held.length === 0) throw new Error("The demo returned no held items to explain.");
  const explanation = await call("explain_hold", { runId: batch.runId, itemId: held[0].itemId });
  console.log(JSON.stringify(explanation, null, 2));
} finally {
  await client.close();
}
