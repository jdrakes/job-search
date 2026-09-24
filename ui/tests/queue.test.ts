import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { computed, createSSRApp, nextTick } from "vue";
import { renderToString } from "vue/server-renderer";

import { STATUSES, type Posting } from "../../src/schema.ts";
import type { AppConfig } from "../src/config.ts";
import {
  ageLabel,
  closeRefusal,
  compLabel,
  daysBetween,
  decidedOutcome,
  evidenceLines,
  iconOf,
  labelOf,
  midpoint,
  nextSelection,
  outcomesFor,
  outcomeToastText,
  patchFor,
  postedAgeLabel,
  postingHref,
  PostingCard,
  reasonLines,
  resolveSelection,
  scoreOf,
  SHAPE_WEIGHT,
  statusTag,
  toneOf,
  type DecidedOutcome,
} from "../src/posting.ts";
import type { SessionStore } from "../src/auth.ts";
import { useMasterDetail } from "../src/master-detail.ts";
import {
  appliedCountsByCompany,
  appliedLabel,
  companyHeadLabel,
  headAt,
  headOf,
  matchesQuery,
  orderedQueue,
  QUEUE_ORDER_KEY,
  queueRows,
  QueueView,
  waitingLabel,
} from "../src/queue.ts";
import {
  cardIn,
  changeButton,
  isDisabled,
  mountUnderAppRoot,
  outcomeButton,
  partOfDialog,
} from "./card-queries.ts";
import {
  allNodes,
  click,
  elementsWithClass,
  fill,
  hasClass,
  mountTree,
  patchedOne,
  settled,
  stubDom,
  stubFetch,
  submitForm,
  textOf,
  typeInto,
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

/** Stands in for `localStorage`. */
function memoryStore(initial: Record<string, string> = {}): SessionStore {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

test("midpoint averages a full band", () => {
  assert.equal(midpoint(posting("a::1", { comp_low: 180_000, comp_high: 220_000 })), 200_000);
});

test("midpoint falls back to whichever bound is present", () => {
  assert.equal(midpoint(posting("a::1", { comp_low: 180_000, comp_high: null })), 180_000);
  assert.equal(midpoint(posting("a::1", { comp_low: null, comp_high: 220_000 })), 220_000);
});

test("midpoint is null with no band at all, not zero", () => {
  assert.equal(midpoint(posting("a::1", { comp_low: null, comp_high: null })), null);
});

test("compLabel prints a range, a single bound, or the dash for no band", () => {
  assert.equal(
    compLabel(posting("a::1", { comp_low: 180_000, comp_high: 220_000 })),
    "$180k–$220k",
  );
  assert.equal(compLabel(posting("a::1", { comp_low: 180_000, comp_high: null })), "$180k");
  assert.equal(compLabel(posting("a::1", { comp_low: null, comp_high: null })), "—");
});

test("postingHref allows an https posting URL", () => {
  assert.equal(
    postingHref("https://boards.example.com/jobs/1"),
    "https://boards.example.com/jobs/1",
  );
});

test("postingHref refuses a javascript: URL, which would run in this origin", () => {
  assert.equal(postingHref("javascript:alert(1)"), null);
});

test("postingHref refuses text that is not an absolute URL", () => {
  assert.equal(postingHref("not a url"), null);
});

test("postingHref is null when there is no URL at all", () => {
  assert.equal(postingHref(null), null);
});

test("reasonLines keeps well-shaped entries and drops malformed ones", () => {
  const lines = reasonLines([
    { criterion: "role", verdict: "kept", detail: "Backend engineer, matches role_words" },
    { criterion: "comp", verdict: "malformed" }, // no detail
    "not an object",
    null,
  ]);

  assert.deepEqual(lines, [
    { criterion: "role", verdict: "kept", detail: "Backend engineer, matches role_words" },
  ]);
});

test("evidenceLines keeps string values only, and turns the key into a label", () => {
  const lines = evidenceLines({
    comp_low: 180_000,
    role_words: 'matched "staff engineer" in the title',
  });

  assert.deepEqual(lines, [
    { fact: "role words", detail: 'matched "staff engineer" in the title' },
  ]);
});

test("patchFor stamps applied_at only for the Applied outcome", () => {
  const p = posting("a::1", { applied_at: null });
  assert.deepEqual(patchFor(p, "applied", null, "2026-09-15T12:00:00Z"), {
    status: "applied",
    status_at: "2026-09-15T12:00:00Z",
    applied_at: "2026-09-15T12:00:00Z",
    note: null,
  });
});

test("patchFor leaves an earlier applied_at alone for the other three outcomes", () => {
  const p = posting("a::1", { applied_at: "2026-09-01T00:00:00Z" });
  for (const status of ["interviewing", "rejected", "offer"] as const) {
    assert.deepEqual(patchFor(p, status, null, "2026-09-15T12:00:00Z"), {
      status,
      status_at: "2026-09-15T12:00:00Z",
      applied_at: "2026-09-01T00:00:00Z",
      note: null,
    });
  }
});

test("patchFor for Closed carries the reason as note and leaves applied_at alone", () => {
  const p = posting("a::1", { applied_at: "2026-09-01T00:00:00Z" });
  assert.deepEqual(patchFor(p, "closed", "role was filled", "2026-09-15T12:00:00Z"), {
    status: "closed",
    status_at: "2026-09-15T12:00:00Z",
    applied_at: "2026-09-01T00:00:00Z",
    note: "role was filled",
  });
});

test("closeRefusal refuses an empty or whitespace-only reason", () => {
  assert.match(closeRefusal("") ?? "", /disagrees with the processor/);
  assert.match(closeRefusal("   ") ?? "", /disagrees with the processor/);
});

test("closeRefusal allows a real reason", () => {
  assert.equal(closeRefusal("role was filled"), null);
});

test("outcomeToastText names the outcome's label and the company", () => {
  assert.equal(outcomeToastText("applied", "Acme"), "Applied — Acme");
  assert.equal(outcomeToastText("closed", "Beta"), "Closed — Beta");
});

test("decidedOutcome carries the posting's key and company and the whole patch just written", () => {
  // The whole payload: the queue reads `key`, the record lays `patch` over
  // its copy, the toast reads `patch.status` and `company`.
  const patch = patchFor(posting("Acme::1"), "applied", null, "2026-09-16T12:00:00Z");
  assert.deepEqual(decidedOutcome(posting("Acme::1", { company: "Acme" }), patch), {
    key: "Acme::1",
    company: "Acme",
    patch: {
      status: "applied",
      status_at: "2026-09-16T12:00:00Z",
      applied_at: "2026-09-16T12:00:00Z",
      note: null,
    },
  });
});

const QUEUE_FLOOR = 150_000;
const QUEUE_NOW = Date.parse("2026-09-15T12:00:00Z");

test("orderedQueue with a floor sorts by score: a fresh band over the floor beats a stale richer one", () => {
  // Top 300k = full pay 70, 120 days old = no freshness: 70.
  const staleRich = posting("a::1", {
    comp_low: 300_000,
    comp_high: 300_000,
    posted_at: "2026-05-18",
  });
  // Top 180k = 28 pay, posted today = 30: 58.
  const freshModest = posting("b::1", {
    comp_low: 120_000,
    comp_high: 180_000,
    posted_at: "2026-09-15",
  });
  // 70 + 30 = 100.
  const freshRich = posting("c::1", {
    comp_low: 300_000,
    comp_high: 300_000,
    posted_at: "2026-09-15",
  });
  assert.deepEqual(
    orderedQueue([freshModest, staleRich, freshRich], QUEUE_FLOOR, QUEUE_NOW).map((p) => p.key),
    ["c::1", "a::1", "b::1"],
  );
});

test("orderedQueue with a floor breaks a score tie by midpoint, then posted_at", () => {
  // Both 100; the wider band has the lower midpoint.
  const wide = posting("a::1", { comp_low: 150_000, comp_high: 225_000, posted_at: "2026-09-15" });
  const narrow = posting("b::1", {
    comp_low: 200_000,
    comp_high: 225_000,
    posted_at: "2026-09-15",
  });
  assert.deepEqual(
    orderedQueue([wide, narrow], QUEUE_FLOOR, QUEUE_NOW).map((p) => p.key),
    ["b::1", "a::1"],
  );
});

test("orderedQueue with a floor puts a fresh unpriced posting under a fresh priced one above the floor", () => {
  const unpriced = posting("a::1", { comp_low: null, comp_high: null, posted_at: "2026-09-15" });
  const priced = posting("b::1", {
    comp_low: 150_000,
    comp_high: 165_000,
    posted_at: "2026-09-15",
  });
  // 20 + 30 = 50 against 14 + 30 = 44; at 180k (28 + 30) it would not win.
  assert.deepEqual(
    orderedQueue([unpriced, priced], QUEUE_FLOOR, QUEUE_NOW).map((p) => p.key),
    ["a::1", "b::1"],
  );
  const pricedHigher = posting("c::1", {
    comp_low: 150_000,
    comp_high: 180_000,
    posted_at: "2026-09-15",
  });
  assert.deepEqual(
    orderedQueue([unpriced, pricedHigher], QUEUE_FLOOR, QUEUE_NOW).map((p) => p.key),
    ["c::1", "a::1"],
  );
});

test("orderedQueue without a floor sorts by comp-band midpoint, highest first", () => {
  const low = posting("a::1", { comp_low: 100_000, comp_high: 100_000 });
  const high = posting("b::1", { comp_low: 300_000, comp_high: 300_000 });
  assert.deepEqual(
    orderedQueue([low, high], null, QUEUE_NOW).map((p) => p.key),
    ["b::1", "a::1"],
  );
});

test("orderedQueue without a floor breaks a midpoint tie by posted_at, most recent first", () => {
  const older = posting("a::1", {
    comp_low: 200_000,
    comp_high: 200_000,
    posted_at: "2026-09-01T00:00:00Z",
  });
  const newer = posting("b::1", {
    comp_low: 200_000,
    comp_high: 200_000,
    posted_at: "2026-09-10T00:00:00Z",
  });
  assert.deepEqual(
    orderedQueue([older, newer], null, QUEUE_NOW).map((p) => p.key),
    ["b::1", "a::1"],
  );
});

test("orderedQueue without a floor sinks a posting with no comp band to the floor, however recent", () => {
  const noBand = posting("a::1", {
    comp_low: null,
    comp_high: null,
    posted_at: "2026-09-14T00:00:00Z",
  });
  const modest = posting("b::1", { comp_low: 1, comp_high: 1, posted_at: "2020-01-01T00:00:00Z" });
  assert.deepEqual(
    orderedQueue([noBand, modest], null, QUEUE_NOW).map((p) => p.key),
    ["b::1", "a::1"],
  );
});

test("orderedQueue with order 'posted' sorts newest first and sinks a posting with no board date, tying the rest by score", () => {
  const older = posting("a::1", { posted_at: "2026-09-01", comp_low: 100_000, comp_high: 100_000 });
  const newer = posting("b::1", { posted_at: "2026-09-14", comp_low: 100_000, comp_high: 100_000 });
  const noDate = posting("c::1", { posted_at: null, comp_low: 500_000, comp_high: 500_000 });
  // A richer band on the undated row must not move it off the bottom.
  assert.deepEqual(
    orderedQueue([older, noDate, newer], null, QUEUE_NOW, [], "posted").map((p) => p.key),
    ["b::1", "a::1", "c::1"],
  );
  // Same day falls back to the (floorless) score order.
  const sameDayLow = posting("d::1", {
    posted_at: "2026-09-14",
    comp_low: 100_000,
    comp_high: 100_000,
  });
  const sameDayHigh = posting("e::1", {
    posted_at: "2026-09-14",
    comp_low: 300_000,
    comp_high: 300_000,
  });
  assert.deepEqual(
    orderedQueue([sameDayLow, sameDayHigh], null, QUEUE_NOW, [], "posted").map((p) => p.key),
    ["e::1", "d::1"],
  );
});

/** Three postings at two companies, whose score order interleaves them. */
const ACME_TOP = posting("acme::top", {
  company: "Acme",
  title: "Top role",
  comp_low: 300_000,
  comp_high: 300_000,
});
const ACME_LOW = posting("acme::low", {
  company: "Acme",
  title: "Low role",
  comp_low: 100_000,
  comp_high: 100_000,
});
const BEVEL_MID = posting("bevel::mid", {
  company: "Bevel",
  title: "Mid role",
  comp_low: 200_000,
  comp_high: 200_000,
});

/** Two acted on at Acme, which still has roles waiting, and one at Cirrus, which has none. */
const ACME_APPLIED = posting("acme::applied", {
  company: "Acme",
  title: "Applied role",
  status: "applied",
  status_at: "2026-09-10T00:00:00Z",
});
const ACME_CLOSED = posting("acme::closed", {
  company: "Acme",
  title: "Closed role",
  status: "closed",
  status_at: "2026-09-12T00:00:00Z",
});
const CIRRUS_APPLIED = posting("cirrus::applied", {
  company: "Cirrus",
  title: "Applied role",
  status: "applied",
  status_at: "2026-09-11T00:00:00Z",
});

test("orderedQueue with order 'company' pulls a company's rows together under the place its best posting earned", () => {
  const scattered = [ACME_LOW, BEVEL_MID, ACME_TOP];
  assert.deepEqual(
    orderedQueue(scattered, null, QUEUE_NOW).map((p) => p.key),
    ["acme::top", "bevel::mid", "acme::low"],
    "the score order interleaves the two companies",
  );
  assert.deepEqual(
    orderedQueue(scattered, null, QUEUE_NOW, [], "company").map((p) => p.key),
    ["acme::top", "acme::low", "bevel::mid"],
    "Acme leads on its best posting, and its own rows stay in score order",
  );
});

test("orderedQueue with order 'company' returns one flat array holding every posting exactly once", () => {
  // The flat array is what `resolveSelection`/`nextSelection` index into.
  const grouped = orderedQueue([ACME_LOW, BEVEL_MID, ACME_TOP], null, QUEUE_NOW, [], "company");
  assert.deepEqual([...grouped].map((p) => p.key).sort(), ["acme::low", "acme::top", "bevel::mid"]);
});

test("orderedQueue with order 'company' follows a company's waiting rows with its history, most recent act first", () => {
  assert.deepEqual(
    orderedQueue([ACME_LOW, BEVEL_MID, ACME_TOP], null, QUEUE_NOW, [], "company", [
      ACME_APPLIED,
      ACME_CLOSED,
    ]).map((p) => p.key),
    ["acme::top", "acme::low", "acme::closed", "acme::applied", "bevel::mid"],
    "Acme's two waiting roles by score, then the closed one (12th) and the applied one (10th)",
  );
});

test("orderedQueue with order 'company' leaves out a company with nothing waiting, however much history it holds", () => {
  assert.deepEqual(
    orderedQueue([BEVEL_MID], null, QUEUE_NOW, [], "company", [CIRRUS_APPLIED, ACME_APPLIED]).map(
      (p) => p.key,
    ),
    ["bevel::mid"],
    "neither Cirrus nor Acme opens a group of its own",
  );
});

test("orderedQueue reads the acted-on postings in the company order alone", () => {
  for (const order of ["score", "posted"] as const) {
    assert.deepEqual(
      orderedQueue([ACME_TOP], null, QUEUE_NOW, [], order, [ACME_APPLIED]).map((p) => p.key),
      ["acme::top"],
      `the ${order} order shows no history`,
    );
  }
});

test("queueRows opens each company with a header naming what is waiting there, and gives every other row none", () => {
  const rows = queueRows([ACME_TOP, ACME_LOW, BEVEL_MID], true);
  assert.deepEqual(
    rows.map((row) => row.head),
    [
      { company: "Acme", waiting: 2, applied: 0 },
      null,
      { company: "Bevel", waiting: 1, applied: 0 },
    ],
  );
  assert.deepEqual(
    rows.map((row) => row.posting.key),
    ["acme::top", "acme::low", "bevel::mid"],
    "the postings come through in the order they were given",
  );
});

test("queueRows outside grouped mode heads nothing, however the companies repeat", () => {
  assert.deepEqual(
    queueRows([ACME_TOP, ACME_LOW, BEVEL_MID], false).map((row) => row.head),
    [null, null, null],
  );
});

test("queueRows counts a header's waiting rows and its applied ones separately, and neither totals the group", () => {
  const rows = queueRows([ACME_TOP, ACME_LOW, ACME_CLOSED, ACME_APPLIED, BEVEL_MID], true);
  assert.deepEqual(
    rows.map((row) => row.head),
    [
      { company: "Acme", waiting: 2, applied: 1 },
      null,
      null,
      null,
      { company: "Bevel", waiting: 1, applied: 0 },
    ],
    "Acme shows four rows and the header counts two of them waiting and one applied: the closed row is neither",
  );
});

test("queueRows marks a company's acted-on rows as its history and leaves the waiting ones unmarked", () => {
  assert.deepEqual(
    queueRows([ACME_TOP, ACME_LOW, ACME_CLOSED, ACME_APPLIED, BEVEL_MID], true).map(
      (row) => row.history,
    ),
    [false, false, true, true, false],
    "a status is what makes a row history: closed counts, however the applied clause reads it",
  );
});

test("queueRows outside grouped mode marks no row history, since the flat orders hold none", () => {
  assert.deepEqual(
    queueRows([ACME_TOP, ACME_LOW, BEVEL_MID], false).map((row) => row.history),
    [false, false, false],
  );
});

test("waitingLabel counts what is still open at a company, with no singular to agree with", () => {
  assert.equal(waitingLabel(1), "1 waiting");
  assert.equal(waitingLabel(13), "13 waiting");
});

test("appliedLabel counts what James has already taken there, as a state and not a share of the waiting count", () => {
  // Not "applied to 1", which beside a waiting count reads as "1 of those 3".
  assert.equal(appliedLabel(1), "1 applied");
  assert.equal(appliedLabel(6), "6 applied");
});

test("companyHeadLabel adds the applied clause only where there is one to show", () => {
  assert.equal(companyHeadLabel({ company: "Bevel", waiting: 1, applied: 0 }), "1 waiting");
  assert.equal(
    companyHeadLabel({ company: "Northwind", waiting: 13, applied: 1 }),
    "13 waiting · 1 applied",
    "a middot, not a comma: two counts over two different sets of the rows below",
  );
});

test("appliedCountsByCompany counts a company's postings with a status, and excludes closed", () => {
  const counts = appliedCountsByCompany([
    posting("northwind::a", { company: "Northwind", status: "applied" }),
    posting("northwind::b", { company: "Northwind", status: "interviewing" }),
    posting("chatterly::a", { company: "Chatterly", status: "closed" }),
    posting("streamly::a", { company: "Streamly", status: null }),
  ]);
  assert.deepEqual(
    [...counts.entries()].sort(),
    [["Northwind", 2]],
    "Chatterly only has a closed posting, so it does not count as applied to; Streamly has no status at all",
  );
});

const FLOOR = 150_000;
const TODAY = Date.parse("2026-09-15T12:00:00Z");

test("scoreOf at the floor, posted today, is the freshness alone: 30", () => {
  const p = posting("a::1", { comp_low: FLOOR, comp_high: FLOOR, posted_at: "2026-09-15" });
  assert.equal(scoreOf(p, FLOOR, TODAY), 30);
});

test("scoreOf at half again over the floor, 90 days old, is the pay alone: 70", () => {
  const p = posting("a::1", { comp_low: 225_000, comp_high: 225_000, posted_at: "2026-06-17" });
  assert.equal(scoreOf(p, FLOOR, TODAY), 70);
});

test("scoreOf at twice the floor, posted today, is still 100: pay is capped", () => {
  const p = posting("a::1", { comp_low: 300_000, comp_high: 300_000, posted_at: "2026-09-15" });
  assert.equal(scoreOf(p, FLOOR, TODAY), 100);
});

test("scoreOf halfway to full pay, 45 days old, is 35 + 15 = 50", () => {
  const p = posting("a::1", { comp_low: 187_500, comp_high: 187_500, posted_at: "2026-08-01" });
  assert.equal(scoreOf(p, FLOOR, TODAY), 50);
});

test("scoreOf with no band gets 20 of the pay marks, so 90 days old is 20", () => {
  const p = posting("a::1", {
    comp_low: null,
    comp_high: null,
    posted_at: null,
    first_seen: "2026-06-17T00:00:00Z",
  });
  assert.equal(scoreOf(p, FLOOR, TODAY), 20);
});

test("scoreOf reads age from first_seen when posted_at is missing", () => {
  const p = posting("a::1", {
    comp_low: FLOOR,
    comp_high: FLOOR,
    posted_at: null,
    first_seen: "2026-09-05T00:00:00Z",
  });
  // 30 × (1 − 10/90) = 26.67, rounded to 27.
  assert.equal(scoreOf(p, FLOOR, TODAY), 27);
});

test("scoreOf reads a top over full reach as full pay: the band is capped, not a bonus", () => {
  const p = posting("a::1", { comp_low: 200_000, comp_high: 250_000, posted_at: "2026-09-15" });
  // Top 250k is past floor × 1.5: 70 + 30.
  assert.equal(scoreOf(p, FLOOR, TODAY), 100);
});

test("scoreOf reads the band's top, so a band straddling the floor scores its reach above it", () => {
  const p = posting("a::1", { comp_low: 120_000, comp_high: 180_000, posted_at: "2026-09-15" });
  // Midpoint 150k is the floor and would score 0; top 180k is 30k of the
  // 75k reach: 70 × 0.4 = 28, plus 30 fresh.
  assert.equal(scoreOf(p, FLOOR, TODAY), 58);
});

test("scoreOf takes a lone comp_low as the band's top", () => {
  const p = posting("a::1", { comp_low: 180_000, comp_high: null, posted_at: "2026-09-15" });
  assert.equal(scoreOf(p, FLOOR, TODAY), 58);
});

// An empty product-words list (the column's seed) must change nothing.
test("scoreOf with an empty product-words list equals today's score", () => {
  const p = posting("a::1", { comp_low: 300_000, comp_high: 300_000, posted_at: "2026-09-15" });
  assert.equal(scoreOf(p, FLOOR, TODAY, []), scoreOf(p, FLOOR, TODAY));
  assert.equal(scoreOf(p, FLOOR, TODAY, []), 100);
});

test("scoreOf with the list, a product title scores SHAPE_WEIGHT above the same posting with a non-product title", () => {
  const productWords = ["product", "growth"];
  const product = posting("a::1", {
    title: "Senior Product Engineer",
    comp_low: 225_000,
    comp_high: 225_000,
    posted_at: "2026-06-17",
  });
  const nonProduct = posting("a::1", {
    title: "Senior Backend Engineer",
    comp_low: 225_000,
    comp_high: 225_000,
    posted_at: "2026-06-17",
  });
  assert.equal(
    scoreOf(product, FLOOR, TODAY, productWords) - scoreOf(nonProduct, FLOOR, TODAY, productWords),
    SHAPE_WEIGHT,
  );
});

test("scoreOf matches a product word whole-word only, not as a substring of a longer word", () => {
  const productWords = ["product"];
  // "Production" carries "product" as a substring, not a whole word.
  const substring = posting("a::1", {
    title: "Production Engineer",
    comp_low: 225_000,
    comp_high: 225_000,
    posted_at: "2026-06-17",
  });
  const wholeWord = posting("a::1", {
    title: "Product Engineer",
    comp_low: 225_000,
    comp_high: 225_000,
    posted_at: "2026-06-17",
  });
  assert.equal(
    scoreOf(wholeWord, FLOOR, TODAY, productWords) - scoreOf(substring, FLOOR, TODAY, productWords),
    SHAPE_WEIGHT,
  );
});

test("scoreOf with a non-empty product-words list, base 70 fixture, product title scores 75", () => {
  const productWords = ["product"];
  const p = posting("a::1", {
    title: "Senior Product Engineer",
    comp_low: 225_000,
    comp_high: 225_000,
    posted_at: "2026-06-17",
  });
  assert.equal(scoreOf(p, FLOOR, TODAY, productWords), 75);
});

test("scoreOf with a non-empty product-words list, base 70 fixture, non-product title scores 60", () => {
  const productWords = ["product"];
  const p = posting("a::1", {
    title: "Senior Backend Engineer",
    comp_low: 225_000,
    comp_high: 225_000,
    posted_at: "2026-06-17",
  });
  assert.equal(scoreOf(p, FLOOR, TODAY, productWords), 60);
});

test("a card with no floor to read shows no score; one with a floor shows the tile", async () => {
  const p = posting("acme::1", { comp_low: 300_000, comp_high: 300_000 });

  const withoutFloor = await render(PostingCard, {
    posting: p,
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
  });
  assert.doesNotMatch(withoutFloor, /class="score"/);

  const withFloor = await render(PostingCard, {
    posting: p,
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: FLOOR,
  });
  // What the tile counts is named in its `title`, not a caption per row.
  assert.match(withFloor, /class="score"[^>]*title="[^"]+"[^>]*>\d+<\/span>/);
});

test("a card shows comp, the evidence the processor kept it for, and the posting link", async () => {
  const p = posting("acme::1", {
    company: "Acme",
    title: "Staff Engineer",
    url: "https://boards.example.com/acme/1",
    comp_low: 180_000,
    comp_high: 220_000,
    reasons: [{ criterion: "role", verdict: "kept", detail: "Matches role_words" }],
  });

  const html = await render(PostingCard, {
    posting: p,
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
  });

  assert.match(html, /\$180k–\$220k/);
  assert.match(html, /href="https:\/\/boards\.example\.com\/acme\/1"/);
  assert.match(html, /target="_blank"/);
  assert.doesNotMatch(html, /class="evidence"/);
});

test("a card's expansion carries the evidence sentences on demand", async () => {
  const p = posting("acme::1", {
    reasons: [{ criterion: "role", verdict: "kept", detail: "Matches role_words" }],
    evidence: { role_words: 'matched "staff engineer" in the title' },
  });

  const closed = await render(PostingCard, {
    posting: p,
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
  });
  assert.doesNotMatch(closed, /class="evidence"/);

  const open = await render(PostingCard, {
    posting: p,
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
    expanded: true,
  });
  assert.match(open, /class="evidence"/);
  assert.match(open, /role words/);
  assert.match(open, /matched &quot;staff engineer&quot; in the title/);
});

test("the drawer shows each reason once, as evidence, and a closed posting's note", async () => {
  const html = await render(PostingCard, {
    posting: posting("Acme::1", {
      status: "closed",
      note: "Requires Go.",
      reasons: [{ criterion: "level", verdict: "in", detail: 'title carries level word "Staff"' }],
      evidence: { level: 'title carries level word "Staff"' },
    }),
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
    expanded: true,
  });
  assert.equal((html.match(/title carries level word/g) ?? []).length, 1);
  assert.match(html, /<dt>level<\/dt>/);
  assert.match(html, /class="note-label">Closed because</);
  assert.match(html, /class="note-body">Requires Go\./);
  assert.doesNotMatch(html, /class="reason"/);
});

// Closing says the processor was wrong, so James's sentence leads the
// drawer and the evidence it overrode follows it.
test("the drawer puts the close reason above the evidence", async () => {
  const html = await render(PostingCard, {
    posting: posting("Acme::1", {
      status: "closed",
      note: "Requires Go.",
      evidence: { level: 'title carries level word "Staff"' },
    }),
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
    expanded: true,
  });
  assert.ok(html.indexOf('class="note"') < html.indexOf('class="evidence"'));
});

test("a rejected card with 'change' revealed offers all five outcomes in order, Closed last and marked as the override", async () => {
  // Only the reveal ever puts all five on one card; `revealed` is the
  // SSR-reachable seed for it.
  const p = posting("acme::1", { company: "Acme", status: "rejected", status_at: "2026-09-10" });

  const html = await render(PostingCard, {
    posting: p,
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
    revealed: true,
  });

  assert.deepEqual(outcomeLabels(html), ["Applied", "Interviewing", "Rejected", "Offer", "Closed"]);
  assert.match(html, /class="close act"/);
});

test("closing opens the close dialog as an accessible, labelled modal", async () => {
  const p = posting("acme::1", { company: "Acme" });

  const html = await render(PostingCard, {
    posting: p,
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
    closing: true,
  });

  assert.match(html, /class="decide close-prompt" role="dialog" aria-modal="true" tabindex="-1"/);
  const labelledby = html.match(/aria-labelledby="([^"]+)"/);
  const headingId = html.match(/<h2 id="([^"]+)">Close — Acme<\/h2>/);
  assert.ok(labelledby, "aria-labelledby is rendered");
  assert.ok(headingId, "the heading carries a matching id");
  assert.equal(labelledby?.[1], headingId?.[1]);
});

test("the close dialog's aria-labelledby stays one IDREF when the posting key holds whitespace", async () => {
  // aria-labelledby is a space-separated IDREF list; the listing id at the
  // end of a key is still whatever the board calls it.
  const p = posting("greenhouse/acme::swe 1");

  const html = await render(PostingCard, {
    posting: p,
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
    closing: true,
  });

  const labelledby = html.match(/aria-labelledby="([^"]+)"/)?.[1] ?? "";
  const headingId = html.match(/<h2 id="([^"]+)">Close — /)?.[1] ?? "";
  assert.notEqual(labelledby, "", "aria-labelledby is rendered");
  assert.doesNotMatch(labelledby, /\s/, "the value is one IDREF, not a list of several");
  assert.equal(labelledby, headingId);
});

test("with closing false (the default), no dialog renders at all", async () => {
  const p = posting("acme::1");

  const html = await render(PostingCard, {
    posting: p,
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
  });

  assert.doesNotMatch(html, /role="dialog"/);
});

test("a card with no URL shows no posting link", async () => {
  const p = posting("acme::1", { url: null });

  const html = await render(PostingCard, {
    posting: p,
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
  });

  assert.doesNotMatch(html, /class="icon-btn"/);
});

test("the posting link opens the group of actions, inside .acts, and every control in it names itself on hover", () => {
  // From the mounted tree, not the rendered string: asking `.acts` for its
  // element children cannot be confused by what is nested inside a control.
  const card = mountTree(PostingCard, {
    posting: posting("acme::1", { company: "Acme", url: "https://acme.example/job/1" }),
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
  });
  try {
    assert.equal(elementsWithClass(card.root, "tools").length, 0, "the link's old wrapper is gone");
    const acts = elementsWithClass(card.root, "acts")[0];
    assert.ok(acts !== undefined, "the card renders an .acts group");
    const controls = acts.children.filter((child) => child.tag === "a" || child.tag === "button");
    // An icon-only group leaves a sighted mouse user nothing to read otherwise.
    assert.deepEqual(
      controls.map((control) => [kindOf(control), control.props["title"]]),
      [
        ["icon-btn", "Open the posting"],
        ["act", "Applied"],
        ["act close", "Closed"],
      ],
    );
  } finally {
    card.unmount();
  }
});

function kindOf(control: TreeNode): string {
  return ["icon-btn", "act", "close"].filter((name) => hasClass(control, name)).join(" ");
}

test("every action carries a glyph, and its word rides in aria-label and title, never on screen", async () => {
  const html = await render(PostingCard, {
    posting: posting("Acme::1", { status: "rejected" }),
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
    revealed: true,
  });
  const glyphs = html.match(/class="glyph"/g) ?? [];
  assert.equal(glyphs.length, STATUSES.length);
  assert.doesNotMatch(html, /class="label"/, "no action writes its word on screen");
  const ariaLabels = [
    ...html.matchAll(/<button[^>]*class="[^"]*\bact\b[^"]*"[^>]*aria-label="([^"]+)"/g),
  ].map((m) => m[1]);
  assert.deepEqual(ariaLabels, [
    "Applied — Acme",
    "Interviewing — Acme",
    "Rejected — Acme",
    "Offer — Acme",
    "Closed — Acme",
  ]);
  assert.deepEqual(outcomeLabels(html), ["Applied", "Interviewing", "Rejected", "Offer", "Closed"]);
  for (const status of STATUSES) {
    assert.notEqual(iconOf(status), "");
  }
});

test("a posting with a status shows it as a toned pill with its age", async () => {
  const now = new Date();
  const threeDaysAgo = new Date(now.getTime() - 3 * 86_400_000).toISOString();
  const withStatus = await render(PostingCard, {
    posting: posting("Acme::1", { status: "applied", status_at: threeDaysAgo }),
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
  });
  assert.match(withStatus, /class="status tag tone-progress"/);
  assert.match(withStatus, /for 3 days/);
});

test("a posting with no status says it is in the queue, and for how long", async () => {
  const fourDaysAgo = new Date(Date.now() - 4 * 86_400_000).toISOString();
  const without = await render(PostingCard, {
    posting: posting("Acme::2", { first_seen: fourDaysAgo }),
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
  });
  assert.match(without, /class="meta"/);
  assert.match(without, /class="status tag tone-neutral"/);
  assert.match(without, /In queue/);
  assert.match(without, /for 4 days/);
});

test("the tag needs no prop to decide it: the same card says it on either page", async () => {
  // The queue and the Record hand `PostingCard` the same props; a page
  // deciding whether a row states its own status is how the two drifted.
  const props = {
    posting: posting("Acme::3"),
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
  };
  const once = await render(PostingCard, props);
  const twice = await render(PostingCard, props);
  assert.equal(once, twice);
  assert.match(once, /In queue/);
});

test("ageLabel and daysBetween say the age in words and never go negative", () => {
  assert.equal(ageLabel(0), "since today");
  assert.equal(ageLabel(1), "for 1 day");
  assert.equal(ageLabel(12), "for 12 days");
  const now = Date.parse("2026-09-15T12:00:00Z");
  assert.equal(daysBetween("2026-09-13T00:00:00Z", now), 2);
  assert.equal(daysBetween("2026-09-16T00:00:00Z", now), 0);
});

test("daysBetween reads a bare date posted today as zero days, even late in a negative-offset evening", () => {
  // `posted_at` arrives as a bare `"2026-09-16"`. TZ is forced to a
  // negative offset: on a UTC runner this case cannot fail either way.
  const originalTz = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";
  try {
    // 23:30 local on the same calendar day; the UTC-midnight parse put this
    // over 24 hours in the past.
    const lateEvening = new Date(2026, 8, 16, 23, 30, 0).getTime();
    assert.equal(daysBetween("2026-09-16", lateEvening), 0);
  } finally {
    process.env.TZ = originalTz;
  }
});

test("postedAgeLabel says how long ago the board posted, worded apart from a status age", () => {
  assert.equal(postedAgeLabel(0), "posted today");
  assert.equal(postedAgeLabel(1), "posted 1 day ago");
  assert.equal(postedAgeLabel(12), "posted 12 days ago");
});

test("a card shows how long ago it was posted, alongside — not in place of — its status age", async () => {
  const now = Date.now();
  const fiveDaysAgo = new Date(now - 5 * 86_400_000).toISOString();
  const twoDaysAgo = new Date(now - 2 * 86_400_000).toISOString();
  const html = await render(PostingCard, {
    posting: posting("Acme::1", {
      status: "applied",
      status_at: twoDaysAgo,
      posted_at: fiveDaysAgo,
    }),
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
  });
  assert.match(html, /class="age"[^>]*>for 2 days</);
  assert.match(html, /class="age posted-age"[^>]*>posted 5 days ago</);
});

test("a bare queue card (no status) still says how long ago it was posted", async () => {
  const now = Date.now();
  const tenDaysAgo = new Date(now - 10 * 86_400_000).toISOString();
  const html = await render(PostingCard, {
    posting: posting("Acme::1", { posted_at: tenDaysAgo }),
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
  });
  assert.match(html, /class="meta"/);
  assert.match(html, /posted 10 days ago/);
});

test("a posting with no posted_at says nothing of posting age, unlike scoreOf which falls back to first_seen", async () => {
  const html = await render(PostingCard, {
    posting: posting("Acme::1", { posted_at: null, first_seen: "2026-01-01T00:00:00Z" }),
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
  });
  assert.doesNotMatch(html, /posted-age/);
  assert.doesNotMatch(html, /posted \d+ days? ago|posted today/);
});

test("QueueView renders in score order when it has a floor", async () => {
  const stale = posting("st::1", {
    company: "Stale",
    comp_low: 300_000,
    comp_high: 300_000,
    posted_at: "2020-01-01",
  });
  const fresh = posting("fr::1", {
    company: "Fresh",
    comp_low: 300_000,
    comp_high: 300_000,
    posted_at: new Date().toISOString().slice(0, 10),
  });
  const html = await render(QueueView, {
    postings: [stale, fresh],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: 150_000,
  });
  assert.ok(html.indexOf("Fresh") < html.indexOf("Stale"), "fresh first by score");
});

test("QueueView renders in midpoint order with an unposted band at the floor when there is no floor", async () => {
  const noBand = posting("nb::1", { company: "NoBand", comp_low: null, comp_high: null });
  const modest = posting("mo::1", { company: "Modest", comp_low: 150_000, comp_high: 150_000 });
  const top = posting("tp::1", { company: "Top", comp_low: 300_000, comp_high: 300_000 });

  const html = await render(QueueView, {
    postings: [noBand, modest, top],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
  });

  const order = ["Top", "Modest", "NoBand"].map((name) => html.indexOf(name));
  assert.ok(
    order[0] < order[1] && order[1] < order[2],
    `expected Top, Modest, NoBand in order: ${order}`,
  );
});

test("QueueView shows the empty state when nothing is waiting", async () => {
  const html = await render(QueueView, {
    postings: [],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
  });

  assert.match(html, /class="empty"/);
  assert.match(html, /Nothing waiting on you/);
});

test("statusTag names the queue for a posting with no status, and the status for one with", () => {
  assert.deepEqual(statusTag(null), { label: "In queue", tone: "neutral" });
  assert.deepEqual(statusTag("applied"), { label: "Applied", tone: "progress" });
  assert.deepEqual(statusTag("closed"), { label: labelOf("closed"), tone: toneOf("closed") });
});

test("a queue row states its place, so a group's waiting rows read beside its acted-on ones", async () => {
  // Grouped, a row with no tag would read as an omission, so the tag is on
  // every card and not behind a prop.
  const html = await render(QueueView, {
    postings: [posting("a::1", { company: "Acme", title: "Waiting role" })],
    history: [
      posting("a::2", {
        company: "Acme",
        title: "Taken role",
        status: "applied",
        status_at: "2026-09-10",
      }),
    ],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
    store: memoryStore({ [QUEUE_ORDER_KEY]: "company" }),
  });
  assert.match(html, /class="status tag tone-neutral">In queue</);
  assert.match(html, /class="status tag tone-progress">Applied</);
});

test("QueueView cards offer applied and closed only, read straight off the posting's own (null) status", async () => {
  // No `outcomes` prop: the queue's rows are exactly the map's "queue" row.
  const p = posting("a::1", { company: "Acme" });
  const queue = await render(QueueView, {
    postings: [p],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
  });
  const list = queue.match(/class="list">([^]*?)<\/div><aside/)?.[1] ?? "";
  assert.deepEqual(outcomeLabels(list), ["Applied", "Closed"]);
});

test("the rendered queue shows all three order controls, 'By score' pressed by default", async () => {
  const html = await render(QueueView, {
    postings: [posting("a::1")],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
  });
  const group = html.match(/class="order"[^>]*>([^]*?)<\/div>/)?.[1] ?? "";
  assert.match(group, />By score</);
  assert.match(group, />Newest first</);
  assert.match(group, />Group by company</);
  assert.match(group, /aria-pressed="true"[^>]*>By score/);
  assert.match(group, /aria-pressed="false"[^>]*>Newest first/);
  assert.match(group, /aria-pressed="false"[^>]*>Group by company/);
});

test("a stored 'posted' order is read on mount and marks 'Newest first' pressed", async () => {
  const html = await render(QueueView, {
    postings: [posting("a::1")],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
    store: memoryStore({ [QUEUE_ORDER_KEY]: "posted" }),
  });
  const group = html.match(/class="order"[^>]*>([^]*?)<\/div>/)?.[1] ?? "";
  assert.match(group, /aria-pressed="false"[^>]*>By score/);
  assert.match(group, /aria-pressed="true"[^>]*>Newest first/);
  assert.match(group, /aria-pressed="false"[^>]*>Group by company/);
});

test("a stored 'company' order is read on mount and marks 'Group by company' pressed", async () => {
  const html = await render(QueueView, {
    postings: [posting("a::1")],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
    store: memoryStore({ [QUEUE_ORDER_KEY]: "company" }),
  });
  const group = html.match(/class="order"[^>]*>([^]*?)<\/div>/)?.[1] ?? "";
  assert.match(group, /aria-pressed="false"[^>]*>By score/);
  assert.match(group, /aria-pressed="false"[^>]*>Newest first/);
  assert.match(group, /aria-pressed="true"[^>]*>Group by company/);
});

test("a stored garbage order value reads as 'score', none of the other two pressed", async () => {
  const html = await render(QueueView, {
    postings: [posting("a::1")],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
    store: memoryStore({ [QUEUE_ORDER_KEY]: "alphabetical" }),
  });
  const group = html.match(/class="order"[^>]*>([^]*?)<\/div>/)?.[1] ?? "";
  assert.match(group, /aria-pressed="true"[^>]*>By score/);
  assert.match(group, /aria-pressed="false"[^>]*>Newest first/);
  assert.match(group, /aria-pressed="false"[^>]*>Group by company/);
});

test("choosing 'Newest first' reorders the list and writes the key", async () => {
  const restoreDom = stubDom();
  const store = memoryStore();
  const older = posting("a::1", {
    company: "Older",
    posted_at: "2020-01-01",
    comp_low: 300_000,
    comp_high: 300_000,
  });
  const newer = posting("b::1", {
    company: "Newer",
    posted_at: "2026-09-14",
    comp_low: 100_000,
    comp_high: 100_000,
  });
  const app = mountTree(QueueView, {
    postings: [older, newer],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
    store,
  });
  try {
    // Older sorts first by the default midpoint order.
    const list = elementsWithClass(app.root, "list")[0];
    assert.ok(list !== undefined, "the list renders");
    assert.ok(
      textOf(list).indexOf("Older") < textOf(list).indexOf("Newer"),
      "Older leads by score",
    );
    const newestFirst = elementsWithClass(app.root, "order")[0]?.children.find(
      (button) => textOf(button) === "Newest first",
    );
    assert.ok(newestFirst !== undefined, "the 'Newest first' button renders");
    click(newestFirst);
    await settled();
    const reordered = elementsWithClass(app.root, "list")[0];
    assert.ok(reordered !== undefined);
    assert.ok(
      textOf(reordered).indexOf("Newer") < textOf(reordered).indexOf("Older"),
      "Newer now leads, by posted date",
    );
    assert.equal(store.getItem(QUEUE_ORDER_KEY), "posted", "the choice is written to the store");
  } finally {
    app.unmount();
    restoreDom();
  }
});

test("choosing 'Group by company' writes the key at once, the same setOrder path 'Newest first' uses", () => {
  // Not settled here: switching into grouped mode mid-mount gives
  // already-mounted rows a company-head sibling, a structural change
  // inside the TransitionGroup whose enter hook needs a real classList the
  // object-tree renderer does not provide. `setOrder` writes to the store
  // synchronously before any re-render.
  const restoreDom = stubDom();
  const store = memoryStore();
  const app = mountTree(QueueView, {
    postings: [ACME_LOW, BEVEL_MID, ACME_TOP],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
    store,
  });
  try {
    const groupByCompany = elementsWithClass(app.root, "order")[0]?.children.find(
      (button) => textOf(button) === "Group by company",
    );
    assert.ok(groupByCompany !== undefined, "the 'Group by company' button renders");
    click(groupByCompany);
    assert.equal(store.getItem(QUEUE_ORDER_KEY), "company", "the choice is written to the store");
  } finally {
    app.unmount();
    restoreDom();
  }
});

test("the grouped list is one list, with the company headers as siblings of the rows inside it", () => {
  // `onListKeydown` reads `.card .head` off the one element the keydown is
  // bound to, so every row has to stay a descendant of it; a
  // TransitionGroup per company would stop Down dead on a company's last row.
  const restoreDom = stubDom();
  const app = mountTree(QueueView, {
    postings: [ACME_LOW, BEVEL_MID, ACME_TOP],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
    store: memoryStore({ [QUEUE_ORDER_KEY]: "company" }),
  });
  try {
    const lists = elementsWithClass(app.root, "list");
    assert.equal(lists.length, 1, "one list, not one per company");
    const list = lists[0];
    assert.ok(list !== undefined);
    assert.equal(typeof list.props["onKeydown"], "function", "the row scan is bound to it");
    assert.deepEqual(
      list.children.map((child) => (hasClass(child, "company-head") ? "company-head" : "card")),
      ["company-head", "card", "card", "company-head", "card"],
      "Acme's header, its two rows, then Bevel's header and its row",
    );
    assert.equal(
      elementsWithClass(list, "head").length,
      3,
      "all three rows' head buttons are inside the one list",
    );
    const acmeHeader = list.children[0];
    assert.ok(acmeHeader !== undefined);
    assert.match(textOf(acmeHeader), /Acme/);
    assert.match(
      textOf(acmeHeader),
      /2 waiting/,
      "the header carries the decision still open there",
    );
  } finally {
    app.unmount();
    restoreDom();
  }
});

test("the list is marked grouped only in grouped mode, which is the hook the row's company cell is dropped by", () => {
  // The header names the company and CSS stops the rows repeating it; the
  // class is the only part of that a test can see.
  const restoreDom = stubDom();
  const grouped = mountTree(QueueView, {
    postings: [ACME_LOW, BEVEL_MID, ACME_TOP],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
    store: memoryStore({ [QUEUE_ORDER_KEY]: "company" }),
  });
  const byScore = mountTree(QueueView, {
    postings: [ACME_LOW, BEVEL_MID, ACME_TOP],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
  });
  try {
    const groupedList = elementsWithClass(grouped.root, "list")[0];
    const scoredList = elementsWithClass(byScore.root, "list")[0];
    assert.ok(groupedList !== undefined && scoredList !== undefined, "both lists render");
    assert.ok(hasClass(groupedList, "grouped"), "grouped mode marks the list");
    assert.ok(!hasClass(scoredList, "grouped"), "the score order does not");
  } finally {
    grouped.unmount();
    byScore.unmount();
    restoreDom();
  }
});

test("a grouped company shows the history app.ts hands in under its waiting rows, and heads it with both counts", () => {
  const restoreDom = stubDom();
  const app = mountTree(QueueView, {
    postings: [ACME_LOW, BEVEL_MID, ACME_TOP],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
    store: memoryStore({ [QUEUE_ORDER_KEY]: "company" }),
    history: [ACME_APPLIED, CIRRUS_APPLIED],
  });
  try {
    const list = elementsWithClass(app.root, "list")[0];
    assert.ok(list !== undefined);
    assert.deepEqual(
      list.children.map((child) =>
        hasClass(child, "company-head") ? textOf(child) : textOf(child).includes("Applied role"),
      ),
      ["Acme — 2 waiting · 1 applied", false, false, true, "Bevel — 1 waiting", false],
      "Acme's two waiting roles then the one he applied to; Cirrus, with nothing waiting, opens no group",
    );
    const statuses = elementsWithClass(list, "status");
    assert.deepEqual(
      statuses.map(textOf),
      ["In queue", "In queue", "Applied", "In queue"],
      "every row states where it stands, so the acted-on one is told apart by what it says",
    );
    assert.deepEqual(
      elementsWithClass(list, "card").map((card) => hasClass(card, "history")),
      [false, false, true, false],
      "only the acted-on row is marked history, which is what app.css draws the division from",
    );
  } finally {
    app.unmount();
    restoreDom();
  }
});

test("a grouped company's history row offers the outcomes its own status allows, not the queue's two", () => {
  // An applied row offers Interviewing, Rejected and Closed, never Applied again.
  const restoreDom = stubDom();
  const app = mountTree(QueueView, {
    postings: [ACME_TOP],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
    store: memoryStore({ [QUEUE_ORDER_KEY]: "company" }),
    history: [ACME_APPLIED],
  });
  try {
    const list = elementsWithClass(app.root, "list")[0];
    assert.ok(list !== undefined);
    const acted = cardIn(app.root, "list", "Applied role");
    assert.deepEqual(
      elementsWithClass(acted, "act").map((button) => button.props["title"]),
      ["Interviewing", "Rejected", "Closed"],
    );
    const waiting = cardIn(app.root, "list", "Top role");
    assert.deepEqual(
      elementsWithClass(waiting, "act").map((button) => button.props["title"]),
      ["Applied", "Closed"],
      "the waiting row still offers what the queue offers",
    );
  } finally {
    app.unmount();
    restoreDom();
  }
});

test("the filtered count counts what is waiting on James, not the rows the grouped order puts on screen", async () => {
  // Grouped, it reads three of three with five rows and two headers on
  // screen: a company's acted-on history is appended to its group whatever
  // the box says, and none of it is waiting on him.
  const restoreDom = stubDom();
  const app = mountTree(QueueView, {
    postings: [ACME_LOW, BEVEL_MID, ACME_TOP],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
    store: memoryStore({ [QUEUE_ORDER_KEY]: "company" }),
    history: [ACME_APPLIED, ACME_CLOSED],
  });
  try {
    typeInto(searchInput(app.root), "role");
    await nextTick();
    const list = elementsWithClass(app.root, "list")[0];
    assert.ok(list !== undefined);
    assert.equal(elementsWithClass(list, "card").length, 5, "five rows are on screen");
    assert.equal(textOf(matchedLine(app.root)!), "3 of 3");
  } finally {
    app.unmount();
    restoreDom();
  }
});

test("nothing waiting is still the empty state, however much history the record holds", async () => {
  const html = await render(QueueView, {
    postings: [],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
    store: memoryStore({ [QUEUE_ORDER_KEY]: "company" }),
    history: [ACME_APPLIED, CIRRUS_APPLIED],
  });
  assert.match(html, /Nothing waiting on you/);
  assert.doesNotMatch(html, /Applied role/, "a company with nothing waiting is not a group");
});

test("the pane's successor after a decision is the row the grouped list reads next, not the score order's", () => {
  // `visible` itself is grouped rather than the grouping painted over a
  // score order: the pane's successor is an index step through the list
  // `useMasterDetail` was handed, and a presentation-only grouping would
  // send the pane to Bevel, disagreeing with the eye. Driven through the
  // composable: removing a card runs `TransitionGroup`'s leave hooks, which
  // need a real `classList` the object-tree renderer has none of.
  const postings = [ACME_LOW, BEVEL_MID, ACME_TOP];
  const grouped = useMasterDetail(
    computed(() => orderedQueue(postings, null, QUEUE_NOW, [], "company")),
  );
  grouped.selectedKey.value = "acme::top";
  grouped.advanceSelection("acme::top");
  assert.equal(grouped.selectedKey.value, "acme::low");

  const byScore = useMasterDetail(computed(() => orderedQueue(postings, null, QUEUE_NOW)));
  byScore.selectedKey.value = "acme::top";
  byScore.advanceSelection("acme::top");
  assert.equal(byScore.selectedKey.value, "bevel::mid", "where the score order would have gone");
});

test("deciding a company's last waiting row sends the pane to that company's history, the row the eye reads next", () => {
  // An acted-on row is a legitimate thing to select: it is the row James
  // moves Applied to Interviewing on.
  const grouped = useMasterDetail(
    computed(() =>
      orderedQueue([ACME_LOW, BEVEL_MID, ACME_TOP], null, QUEUE_NOW, [], "company", [ACME_APPLIED]),
    ),
  );
  grouped.selectedKey.value = "acme::low";
  grouped.advanceSelection("acme::low");
  assert.equal(grouped.selectedKey.value, "acme::applied");
});

test("outcomesFor offers applied and closed from the queue (no status)", () => {
  assert.deepEqual(outcomesFor(null), ["applied", "closed"]);
});

test("outcomesFor offers interviewing, rejected and closed from applied", () => {
  assert.deepEqual(outcomesFor("applied"), ["interviewing", "rejected", "closed"]);
});

test("outcomesFor offers offer, rejected and closed from interviewing", () => {
  assert.deepEqual(outcomesFor("interviewing"), ["offer", "rejected", "closed"]);
});

test("outcomesFor offers closed alone from offer", () => {
  assert.deepEqual(outcomesFor("offer"), ["closed"]);
});

test("outcomesFor offers nothing from rejected or closed — both are ends", () => {
  assert.deepEqual(outcomesFor("rejected"), []);
  assert.deepEqual(outcomesFor("closed"), []);
});

function outcomeLabels(html: string): string[] {
  return [...html.matchAll(/<button[^>]*class="[^"]*\bact\b[^"]*"[^>]*title="([^"]+)"/g)].map(
    (m) => m[1],
  );
}

test("a queue row (no status) offers exactly Applied and Closed", async () => {
  const html = await render(PostingCard, {
    posting: posting("a::1"),
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
  });
  assert.deepEqual(outcomeLabels(html), ["Applied", "Closed"]);
});

test("an applied row offers Interviewing, Rejected and Closed, and no Applied button", async () => {
  const html = await render(PostingCard, {
    posting: posting("a::1", { status: "applied", status_at: "2026-09-10T00:00:00Z" }),
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
  });
  assert.deepEqual(outcomeLabels(html), ["Interviewing", "Rejected", "Closed"]);
});

test("an interviewing row offers Offer, Rejected and Closed", async () => {
  const html = await render(PostingCard, {
    posting: posting("a::1", { status: "interviewing", status_at: "2026-09-10T00:00:00Z" }),
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
  });
  assert.deepEqual(outcomeLabels(html), ["Offer", "Rejected", "Closed"]);
});

test("an offer row offers Closed alone", async () => {
  const html = await render(PostingCard, {
    posting: posting("a::1", { status: "offer", status_at: "2026-09-10T00:00:00Z" }),
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
  });
  assert.deepEqual(outcomeLabels(html), ["Closed"]);
});

test("a rejected row offers no outcome buttons, only the quiet change control", async () => {
  const html = await render(PostingCard, {
    posting: posting("a::1", { status: "rejected", status_at: "2026-09-10T00:00:00Z" }),
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
  });
  assert.deepEqual(outcomeLabels(html), []);
  assert.match(html, /class="ghost change"/);
});

test("a closed row offers no outcome buttons, only the quiet change control", async () => {
  const html = await render(PostingCard, {
    posting: posting("a::1", { status: "closed", status_at: "2026-09-10T00:00:00Z" }),
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
  });
  assert.deepEqual(outcomeLabels(html), []);
  assert.match(html, /class="ghost change"/);
});

test("the quiet change control carries a glyph and a title, same as the outcome buttons it sits beside", async () => {
  const html = await render(PostingCard, {
    posting: posting("a::1", { status: "rejected", status_at: "2026-09-10T00:00:00Z" }),
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
  });
  const change = html.match(/<button[^>]*class="ghost change"[^>]*>([\s\S]*?)<\/button>/);
  assert.ok(change, "no change button in the rendered card");
  assert.match(
    change[1] as string,
    /<svg class="glyph"[^>]*><path d="M11 2.5l2.5 2.5-7 7-3 .5.5-3z"/,
  );
  assert.match(change[0] as string, /title="Change"/);
  assert.doesNotMatch(change[1] as string, /class="change-label"/);
});

test("activating a rejected card's 'change' control reveals all five outcomes and writes nothing on its own", async () => {
  const restoreDom = stubDom();
  const requests: string[] = [];
  const restoreFetch = stubFetch((url) => {
    requests.push(url);
    return Promise.resolve(patchedOne());
  });
  const card = mountTree(PostingCard, {
    posting: posting("a::1", {
      company: "Acme",
      status: "rejected",
      status_at: "2026-09-10T00:00:00Z",
    }),
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
  });
  try {
    assert.equal(elementsWithClass(card.root, "act").length, 0, "no outcomes offered yet");
    click(changeButton(card.root));
    // `settled`, not a bare `nextTick`: `reveal` awaits its own `nextTick`
    // before re-homing focus.
    await settled();
    assert.equal(
      elementsWithClass(card.root, "act").length,
      STATUSES.length,
      "change reveals all five",
    );
    // Revealing unmounts the very button just clicked, so without re-homing
    // focus falls to <body> (WCAG 2.4.3). This fake DOM only tracks that
    // the re-homing call reached "Applied".
    assert.equal(
      outcomeButton(card.root, "Applied — Acme").focused,
      true,
      "focus moves to the first revealed outcome button",
    );
    assert.deepEqual(requests, [], "revealing the outcomes writes nothing on its own");
  } finally {
    card.unmount();
    restoreFetch();
    restoreDom();
  }
});

test("a refused status write shows its reason on the card", async () => {
  const html = await render(PostingCard, {
    posting: posting("a::1"),
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
  });
  assert.doesNotMatch(html, /role="alert"/);
  // Mounted live so the outcome can be clicked and the refusal arrive.
  const restoreFetch = stubFetch(() => Promise.reject(new Error("the network is down")));
  const card = mountTree(PostingCard, {
    posting: posting("a::1", { company: "Acme" }),
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
  });
  try {
    const applied = elementsWithClass(card.root, "act").find(
      (button) => button.props["aria-label"] === "Applied — Acme",
    );
    assert.ok(applied !== undefined, "the card offers Applied");
    click(applied);
    await settled();
    const alert = elementsWithClass(card.root, "error")[0];
    assert.ok(alert !== undefined, "the refusal is announced");
    assert.equal(alert.props["role"], "alert");
    assert.match(textOf(alert), /postings: the network is down/);
  } finally {
    card.unmount();
    restoreFetch();
  }
});

/** The one search box the queue renders. */
function searchInput(root: TreeNode): TreeNode {
  const input = allNodes(root).find((node) => node.props["type"] === "search");
  if (input === undefined) throw new Error("the queue rendered no search box");
  return input;
}

function matchedLine(root: TreeNode): TreeNode | undefined {
  return elementsWithClass(root, "matched")[0];
}

test("the queue's panel is programmatically focusable, so a decided card's removal has somewhere to send focus", async () => {
  // `onDecided` falls back to this panel, which cannot take focus from
  // script without tabindex="-1", and -1 keeps it out of the tab order.
  const html = await render(QueueView, {
    postings: [posting("a::1")],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
  });

  assert.match(
    html,
    /<section role="tabpanel" id="panel-queue" aria-labelledby="tab-queue" tabindex="-1">/,
  );
});

test("a decision hands the posting's key and the patch it wrote up to its parent", async () => {
  // The view keeps no map of its own: what `AppRoot` lays over both reads is
  // exactly what comes out of here.
  const restoreDom = stubDom();
  const restoreFetch = stubFetch(() => Promise.resolve(patchedOne()));
  const emitted: DecidedOutcome[] = [];
  const app = mountTree(QueueView, {
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
    restoreDom();
  }
});

test("the decision that empties the queue sends focus to the panel its tab names", async () => {
  // The last row leaving takes the empty state's place, so there is no
  // successor, no decided row and no row at the old index to catch focus;
  // without the panel it would fall to `<body>` (WCAG 2.4.3).
  const restoreDom = stubDom();
  const restoreFetch = stubFetch(() => Promise.resolve(patchedOne()));
  const app = mountUnderAppRoot(QueueView, [ACME_TOP], {
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
  });
  try {
    click(outcomeButton(cardIn(app.root, "list", "Acme"), "Applied — Acme"));
    await settled();
    const panel = allNodes(app.root).find((node) => node.props["id"] === "panel-queue");
    assert.ok(panel !== undefined, "the panel is still mounted");
    assert.equal(panel.focused, true, "focus landed on the panel");
  } finally {
    app.unmount();
    restoreFetch();
    restoreDom();
  }
});

test("a filter says how many of the waiting rows it matched, and clearing it says nothing again", async () => {
  // With no filter the line says nothing: the Queue tab already carries the
  // number waiting, and two counts saying the same thing is one too many.
  // The element itself stays in the tree either way, because it is the live
  // region that announces the number; one inserted with its text already in
  // it is announced unreliably.
  const restoreDom = stubDom();
  const app = mountTree(QueueView, {
    postings: [ACME_TOP, BEVEL_MID, ACME_LOW],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
  });
  try {
    const line = matchedLine(app.root);
    assert.ok(line !== undefined, "the region is mounted before any filter");
    assert.equal(line.props["role"], "status", "and it is the live region");
    assert.equal(textOf(line), "", "no filter, nothing said");

    typeInto(searchInput(app.root), "acme");
    await nextTick();
    assert.equal(textOf(matchedLine(app.root)!), "2 of 3");
    assert.equal(matchedLine(app.root), line, "the same element, not a new one");

    typeInto(searchInput(app.root), "   ");
    await nextTick();
    assert.equal(textOf(matchedLine(app.root)!), "", "a blank query is no filter");
  } finally {
    app.unmount();
    restoreDom();
  }
});

test("a card's head button, where a committed Close sends focus, is never disabled", async () => {
  // A disabled button cannot hold focus, so if the head ever grew the
  // `busy` binding the fix would put focus back on `<body>`.
  const html = await render(PostingCard, {
    posting: posting("Acme::1"),
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
  });

  const head = html.match(/<button[^>]*class="head"[^>]*>/)?.[0] ?? "";
  assert.notEqual(head, "", "the card renders a head button");
  assert.doesNotMatch(head, /disabled/);
});

test("a selected card carries aria-current and the selected class", async () => {
  const html = await render(PostingCard, {
    posting: posting("acme::1"),
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
    selected: true,
  });
  assert.match(html, /class="card selected"/);
  assert.match(html, /aria-current="true"/);
});

test("an unselected card carries neither aria-current nor the selected class", async () => {
  const html = await render(PostingCard, {
    posting: posting("acme::1"),
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
    selected: false,
  });
  assert.doesNotMatch(html, /selected/);
  assert.doesNotMatch(html, /aria-current/);
});

test("an expandable card's head is a disclosure: it says whether its own detail is open", async () => {
  const p = posting("acme::1", { evidence: { role: "words" } });
  const shut = await render(PostingCard, {
    posting: p,
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
  });
  assert.match(shut.match(/<button[^>]*class="head"[^>]*>/)?.[0] ?? "", /aria-expanded="false"/);

  const open = await render(PostingCard, {
    posting: p,
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
    expanded: true,
  });
  assert.match(open.match(/<button[^>]*class="head"[^>]*>/)?.[0] ?? "", /aria-expanded="true"/);
});

test("a card that cannot expand claims no aria-expanded, open or shut", async () => {
  const p = posting("acme::1", { evidence: { role: "words" } });
  // Nothing expands here, so announcing "collapsed" would promise a
  // disclosure that does not exist.
  const row = await render(PostingCard, {
    posting: p,
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
    expandable: false,
  });
  assert.doesNotMatch(row, /aria-expanded/);
  assert.doesNotMatch(row, /class="evidence"/);

  // The pane's own card: open, with no control that could shut it.
  const pane = await render(PostingCard, {
    posting: p,
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
    expanded: true,
    expandable: false,
  });
  assert.doesNotMatch(pane, /aria-expanded/);
  assert.match(pane, /class="evidence"/);
});

test("nextSelection advances to the posting after the decided one", () => {
  const postings = [posting("a::1"), posting("b::2"), posting("c::3")];
  assert.equal(nextSelection(postings, "b::2"), "c::3");
});

test("nextSelection falls back to the posting before when the decided one was last", () => {
  const postings = [posting("a::1"), posting("b::2"), posting("c::3")];
  assert.equal(nextSelection(postings, "c::3"), "b::2");
});

test("nextSelection returns null when the decided posting was the only one", () => {
  assert.equal(nextSelection([posting("a::1")], "a::1"), null);
});

test("nextSelection returns null for a posting the list does not hold", () => {
  assert.equal(nextSelection([posting("a::1"), posting("b::2")], "gone::9"), null);
});

test("resolveSelection returns the posting matching a selected key that is still present", () => {
  const postings = [posting("a::1"), posting("b::2"), posting("c::3")];
  assert.equal(resolveSelection(postings, "b::2"), postings[1]);
});

test("resolveSelection falls back to the first posting when the key is null", () => {
  const postings = [posting("a::1"), posting("b::2")];
  assert.equal(resolveSelection(postings, null), postings[0]);
});

test("resolveSelection falls back to the first posting when the key is stale", () => {
  const postings = [posting("a::1"), posting("b::2")];
  assert.equal(resolveSelection(postings, "gone::9"), postings[0]);
});

test("resolveSelection returns null for an empty list, whatever the key", () => {
  assert.equal(resolveSelection([], null), null);
  assert.equal(resolveSelection([], "a::1"), null);
});

test("QueueView auto-selects the top-ordered posting into the pane with no prior interaction", async () => {
  const stale = posting("st::1", {
    company: "Stale",
    comp_low: 300_000,
    comp_high: 300_000,
    posted_at: "2020-01-01",
  });
  const fresh = posting("fr::1", {
    company: "Fresh",
    comp_low: 300_000,
    comp_high: 300_000,
    posted_at: new Date().toISOString().slice(0, 10),
  });
  const html = await render(QueueView, {
    postings: [stale, fresh],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: 150_000,
  });
  const pane = html.match(/<aside class="detail-pane"[^]*$/)?.[0] ?? "";
  assert.notEqual(pane, "", "the pane renders");
  assert.match(pane, /Fresh/);
  assert.doesNotMatch(pane, /Stale/);
});

test("an empty queue renders no master-detail pane at all", async () => {
  const html = await render(QueueView, {
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
  const html = await render(QueueView, {
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
  const html = await render(QueueView, {
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
  // Above the breakpoint the selected posting was on screen twice, both
  // copies offering Applied/Closed; `actionable="false"` on the pane's card
  // keeps the whole block out of its markup.
  const html = await render(QueueView, {
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
  // Arrow-key navigation needs a live DOM the server renderer never
  // creates, so this checks the handler is wired to the list and comes from
  // `useMasterDetail`; `nextFocusable`'s delegation lives in
  // `master-detail.test.ts`.
  const source = readFileSync(new URL("../src/queue.ts", import.meta.url), "utf8");
  // `[^>]*` between the two: the queue's list carries a `:class` binding
  // for grouped mode and will take others.
  assert.match(source, /class="list"[^>]*@keydown="onListKeydown"/);
  assert.match(source, /useMasterDetail\(visible\)/);
});

// Against a live mount rather than SSR: `busy` is state a mounted
// component reaches by writing. Only the list row can start a write, so
// what a write locks is the one card that issued it.

test("a Close dialog submitted twice before it can close writes the posting once", async () => {
  // Committing sets `closing` false, but the dialog is only gone on the
  // next render, so a second Enter in that frame still reaches the
  // handler, and a form submits on Enter as well as on its button.
  const restoreDom = stubDom();
  const requests: string[] = [];
  const restoreFetch = stubFetch((url) => {
    requests.push(url);
    return Promise.resolve(patchedOne());
  });
  const card = mountTree(PostingCard, {
    posting: posting("Acme::1", { company: "Acme" }),
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
    closing: true,
  });
  try {
    const form = partOfDialog(card.root, "form");
    fill(partOfDialog(card.root, "textarea"), "the pay band is below floor");
    submitForm(form);
    submitForm(form);
    await settled();
    assert.deepEqual(requests.length, 1, "one PATCH, not two");
  } finally {
    card.unmount();
    restoreFetch();
    restoreDom();
  }
});

test("a card mid-write disables every control that could start a second one", async () => {
  const restoreDom = stubDom();
  // Never settles, so the card stays mid-write.
  const restoreFetch = stubFetch(() => new Promise<Response>(() => {}));
  const card = mountTree(PostingCard, {
    posting: posting("Acme::1", { company: "Acme" }),
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
    closing: true,
  });
  try {
    fill(partOfDialog(card.root, "textarea"), "the pay band is below floor");
    submitForm(partOfDialog(card.root, "form"));
    await settled();
    assert.equal(isDisabled(card.root, "Applied — Acme"), true, "the outcome buttons are disabled");
    // This tree has no notion of a disabled button swallowing a click,
    // which is what lets the dialog be re-opened while the card is busy.
    click(outcomeButton(card.root, "Closed — Acme"));
    await settled();
    assert.equal(
      partOfDialog(card.root, "button", { type: "submit" }).props["disabled"],
      true,
      "and so is the Close dialog's submit",
    );
  } finally {
    card.unmount();
    restoreFetch();
    restoreDom();
  }
});

test("a refused write in the queue shows its reason on the row that issued it, and lets it be retried", async () => {
  const restoreDom = stubDom();
  const restoreFetch = stubFetch(() => Promise.reject(new Error("the network is down")));
  const app = mountTree(QueueView, {
    postings: [posting("a::1", { company: "Acme" }), posting("b::2", { company: "Bevel" })],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
  });
  try {
    click(outcomeButton(cardIn(app.root, "list", "Acme"), "Applied — Acme"));
    await settled();
    assert.match(textOf(cardIn(app.root, "list", "Acme")), /the network is down/);
    assert.doesNotMatch(textOf(cardIn(app.root, "list", "Bevel")), /the network is down/);
    assert.equal(
      isDisabled(cardIn(app.root, "list", "Acme"), "Applied — Acme"),
      false,
      "a settled write releases the card so it can be retried",
    );
  } finally {
    app.unmount();
    restoreFetch();
    restoreDom();
  }
});

test("a successful decision takes the row out of the queue", async () => {
  const restoreDom = stubDom();
  const restoreFetch = stubFetch(() => Promise.resolve(patchedOne()));
  const app = mountUnderAppRoot(
    QueueView,
    [posting("a::1", { company: "Acme" }), posting("b::2", { company: "Bevel" })],
    { config: CONFIG, accessToken: ACCESS_TOKEN, compFloor: null },
  );
  try {
    click(outcomeButton(cardIn(app.root, "list", "Acme"), "Applied — Acme"));
    await settled();
    assert.throws(
      () => cardIn(app.root, "list", "Acme"),
      "a decided row leaves the list, so its TransitionGroup leave hook runs to completion",
    );
    assert.ok(cardIn(app.root, "list", "Bevel"), "a row nobody acted on stays in the list");
  } finally {
    app.unmount();
    restoreFetch();
    restoreDom();
  }
});

// Re-homing focus to the `<h2>` would jump James to the top: `focus()`
// scrolls its target into view, and the heading is above the list.

/**
 * `headOf` is typed for a real element and `render-tree.ts` answers its
 * three questions, but a `TreeNode` is not an `HTMLElement`. This cast is
 * that seam, in the one file that owns it.
 */
function asElement(node: TreeNode): HTMLElement {
  return node as unknown as HTMLElement;
}

/** The same seam the other way. */
function asNode(element: HTMLElement): TreeNode {
  return element as unknown as TreeNode;
}

test("a card names its posting in data-key, so the list can find that row again after it re-renders", async () => {
  const html = await renderToString(
    createSSRApp(QueueView, {
      postings: [ACME_TOP, BEVEL_MID],
      config: CONFIG,
      accessToken: ACCESS_TOKEN,
      compFloor: null,
    }),
  );
  assert.match(html, /<article class="card"[^>]*data-key="acme::top"/);
  assert.match(html, /<article class="card"[^>]*data-key="bevel::mid"/);
});

test("headOf finds the head button of the card holding a given key", () => {
  const restoreDom = stubDom();
  const app = mountTree(QueueView, {
    postings: [ACME_TOP, BEVEL_MID],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
  });
  try {
    const list = elementsWithClass(app.root, "master-detail")[0];
    assert.ok(list !== undefined, "the list container renders");

    const head = headOf(asElement(list), "bevel::mid");
    assert.ok(head !== null, "the head of the Bevel card is found");
    assert.ok(hasClass(asNode(head), "head"), "what came back is the head button");
    assert.match(textOf(asNode(head)), /Mid role/);
  } finally {
    app.unmount();
    restoreDom();
  }
});

test("headOf answers null for a key no card is showing, so the caller can fall through", () => {
  const restoreDom = stubDom();
  const app = mountTree(QueueView, {
    postings: [ACME_TOP],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
  });
  try {
    const list = elementsWithClass(app.root, "master-detail")[0];
    assert.ok(list !== undefined);
    assert.equal(headOf(asElement(list), "nobody::here"), null);
  } finally {
    app.unmount();
    restoreDom();
  }
});

test("headOf takes a null key, which is what nextSelection returns when nothing follows", () => {
  const restoreDom = stubDom();
  const app = mountTree(QueueView, {
    postings: [ACME_TOP],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
  });
  try {
    const list = elementsWithClass(app.root, "master-detail")[0];
    assert.ok(list !== undefined);
    assert.equal(headOf(asElement(list), null), null);
    assert.equal(headOf(null, "acme::top"), null);
  } finally {
    app.unmount();
    restoreDom();
  }
});

test("the successor headOf is asked for is the row that takes the decided one's place", () => {
  // Deciding cannot be driven through a mounted card: unmounting one runs
  // TransitionGroup's leave hooks, which need a real `classList`. So the two
  // halves are checked against each other.
  const restoreDom = stubDom();
  const app = mountTree(QueueView, {
    postings: [ACME_TOP, BEVEL_MID, ACME_LOW],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
  });
  try {
    const list = elementsWithClass(app.root, "master-detail")[0];
    assert.ok(list !== undefined);
    // Midpoint order: Acme top (300k), Bevel (200k), Acme low (100k).
    const ordered = [ACME_TOP, BEVEL_MID, ACME_LOW];
    const successor = nextSelection(ordered, "acme::top");
    assert.equal(successor, "bevel::mid");

    const head = headOf(asElement(list), successor);
    assert.ok(head !== null, "the successor's head is on screen and focusable");
    assert.match(textOf(asNode(head)), /Mid role/);
    assert.equal(nextSelection(ordered, "acme::low"), "bevel::mid");
  } finally {
    app.unmount();
    restoreDom();
  }
});

test("a blank query matches every posting, so the unfiltered queue is the filtered path", () => {
  assert.equal(matchesQuery(ACME_TOP, ""), true);
  assert.equal(matchesQuery(ACME_TOP, "   "), true);
});

test("a query matches on the company", () => {
  assert.equal(matchesQuery(ACME_TOP, "acme"), true);
  assert.equal(matchesQuery(ACME_TOP, "Acme"), true);
  assert.equal(matchesQuery(ACME_TOP, "cm"), true);
  assert.equal(matchesQuery(ACME_TOP, "bevel"), false);
});

test("a query matches on the title, which is the other half of one box", () => {
  assert.equal(matchesQuery(ACME_TOP, "top role"), true);
  assert.equal(matchesQuery(ACME_TOP, "TOP"), true);
  assert.equal(matchesQuery(BEVEL_MID, "mid"), true);
  assert.equal(matchesQuery(BEVEL_MID, "top"), false);
});

test("a query is trimmed, so a trailing space from a phone keyboard still matches", () => {
  assert.equal(matchesQuery(ACME_TOP, "  acme  "), true);
});

test("the queue renders one search input, over company and role", async () => {
  const html = await renderToString(
    createSSRApp(QueueView, {
      postings: [ACME_TOP, BEVEL_MID],
      config: CONFIG,
      accessToken: ACCESS_TOKEN,
      compFloor: null,
    }),
  );
  const box = html.match(/<div class="queue-search">[^]*?<\/div>/)?.[0] ?? "";
  assert.match(box, /<span>Search<\/span>/);
  assert.match(box, /type="search"/);
  assert.match(box, /placeholder="Company or role"/);
  assert.equal((html.match(/type="search"/g) ?? []).length, 1, "one box, not two");
});

test("narrowing composes: the rows the queue would show are the ordering of what matches", () => {
  // The wiring from the box to these rows is a template binding this
  // harness cannot exercise (TransitionGroup leave hooks need a real
  // `classList`); it was checked in Chrome.
  const all = [ACME_TOP, BEVEL_MID, ACME_LOW];
  const matching = all.filter((posting) => matchesQuery(posting, "acme"));
  assert.deepEqual(
    matching.map((posting) => posting.key),
    ["acme::top", "acme::low"],
  );

  const rows = queueRows(orderedQueue(matching, null, Date.now(), [], "company"), true);
  const heads = rows.filter((row) => row.head !== null).map((row) => row.head?.company);
  assert.deepEqual(heads, ["Acme"], "only the matching company opens a group");
  assert.equal(
    rows[0]?.head?.waiting,
    2,
    "the header counts the matching rows, not the whole company",
  );
});

// Grouped, a company's group exists only because something is waiting in
// it, so deciding its last waiting row takes the group, the decided row and
// that company's history off screen together, leaving neither the
// successor nor the decided row to focus.

test("headAt gives the row that now sits where the decided one was", () => {
  const restoreDom = stubDom();
  const app = mountTree(QueueView, {
    postings: [ACME_TOP, BEVEL_MID, ACME_LOW],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
  });
  try {
    const list = elementsWithClass(app.root, "master-detail")[0];
    assert.ok(list !== undefined);
    // Acme top (300k), Bevel (200k), Acme low (100k).
    assert.match(textOf(asNode(headAt(asElement(list), 0)!)), /Top role/);
    assert.match(textOf(asNode(headAt(asElement(list), 1)!)), /Mid role/);
    assert.match(textOf(asNode(headAt(asElement(list), 2)!)), /Low role/);
  } finally {
    app.unmount();
    restoreDom();
  }
});

test("headAt clamps past the end, so a shorter list still yields a row and not the heading", () => {
  const restoreDom = stubDom();
  const app = mountTree(QueueView, {
    postings: [ACME_TOP, BEVEL_MID],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
  });
  try {
    const list = elementsWithClass(app.root, "master-detail")[0];
    assert.ok(list !== undefined);
    assert.match(textOf(asNode(headAt(asElement(list), 9)!)), /Mid role/);
  } finally {
    app.unmount();
    restoreDom();
  }
});

test("headAt answers null for an empty list and a negative index, so the caller falls through", () => {
  const restoreDom = stubDom();
  const app = mountTree(QueueView, {
    postings: [ACME_TOP],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    compFloor: null,
  });
  try {
    const list = elementsWithClass(app.root, "master-detail")[0];
    assert.ok(list !== undefined);
    assert.equal(headAt(asElement(list), -1), null);
    assert.equal(headAt(null, 0), null);
  } finally {
    app.unmount();
    restoreDom();
  }
});

test("a company's group closes when its last waiting row is decided, taking its history with it", () => {
  // One waiting row and one already applied to: with nothing waiting there
  // is no bucket and the history has nowhere to go.
  const waiting = posting("acme::last", { company: "Acme", title: "Last waiting" });
  const history = posting("acme::done", {
    company: "Acme",
    title: "Already applied",
    status: "applied",
    status_at: "2026-09-10",
  });
  const other = posting("bevel::1", { company: "Bevel", title: "Bevel role" });

  const before = orderedQueue([waiting, other], null, Date.now(), [], "company", [history]);
  assert.deepEqual(
    before.map((each) => each.key),
    ["acme::last", "acme::done", "bevel::1"],
    "Acme opens with its waiting row and carries its history under it",
  );
  assert.equal(nextSelection(before, "acme::last"), "acme::done");

  // Acme has nothing waiting, so the whole group goes.
  const after = orderedQueue([other], null, Date.now(), [], "company", [history]);
  assert.deepEqual(
    after.map((each) => each.key),
    ["bevel::1"],
    "neither the decided row nor the successor is still rendered",
  );
  // Index 0 is now Bevel's row.
  assert.equal(after[0]?.key, "bevel::1");
});
