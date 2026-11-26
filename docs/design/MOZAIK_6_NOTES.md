# Notes on @mozaik-ai/core 6.0.0 (measured on 2026-11-26)

The project pins `@mozaik-ai/core` to exactly `6.0.0` (the version the official examples pin). The public docs site
still describes v4; the type definitions in `reference/mozaik-core-6.0.0.index.d.ts` are the source of truth.
The v5 loop API (`createLoop`, `setBreakpoint`, `advanceLoop`, `endLoop`) does not exist in 6.0.0.

API used here: `defineRuntime<State>()` → `{ initializeRuntime, resolveRuntime, join, leave, sendMessage, sendEvent, runLoop }`,
`RuntimeState` (subclass it for shared state), `createAgent`, `createHuman`, `SituationSpecification`,
`InterceptionHandler { isSatisfiedBy(transition), handle(transition) }`, `FunctionCallItem.rehydrate`,
`ModelMessageItem.rehydrate`, `ModelContext.create()`, `DeveloperMessageItem.create`, `OpenAIChatCompletions`, `supportedModels`.

## What we measured (scripts in `reference/`)

| check | result |
|---|---|
| two agents, `runLoop` on both, custom `InferenceRunner` via `initializeRuntime({ inferenceRunnerConfig: { runner } })` | both loops overlap from the first event; exit 0 |
| gate: `InterceptionHandler` on `function_call` of the release tool waits for a verdict another agent writes into `RuntimeState` | correct account → tool runs (1 release); wrong account → handler returns `{ nextStateId: "model_message", input: { answer } }`, the tool never runs (0 releases) |
| two `runLoop` calls on the SAME agent memory context | the loops mix: each final answer saw both user messages. Rule: one task = one loop with a fresh `ModelContext` |
| runner throws | no Mozaik event is published; only an unhandled promise rejection. Rule: wrap every runner and emit `inference.failed` |
| end of a loop | `model.answer` event from the agent (payload has `loopId`) |
| live round trip, OpenRouter `deepseek/deepseek-v4.1-flash-1017` through `OpenAIChatCompletions` with `baseURL: https://openrouter.ai/api/v1` and a custom model spec copied from the built-in `deepseek-v4-flash` spec | tool call → tool output → answer with the number and its source, about 2.5 s |
| live round trip, built-in Gemini endpoint (`gemini-3.5-flash-lite`) | second call fails: "Function call is missing a thought_signature in functionCall parts" (400) |
| no `MOZAIK_API_KEY` | prints "mozaik cloud: no API key — telemetry disabled" and runs normally |

Mozaik Cloud (the hosted live view) needs an account and `npx @mozaik-ai/cloud-sdk pair`; it is not part of the judging criteria
and is not required to run anything in this repository.
