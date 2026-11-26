// 使い捨ての試し 2（作品に写さない）: ①同じ係に 2 本のループ ②推論の例外の出どころ ③ループの終わりを出来事で拾う ④本物の LLM で道具の 1 往復
import { defineRuntime, RuntimeState, createAgent, createHuman, SituationSpecification,
  FunctionCallItem, ModelMessageItem, OpenAIChatCompletions, supportedModels } from "@mozaik-ai/core"
const ORM = process.env.OR_MODEL || "deepseek/deepseek-v4.1-flash-1017"
const base = supportedModels.find(m => m.specification.name === "deepseek-v4-flash")
const orModel = { endpoint: new OpenAIChatCompletions(undefined, { baseURL: "https://openrouter.ai/api/v1", apiKey: process.env.OPENROUTER_API_KEY }), specification: { ...base.specification, name: ORM, provider: "openrouter" } }

const mode = process.argv[2] || "mock"
const t0 = Date.now(); const ms = () => Date.now() - t0
const sleep = (n) => new Promise(r => setTimeout(r, n))
process.on("unhandledRejection", (e) => { console.log("UNHANDLED_REJECTION", String(e).slice(0, 200)) })
process.on("uncaughtException", (e) => { console.log("UNCAUGHT", String(e).slice(0, 200)) })

class S extends RuntimeState { rows = { "R-7": { amount: 1250, currency: "EUR" } } }
let calls = 0
const mock = {
  async run(input) {
    calls++
    await sleep(30)
    const items = input.context.getItems()
    const users = items.filter(i => i.type === "message" && i.role === "user").map(i => i.content.text)
    if (users.some(u => u.includes("THROW"))) throw new Error("runner boom")
    const last = items[items.length - 1]
    if (last?.type === "function_call_output") return { items: [ModelMessageItem.rehydrate({ text: "users-seen=" + users.join("|") })], tokenUsage: undefined, rowResponse: null }
    return { items: [FunctionCallItem.rehydrate({ callId: "c" + calls, name: "get_row", args: JSON.stringify({ id: "R-7" }) })], tokenUsage: undefined, rowResponse: null }
  }, async *stream() {},
}
const { initializeRuntime, resolveRuntime, join, runLoop } = defineRuntime()
initializeRuntime({ state: new S(), inferenceRunnerConfig: mode === "mock" ? { runner: mock } : { supportedModels: [orModel] } })
const getRow = { type: "function", name: "get_row", description: "Look up a synthetic ledger row by id. Returns amount, currency and the source row id.", strict: false,
  parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  async invoke({ id }) { const r = resolveRuntime().state.rows[id]; return JSON.stringify(r ? { ...r, source: "synthetic-ledger.csv#" + id } : { error: "no such row" }) } }

const ev = []
const answers = new Map()
class Any extends SituationSpecification { isSatisfiedBy() { return true } }
const obs = createHuman({ name: "Obs", capabilities: [], handlers: [{ specification: new Any(), processor: { apply({ event }) {
  const p = event.payload || {}
  ev.push([ms(), event.type, p.loopId || ""])
  if (event.type === "model.answer") answers.set(event.producerId + ":" + ms(), p.answer?.content?.text)
} } }] })
const a = createAgent({ name: "A", capabilities: [], instruction: "Use the get_row tool to look up the row the user names, then answer in one sentence with the amount and the source id. Never invent numbers.", tools: [getRow], handlers: [] })
join(obs); join(a)
const model = mode === "mock" ? "gpt-5.5" : ORM
const inp = () => ({ model, context: a.getMemory().getContext(), tools: a.getTools() })
if (mode === "mock") {
  runLoop(a.getId(), "first R-7", inp())
  runLoop(a.getId(), "second R-7", inp())
  await sleep(400)
  runLoop(a.getId(), "THROW please", inp())
  await sleep(300)
} else {
  runLoop(a.getId(), "What is the amount of row R-7?", inp())
  for (let i = 0; i < 300 && answers.size === 0; i++) await sleep(100)
}
const types = {}; for (const e of ev) types[e[1]] = (types[e[1]] || 0) + 1
const ctxTypes = a.getMemory().getContext().getItems().map(i => i.type + (i.role ? ":" + i.role : ""))
console.log(JSON.stringify({ mode, ms: ms(), answers: [...answers.values()].map(s => (s || "").slice(0, 300)), types, loopIds: [...new Set(ev.map(e => e[2]).filter(Boolean))].length, ctxTypes }))
process.exit(0)
