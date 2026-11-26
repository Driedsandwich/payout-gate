import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema, ListToolsRequestSchema, ToolSchema, type CallToolResult, type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { checkInput, explainInput, generatedInput, suppliedInput, summaryInput, validateData } from "./input.js";

const workspace = mkdtempSync(resolve(tmpdir(), "payout-mcp-"));
process.once("exit", () => {
  process.chdir(dirname(workspace));
  rmSync(workspace, { recursive: true, force: true });
});
// The shared event logger inspects its environment and Mozaik's Cloud client looks for a local .env.
process.env = {};
process.chdir(workspace);
// Core 6.0.0 emits this warning on every loop when its telemetry is intentionally disabled.
const warn = console.warn;
console.warn = (message, ...args) => {
  if (typeof message === "string" && message.startsWith("mozaik cloud: no API key — telemetry disabled.")) return;
  warn(message, ...args);
};
const { createRuns, generateDemo, note } = await import("./payout-runs.js");
const runs = createRuns(workspace);

const instructions = "Call check_payout_batch before releasing a payout batch; do not release items it returns as held.";
const server = new Server(
  { name: "payout-gate", version: "0.1.0" },
  { capabilities: { tools: {} }, instructions },
);

function inputSchema(schema: z.ZodType): Tool["inputSchema"] {
  return ToolSchema.shape.inputSchema.parse({ ...z.toJSONSchema(schema, { target: "draft-07", io: "input" }), type: "object" });
}

const tools: Tool[] = [
  {
    name: "check_payout_batch",
    description: `${instructions} Check the generated demo or supply a synthetic payout-change dataset.`,
    inputSchema: inputSchema(checkInput),
  },
  {
    name: "explain_hold",
    description: `${instructions} Use explain_hold to read a held item's notice, verdicts, and source references.`,
    inputSchema: inputSchema(explainInput),
  },
  {
    name: "get_run_summary",
    description: `${instructions} Use get_run_summary to retrieve the evaluated totals for a completed run.`,
    inputSchema: inputSchema(summaryInput),
  },
];

function parse<S extends z.ZodType>(schema: S, args: unknown): z.output<S> {
  const result = schema.safeParse(args);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const message = issue.code === "unrecognized_keys" ? "Unexpected field." : issue.message;
  throw new Error(`Invalid ${issue.path.join(".") || "arguments"}. ${message}`);
}

function success(data: Record<string, unknown>): CallToolResult {
  const content: CallToolResult["content"] = [{ type: "text", text: JSON.stringify(data) }];
  if (data.note !== note) content.push({ type: "text", text: note });
  return { content, structuredContent: data };
}

server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  const args = params.arguments ?? {};
  try {
    switch (params.name) {
      case "check_payout_batch": {
        if ("data" in args) {
          const { data } = parse(suppliedInput, args);
          validateData(data);
          return success(await runs.check(data));
        }
        const { seed } = parse(generatedInput, args);
        return success(await runs.check(generateDemo(seed)));
      }
      case "explain_hold": {
        const { runId, itemId } = parse(explainInput, args);
        return success(runs.explain(runId, itemId));
      }
      case "get_run_summary": {
        const { runId } = parse(summaryInput, args);
        return success({ ...runs.summary(runId) });
      }
      default:
        throw new Error("Unknown payout tool.");
    }
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text", text: error instanceof Error ? error.message : "The payout tool failed." }],
    };
  }
});

await server.connect(new StdioServerTransport());
