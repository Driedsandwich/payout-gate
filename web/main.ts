import "../docs/design/palette.css";
import "./style.css";
import concurrentData from "./public/runs/web-concurrent.json";
import sequentialData from "./public/runs/web-sequential.json";
import sweepData from "./public/sweeps/web-sweep.json";
import type { RunSummary, SourceRef } from "../src/core/types.js";
import { PRODUCT_NAME, TAGLINE } from "./brand.js";
import type { HeldItem, ReplayRun } from "./run-data.js";
import { outcomeLabel, resolutionAt, snapshotAt } from "./state.js";
import type { CutoffSweep } from "./sweep-data.js";
import { renderSweep } from "./sweep.js";
import { buildTimeline, element, seconds, timelineEnd } from "./timeline.js";
import { showEvidence } from "./evidence.js";

const concurrent = concurrentData as ReplayRun;
const sequential = sequentialData as ReplayRun;
const at = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const slider = at<HTMLInputElement>("time");
const play = at<HTMLButtonElement>("play");
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

function loadReplay(replay: ReplayRun) {
  run = replay;
  time = run.duration;
  selectionId = run.holds.find((hold) => !hold.timeout)?.itemId;
  listedHolds = undefined;
  stop();
  const { summary, words } = run;
  const timeoutClause = summary.heldByTimeout ? ` (${number.format(summary.heldByTimeout)} at the cut-off)` : "";
  const overlap = summary.maxConcurrentLoops === 1
    ? "One agent loop ran at a time"
    : `Up to ${number.format(summary.maxConcurrentLoops)} agent loops ran at the same time`;
  at("headline").replaceChildren(
    element("strong", "", overlap),
    `, with ${number.format(summary.released)} of ${number.format(summary.items)} ${itemWord(summary.items)} sent on their cut-offs and ${number.format(summary.held)} held${timeoutClause}.`,
  );
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

const metrics: Array<[string, (s: RunSummary) => string | number]> = [
  ["Cut-off interval", (s) => `${number.format(s.tickMs)} ms`],
  ["On time", (s) => s.released],
  ["Held", (s) => s.held],
  ["Held by timeout", (s) => s.heldByTimeout],
  ["Missed takeovers", (s) => s.plantedMissed],
  ["Peak concurrent loops", (s) => s.maxConcurrentLoops],
  ["Model calls", (s) => s.modelCalls],
  ["Wall time", (s) => seconds(s.wallMs, 2)],
];

function renderComparison() {
  const summaries = [concurrent.summary, sequential.summary];
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
  renderSweep(at("cutoff-sweep"), sweepData as CutoffSweep);
  const end = timelineEnd(concurrent, sequential);
  for (const [label, replay, href] of [["Concurrent", concurrent, "#replay"], ["Sequential", sequential, "#sequential"]] as const) {
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
    at("compare-charts").append(chart);
  }
}

function navigate(focus: boolean) {
  const compare = location.hash === "#compare";
  if (compare) stop();
  else {
    const next = location.hash === "#sequential" ? sequential : concurrent;
    if (run !== next) loadReplay(next);
  }
  at("replay-view").hidden = compare;
  at("compare-view").hidden = !compare;
  at("playback").hidden = compare;
  const link = at<HTMLAnchorElement>("view-link");
  link.href = compare ? (run === sequential ? "#sequential" : "#replay") : "#compare";
  link.textContent = compare ? "Back to replay" : "Compare runs";
  if (focus) {
    if (compare) at("compare-title").focus();
    else play.focus();
  }
}

window.addEventListener("hashchange", () => navigate(true));
loadReplay(location.hash === "#sequential" ? sequential : concurrent);
renderComparison();
navigate(false);
