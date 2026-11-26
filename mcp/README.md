# Payout gate MCP server

Install the project dependencies with `npm ci` using Node.js 22 or newer. Run `npm run mcp:example` to start the server over stdio, check the demo batch, and print the explanation for its first held item.

## Register over stdio

Use the following generic launch configuration in your MCP client. Replace the project path with the absolute path to this checkout. If the client expects a different outer config structure, copy the `command` and `args` into its stdio server entry. The silent npm flag keeps the launch banner off the protocol stream.

```json
{
  "mcpServers": {
    "payout-gate": {
      "command": "npm",
      "args": ["--silent", "--prefix", "/absolute/path/to/payout-gate", "run", "mcp:start"]
    }
  }
}
```

## Call the tools

Call `check_payout_batch` before releasing a payout batch. Do not release items it returns as held.

- `check_payout_batch` accepts `{}` for the generated demo, optionally with `scenario: "payout-change"`, `scale: "demo"`, and an integer `seed`. To supply a batch, pass `{ "data": … }` using the payout-change `ScenarioData` fields. Include the `creators`, `master`, `change_log`, and `history` tables, synthetic `ACCT-NNNN` references, a chunk for every item, and each arrival's `atTick`. Fractional arrival ticks are supported.
- `explain_hold` takes `runId` and `itemId` and returns the hold notice, verdicts, and source references. The verdict list is empty when a deadline hold has no recorded verdicts.
- `get_run_summary` takes `runId` and returns the evaluated run summary.

All runs use concurrent scripted inference and hold uncertain items at their deadline. The last 20 completed runs are available in memory for the life of the server. Each run's event log is created in an OS temporary directory and deleted when processing finishes. Use synthetic data only. Not financial advice. Nothing moves.
