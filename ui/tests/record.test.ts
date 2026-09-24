import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createSSRApp } from "vue";
import { renderToString } from "vue/server-renderer";

import { STATUSES, type Posting } from "../../src/schema.ts";
import type { AppConfig } from "../src/config.ts";
import type { DecidedOutcome } from "../src/posting.ts";
import {
  emptyLabel,
  filteredRecord,
  orderedRecord,
  RecordView,
  statusCounts,
} from "../src/record.ts";
import {
  cardIn,
  changeButton,
  isDisabled,
  mountUnderAppRoot,
  outcomeButton,
} from "./card-queries.ts";
import {
  allNodes,
  click,
  elementsWithClass,
  mountTree,
  patchBody,
  patchedOne,
  settled,
  stubFetch,
  textOf,
  type TreeNode,
} from "./render-tree.ts";

function render(component: object, props: Record<string, unknown>): Promise<string> {
  return renderToString(createSSRApp(component, props));
}

function posting(key: string, overrides: Partial<Posting> = {}): Posting {
  return {
    key,
    company: key.split("::")[0] ?? key,
    platform: "greenhouse",
    board: "acme",
    title: "Engineer",
    url: null,
    location: null,
    comp_low: null,
    comp_high: null,
    posted_at: null,
    first_seen: "2026-09-15T00:00:00Z",
    last_seen: "2026-09-15T00:00:00Z",
    live: null,
    body: null,
    kept: true,
    reasons: [],
    evidence: {},
    judged_with: null,
    status: null,
    applied_at: null,
    status_at: null,
    note: null,
    body_hash: null,
    workplace: null,
    ...overrides,
  };
}

const CONFIG: AppConfig = {
  url: "https://project.supabase.co",
  anonKey: "anon-key",
  statuses: [...STATUSES],
};
const ACCESS_TOKEN = "user-jwt";

test("filteredRecord with no filters returns every posting", () => {
  const a = posting("acme::1");
  const b = posting("beta::1", { company: "Beta" });
  assert.deepEqual(filteredRecord([a, b], { status: "", company: "", title: "" }), [a, b]);
});

test("filteredRecord narrows by status exactly", () => {
  const applied = posting("acme::1", { status: "applied" });
  const rejected = posting("acme::2", { status: "rejected" });
  assert.deepEqual(
    filteredRecord([applied, rejected], { status: "applied", company: "", title: "" }),
    [applied],
  );
});

test("filteredRecord narrows by company, case-insensitively", () => {
  const acme = posting("acme::1", { company: "Acme Corp" });
  const beta = posting("beta::1", { company: "Beta Inc" });
  assert.deepEqual(filteredRecord([acme, beta], { status: "", company: "acme", title: "" }), [
    acme,
  ]);
});

test("filteredRecord narrows by title, case-insensitively", () => {
  const staff = posting("acme::1", { title: "Staff Engineer" });
  const manager = posting("acme::2", { title: "Engineering Manager" });
  assert.deepEqual(filteredRecord([staff, manager], { status: "", company: "", title: "staff" }), [
    staff,
  ]);
});

test("filteredRecord combines all three filters", () => {
  const match = posting("acme::1", { company: "Acme", title: "Staff Engineer", status: "applied" });
  const wrongStatus = posting("acme::2", {
    company: "Acme",
    title: "Staff Engineer",
    status: "rejected",
  });
  const wrongCompany = posting("beta::1", {
    company: "Beta",
    title: "Staff Engineer",
    status: "applied",
  });
  assert.deepEqual(
    filteredRecord([match, wrongStatus, wrongCompany], {
      status: "applied",
      company: "acme",
      title: "staff",
    }),
    [match],
  );
});

test("RecordView renders the three filters and one card per posting", async () => {
  const a = posting("acme::1", { company: "Acme" });
  const b = posting("beta::1", { company: "Beta" });

  const html = await render(RecordView, {
    postings: [a, b],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
  });

  assert.match(html, /<select/);
  assert.match(html, /type="search"/g);
  assert.match(html, /Acme/);
  assert.match(html, /Beta/);
});

test("RecordView's rows offer only the outcomes that make sense from their own status, not all five", async () => {
  // Record passes no `outcomes` of its own; `PostingCard` reads it off each
  // posting's status.
  const interviewing = posting("acme::1", {
    company: "Acme",
    status: "interviewing",
    status_at: "2026-09-14T00:00:00Z",
  });
  const html = await render(RecordView, {
    postings: [interviewing],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
  });
  // The row also auto-selects into the pane, so this reads the list row
  // alone.
  const list = html.match(/class="list">([^]*?)<\/div><aside/)?.[1] ?? "";
  const labels = [
    ...list.matchAll(/<button[^>]*class="[^"]*\bact\b[^"]*"[^>]*title="([^"]+)"/g),
  ].map((m) => m[1]);
  assert.deepEqual(labels, ["Offer", "Rejected", "Closed"]);
});

test("RecordView shows the empty state when nothing is kept at all", async () => {
  const html = await render(RecordView, {
    postings: [],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
  });

  assert.match(html, /class="empty"/);
  assert.match(html, /Nothing matches/);
});

test("orderedRecord puts acted-on postings first, most recent act first, then the untouched by the queue's order", () => {
  const now = Date.parse("2026-09-15T12:00:00Z");
  const oldAct = posting("a::1", { status: "applied", status_at: "2026-09-01T00:00:00Z" });
  const newAct = posting("b::1", { status: "closed", status_at: "2026-09-14T00:00:00Z" });
  const richUntouched = posting("c::1", {
    comp_low: 300_000,
    comp_high: 300_000,
    posted_at: "2026-09-15",
  });
  const modestUntouched = posting("d::1", {
    comp_low: 150_000,
    comp_high: 150_000,
    posted_at: "2026-09-15",
  });
  assert.deepEqual(
    orderedRecord([modestUntouched, oldAct, richUntouched, newAct], 150_000, now).map((p) => p.key),
    ["b::1", "a::1", "c::1", "d::1"],
  );
});

test("RecordView folds its filters under a summary and says its place on an untouched row", async () => {
  const untouched = posting("a::1", { company: "Acme", first_seen: "2026-09-01T00:00:00Z" });
  const html = await render(RecordView, {
    postings: [untouched],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
  });
  assert.match(html, /<details class="filters"><summary>Filters<!---->/);
  assert.match(html, /class="status tag tone-neutral">In queue</);
  assert.match(html, /class="age"[^>]*>for \d+ days</);
});

test("a Record row's status-age still reads as days-since-status, unchanged, alongside the new posting age", async () => {
  const acted = posting("a::1", {
    company: "Acme",
    status: "applied",
    status_at: "2026-09-08T00:00:00Z",
    posted_at: "2026-09-01T00:00:00Z",
  });
  const html = await render(RecordView, {
    postings: [acted],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
  });
  // Only that the status-age wording is untouched and a separate
  // posting-age line has appeared beside it.
  assert.match(html, /class="age"[^>]*>for \d+ days</);
  assert.match(html, /class="age posted-age"[^>]*>posted \d+ days ago</);
});

test('filteredRecord\'s "queue" status matches the rows with none', () => {
  const untouched = posting("a::1");
  const applied = posting("b::1", { status: "applied" });
  assert.deepEqual(
    filteredRecord([untouched, applied], { status: "queue", company: "", title: "" }),
    [untouched],
  );
});

test("statusCounts counts each status and the rows with none as queue", () => {
  const counts = statusCounts([
    posting("a::1"),
    posting("b::1"),
    posting("c::1", { status: "applied" }),
  ]);
  assert.equal(counts.get("queue"), 2);
  assert.equal(counts.get("applied"), 1);
  assert.equal(counts.get("closed"), undefined);
});

test("emptyLabel names the status when it alone emptied the list", () => {
  assert.equal(
    emptyLabel({ status: "applied", company: "", title: "" }),
    "No postings marked Applied yet.",
  );
  assert.equal(emptyLabel({ status: "queue", company: "", title: "" }), "Nothing is in the queue.");
  assert.equal(emptyLabel({ status: "applied", company: "acme", title: "" }), "Nothing matches.");
  assert.equal(emptyLabel({ status: "", company: "", title: "" }), "Nothing matches.");
});

test("RecordView's status options carry their counts, In queue among them", async () => {
  const html = await render(RecordView, {
    postings: [posting("a::1"), posting("b::1", { status: "applied" })],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
  });
  assert.match(html, /<option value="">All \(2\)<\/option>/);
  assert.match(html, /<option value="queue">In queue \(1\)<\/option>/);
  assert.match(html, /<option value="applied">Applied \(1\)<\/option>/);
  assert.match(html, /<option value="closed">Closed \(0\)<\/option>/);
});

test("RecordView auto-selects the first row of filtered into the pane with no prior interaction", async () => {
  const acted = posting("a::1", {
    company: "Acme",
    status: "applied",
    status_at: "2026-09-14T00:00:00Z",
  });
  const untouched = posting("b::1", { company: "Beta" });
  const html = await render(RecordView, {
    postings: [untouched, acted],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
  });
  const pane = html.match(/<aside class="detail-pane"[^]*$/)?.[0] ?? "";
  assert.notEqual(pane, "", "the pane renders");
  assert.match(pane, /Acme/);
  assert.doesNotMatch(pane, /Beta/);
});

test("an empty filter result renders no master-detail pane at all", async () => {
  // The filters are internal refs seeded to "", so an SSR render reaches
  // an empty `filtered` only through an empty `postings` prop.
  const html = await render(RecordView, {
    postings: [],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
  });
  assert.doesNotMatch(html, /class="master-detail"/);
  assert.doesNotMatch(html, /class="detail-pane"/);
});

test("no list card carries aria-current when paneMode is false, even though the pane picks one", async () => {
  // usePaneMode falls back to false with no window, the single-column
  // case; losing the `paneMode &&` guard on `:selected` would mark the
  // top-ordered row current regardless of layout.
  const a = posting("a::1", { company: "Acme" });
  const b = posting("b::2", { company: "Bevel" });
  const html = await render(RecordView, {
    postings: [a, b],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
  });
  const list = html.match(/class="list">([^]*?)<\/div><aside/)?.[1] ?? "";
  assert.equal(
    (list.match(/aria-current="true"/g) ?? []).length,
    0,
    "no list card is marked current below the breakpoint",
  );
  const pane = html.match(/<aside class="detail-pane"[^]*$/)?.[0] ?? "";
  assert.match(pane, /Acme/, "the pane still shows the top-ordered posting");
});

test("the pane's card is open with no disclosure that could shut it", async () => {
  const html = await render(RecordView, {
    postings: [posting("a::1", { company: "Acme", evidence: { role: "words" } })],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
  });
  const pane = html.match(/<aside class="detail-pane"[^]*$/)?.[0] ?? "";
  assert.match(pane, /class="evidence"/, "the pane shows the posting's evidence");
  assert.doesNotMatch(pane, /aria-expanded/, "and offers no way to collapse it");
});

test("the pane offers no outcome or change button, only its posting link", async () => {
  // `actionable="false"` on the pane's card keeps the whole outcomes/change
  // block out of its markup.
  const html = await render(RecordView, {
    postings: [posting("a::1", { company: "Acme", url: "https://boards.example/acme/1" })],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
  });
  const pane = html.match(/<aside class="detail-pane"[^]*$/)?.[0] ?? "";
  assert.doesNotMatch(pane, /class="act(?:"| )/, "no outcome button in the pane");
  assert.doesNotMatch(pane, /class="ghost change"/, "and no change control either");
  assert.match(pane, /class="icon-btn"/, "the pane still links out to the posting");
});

test("the list wraps a keydown handler sourced from the shared master-detail module", () => {
  // As in queue.test.ts: arrow-key navigation needs a live DOM, so this
  // checks the wiring comes from `useMasterDetail`; `nextFocusable`'s
  // delegation lives in `master-detail.test.ts`.
  const source = readFileSync(new URL("../src/record.ts", import.meta.url), "utf8");
  assert.match(source, /class="list" @keydown="onListKeydown"/);
  assert.match(source, /useMasterDetail\(filtered\)/);
});

// Against a live mount rather than SSR. Only the list row can write, so a
// refusal is the writing card's own and shows there.

// Applied offers Interviewing, Rejected and Closed, not Applied itself.
const ACTED = { status: "applied", status_at: "2026-09-14T00:00:00Z" } as const;

test("a refused write shows its reason on the row that issued it, and no other", async () => {
  const restoreFetch = stubFetch(() => Promise.reject(new Error("the network is down")));
  const app = mountTree(RecordView, {
    postings: [
      posting("a::1", { company: "Acme", ...ACTED }),
      posting("b::2", { company: "Bevel" }),
    ],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
  });
  try {
    click(outcomeButton(cardIn(app.root, "list", "Acme"), "Rejected — Acme"));
    await settled();
    assert.match(textOf(cardIn(app.root, "list", "Acme")), /the network is down/);
    assert.doesNotMatch(textOf(cardIn(app.root, "list", "Bevel")), /the network is down/);
    assert.equal(
      isDisabled(cardIn(app.root, "list", "Acme"), "Rejected — Acme"),
      false,
      "a settled write releases the card so it can be retried",
    );
  } finally {
    app.unmount();
    restoreFetch();
  }
});

// The Record keeps its rows and refetches nothing, so a decided row must
// state its new status at once, or it goes on offering the outcomes of the
// status it had before the write.

test("a Record decision hands the posting's key and the patch it wrote up to its parent", async () => {
  // The view keeps no map of its own: what `AppRoot` lays over both reads is
  // exactly what comes out of here, which is how the Queue learns of a
  // decision made on this tab.
  const restoreFetch = stubFetch(() => Promise.resolve(patchedOne()));
  const emitted: DecidedOutcome[] = [];
  const app = mountTree(RecordView, {
    postings: [posting("a::1", { company: "Acme" })],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
    onDecided: (outcome: DecidedOutcome) => emitted.push(outcome),
  });
  try {
    click(outcomeButton(cardIn(app.root, "list", "Acme"), "Applied — Acme"));
    await settled();
    assert.equal(emitted.length, 1, "one decision, emitted once");
    assert.equal(emitted[0]?.key, "a::1");
    assert.equal(emitted[0]?.company, "Acme");
    assert.equal(emitted[0]?.patch.status, "applied");
    assert.equal(
      typeof emitted[0]?.patch.applied_at,
      "string",
      "the whole patch, so the next write off that row can read applied_at back",
    );
  } finally {
    app.unmount();
    restoreFetch();
  }
});

test("a decided Record row offers its new status's outcomes at once, and an end status offers Change", async () => {
  const requests: string[] = [];
  const restoreFetch = stubFetch((url) => {
    requests.push(url);
    return Promise.resolve(patchedOne());
  });
  const app = mountUnderAppRoot(
    RecordView,
    [
      posting("a::1", { company: "Acme", status: "applied", status_at: "2026-09-10" }),
      posting("b::2", { company: "Bevel" }),
    ],
    { config: CONFIG, accessToken: ACCESS_TOKEN, compFloor: null },
  );
  try {
    click(outcomeButton(cardIn(app.root, "list", "Acme"), "Rejected — Acme"));
    await settled();
    assert.equal(requests.length, 1, "the write went out");
    const card = cardIn(app.root, "list", "Acme");
    assert.match(textOf(card), /Rejected/, "the row says what it is now");
    assert.equal(
      elementsWithClass(card, "act").length,
      0,
      "rejected is an end state: no outcome buttons at all",
    );
    assert.throws(
      () => outcomeButton(cardIn(app.root, "list", "Acme"), "Rejected — Acme"),
      /Rejected — Acme/,
      "and no second Rejected to click, which would re-PATCH the row with a fresh status_at",
    );
    assert.equal(
      changeButton(card).props["aria-label"],
      "Change — Acme",
      "the design table's one control for an end state is there instead",
    );
    assert.equal(
      elementsWithClass(cardIn(app.root, "list", "Bevel"), "act").length,
      2,
      "a row nobody decided is untouched: applied and closed, as the queue's row offers",
    );
  } finally {
    app.unmount();
    restoreFetch();
  }
});

test("a second decision from a written Record row sends the applied_at the first one stamped, not null", async () => {
  // `patchFor` reads `applied_at` back off the row it is writing, so a row
  // overridden with the status alone would PATCH `applied_at: null` on the
  // next decision.
  const bodies: Record<string, unknown>[] = [];
  const restoreFetch = stubFetch((_url, init) => {
    bodies.push(patchBody(init));
    return Promise.resolve(patchedOne());
  });
  const app = mountUnderAppRoot(RecordView, [posting("a::1", { company: "Acme" })], {
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
  });
  try {
    click(outcomeButton(cardIn(app.root, "list", "Acme"), "Applied — Acme"));
    await settled();
    click(outcomeButton(cardIn(app.root, "list", "Acme"), "Interviewing — Acme"));
    await settled();
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0]?.["status"], "applied");
    assert.equal(bodies[1]?.["status"], "interviewing");
    assert.equal(typeof bodies[0]?.["applied_at"], "string", "Applied stamps the date");
    assert.equal(
      bodies[1]?.["applied_at"],
      bodies[0]?.["applied_at"],
      "and the next write carries it forward rather than erasing it",
    );
  } finally {
    app.unmount();
    restoreFetch();
  }
});

test("revealing Change on the list row reveals its own five outcomes; the non-actionable pane stays as it was", async () => {
  const requests: string[] = [];
  const restoreFetch = stubFetch((url) => {
    requests.push(url);
    return Promise.resolve(patchedOne());
  });
  const app = mountTree(RecordView, {
    // Acted on, so orderedRecord puts it first and the pane selects it.
    postings: [
      posting("a::1", { company: "Acme", status: "rejected", status_at: "2026-09-10" }),
      posting("b::2", { company: "Bevel" }),
    ],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
  });
  try {
    assert.equal(elementsWithClass(cardIn(app.root, "detail-pane", "Acme"), "act").length, 0);
    click(changeButton(cardIn(app.root, "list", "Acme")));
    // `settled`, not a bare `nextTick`: `reveal` awaits its own `nextTick`
    // before re-homing focus.
    await settled();
    assert.equal(
      elementsWithClass(cardIn(app.root, "list", "Acme"), "act").length,
      STATUSES.length,
      "the copy that was clicked reveals all five",
    );
    // `revealed` still reaches the pane's props, but `actionable="false"`
    // keeps the outcomes/change block out of its markup.
    assert.equal(
      elementsWithClass(cardIn(app.root, "detail-pane", "Acme"), "act").length,
      0,
      "the pane still offers no outcomes; it is not actionable",
    );
    assert.equal(
      elementsWithClass(cardIn(app.root, "list", "Bevel"), "act").length,
      2,
      "a different posting is not revealed",
    );
    assert.equal(
      outcomeButton(cardIn(app.root, "list", "Acme"), "Applied — Acme").focused,
      true,
      "focus moves to the clicked copy's first revealed outcome button",
    );
    assert.deepEqual(requests, [], "revealing writes nothing");
  } finally {
    app.unmount();
    restoreFetch();
  }
});

/** Binds `:value` + `@input`, not `v-model`, so `fill` cannot drive it. */
function typeCompanyFilter(root: TreeNode, text: string): void {
  const field = allNodes(root).find((target) => target.tag === "input");
  if (field === undefined) throw new Error("no filter input in the rendered tree");
  const onInput = field.props["onInput"];
  if (typeof onInput !== "function") throw new Error("the company filter binds no input handler");
  (onInput as (event: object) => void)({ target: { value: text } });
}

test("a reveal outlives a filter that takes its row off the list and puts it back", async () => {
  // A row that stops matching the filter is unmounted, and a reveal held in
  // the card alone would die with it.
  const restoreFetch = stubFetch(() => Promise.resolve(patchedOne()));
  const app = mountTree(RecordView, {
    postings: [
      posting("a::1", { company: "Acme", status: "rejected", status_at: "2026-09-10" }),
      posting("b::2", { company: "Bevel" }),
    ],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
  });
  try {
    click(changeButton(cardIn(app.root, "list", "Acme")));
    await settled();
    assert.equal(
      elementsWithClass(cardIn(app.root, "list", "Acme"), "act").length,
      STATUSES.length,
    );

    typeCompanyFilter(app.root, "Bevel");
    await settled();
    assert.throws(
      () => cardIn(app.root, "list", "Acme"),
      /Acme/,
      "the filter takes the revealed row off the list, unmounting its card",
    );

    typeCompanyFilter(app.root, "");
    await settled();
    assert.equal(
      elementsWithClass(cardIn(app.root, "list", "Acme"), "act").length,
      STATUSES.length,
      "and the row comes back still offering all five",
    );
    assert.equal(
      elementsWithClass(cardIn(app.root, "list", "Bevel"), "act").length,
      2,
      "a row that was never revealed comes back as it was",
    );
  } finally {
    app.unmount();
    restoreFetch();
  }
});

test("a Record filter says how many of its postings matched, and no filter says nothing", async () => {
  // Unfiltered the number is the list itself, so the line would only repeat
  // what is on screen; filtered it answers how much the bar just took out,
  // and it sits under the bar that took it. The `<p>` stays mounted through
  // all of it: it is the live region, and one inserted with its text already
  // in it is announced unreliably.
  const app = mountTree(RecordView, {
    postings: [
      posting("a::1", { company: "Acme" }),
      posting("a::2", { company: "Acme" }),
      posting("b::1", { company: "Bevel" }),
    ],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
  });
  try {
    const line = elementsWithClass(app.root, "matched")[0];
    assert.ok(line !== undefined, "the region is mounted before any filter");
    assert.equal(line.props["role"], "status", "and it is the live region");
    assert.equal(textOf(line), "", "no filter, nothing said");

    typeCompanyFilter(app.root, "acme");
    await settled();
    assert.equal(textOf(elementsWithClass(app.root, "matched")[0]!), "2 of 3");
    assert.equal(
      elementsWithClass(app.root, "matched")[0],
      line,
      "the same element, not a new one",
    );

    typeCompanyFilter(app.root, "");
    await settled();
    assert.equal(
      textOf(elementsWithClass(app.root, "matched")[0]!),
      "",
      "clearing it takes the number away and leaves the region",
    );
  } finally {
    app.unmount();
  }
});
