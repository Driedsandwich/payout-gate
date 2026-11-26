import type { SourceRef } from "../src/core/types.js";
import type { HeldItem, ReplayRun } from "./run-data.js";
import { outcomeLabel, resolutionAt } from "./state.js";
import { element, seconds } from "./timeline.js";

type Review = "Approve" | "Reject";
const reviews = new Map<string, Review>();

function section(title: string) {
  const block = element("section", "drawer-section");
  block.append(element("h3", "", title));
  return block;
}

function field(label: string, value: string, monospace = false) {
  const row = element("div");
  row.append(element("dt", "", label), element("dd", monospace ? "mono" : "", value));
  return row;
}

function sourceRows(sources: string[], citations: SourceRef[], values: ReplayRun["sourceRows"]) {
  const list = element("div", "quoted-rows");
  for (const source of new Set([...sources, ...citations.map((ref) => ref.source)])) {
    const row = element("section", "quoted-row");
    row.append(element("h4", "mono", source.replace(/^data\//, "")));
    const data = values[source];
    if (data) {
      const entries = element("dl");
      for (const [key, value] of Object.entries(data)) {
        if (key !== "id") entries.append(field(key, String(value), true));
      }
      row.append(entries);
    }
    const unmatched = new Map(citations.flatMap((ref) => {
      if (ref.source !== source || ref.field === undefined || ref.value === undefined) return [];
      if (data?.[ref.field] === ref.value) return [];
      const entry = [ref.field, ref.value] as const;
      return [[JSON.stringify(entry), entry] as const];
    }));
    if (unmatched.size) {
      row.append(element("p", "citation-label", "Additional field values quoted in the log"));
      const extra = element("dl");
      for (const [key, value] of unmatched.values()) extra.append(field(key, String(value), true));
      row.append(extra);
    }
    if (!data && !unmatched.size) row.append(element("p", "", "This reference has no quoted row values."));
    list.append(row);
  }
  return list;
}

export function showEvidence(
  dialog: HTMLDialogElement,
  hold: HeldItem,
  run: ReplayRun,
  time: number,
): void {
  const { words } = run;
  const isPayout = run.scenarioId === "payout-change";
  const itemLabel = words.item[0].toUpperCase() + words.item.slice(1);
  const subjectLabel = words.subject[0].toUpperCase() + words.subject.slice(1);
  const item = section(`${itemLabel} details`);
  const fields = element("dl", "payout-fields");
  const money = new Intl.NumberFormat("en", { style: "currency", currency: hold.currency }).format(hold.amountCents / 100);
  fields.append(
    field(subjectLabel, isPayout ? `${hold.subjectName} / ${hold.subjectId}` : hold.subjectName, true),
    field(itemLabel, `${hold.itemId} · ${hold.chunkId} · ${money}`, true),
  );
  if (isPayout) fields.append(field("Verified account on file", hold.accountOnFile ?? "Unavailable", true));
  else fields.append(field("Invoice record", hold.subjectId, true));
  fields.append(field("Account in the batch", hold.batchAccount, true));
  for (const request of hold.requests.filter((entry) => entry.time <= time)) {
    fields.append(field(`Account in request ${request.arrivalId}`, request.account, true));
  }
  item.append(fields);

  const gate = section(outcomeLabel(hold, time));
  const reasons = element("ul");
  reasons.append(...hold.reasons.map((reason) => element("li", "", reason)));
  gate.append(element("p", "mono", `Held at ${seconds(hold.time, 2)} elapsed`), reasons);
  const resolution = resolutionAt(hold, time);
  if (resolution?.reasons.length) {
    const review = element("ul");
    review.append(...resolution.reasons.map((reason) => element("li", "", reason)));
    gate.append(element("p", "mono resolution-time", `Reviewed at ${seconds(resolution.time, 2)} elapsed`), review);
  }

  const verdictBlock = section("Agent verdicts");
  const verdicts = hold.verdicts.filter((entry) => entry.time <= time);
  if (verdicts.length) {
    const list = element("ul", "verdicts");
    for (const verdict of verdicts) {
      const row = element("li");
      row.append(
        element("strong", "", run.lanes.find((lane) => lane.agent === verdict.by)?.label ?? verdict.by),
        element("span", `verdict ${verdict.value}`, verdict.value),
        element("span", "mono verdict-time", seconds(verdict.time, 2)),
        element("p", "", verdict.reason),
      );
      const refs = [...new Set(verdict.sources.map(({ source }) => source.replace(/^data\//, "")))];
      if (refs.length) row.append(element("p", "mono verdict-refs", refs.join(", ")));
      list.append(row);
    }
    verdictBlock.append(list);
  } else {
    verdictBlock.append(element("p", "", `No agent verdicts had been recorded for this ${words.item} at this point.`));
  }

  const notice = section("Hold notice");
  const recorded = hold.notices.filter((entry) => entry.time <= time);
  for (const entry of recorded) {
    const label = entry.origin === "cutoff" ? "Gate notice at cut-off"
      : entry.origin === "resolution" ? "Gate notice after review" : "Explainer notice";
    notice.append(element("h4", "", label), element("blockquote", "", entry.text));
  }
  if (!recorded.length) notice.append(element("p", "", "No hold notice had been recorded at this point."));

  const evidence = section("Source rows");
  evidence.append(sourceRows(
    hold.sources, [...hold.citations, ...(resolution?.citations ?? []), ...verdicts.flatMap((verdict) => verdict.sources)], run.sourceRows,
  ));

  const review = section("Simulate a review");
  const approveText = !isPayout ? "Approve simulates funding the request."
    : hold.accountOnFile
    ? `Approve pays the verified account on file (${hold.accountOnFile}).`
    : "Approve is unavailable without a verified account on file.";
  const rejectText = isPayout
    ? "Reject keeps the payout held and freezes account changes."
    : "Reject keeps funding on hold.";
  const actions = element("div", "review-actions");
  const approve = element("button", "approve", "Approve");
  const reject = element("button", "reject", "Reject");
  const feedback = element("p", "review-feedback");
  feedback.setAttribute("role", "status");
  approve.type = reject.type = "button";
  approve.disabled = isPayout && !hold.accountOnFile;
  const reviewId = `${run.summary.runId}/${hold.itemId}`;
  function displayReview() {
    const choice = reviews.get(reviewId);
    approve.setAttribute("aria-pressed", String(choice === "Approve"));
    reject.setAttribute("aria-pressed", String(choice === "Reject"));
    feedback.textContent = choice === "Approve"
      ? `Simulated approval recorded for ${hold.accountOnFile ?? hold.itemId}.`
      : choice === "Reject" ? `Simulated rejection recorded. ${rejectText}` : "";
  }
  for (const [button, choice] of [[approve, "Approve"], [reject, "Reject"]] as const) {
    button.addEventListener("click", () => {
      reviews.set(reviewId, choice);
      displayReview();
    });
  }
  displayReview();
  actions.append(approve, reject);
  review.append(
    element("p", "", `${approveText} ${rejectText} Nothing moves in this demo.`),
    actions, feedback,
  );

  const body = dialog.querySelector<HTMLElement>("#evidence-content")!;
  const reviewPanel = dialog.querySelector<HTMLElement>("#evidence-review")!;
  body.replaceChildren(item, gate, verdictBlock, notice, evidence);
  reviewPanel.hidden = resolution?.outcome === "cleared_late";
  reviewPanel.replaceChildren(review);
  body.scrollTop = 0;
  dialog.showModal();
}
