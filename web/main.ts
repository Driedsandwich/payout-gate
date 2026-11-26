import "../docs/design/palette.css";
import "./style.css";
import concurrentData from "./public/runs/web-concurrent.json";
import {
  duration as sequentialDuration, lanes as sequentialLanes, summary as sequentialSummary,
  ticks as sequentialTicks, waits as sequentialWaits,
} from "./public/runs/web-sequential.json";
import type { RunSummary, SourceRef } from "../src/core/types.js";
import type { HeldPayout, ReplayRun } from "./run-data.js";
import { snapshotAt } from "./state.js";
import { agentLabel, buildTimeline, element, seconds, timelineEnd } from "./timeline.js";
import { showEvidence } from "./evidence.js";

const run = concurrentData as ReplayRun;
const sequential = {
  summary: sequentialSummary as RunSummary, duration: sequentialDuration,
  lanes: sequentialLanes, ticks: sequentialTicks, waits: sequentialWaits,
};
const duration = run.duration;
const at = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const slider = at<HTMLInputElement>("time");
const play = at<HTMLButtonElement>("play");
const tableBody = at<HTMLTableSectionElement>("hold-rows");
const dialog = at<HTMLDialogElement>("evidence");
const preferredHold = run.holds.find((hold) => !hold.timeout)?.itemId;
let time = duration;
let selectionId = preferredHold;
let listedHolds: HeldPayout[] | undefined;
let evidenceTrigger: HTMLElement | undefined;
let frame: number | undefined;

const { summary } = run;
const number = new Intl.NumberFormat("en");
const payoutWord = (n: number) => n === 1 ? "payout" : "payouts";
const timeoutClause = summary.heldByTimeout ? ` (${number.format(summary.heldByTimeout)} at timeout)` : "";
at("headline").append(
  element("strong", "", `Up to ${number.format(summary.maxConcurrentLoops)} agent loops ran at the same time`),
  `, with ${number.format(summary.released)} of ${number.format(summary.items)} payouts sent on their cut-offs and ${number.format(summary.held)} held${timeoutClause}.`,
);
at("cutoff").textContent = run.ticks.length ? seconds(run.ticks.at(-1)!.cutoff) : "—";
slider.max = String(duration);

const drawTimeline = buildTimeline(at("main-chart"), run, timelineEnd(run));

function shortSource(source: string): string {
  return source.replace(/^data\//, "");
}

function sourceText(sources: string[]): string {
  return sources.map(shortSource).join(", ");
}

function fillSelection(hold?: HeldPayout) {
  at("selection-title").textContent = hold ? `Selected hold: ${hold.creator} / ${hold.subjectId}` : "No holds at this time";
  at("selection-sources").textContent = hold ? sourceText(hold.sources) : "";
  at("selection-sources").title = hold ? sourceText(hold.sources) : "";
  let reason = hold?.reasons[0] ?? "";
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

function highlight(hold?: HeldPayout) {
  fillSelection(hold);
  for (const row of tableBody.rows) {
    if (row.dataset.itemId && row.dataset.itemId === hold?.itemId) row.dataset.selected = "true";
    else delete row.dataset.selected;
  }
}

function holdRow(hold: HeldPayout) {
  const row = element("tr");
  row.dataset.itemId = hold.itemId;
  const creator = element("th", "creator mono", hold.creator);
  creator.scope = "row";
  const status = element("td");
  const statusLabel = element("span", "status-label");
  const mark = element("span", "mark held");
  mark.setAttribute("aria-hidden", "true");
  statusLabel.append(mark, hold.timeout ? "Held · timeout" : "Held");
  status.append(statusLabel);
  const sources = element("td", "mono");
  const references = element("span", "row-sources", sourceText(hold.sources));
  references.title = references.textContent!;
  sources.append(references);
  const action = element("td", "evidence-action");
  const open = element("button", "text-button", "Open evidence");
  open.type = "button";
  open.setAttribute("aria-label", `Open evidence for ${hold.creator}`);
  open.addEventListener("click", () => {
    stop();
    selectionId = hold.itemId;
    highlight(hold);
    evidenceTrigger = open;
    showEvidence(dialog, hold, run.sourceRows, time);
  });
  action.append(open);
  row.append(creator, status, sources, action);
  return row;
}

function drawHolds(holds: HeldPayout[]) {
  const start = listedHolds?.length ?? 0;
  const extendsList = listedHolds?.every((hold, i) => hold === holds[i]);
  if (extendsList && holds.length === start) {
    fillSelection(holds.find((hold) => hold.itemId === selectionId) ?? holds[0]);
    return;
  }
  if (extendsList && start > 0) {
    tableBody.append(...holds.slice(start).map(holdRow));
  } else if (holds.length) {
    tableBody.replaceChildren(...holds.map(holdRow));
  } else {
    const row = element("tr");
    const cell = row.insertCell();
    cell.colSpan = 4;
    cell.className = "empty";
    cell.textContent = "No payouts have been held at this point in the replay.";
    tableBody.replaceChildren(row);
  }
  listedHolds = holds;
  at("table-count").textContent = `${number.format(holds.length)} ${payoutWord(holds.length)}`;
  highlight(holds.find((hold) => hold.itemId === selectionId) ?? holds[0]);
}

function render() {
  slider.value = String(time);
  slider.setAttribute("aria-valuetext", `${seconds(time)} elapsed`);
  at("elapsed").textContent = `${seconds(time)} / ${seconds(duration)}`;
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
  play.textContent = time >= duration ? "▶ Replay" : "▶ Play";
}

play.addEventListener("click", () => {
  if (frame !== undefined) {
    stop();
    return;
  }
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

const metrics: Array<[string, (s: RunSummary) => string | number]> = [
  ["On time", (s) => s.released],
  ["Held", (s) => s.held],
  ["Held by timeout", (s) => s.heldByTimeout],
  ["Missed takeovers", (s) => s.plantedMissed],
  ["Peak concurrent loops", (s) => s.maxConcurrentLoops],
  ["Model calls", (s) => s.modelCalls],
  ["Wall time", (s) => seconds(s.wallMs, 2)],
];

function renderComparison() {
  const summaries = [summary, sequential.summary];
  for (const [label, value] of metrics) {
    const row = element("tr");
    const header = element("th", "", label);
    header.scope = "row";
    row.append(header, ...summaries.map((s) => {
      const result = value(s);
      return element("td", "mono", typeof result === "number" ? number.format(result) : result);
    }));
    at("metrics-rows").append(row);
  }
  at("compare-note").hidden = !summaries.some((s) => s.inference === "scripted");
  const end = timelineEnd(run, sequential);
  for (const [label, replay] of [["Concurrent", run], ["Sequential", sequential]] as const) {
    const chart = element("section", "compare-chart");
    const chartTitle = element("h3", "", label);
    const mount = element("div");
    chart.setAttribute("aria-label", `${label} lanes for ${replay.lanes.map(({ agent }) => agentLabel(agent)).join(", ")}`);
    buildTimeline(mount, replay, end, true);
    chart.append(chartTitle, mount);
    at("compare-charts").append(chart);
  }
}

function navigate(focus: boolean) {
  const compare = location.hash === "#compare";
  if (compare) stop();
  at("replay-view").hidden = compare;
  at("compare-view").hidden = !compare;
  at("playback").hidden = compare;
  const link = at<HTMLAnchorElement>("view-link");
  link.href = compare ? "#replay" : "#compare";
  link.textContent = compare ? "Back to replay" : "Compare runs";
  if (focus) {
    if (compare) at("compare-title").focus();
    else play.focus();
  }
}

window.addEventListener("hashchange", () => navigate(true));
render();
renderComparison();
navigate(false);
