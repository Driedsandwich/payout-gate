// 使い捨ての試し（作品に写さない）: core 6.0.0 で 2 体の同時・共有の状態・門・自前の推論
import { defineRuntime, RuntimeState, createAgent, createHuman, SituationSpecification, Agent,
  FunctionCallItem, ModelMessageItem, ModelContext } from "@mozaik-ai/core"

const t0 = Date.now(); const ms = () => Date.now() - t0
const sleep = (n) => new Promise(r => setTimeout(r, n))
const WRONG = process.argv[2] === "wrong"

class AppState extends RuntimeState { verdicts = new Map(); log = []; payouts = [] }

// 自前の推論: 文脈の最後の品目で決まった答えを返す（鍵なし）
const runner = {
  async run(input) {
    await sleep(40)
    const items = input.context.getItems()
    const last = items[items.length - 1]
    const name = input.tools?.[0]?.name
    if (last?.type === "function_call_output") {
      return { items: [ModelMessageItem.rehydrate({ text: "done" })], tokenUsage: undefined, rowResponse: null }
    }
    const args = name === "release_payout" ? { id: "P-1", iban: WRONG ? "XX99" : "DE01" }
               : { id: "P-1", master_iban: "DE01" }
    return { items: [FunctionCallItem.rehydrate({ callId: "c-" + name, name, args: JSON.stringify(args) })], tokenUsage: undefined, rowResponse: null }
  },
  async *stream() {},
}

const { initializeRuntime, resolveRuntime, join, runLoop } = defineRuntime()
initializeRuntime({ state: new AppState(), inferenceRunnerConfig: { runner } })
const st = () => resolveRuntime().state

const release = { type: "function", name: "release_payout", description: "release", strict: false,
  parameters: { type: "object", properties: { id: { type: "string" }, iban: { type: "string" } } },
  async invoke(a) { st().payouts.push(a); st().log.push([ms(), "PAYOUT", a.iban]); return "released" } }
const check = { type: "function", name: "check_master", description: "check", strict: false,
  parameters: { type: "object", properties: { id: { type: "string" }, master_iban: { type: "string" } } },
  async invoke(a) { st().log.push([ms(), "CHECK start"]); await sleep(300); st().verdicts.set(a.id, a.master_iban); st().log.push([ms(), "CHECK done"]); return "ok" } }

const payer = createAgent({ name: "Payer", capabilities: [], instruction: "pay", tools: [release], handlers: [] })
const checker = createAgent({ name: "Checker", capabilities: [], instruction: "check", tools: [check], handlers: [] })
let blocked = 0
const gate = {
  isSatisfiedBy: (t) => t.nextStateId === "function_call" && t.input.call.name === "release_payout",
  async handle(t) {
    const a = JSON.parse(t.input.call.args)
    st().log.push([ms(), "GATE wait"])
    while (!st().verdicts.has(a.id)) await sleep(10)
    if (st().verdicts.get(a.id) !== a.iban) {
      blocked++; st().log.push([ms(), "GATE block"])
      // 道具を走らせずに答えへ替える
      return { nextStateId: "model_message", input: { answer: ModelMessageItem.rehydrate({ text: "blocked: iban mismatch" }) } }
    }
    st().log.push([ms(), "GATE pass"]); return t
  },
}
const events = []
class Any extends SituationSpecification { isSatisfiedBy() { return true } }
const obs = createHuman({ name: "Obs", capabilities: [], handlers: [{ specification: new Any(), processor: { apply({ event }) { events.push([ms(), event.producerId.slice(0, 6), event.type]) } } }] })
join(obs); join(payer); join(checker)
const inp = (a) => ({ model: "gpt-5.5", context: a.getMemory().getContext(), tools: a.getTools() })
runLoop(payer.getId(), "pay P-1", inp(payer), gate)
runLoop(checker.getId(), "check P-1", inp(checker))
await sleep(1200)
console.log(JSON.stringify({ wrong: WRONG, payouts: st().payouts, blocked, log: st().log, nEvents: events.length, types: [...new Set(events.map(e => e[2]))] }))
process.exit(st().payouts.length === (WRONG ? 0 : 1) ? 0 : 1)
