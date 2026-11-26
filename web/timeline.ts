import type { GateWait, Lane, ReplayRun, Segment } from "./run-data.js";

export type TimelineRun = Pick<ReplayRun, "duration" | "lanes" | "ticks" | "waits" | "unread" | "words">;

export function seconds(ms: number, digits = 1): string {
  return `${(ms / 1000).toFixed(digits)} s`;
}

export function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", value?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined) node.textContent = value;
  return node;
}

function taskLabel(task: string): string {
  try {
    const fields = JSON.parse(task) as Record<string, unknown>;
    const parts = Object.values(fields).filter((part): part is string => typeof part === "string");
    return parts.join(" / ") || task;
  } catch {
    return task;
  }
}

function tracks(lane: Lane) {
  const ends: number[] = [];
  const placed = lane.segments.map((segment) => {
    let track = ends.findIndex((end) => end <= segment.start);
    if (track === -1) track = ends.length;
    ends[track] = segment.end;
    return { segment, track };
  });
  return { placed, count: ends.length || 1 };
}

export function timelineEnd(...runs: TimelineRun[]): number {
  return Math.max(1, ...runs.map((run) => Math.max(run.duration, (run.ticks.at(-1)?.cutoff ?? 0) * 1.065)));
}

type Span = { node: HTMLElement; start: number; end: number };

export function buildTimeline(mount: HTMLElement, run: TimelineRun, end: number, compact = false) {
  const chart = element("div", `chart${compact ? " compact" : ""}`);
  const axis = element("div", "chart-axis mono");
  const lines = element("div", "chart-lines");
  lines.setAttribute("aria-hidden", "true");
  const plot = element("div", "chart-plot");
  const spans: Span[] = [];
  const position = (time: number) => `${time / end * 100}%`;
  const finalTick = run.ticks.at(-1);
  const cursor = element("div", "time-cursor");
  const inspection = compact ? undefined : element("p", "loop-detail mono");
  if (inspection) inspection.hidden = true;

  function addTick(time: number, label?: string, isFinal = false) {
    const x = position(time);
    const line = element("div", isFinal ? "tick-line cutoff-line" : "tick-line");
    line.style.left = x;
    lines.append(line);
    if (label) {
      const timeLabel = element("span", `tick-label${time === 0 ? " zero-label" : ""}`, label);
      timeLabel.style.left = x;
      axis.append(timeLabel);
    }
    if (isFinal && !compact) {
      const cutoff = element("span", "cutoff-label", run.words.cutoff);
      cutoff.style.left = x;
      axis.append(cutoff);
    }
  }

  addTick(0, "0 s");
  run.ticks.forEach((tick, i) => {
    const isFinal = tick === finalTick;
    const shouldLabel = isFinal || (!compact && i % Math.ceil(run.ticks.length / 8) === 0);
    addTick(tick.cutoff, shouldLabel ? seconds(tick.cutoff, tick.cutoff % 1000 ? 1 : 0) : undefined, isFinal);
  });
  if (compact && end > (finalTick?.cutoff ?? 0) * 1.3) addTick(end, seconds(end, 0));
  if (!compact) lines.append(cursor);

  function describe(node: HTMLElement, label: string) {
    node.title = label;
    node.setAttribute("aria-label", label);
    if (inspection) {
      const show = () => {
        inspection.textContent = label;
        inspection.hidden = false;
      };
      const hide = () => { inspection.hidden = true; };
      node.addEventListener("focus", show);
      node.addEventListener("blur", hide);
      node.addEventListener("pointerenter", show);
      node.addEventListener("pointerleave", () => {
        if (document.activeElement !== node) hide();
      });
      if (node instanceof HTMLButtonElement) node.addEventListener("click", show);
    }
  }

  function addSpan(node: HTMLElement, time: Pick<Segment, "start" | "end">, label: string) {
    node.style.left = position(time.start);
    describe(node, label);
    spans.push({ node, ...time });
  }

  function addGateWait(wait: GateWait, lane: HTMLElement) {
    const node = element(compact ? "span" : "button", "gate-wait");
    if (node instanceof HTMLButtonElement) node.type = "button";
    addSpan(node, wait, `Gate wait for ${wait.chunkId} · due at ${seconds(wait.dueMs)}`);
    lane.append(node);
  }

  const gateLane = run.waits.find((wait) => wait.agent)?.agent ?? run.lanes[0]?.agent;
  const marks: Array<{ node: HTMLElement; time: number }> = [];
  for (const lane of run.lanes) {
    const { agent, label } = lane;
    const name = element("div", "lane-label", label);
    const row = element("div", "lane-plot");
    const { placed, count } = tracks(lane);
    for (const { segment, track } of placed) {
      const node = element(compact ? "span" : "button", "loop");
      if (node instanceof HTMLButtonElement) node.type = "button";
      node.style.setProperty("--track", String(track));
      node.style.setProperty("--track-count", String(count));
      addSpan(node, segment, `${label} · ${taskLabel(segment.task)}`);
      row.append(node);
    }
    for (const wait of run.waits) {
      if ((wait.agent ?? gateLane) === agent) addGateWait(wait, row);
    }
    for (const { time, arrivalId, agent: actor } of run.unread) {
      if ((actor ?? gateLane) !== agent) continue;
      const mark = element(compact ? "span" : "button", "unread-mark");
      if (mark instanceof HTMLButtonElement) mark.type = "button";
      mark.style.left = position(time);
      describe(mark, `${arrivalId} · Message unread at cut-off. It named nobody and stopped nothing.`);
      marks.push({ node: mark, time });
      row.append(mark);
    }
    plot.append(name, row);
  }
  plot.append(lines);
  chart.append(axis, plot);
  if (inspection) chart.append(inspection);
  mount.replaceChildren(chart);

  function render(time: number): void {
    for (const mark of marks) mark.node.hidden = mark.time > time;
    for (const span of spans) {
      span.node.hidden = span.start > time;
      if (!span.node.hidden) span.node.style.width = position(Math.min(span.end, time) - span.start);
    }
    cursor.style.left = position(Math.min(time, end));
    cursor.classList.toggle("near-cutoff", Boolean(finalTick && Math.abs(time - finalTick.cutoff) / end < 0.002));
  }
  render(run.duration);
  return render;
}
