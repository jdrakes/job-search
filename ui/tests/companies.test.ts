import assert from "node:assert/strict";
import { test } from "node:test";
import { createSSRApp } from "vue";
import { renderToString } from "vue/server-renderer";

import { STATUSES, type Company, type Posting } from "../../src/schema.ts";
import type { AppConfig } from "../src/config.ts";
import {
  boardLabel,
  CompaniesView,
  countsByCompany,
  dropRefusal,
  groupByState,
  groupOf,
  queuedLabel,
  whyText,
} from "../src/companies.ts";
import {
  allNodes,
  elementsWithClass,
  fill,
  mountTree,
  patchedOne,
  settled,
  stubDom,
  stubFetch,
  submitForm,
  textOf,
} from "./render-tree.ts";

function render(component: object, props: Record<string, unknown>): Promise<string> {
  return renderToString(createSSRApp(component, props));
}

function company(name: string, overrides: Partial<Company> = {}): Company {
  return {
    name,
    state: "discovered",
    boards: [],
    source: null,
    reason: null,
    first_seen: "2026-09-15T00:00:00Z",
    last_seen: "2026-09-15T00:00:00Z",
    dropped_at: null,
    alias_of: null,
    ...overrides,
  };
}

/** Only the company matters to these tests. */
function queued(companyName: string, id: string): Posting {
  return {
    key: `${companyName}::${id}`,
    company: companyName,
    platform: "greenhouse",
    board: null,
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
  };
}

const NO_COUNTS: ReadonlyMap<string, number> = new Map();

const CONFIG: AppConfig = {
  url: "https://project.supabase.co",
  anonKey: "anon-key",
  statuses: [...STATUSES],
};
const ACCESS_TOKEN = "user-jwt";

// The design's order, not the alphabetical order PostgREST returns rows in.

test("groupOf reads dropped_at first, and only falls back to state when it is null", () => {
  assert.equal(groupOf(company("Acme", { state: "watched" })), "watched");
  assert.equal(groupOf(company("Acme", { state: "discovered" })), "discovered");
  assert.equal(groupOf(company("Acme", { state: "alias", alias_of: "Beta" })), "alias");
  assert.equal(
    groupOf(company("Acme", { state: "watched", dropped_at: "2026-09-18T12:17:00Z" })),
    "dropped",
  );
});

test("groupByState buckets into watched, discovered, dropped, alias, in that order", () => {
  const watched = company("Acme", { state: "watched" });
  const discovered = company("Beta", { state: "discovered" });
  // A drop is the flag, not the state: this one is still `watched`.
  const dropped = company("Gamma", { state: "watched", dropped_at: "2026-09-18T12:17:00Z" });
  const alias = company("Delta", { state: "alias", alias_of: "Acme" });

  const groups = groupByState([alias, dropped, discovered, watched], NO_COUNTS);

  assert.deepEqual(
    groups.map((group) => group.key),
    ["watched", "discovered", "dropped", "alias"],
  );
  assert.deepEqual(groups[0]?.companies, [watched]);
  assert.deepEqual(groups[1]?.companies, [discovered]);
  assert.deepEqual(groups[2]?.companies, [dropped]);
  assert.deepEqual(groups[3]?.companies, [alias]);
});

test("countsByCompany counts the queue's postings by company name", () => {
  const counts = countsByCompany([queued("Acme", "1"), queued("Acme", "2"), queued("Beta", "1")]);
  assert.equal(counts.get("Acme"), 2);
  assert.equal(counts.get("Beta"), 1);
  assert.equal(counts.get("Gamma"), undefined);
});

test("groupByState orders each group by queued postings, most first, then name", () => {
  const none = company("Zed", { state: "watched" });
  const one = company("Beta", { state: "watched" });
  const two = company("Acme", { state: "watched" });
  const alsoNone = company("Alpha", { state: "watched" });
  const counts = countsByCompany([queued("Beta", "1"), queued("Acme", "1"), queued("Acme", "2")]);
  const groups = groupByState([none, one, alsoNone, two], counts);
  assert.deepEqual(
    groups[0]?.companies.map((c) => c.name),
    ["Acme", "Beta", "Alpha", "Zed"],
  );
});

test("queuedLabel says the count in words", () => {
  assert.equal(queuedLabel(0), "none in queue");
  assert.equal(queuedLabel(1), "1 in queue");
  assert.equal(queuedLabel(3), "3 in queue");
});

test("groupByState leaves a bucket empty rather than dropping it", () => {
  const groups = groupByState([company("Acme", { state: "watched" })], NO_COUNTS);
  assert.deepEqual(groups[1]?.companies, []);
  assert.deepEqual(groups[2]?.companies, []);
});

test("boardLabel joins every board as platform:id", () => {
  const c = company("Acme", {
    boards: [
      { platform: "greenhouse", id: "acme" },
      { platform: "lever", id: "acme-hq" },
    ],
  });
  assert.equal(boardLabel(c), "greenhouse:acme, lever:acme-hq");
});

test("boardLabel is empty text for a company with no boards", () => {
  assert.equal(boardLabel(company("Acme", { boards: [] })), "");
});

test("whyText prefers James's reason, falls back to the alias owner, else nothing", () => {
  assert.equal(whyText(company("Acme", { reason: "acquired" })), "acquired");
  assert.equal(whyText(company("Acme", { alias_of: "Beta" })), "alias of Beta");
  assert.equal(
    whyText(company("Acme", { reason: "acquired", alias_of: "Beta" })),
    "acquired",
    "a reason wins over alias_of when a row somehow carries both",
  );
  assert.equal(whyText(company("Acme")), null);
});

test("dropRefusal refuses an empty or whitespace-only reason", () => {
  assert.match(dropRefusal("") ?? "", /judgement, not a fact/);
  assert.match(dropRefusal("   ") ?? "", /judgement, not a fact/);
});

test("dropRefusal allows a real reason", () => {
  assert.equal(dropRefusal("acquired, boards gone dark"), null);
});

test("CompaniesView renders each group with its count and its companies", async () => {
  const watched = company("Acme", {
    state: "watched",
    boards: [{ platform: "greenhouse", id: "acme" }],
  });
  const dropped = company("Gamma", {
    state: "watched",
    dropped_at: "2026-09-18T12:17:00Z",
    reason: "acquired",
  });

  const html = await render(CompaniesView, {
    companies: [watched, dropped],
    queue: [],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
  });

  assert.match(html, /Watched.*?\(1\)/);
  assert.match(html, /Discovered.*?\(0\)/);
  assert.match(html, /Dropped.*?\(1\)/);
  assert.match(html, /Acme/);
  assert.match(html, /greenhouse:acme/);
  assert.match(html, /Gamma/);
  assert.match(html, /acquired/);
});

test("CompaniesView offers Drop on a watched or discovered company but not on one already dropped", async () => {
  const watched = company("Acme", { state: "watched" });
  const dropped = company("Gamma", { state: "watched", dropped_at: "2026-09-18T12:17:00Z" });

  const html = await render(CompaniesView, {
    companies: [watched, dropped],
    queue: [],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
  });

  // The button writes no word on screen; the one it announces is what says
  // a row offers Drop at all.
  const dropButtons = [...html.matchAll(/aria-label="Drop [^"]+"/g)];
  assert.equal(dropButtons.length, 1);
});

test("CompaniesView renders a dropped company with no .acts, and the list carries the dropped class", async () => {
  const dropped = company("Gamma", {
    state: "watched",
    dropped_at: "2026-09-18T12:17:00Z",
    reason: "acquired",
  });

  const html = await render(CompaniesView, {
    companies: [dropped],
    queue: [],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
  });

  assert.doesNotMatch(html, /<span class="acts"/);
  // `TransitionGroup` resolves `class`/`:class` in the opposite order a
  // plain element did ("list dropped", not "dropped list").
  assert.match(html, /class="list dropped"/);
});

test("CompaniesView renders an alias card with 'alias of X' and no Drop button", async () => {
  const alias = company("Delta", { state: "alias", alias_of: "Acme" });

  const html = await render(CompaniesView, {
    companies: [alias],
    queue: [],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
  });

  assert.match(html, /alias of Acme/);
  assert.doesNotMatch(html, /<span class="acts"/);
  assert.doesNotMatch(html, /aria-label="Drop /);
});

test("CompaniesView renders 'no board yet' for a company with no boards", async () => {
  const noBoardsCompany = company("Acme", {
    state: "watched",
    boards: [],
  });

  const html = await render(CompaniesView, {
    companies: [noBoardsCompany],
    queue: [],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
  });

  assert.match(html, /class="board none">/);
  assert.match(html, /no board yet/);
});

test("CompaniesView shows each company's queued count, none in the muted type", async () => {
  const acme = company("Acme", { state: "watched" });
  const beta = company("Beta", { state: "watched" });
  const html = await render(CompaniesView, {
    companies: [acme, beta],
    queue: [queued("Acme", "1"), queued("Acme", "2"), queued("Acme", "3")],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
  });
  assert.match(html, /class="queued">3 in queue</);
  assert.match(html, /class="none queued">none in queue</);
  assert.ok(html.indexOf("Acme") < html.indexOf("Beta"), "most queued first");
});

test("initialDropping opens the drop dialog as an accessible, labelled modal", async () => {
  const acme = company("Acme", { state: "watched" });

  const html = await render(CompaniesView, {
    companies: [acme],
    queue: [],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    initialDropping: "Acme",
  });

  assert.match(html, /class="decide drop-prompt" role="dialog" aria-modal="true" tabindex="-1"/);
  // Read off the dialog, not the document: the view's own section is
  // labelled by its tab, and that is the first match in the page.
  const labelledby = html.match(/class="decide drop-prompt"[^>]*aria-labelledby="([^"]+)"/);
  const headingId = html.match(/<h2 id="([^"]+)">Drop — Acme<\/h2>/);
  assert.ok(labelledby, "aria-labelledby is rendered");
  assert.ok(headingId, "the heading carries a matching id");
  assert.equal(labelledby?.[1], headingId?.[1]);
});

test("the drop dialog's aria-labelledby stays one IDREF when the company name holds whitespace", async () => {
  // aria-labelledby is a space-separated IDREF list; this name is a real
  // one in this project's data.
  const messy = company("Overland Transport & Logistics", { state: "watched" });

  const html = await render(CompaniesView, {
    companies: [messy],
    queue: [],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    initialDropping: "Overland Transport & Logistics",
  });

  const labelledby =
    html.match(/class="decide drop-prompt"[^>]*aria-labelledby="([^"]+)"/)?.[1] ?? "";
  const headingId = html.match(/<h2 id="([^"]+)">Drop — /)?.[1] ?? "";
  assert.notEqual(labelledby, "", "aria-labelledby is rendered");
  assert.doesNotMatch(labelledby, /\s/, "the value is one IDREF, not a list of several");
  assert.equal(labelledby, headingId);
  assert.match(html, /Drop — Overland Transport &amp; Logistics<\/h2>/);
});

test("the Companies panel is programmatically focusable, so a committed Drop has somewhere to send focus", async () => {
  // A dropped company's card keeps no focusable element (its head is a
  // `<div>` and `.acts` stops rendering), so the panel is the anchor, and it
  // cannot take focus from script without tabindex="-1".
  const html = await render(CompaniesView, {
    companies: [company("Acme", { state: "watched" })],
    queue: [],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
  });

  assert.match(
    html,
    /role="tabpanel" id="panel-companies" aria-labelledby="tab-companies" tabindex="-1"/,
  );
});

test("a committed Drop sends focus to the panel, since the card it was issued from keeps nothing focusable", async () => {
  const restoreDom = stubDom();
  const restoreFetch = stubFetch(() => Promise.resolve(patchedOne()));
  const app = mountTree(CompaniesView, {
    companies: [company("Acme", { state: "watched" })],
    queue: [],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    initialDropping: "Acme",
  });
  try {
    const reason = allNodes(app.root).find((node) => node.tag === "textarea");
    assert.ok(reason !== undefined, "the drop dialog is open");
    // A drop with no reason is refused before it is written, and a refused
    // drop leaves the dialog open, so the focus path is never reached.
    fill(reason, "they stopped hiring");
    const form = allNodes(app.root).find((node) => node.tag === "form");
    assert.ok(form !== undefined, "the dialog carries the form");
    submitForm(form);
    await settled();
    const panel = allNodes(app.root).find((node) => node.props["id"] === "panel-companies");
    assert.ok(panel !== undefined, "the panel is still mounted");
    assert.equal(panel.focused, true, "focus landed on the panel, not <body>");
  } finally {
    app.unmount();
    restoreFetch();
    restoreDom();
  }
});

test("a committed Drop hands the name and the patch up, and keeps no copy of its own", async () => {
  // The view used to keep what James dropped in a local map. Its panel is a
  // `v-if`, so that map died on a tab switch and the drop came back undone.
  // It emits now, and AppRoot holds the answer.
  const restoreDom = stubDom();
  const restoreFetch = stubFetch(() => Promise.resolve(patchedOne()));
  const watched = company("Acme", { state: "watched" });
  const handed: { name: string; patch: { dropped_at: string; reason: string } }[] = [];
  const app = mountTree(CompaniesView, {
    companies: [watched],
    queue: [],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    initialDropping: "Acme",
    onDropped: (dropped: { name: string; patch: { dropped_at: string; reason: string } }) => {
      handed.push(dropped);
    },
  });
  try {
    const reason = allNodes(app.root).find((node) => node.tag === "textarea");
    assert.ok(reason !== undefined, "the drop dialog is open");
    fill(reason, "they stopped hiring");
    const form = allNodes(app.root).find((node) => node.tag === "form");
    assert.ok(form !== undefined, "the dialog carries the form");
    submitForm(form);
    await settled();

    assert.equal(handed.length, 1, "the drop was handed up exactly once");
    assert.equal(handed[0]?.name, "Acme");
    assert.equal(handed[0]?.patch.reason, "they stopped hiring");
    assert.ok(handed[0]?.patch.dropped_at, "the patch carries when it was dropped");

    // It renders from its props alone now. Its props did not change, so Acme
    // is still under Watched here: the move happens when AppRoot hands the
    // patched row back down. A local map would put it under Dropped instead,
    // which is exactly the copy that died on a tab switch.
    assert.equal(watched.dropped_at, null, "the row it was handed is untouched");
    const dropped = elementsWithClass(app.root, "dropped");
    assert.ok(
      !dropped.some((list) => textOf(list).includes("Acme")),
      "the view moved nothing on its own",
    );
  } finally {
    app.unmount();
    restoreFetch();
    restoreDom();
  }
});

test("with no initialDropping, no dialog renders at all", async () => {
  const acme = company("Acme", { state: "watched" });

  const html = await render(CompaniesView, {
    companies: [acme],
    queue: [],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
  });

  assert.doesNotMatch(html, /role="dialog"/);
});
