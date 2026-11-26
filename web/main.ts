import "../docs/design/palette.css";
import "./style.css";
import payoutConcurrent from "./public/runs/live/payout-change-t20/concurrent-20000.json";
import payoutSequential from "./public/runs/live/payout-change-t20/sequential-20000.json";
import pledgeConcurrent from "./public/runs/live/double-pledge-t20/concurrent-20000.json";
import pledgeSequential from "./public/runs/live/double-pledge-t20/sequential-20000.json";
import sweepData from "./public/sweeps/web-sweep.json";
import { PRODUCT_NAME, TAGLINE } from "./brand.js";
import { comparisonPair } from "./compare.js";
import type { HeldItem, ReplayRun } from "./run-data.js";
import { outcomeLabel, resolutionAt, snapshotAt } from "./state.js";
import type { CutoffSweep } from "./sweep-data.js";
import { renderSweep } from "./sweep.js";
import { buildTimeline, element, seconds, timelineEnd } from "./timeline.js";
import { showEvidence } from "./evidence.js";

const scenarios = {
  "payout-change": {
    concurrent: payoutConcurrent as ReplayRun,
    sequential: payoutSequential as ReplayRun,
    routes: { concurrent: "#replay", sequential: "#sequential", compare: "#compare" },
  },
  "double-pledge": {
    concurrent: pledgeConcurrent as ReplayRun,
    sequential: pledgeSequential as ReplayRun,
    routes: { concurrent: "#pledge", sequential: "#pledge-sequential", compare: "#pledge-compare" },
  },
};
type ScenarioId = keyof typeof scenarios;
const views = ["concurrent", "sequential", "compare"] as const;
type View = typeof views[number];
const at = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const slider = at<HTMLInputElement>("time");
const play = at<HTMLButtonElement>("play");
const scenarioSwitch = at<HTMLSelectElement>("scenario");
const tableBody = at<HTMLTableSectionElement>("hold-rows");
const dialog = at<HTMLDialogElement>("evidence");
let run: ReplayRun;
let drawTimeline: (time: number) => void;
let time = 0;
let selectionId: string | undefined;
let listedHolds: HeldItem[] | undefined;
let evidenceTrigger: HTMLElement | undefined;
let frame: number | undefined;

const number = new Intl.NumberFormat("en");
document.title = `${PRODUCT_NAME} — ${TAGLINE}`;
at("product-name").textContent = PRODUCT_NAME;
at("tagline").textContent = TAGLINE;

function inferenceLabel({ inference, tickMs }: ReplayRun["started"]) {
  const live = /^live:([^:]+):(.+)$/.exec(inference);
  if (live) {
    const [, provider, model] = live;
    const names: Record<string, string> = { openrouter: "OpenRouter", openai: "OpenAI", anthropic: "Anthropic" };
    return `Live run · ${model} via ${names[provider] ?? provider}, ${seconds(tickMs, tickMs % 1000 ? 3 : 0)} cut-offs`;
  }
  return `Inference · ${inference}, ${number.format(tickMs)} ms cut-offs`;
}

function renderHeadline(concurrent: ReplayRun, sequential?: ReplayRun) {
  const { summary, lanes, scenarioId } = concurrent;
  const payout = scenarioId === "payout-change";
  const action = payout ? "paid" : "funded";
  const planted = payout ? "takeovers" : "double pledges";
  const baseline = sequential ? `, while the same agents ${action} ${number.format(sequential.summary.released)} on time running one loop at a time` : "";
  at("headline").replaceChildren(
    "With ",
    element("strong", "", `${number.format(lanes.length)} agents running up to ${number.format(summary.maxConcurrentLoops)} loops at once`),
    `, ${number.format(summary.released)} of ${number.format(summary.items)} ${concurrent.words.items} ${payout ? "left" : "were funded"} on their cut-off and ${number.format(summary.plantedHeld)} of ${number.format(summary.scale.planted)} planted ${planted} were held${baseline}.`,
  );
}

function loadReplay(replay: ReplayRun, concurrent: ReplayRun, sequential?: ReplayRun) {
  run = replay;
  time = run.duration;
  selectionId = run.holds.find((hold) => !hold.timeout)?.itemId;
  listedHolds = undefined;
  stop();
  const { summary, words } = run;
  const mode = summary.mode === "concurrent" ? "Concurrent" : "Sequential";
  renderHeadline(concurrent, sequential);
  at("replay-provenance").textContent = `${mode} replay · ${inferenceLabel(run.started)}`;
  at("scenario-title").textContent = run.scenarioTitle;
  at("stats").setAttribute("aria-label", `${words.item} counts at the replay position`);
  at("holds-title").textContent = `Held ${words.items}`;
  at("hold-subject").textContent = words.subject[0].toUpperCase() + words.subject.slice(1);
  at("unread-key").hidden = run.unread.length === 0;
  const lastTick = run.ticks.at(-1);
  at("cutoff").textContent = lastTick ? seconds(lastTick.cutoff) : "—";
  slider.max = String(run.duration);
  drawTimeline = buildTimeline(at("main-chart"), run, timelineEnd(run));
  render();
}

function itemWord(count: number) {
  return count === 1 ? run.words.item : run.words.items;
}

function shortSource(source: string): string {
  return source.replace(/^data\//, "");
}

function sourceText(hold: HeldItem): string {
  const resolution = resolutionAt(hold, time);
  return [...new Set([...hold.sources, ...(resolution?.sources ?? [])])].map(shortSource).join(", ");
}

function fillSelection(hold?: HeldItem) {
  at("selection-title").textContent = hold ? `Selected hold: ${hold.subjectName} / ${hold.subjectId}` : "No holds at this time";
  const sources = hold ? sourceText(hold) : "";
  at("selection-sources").textContent = sources;
  at("selection-sources").title = sources;
  const resolution = hold && resolutionAt(hold, time);
  let reason = resolution?.reasons[0] ?? hold?.reasons[0] ?? "";
  if (hold?.accountOnFile && !hold.timeout) {
    const request = hold.requests.filter((entry) => entry.time <= time).at(-1);
    if (hold.batchAccount !== hold.accountOnFile) {
      reason = `Batch account ${hold.batchAccount} differs from the verified account ${hold.accountOnFile}.`;
    } else if (request && request.account !== hold.accountOnFile) {
      reason = `Requested account ${request.account} differs from the verified account ${hold.accountOnFile}.`;
    }
  }
  at("selection-reason").textContent = reason;
}

function highlight(hold?: HeldItem) {
  fillSelection(hold);
  for (const row of tableBody.rows) {
    if (row.dataset.itemId && row.dataset.itemId === hold?.itemId) row.dataset.selected = "true";
    else delete row.dataset.selected;
  }
}

function holdRow(hold: HeldItem) {
  const row = element("tr");
  row.dataset.itemId = hold.itemId;
  const subject = element("th", "hold-subject mono", hold.subjectName);
  subject.scope = "row";
  const status = element("td");
  const statusLabel = element("span", "status-label");
  const mark = element("span", "mark held");
  mark.setAttribute("aria-hidden", "true");
  statusLabel.append(mark, "Held");
  status.append(statusLabel);
  const outcome = element("td", "hold-outcome");
  const sources = element("td", "mono");
  sources.append(element("span", "row-sources"));
  const action = element("td", "evidence-action");
  const open = element("button", "text-button", "Open evidence");
  open.type = "button";
  open.setAttribute("aria-label", `Open evidence for ${hold.subjectName}`);
  open.addEventListener("click", () => {
    stop();
    selectionId = hold.itemId;
    highlight(hold);
    evidenceTrigger = open;
    showEvidence(dialog, hold, run, time);
  });
  action.append(open);
  row.append(subject, status, outcome, sources, action);
  return row;
}

function drawHolds(holds: HeldItem[]) {
  const start = listedHolds?.length ?? 0;
  const extendsList = start > 0 && listedHolds?.every((hold, i) => hold === holds[i]);
  if (extendsList) {
    tableBody.append(...holds.slice(start).map(holdRow));
  } else if (holds.length) {
    tableBody.replaceChildren(...holds.map(holdRow));
  } else if (!listedHolds || start > 0) {
    const row = element("tr");
    const cell = row.insertCell();
    cell.colSpan = 5;
    cell.className = "empty";
    cell.textContent = `No ${run.words.items} have been held at this point in the replay.`;
    tableBody.replaceChildren(row);
  }
  for (const [index, hold] of holds.entries()) {
    const row = tableBody.rows[index];
    const outcome = row.cells[2];
    const label = outcomeLabel(hold, time);
    if (outcome.textContent !== label) outcome.textContent = label;
    const references = row.querySelector<HTMLElement>(".row-sources")!;
    const sources = sourceText(hold);
    if (references.textContent !== sources) {
      references.textContent = sources;
      references.title = sources;
    }
  }
  listedHolds = holds;
  at("table-count").textContent = `${number.format(holds.length)} ${itemWord(holds.length)}`;
  highlight(holds.find((hold) => hold.itemId === selectionId) ?? holds[0]);
}

function render() {
  slider.value = String(time);
  slider.setAttribute("aria-valuetext", `${seconds(time)} elapsed`);
  at("elapsed").textContent = `${seconds(time)} / ${seconds(run.duration)}`;
  drawTimeline(time);
  const snapshot = snapshotAt(run, time);
  at("sent").textContent = number.format(snapshot.sent);
  at("held").textContent = number.format(snapshot.held);
  at("waiting").textContent = number.format(snapshot.waiting);
  drawHolds(snapshot.holds);
}

function stop() {
  if (frame !== undefined) cancelAnimationFrame(frame);
  frame = undefined;
  play.textContent = time >= run.duration ? "▶ Replay" : "▶ Play";
}

play.addEventListener("click", () => {
  if (frame !== undefined) {
    stop();
    return;
  }
  const { duration } = run;
  if (time >= duration) time = 0;
  const start = performance.now() - time;
  function advance(now: number) {
    time = Math.min(now - start, duration);
    render();
    if (time < duration) frame = requestAnimationFrame(advance);
    else stop();
  }
  play.textContent = "Ⅱ Pause";
  render();
  frame = requestAnimationFrame(advance);
});

slider.addEventListener("input", () => {
  time = slider.valueAsNumber;
  stop();
  render();
});

dialog.addEventListener("close", () => evidenceTrigger?.focus());

function renderComparison(
  scenario: typeof scenarios[ScenarioId],
  pair: ReturnType<typeof comparisonPair>,
) {
  at("compare-title").textContent = `Compare runs · ${scenario.concurrent.scenarioTitle}`;
  at("live-comparison").hidden = !pair;
  at("missing-comparison").hidden = Boolean(pair);
  if (!pair) return;
  const [concurrent, sequential] = pair;
  const [first, second] = pair.map((replay) => inferenceLabel(replay.started));
  at("compare-provenance").textContent = first === second ? first : `Concurrent · ${first} / Sequential · ${second}`;
  const payout = concurrent.scenarioId === "payout-change";
  const latency = (replay: ReplayRun, percentile: "median" | "p90") =>
    replay.modelLatencyMs ? seconds(replay.modelLatencyMs[percentile], 2) : "—";
  const unresolved = ({ holds }: ReplayRun) => {
    const pending = holds.filter(({ resolution }) => resolution?.outcome === "unresolved");
    return [
      element("span", "mono", number.format(pending.length)),
      ...pending.map(({ itemId, resolution }) =>
        element("p", "unresolved-reason", `${itemId} · ${resolution!.reasons.join(" ")}`)),
    ];
  };
  const metrics: Array<[string, (replay: ReplayRun) => string | number | HTMLElement[]]> = [
    ["Cut-off interval", ({ summary }) => `${number.format(summary.tickMs)} ms`],
    [payout ? "Paid on their cut-off" : "Funded on their cut-off", ({ summary }) => summary.released],
    [payout ? "Clean payouts paid late" : "Clean requests funded late", ({ holdOutcomes }) => holdOutcomes.clearedLate],
    [payout ? "Takeovers held" : "Double pledges held", ({ summary }) => summary.plantedHeld],
    ["Held at cut-off, confirmed later", ({ holdOutcomes }) => holdOutcomes.confirmedLate],
    ["Holds left unresolved", unresolved],
    ["Peak concurrent loops", ({ summary }) => summary.maxConcurrentLoops],
    ["Model calls", ({ summary }) => summary.modelCalls],
    ["Median model latency", (replay) => latency(replay, "median")],
    ["90th percentile model latency", (replay) => latency(replay, "p90")],
    ["Wall time", ({ summary }) => seconds(summary.wallMs, 2)],
  ];
  at("metrics-rows").replaceChildren(...metrics.map(([label, value]) => {
    const row = element("tr");
    const header = element("th", "", label);
    header.scope = "row";
    row.append(header, ...pair.map((replay) => {
      const result = value(replay);
      const cell = element("td");
      if (Array.isArray(result)) cell.append(...result);
      else cell.append(element("span", "mono", typeof result === "number" ? number.format(result) : result));
      return cell;
    }));
    return row;
  }));
  const end = timelineEnd(concurrent, sequential);
  const charts = [
    ["Concurrent", concurrent, scenario.routes.concurrent],
    ["Sequential", sequential, scenario.routes.sequential],
  ] as const;
  at("compare-charts").replaceChildren(...charts.map(([label, replay, href]) => {
    const chart = element("section", "compare-chart");
    const header = element("div", "compare-chart-header");
    const chartTitle = element("h3", "", label);
    const link = element("a", "", `Replay ${label.toLowerCase()}`);
    link.href = href;
    header.append(chartTitle, link);
    const mount = element("div");
    chart.setAttribute("aria-label", `${label} lanes for ${replay.lanes.map(({ label }) => label).join(", ")}`);
    buildTimeline(mount, replay, end, true);
    chart.append(header, mount);
    return chart;
  }));
}

function currentRoute(): { scenarioId: ScenarioId; view: View } {
  for (const scenarioId of Object.keys(scenarios) as ScenarioId[]) {
    const view = views.find((candidate) => scenarios[scenarioId].routes[candidate] === location.hash);
    if (view) return { scenarioId, view };
  }
  return { scenarioId: "payout-change", view: "concurrent" };
}

function navigate(focus: boolean) {
  const { scenarioId, view } = currentRoute();
  const scenario = scenarios[scenarioId];
  const pair = comparisonPair(scenario.concurrent, scenario.sequential);
  const compare = view === "compare";
  scenarioSwitch.value = scenarioId;
  if (compare) {
    if (run) stop();
    renderComparison(scenario, pair);
  } else if (run !== scenario[view]) {
    loadReplay(scenario[view], scenario.concurrent, pair?.[1]);
  }
  at("replay-view").hidden = compare;
  at("compare-view").hidden = !compare;
  at("playback").hidden = compare;
  const link = at<HTMLAnchorElement>("view-link");
  const back = run?.scenarioId === scenarioId ? run.summary.mode : "concurrent";
  link.href = scenario.routes[compare ? back : "compare"];
  link.textContent = compare ? "Back to replay" : "Compare runs";
  if (focus && document.activeElement !== scenarioSwitch) {
    if (compare) at("compare-title").focus();
    else play.focus();
  }
}

scenarioSwitch.addEventListener("change", () => {
  const scenario = scenarios[scenarioSwitch.value as ScenarioId];
  const { view } = currentRoute();
  location.hash = scenario.routes[view === "compare" ? "compare" : "concurrent"];
});
window.addEventListener("hashchange", () => navigate(true));
renderSweep(at("cutoff-sweep"), sweepData as CutoffSweep);
navigate(false);
