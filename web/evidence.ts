import type { SourceRef } from "../src/core/types.js";
import type { HeldPayout, ReplayRun } from "./run-data.js";
import { agentLabel, element, seconds } from "./timeline.js";

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
  hold: HeldPayout,
  values: ReplayRun["sourceRows"],
  time: number,
): void {
  const item = section("Payout details");
  const fields = element("dl", "payout-fields");
  const money = new Intl.NumberFormat("en", { style: "currency", currency: hold.currency }).format(hold.amountCents / 100);
  fields.append(
    field("Creator", `${hold.creator} / ${hold.subjectId}`, true),
    field("Payout", `${hold.itemId} · ${hold.chunkId} · ${money}`, true),
    field("Verified account on file", hold.accountOnFile ?? "Unavailable", true),
    field("Account in the batch", hold.batchAccount, true),
  );
  for (const request of hold.requests.filter((entry) => entry.time <= time)) {
    fields.append(field(`Account in request ${request.arrivalId}`, request.account, true));
  }
  item.append(fields);

  const gate = section(hold.timeout ? "Held by timeout" : "Gate decision");
  const reasons = element("ul");
  reasons.append(...hold.reasons.map((reason) => element("li", "", reason)));
  gate.append(element("p", "mono", `Held at ${seconds(hold.time, 2)} elapsed`), reasons);

  const verdictBlock = section("Agent verdicts");
  const verdicts = hold.verdicts.filter((entry) => entry.time <= time);
  if (verdicts.length) {
    const list = element("ul", "verdicts");
    for (const verdict of verdicts) {
      const row = element("li");
      row.append(
        element("strong", "", agentLabel(verdict.by)),
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
    verdictBlock.append(element("p", "", "No agent verdicts had been recorded for this payout at this point."));
  }

  const notice = section("Hold notice");
  const text = hold.notices.filter((entry) => entry.time <= time).at(-1)?.text;
  notice.append(text
    ? element("blockquote", "", text)
    : element("p", "", "No hold notice had been recorded at this point."));

  const evidence = section("Source rows");
  evidence.append(sourceRows(hold.sources, [...hold.citations, ...verdicts.flatMap((verdict) => verdict.sources)], values));

  const review = section("Simulate a review");
  const approveText = hold.accountOnFile
    ? `Approve pays the verified account on file (${hold.accountOnFile}).`
    : "Approve is unavailable without a verified account on file.";
  const actions = element("div", "review-actions");
  const approve = element("button", "approve", "Approve");
  const reject = element("button", "reject", "Reject");
  const feedback = element("p", "review-feedback");
  feedback.setAttribute("role", "status");
  approve.type = reject.type = "button";
  approve.disabled = !hold.accountOnFile;
  function displayReview() {
    const choice = reviews.get(hold.itemId);
    approve.setAttribute("aria-pressed", String(choice === "Approve"));
    reject.setAttribute("aria-pressed", String(choice === "Reject"));
    feedback.textContent = choice === "Approve"
      ? `Simulated approval recorded for ${hold.accountOnFile}.`
      : choice === "Reject" ? "Simulated rejection recorded. Account changes are frozen in this simulation." : "";
  }
  for (const [button, choice] of [[approve, "Approve"], [reject, "Reject"]] as const) {
    button.addEventListener("click", () => {
      reviews.set(hold.itemId, choice);
      displayReview();
    });
  }
  displayReview();
  actions.append(approve, reject);
  review.append(
    element("p", "", `${approveText} Reject keeps the payout held and freezes account changes. Nothing moves in this demo.`),
    actions, feedback,
  );

  const body = dialog.querySelector<HTMLElement>("#evidence-content")!;
  const reviewPanel = dialog.querySelector<HTMLElement>("#evidence-review")!;
  body.replaceChildren(item, gate, verdictBlock, notice, evidence);
  reviewPanel.replaceChildren(review);
  body.scrollTop = 0;
  dialog.showModal();
}
