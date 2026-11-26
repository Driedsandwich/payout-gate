import { SWEEP_MODES, type CutoffSweep, type SweepPoint } from "./sweep-data.js";
import { element } from "./timeline.js";

const labels = { concurrent: "Concurrent", sequential: "Sequential" };
const format = new Intl.NumberFormat("en");

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, number | string> = {}) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  return node;
}

function marker(mode: SweepPoint["mode"], x: number, y: number) {
  if (mode === "concurrent") return svg("circle", { class: "sweep-point", cx: x, cy: y, r: 5 });
  return svg("polygon", { class: "sweep-point", points: `${x},${y - 4} ${x + 4},${y} ${x},${y + 4} ${x - 4},${y}` });
}

function chartFor(rows: SweepPoint[]) {
  const chart = svg("svg", { class: "sweep-plot", viewBox: "0 0 500 158", role: "img", "aria-labelledby": "sweep-plot-title" });
  const title = svg("title", { id: "sweep-plot-title" });
  title.textContent = "Payouts paid on time by cut-off interval and mode. Exact counts are in the table below.";
  chart.append(title);

  const left = 40;
  const right = 470;
  const top = 12;
  const bottom = 113;
  const ticks = [...new Set(rows.map((row) => row.tickMs))];
  const first = Math.min(...ticks);
  const last = Math.max(...ticks);
  const peak = Math.max(...rows.map((row) => row.released));
  const step = Math.max(1, Math.ceil(peak / 400)) * 100;
  const limit = Math.max(step, Math.ceil(peak / step) * step);
  const x = (tick: number) => last === first ? (left + right) / 2 : left + (tick - first) / (last - first) * (right - left);
  const y = (paid: number) => bottom - paid / limit * (bottom - top);

  for (let paid = 0; paid <= limit; paid += step) {
    const yPos = y(paid);
    chart.append(svg("line", { class: "sweep-grid", x1: left, x2: right, y1: yPos, y2: yPos }));
    const axisCount = svg("text", { x: left - 8, y: yPos + 4, "text-anchor": "end" });
    axisCount.textContent = format.format(paid);
    chart.append(axisCount);
  }
  for (const tick of ticks) {
    const text = svg("text", { x: x(tick), y: bottom + 18, "text-anchor": "middle" });
    text.textContent = format.format(tick);
    chart.append(text);
  }
  const axisLabel = svg("text", { x: (left + right) / 2, y: 151, "text-anchor": "middle" });
  axisLabel.textContent = "Cut-off interval (ms)";
  chart.append(axisLabel);

  const points = svg("g");
  for (const mode of SWEEP_MODES) {
    const series = rows.filter((row) => row.mode === mode).sort((a, b) => a.tickMs - b.tickMs);
    const coords = series.map((row) => `${x(row.tickMs)},${y(row.released)}`).join(" ");
    chart.append(svg("polyline", { class: `sweep-line ${mode}`, points: coords }));
    const group = svg("g", { class: mode });
    for (const row of series) {
      const point = marker(mode, x(row.tickMs), y(row.released));
      const detail = svg("title");
      detail.textContent = `${labels[mode]} · ${row.tickMs} ms · ${row.released} paid on time`;
      point.append(detail);
      group.append(point);
    }
    points.append(group);
  }
  chart.append(points);
  return chart;
}

export function renderSweep(section: HTMLElement, sweep: CutoffSweep) {
  const figure = element("figure", "sweep-figure");
  const caption = element("figcaption", "sweep-caption");
  const legend = element("ul", "sweep-legend");
  for (const mode of SWEEP_MODES) {
    const item = element("li");
    const key = svg("svg", { class: mode, viewBox: "0 0 26 14", width: 26, height: 14, "aria-hidden": "true" });
    key.append(svg("line", { class: "sweep-line", x1: 1, x2: 25, y1: 7, y2: 7 }), marker(mode, 13, 7));
    item.append(key, labels[mode]);
    legend.append(item);
  }
  const metric = sweep.started?.scenarioId === "payout-change" ? "Black Friday payouts paid on time" : "Payouts paid on time";
  caption.append(element("strong", "", metric), legend);
  figure.append(caption, chartFor(sweep.rows));

  const table = element("table", "metrics sweep-table");
  table.createCaption().textContent = "Cut-off sweep counts";
  table.caption!.className = "visually-hidden";
  const header = table.createTHead().insertRow();
  for (const label of ["Cut-off", "Mode", "On time", "Planted takeovers held", "Clean payouts paid late"]) {
    const cell = element("th", "", label);
    cell.scope = "col";
    header.append(cell);
  }
  const body = table.createTBody();
  for (const point of sweep.rows) {
    const row = body.insertRow();
    row.append(
      element("td", "mono", `${format.format(point.tickMs)} ms`),
      element("td", "", labels[point.mode]),
      ...[point.released, point.plantedHeld, point.clearedLate].map((count) => element("td", "mono", format.format(count))),
    );
  }
  if (sweep.note) section.append(element("p", "compare-note", sweep.note));
  const results = element("div", "sweep-results");
  results.append(figure, table);
  section.append(results);
}
