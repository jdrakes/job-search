import assert from "node:assert/strict";
import { test } from "node:test";
import { createSSRApp } from "vue";
import { renderToString } from "vue/server-renderer";

import { STATUSES, type Candidate, type Company, type Posting } from "../../src/schema.ts";
import type { AppConfig } from "../src/config.ts";
import {
  boardLabel,
  CompaniesView,
  countsByCompany,
  dropRefusal,
  groupCompanies,
  groupOf,
  newCompanies,
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
    boards: [],
    reason: null,
    dropped_at: null,
    ...overrides,
  };
}

// A company with a board, so it is read.
const READ: Partial<Company> = { boards: [{ platform: "greenhouse", id: "board" }] };

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
    gone_at: null,
  };
}

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    id: "candidate-1",
    name: null,
    url: null,
    origin: "james",
    evidence: null,
    added_at: "2026-09-20T00:00:00Z",
    outcome: "watched",
    outcome_at: "2026-09-20T00:00:00Z",
    company: null,
    ...overrides,
  };
}

const NO_COUNTS: ReadonlyMap<string, number> = new Map();

const CONFIG: AppConfig = {
  url: "https://project.supabase.co",
  anonKey: "anon-key",
  statuses: [...STATUSES],
};
const ACCESS_TOKEN = "user-jwt";

test("groupOf reads dropped_at first, then whether the company has a board", () => {
  assert.equal(groupOf(company("Acme", READ)), "read");
  assert.equal(groupOf(company("Acme")), "no_board");
  assert.equal(
    groupOf(company("Acme", { ...READ, dropped_at: "2026-09-18T12:17:00Z" })),
    "dropped",
  );
  assert.equal(groupOf(company("Acme", { dropped_at: "2026-09-18T12:17:00Z" })), "dropped");
});

// The design's order, not the alphabetical order PostgREST returns rows in.
test("groupCompanies buckets into read, no board, dropped, in that order, labelled so", () => {
  const read = company("Acme", READ);
  const boardless = company("Beta");
  const dropped = company("Gamma", { ...READ, dropped_at: "2026-09-18T12:17:00Z" });

  const groups = groupCompanies([dropped, boardless, read], NO_COUNTS);

  assert.deepEqual(
    groups.map((group) => [group.key, group.label]),
    [
      ["read", "Read"],
      ["no_board", "No board"],
      ["dropped", "Dropped"],
    ],
  );
  assert.deepEqual(groups[0]?.companies, [read]);
  assert.deepEqual(groups[1]?.companies, [boardless]);
  assert.deepEqual(groups[2]?.companies, [dropped]);
});

test("countsByCompany counts the queue's postings by company name", () => {
  const counts = countsByCompany([queued("Acme", "1"), queued("Acme", "2"), queued("Beta", "1")]);
  assert.equal(counts.get("Acme"), 2);
  assert.equal(counts.get("Beta"), 1);
  assert.equal(counts.get("Gamma"), undefined);
});

test("groupCompanies orders each group by queued postings, most first, then name", () => {
  const none = company("Zed", READ);
  const one = company("Beta", READ);
  const two = company("Acme", READ);
  const alsoNone = company("Alpha", READ);
  const counts = countsByCompany([queued("Beta", "1"), queued("Acme", "1"), queued("Acme", "2")]);
  const groups = groupCompanies([none, one, alsoNone, two], counts);
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

test("groupCompanies leaves a bucket empty rather than dropping it", () => {
  const groups = groupCompanies([company("Acme", READ)], NO_COUNTS);
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

test("whyText is the operator's reason, else nothing", () => {
  assert.equal(whyText(company("Acme", { reason: "acquired" })), "acquired");
  assert.equal(whyText(company("Acme")), null);
  assert.equal(whyText(company("Acme", { reason: "" })), null);
});

test("dropRefusal refuses an empty or whitespace-only reason", () => {
  assert.match(dropRefusal("") ?? "", /judgement, not a fact/);
  assert.match(dropRefusal("   ") ?? "", /judgement, not a fact/);
});

test("dropRefusal allows a real reason", () => {
  assert.equal(dropRefusal("acquired, boards gone dark"), null);
});

test("newCompanies holds a company watched within the last 7 days, not one watched 9 days ago", () => {
  const now = Date.now();
  const twoDaysAgo = new Date(now - 2 * 86_400_000).toISOString();
  const nineDaysAgo = new Date(now - 9 * 86_400_000).toISOString();
  const recent = company("Acme", READ);
  const stale = company("Beta", READ);
  const candidates = [
    candidate({ id: "c1", outcome: "watched", outcome_at: twoDaysAgo, company: "Acme" }),
    candidate({ id: "c2", outcome: "watched", outcome_at: nineDaysAgo, company: "Beta" }),
  ];

  const names = newCompanies([recent, stale], candidates, now).map((entry) => entry.company.name);

  assert.deepEqual(names, ["Acme"], "watched 2 days ago is new; watched 9 days ago is not");
});

test("newCompanies' window is under seven days to the millisecond, not seven floored days", () => {
  // Breaks if the window goes back to `daysBetween(...) <= 7`: that floors
  // 7 days and an hour to 7 and keeps the company for most of an eighth day.
  const now = Date.parse("2026-09-27T12:00:00Z");
  const hour = 3_600_000;
  const candidates = [
    candidate({
      id: "c1",
      company: "Acme",
      outcome_at: new Date(now - (6 * 24 + 23) * hour).toISOString(),
    }),
    candidate({
      id: "c2",
      company: "Beta",
      outcome_at: new Date(now - (7 * 24 + 1) * hour).toISOString(),
    }),
  ];

  const names = newCompanies([company("Acme", READ), company("Beta", READ)], candidates, now).map(
    (entry) => entry.company.name,
  );

  assert.deepEqual(names, ["Acme"], "6 days 23 hours is in; 7 days 1 hour is out");
});

test("newCompanies leaves out a dropped company: dropping it from New is the reversal", () => {
  const now = Date.parse("2026-09-27T12:00:00Z");
  const dropped = company("Acme", {
    ...READ,
    dropped_at: "2026-09-27T11:00:00Z",
    reason: "not a fit",
  });
  const candidates = [
    candidate({ company: "Acme", outcome_at: new Date(now - 3_600_000).toISOString() }),
  ];

  assert.deepEqual(newCompanies([dropped], candidates, now), []);
});

test("newCompanies pairs a company with its earliest watched candidate, most recently watched company first", () => {
  // A later duplicate watched into Acme today must not re-open its window
  // or replace the candidate that opened it.
  const now = Date.parse("2026-09-27T12:00:00Z");
  const opener = candidate({
    id: "c1",
    company: "Acme",
    added_at: "2026-09-24T00:00:00Z",
    outcome_at: "2026-09-24T06:00:00Z",
  });
  const duplicate = candidate({
    id: "c2",
    company: "Acme",
    added_at: "2026-09-27T00:00:00Z",
    outcome_at: "2026-09-27T06:00:00Z",
  });
  const beta = candidate({
    id: "c3",
    company: "Beta",
    added_at: "2026-09-25T00:00:00Z",
    outcome_at: "2026-09-25T06:00:00Z",
  });

  const entries = newCompanies(
    [company("Acme", READ), company("Beta", READ)],
    [duplicate, beta, opener],
    now,
  );

  assert.deepEqual(
    entries.map((entry) => [entry.company.name, entry.candidate.id]),
    [
      ["Beta", "c3"],
      ["Acme", "c1"],
    ],
  );
});

test("newCompanies ignores an unresolved candidate and one watched into a different company", () => {
  const now = Date.now();
  const acme = company("Acme", READ);
  const candidates = [
    candidate({ id: "c1", outcome: null, outcome_at: null, company: null }),
    candidate({
      id: "c2",
      outcome: "watched",
      outcome_at: new Date(now - 1000).toISOString(),
      company: "Gamma",
    }),
  ];

  assert.deepEqual(newCompanies([acme], candidates, now), []);
});

test("CompaniesView's New group holds a company watched 2 days ago, showing that candidate's origin and evidence, not one watched 9 days ago", async () => {
  const now = Date.now();
  const twoDaysAgo = new Date(now - 2 * 86_400_000).toISOString();
  const nineDaysAgo = new Date(now - 9 * 86_400_000).toISOString();
  const recent = company("Acme", READ);
  const stale = company("Beta", READ);
  const candidates = [
    candidate({
      id: "c1",
      outcome: "watched",
      outcome_at: twoDaysAgo,
      company: "Acme",
      origin: "peers",
      evidence: "found on their careers page",
    }),
    candidate({
      id: "c2",
      outcome: "watched",
      outcome_at: nineDaysAgo,
      company: "Beta",
      origin: "peers",
      evidence: "a friend mentioned it",
    }),
  ];

  const html = await render(CompaniesView, {
    companies: [recent, stale],
    queue: [],
    candidates,
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
  });

  assert.match(html, /New.*?\(1\)/s);
  const newSection = html.slice(html.indexOf("New <"), html.indexOf("Read <"));
  assert.match(newSection, /Acme/);
  assert.doesNotMatch(newSection, /Beta/);
  assert.match(newSection, /peers/);
  assert.match(newSection, /found on their careers page/);
  // Breaks if the New card loses its Drop: a company James never asked for
  // is the one he most needs to turn away from where he first sees it.
  assert.match(newSection, /aria-label="Drop Acme"/);
});

test("CompaniesView renders each group with its count and its companies", async () => {
  const read = company("Acme", { boards: [{ platform: "greenhouse", id: "acme" }] });
  const dropped = company("Gamma", {
    ...READ,
    dropped_at: "2026-09-18T12:17:00Z",
    reason: "acquired",
  });

  const html = await render(CompaniesView, {
    companies: [read, dropped],
    queue: [],
    candidates: [],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
  });

  assert.match(html, /Read.*?\(1\)/);
  assert.match(html, /No board.*?\(0\)/);
  assert.match(html, /Dropped.*?\(1\)/);
  assert.match(html, /Acme/);
  assert.match(html, /greenhouse:acme/);
  assert.match(html, /Gamma/);
  assert.match(html, /acquired/);
});

test("CompaniesView offers Drop on a read or boardless company but not on one already dropped", async () => {
  const read = company("Acme", READ);
  const boardless = company("Beta");
  const dropped = company("Gamma", { ...READ, dropped_at: "2026-09-18T12:17:00Z" });

  const html = await render(CompaniesView, {
    companies: [read, boardless, dropped],
    queue: [],
    candidates: [],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
  });

  // The button writes no word on screen; the one it announces is what says
  // a row offers Drop at all.
  const dropButtons = [...html.matchAll(/aria-label="Drop [^"]+"/g)].map((match) => match[0]);
  assert.deepEqual(dropButtons, ['aria-label="Drop Acme"', 'aria-label="Drop Beta"']);
});

test("CompaniesView renders a dropped company with no .acts, and the list carries the dropped class", async () => {
  const dropped = company("Gamma", {
    ...READ,
    dropped_at: "2026-09-18T12:17:00Z",
    reason: "acquired",
  });

  const html = await render(CompaniesView, {
    companies: [dropped],
    queue: [],
    candidates: [],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
  });

  assert.doesNotMatch(html, /<span class="acts"/);
  // `TransitionGroup` resolves `class`/`:class` in the opposite order a
  // plain element did ("list dropped", not "dropped list").
  assert.match(html, /class="list dropped"/);
});

test("CompaniesView renders 'no board yet' for a company with no boards", async () => {
  const noBoardsCompany = company("Acme");

  const html = await render(CompaniesView, {
    companies: [noBoardsCompany],
    queue: [],
    candidates: [],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
  });

  assert.match(html, /class="board none">/);
  assert.match(html, /no board yet/);
});

test("CompaniesView shows each company's queued count, none in the muted type", async () => {
  const acme = company("Acme", READ);
  const beta = company("Beta", READ);
  const html = await render(CompaniesView, {
    companies: [acme, beta],
    queue: [queued("Acme", "1"), queued("Acme", "2"), queued("Acme", "3")],
    candidates: [],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
  });
  assert.match(html, /class="queued">3 in queue</);
  assert.match(html, /class="none queued">none in queue</);
  assert.ok(html.indexOf("Acme") < html.indexOf("Beta"), "most queued first");
});

test("initialDropping opens the drop dialog as an accessible, labelled modal", async () => {
  const acme = company("Acme", READ);

  const html = await render(CompaniesView, {
    companies: [acme],
    queue: [],
    candidates: [],
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
  const messy = company("Overland Transport & Logistics", READ);

  const html = await render(CompaniesView, {
    companies: [messy],
    queue: [],
    candidates: [],
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
    companies: [company("Acme", READ)],
    queue: [],
    candidates: [],
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
    companies: [company("Acme", READ)],
    queue: [],
    candidates: [],
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
  const read = company("Acme", READ);
  const handed: { name: string; patch: { dropped_at: string; reason: string } }[] = [];
  const app = mountTree(CompaniesView, {
    companies: [read],
    queue: [],
    candidates: [],
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
    // is still under Read here: the move happens when AppRoot hands the
    // patched row back down. A local map would put it under Dropped instead,
    // which is exactly the copy that died on a tab switch.
    assert.equal(read.dropped_at, null, "the row it was handed is untouched");
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
  const acme = company("Acme", READ);

  const html = await render(CompaniesView, {
    companies: [acme],
    queue: [],
    candidates: [],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
  });

  assert.doesNotMatch(html, /role="dialog"/);
});
