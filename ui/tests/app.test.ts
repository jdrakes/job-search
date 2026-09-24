import assert from "node:assert/strict";
import { test } from "node:test";
import { createSSRApp, defineComponent, h, nextTick, ref, Suspense } from "vue";
import { renderToString } from "vue/server-renderer";

import { STATUSES, type Company, type PostingSummary } from "../../src/schema.ts";
import { AppRoot, LoadingShell, runRefresh, searchFor, tabFrom } from "../src/app.ts";
import { SESSION_KEY, type Session, type SessionStore } from "../src/auth.ts";
import { QUEUE_ORDER_KEY } from "../src/queue.ts";
import { TABS } from "../src/tabs.ts";
import { clearReads, loadReads, READS_KEY, saveReads } from "../src/reads-cache.ts";
import type { AppConfig } from "../src/config.ts";
import { cardIn, outcomeButton } from "./card-queries.ts";
import {
  allNodes,
  click,
  elementsWithClass,
  fill,
  mountTree,
  patchedOne,
  settled,
  stubDom,
  stubFetch,
  submitForm,
  textOf,
  typeInto,
  type Mounted,
  type TreeNode,
} from "./render-tree.ts";

// Replays responses in the order the four reads issue them: `loadAll`
// fires all four with `Promise.all`, and each makes exactly one request
// before its first `await`, so the call order matches the array order.

function recordingFetch(replies: readonly (() => Response)[]): {
  calls: string[];
  fetchImpl: typeof fetch;
} {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const reply = replies[calls.length];
    calls.push(String(input));
    if (reply === undefined) throw new Error(`unexpected request ${calls.length}`);
    return reply();
  };
  return { calls, fetchImpl };
}

function jsonReply(value: unknown): () => Response {
  return () =>
    new Response(JSON.stringify(value), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
}

function statusReply(code: number, body: string): () => Response {
  return () => new Response(body, { status: code });
}

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

const NOW = 1_800_000_000;

function sessionJson(overrides: Partial<Session> = {}): string {
  return JSON.stringify({
    email: "someone@example.com",
    accessToken: "user-jwt",
    expiresAt: NOW + 3600,
    refreshToken: "refresh-token",
    lastActiveAt: NOW,
    ...overrides,
  });
}

const CONFIG: AppConfig = {
  url: "https://project.supabase.co",
  anonKey: "anon-key",
  statuses: [...STATUSES],
};

const CRITERIA_ROW = {
  id: 1,
  level_words: [],
  role_words: [],
  excluded_title_words: [],
  team_name_words: [],
  excluded_states: [],
  missing_languages: [],
  comp_floor: 150_000,
  max_age_days: null,
  excluded_locations: [],
  product_words: [],
  assumed_bonus_pct: null,
  updated_at: "2026-09-01T00:00:00Z",
};

function render(props: Record<string, unknown>): Promise<string> {
  return renderToString(createSSRApp(AppRoot, props));
}

function signedInProps(
  httpFetch: typeof fetch,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    config: CONFIG,
    store: memoryStore({ [SESSION_KEY]: sessionJson() }),
    httpFetch,
    now: () => NOW,
    ...overrides,
  };
}

test("AppRoot shows the sign-in form when there is no session, and reads nothing", async () => {
  const { calls, fetchImpl } = recordingFetch([]);

  const html = await render({
    config: CONFIG,
    store: memoryStore(),
    httpFetch: fetchImpl,
    now: () => NOW,
  });

  assert.match(html, /class="sign-in"/);
  assert.equal(calls.length, 0);
});

test("AppRoot opens on the Queue tab when signed in", async () => {
  const { fetchImpl } = recordingFetch([
    jsonReply([{ key: "acme::1", company: "Acme", evidence: {} }]),
    jsonReply([]),
    jsonReply([]),
    jsonReply([CRITERIA_ROW]),
  ]);

  const html = await render(signedInProps(fetchImpl));

  assert.match(html, /id="tab-queue"[^>]*aria-selected="true"/);
  assert.match(html, /id="panel-queue"/);
  assert.doesNotMatch(html, /class="filters"/); // Record's filter bar, not rendered on Queue
});

test("AppRoot's header puts the queue's depth on the Queue tab, not in the h1", async () => {
  const { fetchImpl } = recordingFetch([
    jsonReply([
      // `loadQueue` only ever returns `status.is.null` rows; the pill now
      // counts what is waiting, so the fixture carries that field rather
      // than leaving it implicitly undefined.
      { key: "acme::1", company: "Acme", evidence: {}, status: null },
      { key: "beta::1", company: "Beta", evidence: {}, status: null },
      { key: "gamma::1", company: "Gamma", evidence: {}, status: null },
    ]),
    jsonReply([]),
    jsonReply([]),
    jsonReply([CRITERIA_ROW]),
  ]);

  const html = await render(signedInProps(fetchImpl));

  assert.match(html, /<h1>Job search<\/h1>/);
  assert.match(html, /<span class="count-value">3<\/span>/);
});

const QUEUE_ROW = {
  key: "acme::1",
  company: "Acme",
  platform: "greenhouse" as const,
  board: "acme",
  title: "Staff Engineer",
  url: null,
  location: null,
  comp_low: 300_000,
  comp_high: 300_000,
  posted_at: "2026-09-15",
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
};

test("a signed-in shell with a criteria row passes its floor through to the queue's cards", async () => {
  const { fetchImpl } = recordingFetch([
    jsonReply([QUEUE_ROW]),
    jsonReply([]),
    jsonReply([]),
    jsonReply([CRITERIA_ROW]),
  ]);

  const html = await render(signedInProps(fetchImpl));

  assert.match(html, /class="score"/);
});

test("the grouped queue's history comes from the record read the shell already made, not a fifth request", async () => {
  // Cirrus has been applied to and has nothing waiting, so it opens no
  // group at all.
  const { calls, fetchImpl } = recordingFetch([
    jsonReply([QUEUE_ROW]),
    jsonReply([
      QUEUE_ROW,
      {
        ...QUEUE_ROW,
        key: "acme::2",
        title: "Principal Engineer",
        status: "applied",
        status_at: "2026-09-10T00:00:00Z",
      },
      {
        ...QUEUE_ROW,
        key: "cirrus::1",
        company: "Cirrus",
        title: "Cirrus Engineer",
        status: "applied",
        status_at: "2026-09-11T00:00:00Z",
      },
    ]),
    jsonReply([]),
    jsonReply([CRITERIA_ROW]),
  ]);

  const html = await render(
    signedInProps(fetchImpl, {
      store: memoryStore({ [SESSION_KEY]: sessionJson(), [QUEUE_ORDER_KEY]: "company" }),
    }),
  );

  // The four reads the shell already makes (queue, postings, companies,
  // criteria) — not a fifth for grouped history, which is what this test
  // guards.
  assert.equal(calls.length, 4, "the four reads the shell already makes");
  assert.match(html, /<span class="company">Acme<\/span> — 1 waiting · 1 applied/);
  assert.match(html, /Principal Engineer/, "the applied role is a row under Acme's header");
  assert.doesNotMatch(html, /Cirrus/, "a company with nothing waiting opens no group");
  assert.match(
    html,
    /<span class="count-value">1<\/span>/,
    "the count stays the number waiting on him",
  );
});

test("a failed criteria read leaves the queue's cards with no score to show", async () => {
  const { fetchImpl } = recordingFetch([
    jsonReply([QUEUE_ROW]),
    jsonReply([]),
    jsonReply([]),
    statusReply(500, "relation does not exist"),
  ]);

  const html = await render(signedInProps(fetchImpl));

  assert.match(html, /Acme/);
  assert.doesNotMatch(html, /class="score"/);
});

test("a failed queue read shows a Try again button, enabled, on the Queue tab", async () => {
  const { fetchImpl } = recordingFetch([
    statusReply(500, "relation does not exist"),
    jsonReply([]),
    jsonReply([]),
    jsonReply([CRITERIA_ROW]),
  ]);

  const html = await render(signedInProps(fetchImpl));

  assert.match(html, /relation does not exist/);
  assert.match(html, /<button[^>]*>Try again<\/button>/);
  assert.doesNotMatch(html, /<button[^>]*disabled[^>]*>Try again<\/button>/);
});

test("a failed criteria read shows its own reason but leaves Companies populated", async () => {
  const { fetchImpl } = recordingFetch([
    jsonReply([]),
    jsonReply([]),
    jsonReply([{ name: "Acme", state: "watched", boards: [], source: null, reason: null }]),
    statusReply(500, "relation does not exist"),
  ]);

  const onCompanies = await render(signedInProps(fetchImpl, { initialTab: "companies" }));
  assert.match(onCompanies, /Acme/);
  assert.match(onCompanies, /Watched.*?\(1\)/);
});

test("a failed criteria read shows its reason on the Criteria tab and renders no form", async () => {
  const { fetchImpl } = recordingFetch([
    jsonReply([]),
    jsonReply([]),
    jsonReply([]),
    statusReply(500, "relation does not exist"),
  ]);

  const onCriteria = await render(signedInProps(fetchImpl, { initialTab: "criteria" }));
  assert.match(onCriteria, /relation does not exist/);
  assert.doesNotMatch(onCriteria, /re-judges every posting at the next run/);
  assert.match(onCriteria, /<button[^>]*>Try again<\/button>/);
  assert.doesNotMatch(onCriteria, /<button[^>]*disabled[^>]*>Try again<\/button>/);
});

test("the page has exactly one h1", async () => {
  const { fetchImpl } = recordingFetch([
    jsonReply([]),
    jsonReply([]),
    jsonReply([]),
    jsonReply([CRITERIA_ROW]),
  ]);

  const html = await render(signedInProps(fetchImpl));

  const h1Count = (html.match(/<h1[\s>]/g) ?? []).length;
  assert.equal(h1Count, 1);
});

test("LoadingShell shows the header and tabs with a skeleton list, and no empty state", async () => {
  const html = await renderToString(createSSRApp(LoadingShell));
  assert.match(html, /<h1>Job search<\/h1>/);
  assert.match(html, /role="tab"/);
  assert.match(html, /class="list skeleton" role="status" aria-label="Reading the store…"/);
  const rows = html.match(/class="card skeleton-row"/g) ?? [];
  assert.equal(rows.length, 5);
  assert.doesNotMatch(html, /class="empty"/);
  assert.doesNotMatch(html, /class="count"/);
});

test("tabFrom reads ?tab= and falls back to the queue for anything else", () => {
  assert.equal(tabFrom("?tab=record"), "record");
  assert.equal(tabFrom("?tab=criteria"), "criteria");
  assert.equal(tabFrom(""), "queue");
  assert.equal(tabFrom("?tab=runs"), "queue");
});

test("searchFor writes the bare path for the queue and ?tab= for the rest", () => {
  assert.equal(searchFor("queue"), "");
  assert.equal(searchFor("companies"), "?tab=companies");
  assert.equal(tabFrom(searchFor("record")), "record");
});

test("runRefresh raises the flag for the round and lowers it again even when the round rejects", async () => {
  const flag = ref(false);
  const duringRound: boolean[] = [];

  await runRefresh(flag, async () => {
    duringRound.push(flag.value);
  });
  assert.equal(flag.value, false);

  // A round rejects when `saveSession` cannot write; without the reset in
  // a `finally`, every Try again button would stay disabled.
  await assert.rejects(
    runRefresh(flag, async () => {
      duringRound.push(flag.value);
      throw new Error("The quota has been exceeded.");
    }),
    /quota/,
  );
  assert.equal(flag.value, false);
  assert.deepEqual(duringRound, [true, true]);
});

test("LoadingShell draws the requested tab as current", async () => {
  const html = await renderToString(createSSRApp(LoadingShell, { tab: "record" }));
  assert.match(html, /id="tab-record"[^>]*aria-selected="true"/);
});

test("saveReads and loadReads round-trip a round; a broken or wrong-shaped entry reads as none", () => {
  const store = memoryStore();
  assert.equal(loadReads(store), null);
  const reads = {
    queue: [QUEUE_ROW],
    postings: [QUEUE_ROW],
    companies: [],
    criteria: CRITERIA_ROW,
  };
  saveReads(store, reads);
  assert.deepEqual(loadReads(store), reads);
  store.setItem(READS_KEY, "{not json");
  assert.equal(loadReads(store), null);
  assert.equal(store.getItem(READS_KEY), null);
  store.setItem(READS_KEY, JSON.stringify({ queue: "no" }));
  assert.equal(loadReads(store), null);
  saveReads(store, reads);
  clearReads(store);
  assert.equal(loadReads(store), null);
});

test("with a cached round, AppRoot renders its rows and turns the header's ring before any read has answered", async () => {
  // Never resolves: the render must not depend on it.
  const pending = () => new Promise<Response>(() => {});
  const store = memoryStore({ [SESSION_KEY]: sessionJson() });
  saveReads(store, {
    queue: [QUEUE_ROW],
    postings: [QUEUE_ROW],
    companies: [],
    criteria: CRITERIA_ROW,
  });

  const html = await render({ config: CONFIG, store, httpFetch: pending, now: () => NOW });

  assert.match(html, /Acme/);
  assert.match(html, /class="score"/);
  assert.match(html, /class="[^"]*\brecounting\b/);
  assert.match(html, /class="spinner"/);
  assert.match(html, /class="sr-only" role="status">Recounting the queue</);
  assert.doesNotMatch(html, /Reading the store/);
});

// The count on screen while a round runs is the last round's, so the ring
// standing in its place is the honest reading, not a decoration over it.
test("a round hides the cached count behind the ring and gives it back when the round lands", async () => {
  const store = memoryStore({ [SESSION_KEY]: sessionJson() });
  const { fetchImpl } = recordingFetch([
    jsonReply([QUEUE_ROW]),
    jsonReply([QUEUE_ROW]),
    jsonReply([]),
    jsonReply([CRITERIA_ROW]),
  ]);

  const html = await render({ config: CONFIG, store, httpFetch: fetchImpl, now: () => NOW });

  assert.doesNotMatch(html, /recounting/);
  assert.doesNotMatch(html, /class="spinner"/);
  assert.match(html, /class="count-value">1</);
  assert.match(html, /class="sr-only" role="status"><\/p>/);
});

// The whole point of the move: the round says nothing anywhere the list can
// feel it. Nothing between the header and the first card, and the pill keeps
// the number in the layout so the tabs after Queue do not slide left.
test("a round adds nothing between the header and the list, and vacates no width in the tab strip", async () => {
  const pending = () => new Promise<Response>(() => {});
  const store = memoryStore({ [SESSION_KEY]: sessionJson() });
  saveReads(store, {
    queue: [QUEUE_ROW],
    postings: [QUEUE_ROW],
    companies: [],
    criteria: CRITERIA_ROW,
  });

  const html = await render({ config: CONFIG, store, httpFetch: pending, now: () => NOW });

  // The ring is inside the Queue tab's pill, before the three tabs after it.
  const spinner = html.indexOf('class="spinner"');
  const record = html.indexOf("tab-record");
  const firstCard = html.indexOf('class="card');
  assert.ok(spinner !== -1 && record !== -1 && firstCard !== -1);
  assert.ok(spinner < record, "the ring is in the Queue tab, not after the strip");

  // The number is still rendered: hidden by `visibility`, so it keeps the
  // pill exactly as wide as its digits.
  assert.match(html, /class="count-value">1</);
  assert.equal((html.match(/class="spinner"/g) ?? []).length, 1);

  // Sign out is the header's last child, so past it is past the header.
  // Nothing out there says a round is running, which is what kept moving
  // the list when it did.
  const signOut = html.indexOf("sign-out");
  assert.ok(signOut < firstCard, "the header ends before the list starts");
  assert.doesNotMatch(html.slice(signOut), /spinner|Recounting/);
});

test("a successful round is written to the cache; sign-out would clear it", async () => {
  const { fetchImpl } = recordingFetch([
    jsonReply([QUEUE_ROW]),
    jsonReply([QUEUE_ROW]),
    jsonReply([]),
    jsonReply([CRITERIA_ROW]),
  ]);
  const store = memoryStore({ [SESSION_KEY]: sessionJson() });
  assert.equal(loadReads(store), null);

  await render({ config: CONFIG, store, httpFetch: fetchImpl, now: () => NOW });

  const cached = loadReads(store);
  assert.ok(cached !== null, "the round was cached");
  assert.equal(cached.queue.length, 1);
  assert.equal(cached.criteria?.comp_floor, 150_000);
});

test("a round with a failed read is not cached, so the next reload does not open on a half-empty page", async () => {
  const { fetchImpl } = recordingFetch([
    jsonReply([QUEUE_ROW]),
    () => new Response("nope", { status: 500 }),
    jsonReply([]),
    jsonReply([CRITERIA_ROW]),
  ]);
  const store = memoryStore({ [SESSION_KEY]: sessionJson() });

  await render({ config: CONFIG, store, httpFetch: fetchImpl, now: () => NOW });

  assert.equal(loadReads(store), null);
});

test("every tab renders the panel it claims to control, named by that tab and with no heading of its own", async () => {
  // Each tab has always carried `aria-controls="panel-<id>"` and no element
  // had those ids; the four `h2`s were what named the views instead. The
  // panels name them now, so a fifth tab cannot ship without one. A view may
  // still carry headings of its own (the Companies groups, the Queue's
  // company bands); what it must not do is repeat the tab already on screen
  // above it.
  for (const tab of TABS) {
    const { fetchImpl } = recordingFetch([
      jsonReply([QUEUE_ROW]),
      jsonReply([QUEUE_ROW]),
      jsonReply([]),
      jsonReply([CRITERIA_ROW]),
    ]);

    const html = await render(signedInProps(fetchImpl, { initialTab: tab.id }));

    assert.match(html, new RegExp(`aria-controls="panel-${tab.id}"`), `${tab.id} claims a panel`);
    assert.match(
      html,
      new RegExp(`role="tabpanel"[^>]*id="panel-${tab.id}"[^>]*aria-labelledby="tab-${tab.id}"`),
      `${tab.id} renders that panel, labelled by its tab`,
    );
    assert.match(
      html,
      new RegExp(`id="panel-${tab.id}"[^>]*tabindex="-1"`),
      `${tab.id} can be focused from script`,
    );
    assert.doesNotMatch(
      html,
      new RegExp(`<h[1-6][^>]*>${tab.label}<`),
      `the ${tab.id} view repeats no heading naming its own tab`,
    );
  }
});

/*
 * What James decided on this page lives in `AppRoot` and is laid over both
 * reads, so the tests below drive real clicks through a mounted shell
 * rather than `renderToString`, which cannot click anything.
 */

const ACME_SECOND = { ...QUEUE_ROW, key: "acme::2", title: "Principal Engineer" };

interface RootProps {
  readonly config: AppConfig;
  readonly store: SessionStore;
  readonly httpFetch: typeof fetch;
  readonly now: () => number;
}

/** `AppRoot`'s async `setup()` needs the `<Suspense>` boundary `mountApp` gives it in the browser. */
function mountRoot(props: RootProps): Mounted {
  const shell = defineComponent({
    name: "SuspenseShell",
    render: () => h(Suspense, null, { default: () => h(AppRoot, props) }),
  });
  return mountTree(shell, {});
}

/** Seeds the store so the first paint has rows without waiting on a round. */
function storeWithRound(
  queue: PostingSummary[],
  postings: PostingSummary[],
  order = "score",
  companies: Company[] = [],
) {
  const store = memoryStore({ [SESSION_KEY]: sessionJson(), [QUEUE_ORDER_KEY]: order });
  saveReads(store, { queue, postings, companies, criteria: CRITERIA_ROW });
  return store;
}

/** A watched company with nothing in the queue, for the drop tests. */
const WATCHED_COMPANY: Company = {
  name: "Acme",
  state: "watched",
  boards: [],
  source: null,
  reason: null,
  first_seen: "2026-09-01",
  last_seen: "2026-09-22",
  dropped_at: null,
  alias_of: null,
};

/** Opens the drop dialog on `name` and commits it with a reason. */
async function dropCompany(root: TreeNode, name: string): Promise<void> {
  const dropButton = allNodes(root).find((node) => node.props["aria-label"] === `Drop ${name}`);
  if (dropButton === undefined) throw new Error(`no Drop button for ${name}`);
  click(dropButton);
  await nextTick();
  const reason = allNodes(root).find((node) => node.tag === "textarea");
  if (reason === undefined) throw new Error("the drop dialog did not open");
  // An empty reason is refused before the write, so the drop would never commit.
  fill(reason, "they stopped hiring");
  const form = allNodes(root).find((node) => node.tag === "form");
  if (form === undefined) throw new Error("the drop dialog carries no form");
  submitForm(form);
  await settled();
}

/**
 * Whether the Companies view has `name` in its dropped group. Each group's
 * list carries the group's key as a class (`:class="group.key"`), so this
 * asks the rendered grouping rather than reading a row's own field.
 */
function isInDroppedGroup(root: TreeNode, name: string): boolean {
  return elementsWithClass(root, "dropped").some((list) => textOf(list).includes(name));
}

/** A round nobody answers: the page keeps the cached rows it opened on. */
const unanswered: typeof fetch = () => new Promise<Response>(() => {});

/** A round held open, so a test can decide something while it is in flight. */
function heldRound(replies: readonly (() => Response)[]): {
  fetchImpl: typeof fetch;
  land: () => void;
} {
  const waiting: (() => void)[] = [];
  let sent = 0;
  const fetchImpl: typeof fetch = () => {
    const reply = replies[sent];
    sent += 1;
    if (reply === undefined) throw new Error(`unexpected request ${sent}`);
    return new Promise<Response>((resolve) => waiting.push(() => resolve(reply())));
  };
  return {
    fetchImpl,
    land: () => {
      for (const resume of waiting.splice(0, waiting.length)) resume();
    },
  };
}

/** Every card in the rendered list showing `key`; the detail pane is outside it. */
function listCards(root: TreeNode, key: string): TreeNode[] {
  const list = elementsWithClass(root, "list")[0];
  if (list === undefined) return [];
  return elementsWithClass(list, "card").filter((card) => card.props["data-key"] === key);
}

function tabButton(root: TreeNode, id: string): TreeNode {
  const button = allNodes(root).find((node) => node.props["id"] === `tab-${id}`);
  if (button === undefined) throw new Error(`no ${id} tab in the rendered tree`);
  return button;
}

/** The number the Queue tab's pill shows, read off `tab-queue`'s own `count-value`. */
function queuePillCount(root: TreeNode): string {
  const pill = elementsWithClass(tabButton(root, "queue"), "count-value")[0];
  if (pill === undefined) throw new Error("no count pill on the queue tab");
  return textOf(pill);
}

/** The "n of n" line `QueueView` renders beside its search box once a filter narrows something. */
function matchedLine(root: TreeNode): TreeNode | undefined {
  return elementsWithClass(root, "matched")[0];
}

function searchInput(root: TreeNode): TreeNode {
  const input = allNodes(root).find((node) => node.props["type"] === "search");
  if (input === undefined) throw new Error("the queue rendered no search box");
  return input;
}

test("a decision made in the Queue survives the tab switch that unmounts it, and the Record says so", async () => {
  // #249: the view that took the decision used to keep it, so leaving the
  // tab threw it away and the row came back as though he had done nothing.
  const restoreDom = stubDom();
  const restoreFetch = stubFetch(() => Promise.resolve(patchedOne()));
  const app = mountRoot({
    config: CONFIG,
    store: storeWithRound([QUEUE_ROW], [QUEUE_ROW]),
    httpFetch: unanswered,
    now: () => NOW,
  });
  try {
    await settled();
    click(outcomeButton(cardIn(app.root, "list", "Acme"), "Applied — Acme"));
    await settled();
    assert.equal(listCards(app.root, "acme::1").length, 0, "the decided row left the queue");

    click(tabButton(app.root, "record"));
    await nextTick();
    const record = cardIn(app.root, "list", "Acme");
    assert.match(textOf(record), /Applied/, "the Record shows the status he just wrote");

    click(tabButton(app.root, "queue"));
    await nextTick();
    assert.equal(
      listCards(app.root, "acme::1").length,
      0,
      "and coming back does not put it in front of him again",
    );
    assert.match(textOf(app.root), /Nothing waiting on you/);
  } finally {
    app.unmount();
    restoreFetch();
    restoreDom();
  }
});

test("a posting decided in grouped order shows once under its company, not twice", async () => {
  // Ruling 2: the record read is a superset of the queue read, so the
  // history `AppRoot` hands down already carries the decided row. Assembling
  // it from the queue side as well rendered it a second time.
  const restoreDom = stubDom();
  const restoreFetch = stubFetch(() => Promise.resolve(patchedOne()));
  const app = mountRoot({
    config: CONFIG,
    store: storeWithRound([QUEUE_ROW, ACME_SECOND], [QUEUE_ROW, ACME_SECOND], "company"),
    httpFetch: unanswered,
    now: () => NOW,
  });
  try {
    await settled();
    click(outcomeButton(cardIn(app.root, "list", "Staff Engineer"), "Applied — Acme"));
    await settled();
    assert.equal(
      listCards(app.root, "acme::1").length,
      1,
      "one card for the posting he decided, as its company's history",
    );
    assert.equal(listCards(app.root, "acme::2").length, 1, "and one for the row still waiting");
  } finally {
    app.unmount();
    restoreFetch();
    restoreDom();
  }
});

test("a drop survives the tab switch that unmounts the Companies view", async () => {
  // #252: the view that took the drop used to keep it, and its panel is a
  // `v-if`, so leaving the tab threw the drop away and the company came back
  // watched, with a Drop button, as though the write had never landed.
  const restoreDom = stubDom();
  const restoreFetch = stubFetch(() => Promise.resolve(patchedOne()));
  const app = mountRoot({
    config: CONFIG,
    store: storeWithRound([], [], "score", [WATCHED_COMPANY]),
    httpFetch: unanswered,
    now: () => NOW,
  });
  try {
    await settled();
    click(tabButton(app.root, "companies"));
    await nextTick();
    assert.equal(isInDroppedGroup(app.root, "Acme"), false, "Acme starts out watched");

    await dropCompany(app.root, "Acme");
    assert.equal(isInDroppedGroup(app.root, "Acme"), true, "the drop shows at once");

    click(tabButton(app.root, "queue"));
    await nextTick();
    click(tabButton(app.root, "companies"));
    await nextTick();
    assert.equal(
      isInDroppedGroup(app.root, "Acme"),
      true,
      "and it is still dropped after the panel was unmounted and built again",
    );
  } finally {
    app.unmount();
    restoreFetch();
    restoreDom();
  }
});

test("a drop made while a round is in flight survives that round landing", async () => {
  // Ruling 3 again, for companies: the round was issued before he dropped,
  // so its answer cannot carry the drop. Clearing the whole map on success
  // would put the company back under Watched.
  const restoreDom = stubDom();
  const restoreFetch = stubFetch(() => Promise.resolve(patchedOne()));
  const round = heldRound([
    jsonReply([]),
    jsonReply([]),
    jsonReply([WATCHED_COMPANY]),
    jsonReply([CRITERIA_ROW]),
  ]);
  const app = mountRoot({
    config: CONFIG,
    store: storeWithRound([], [], "score", [WATCHED_COMPANY]),
    httpFetch: round.fetchImpl,
    now: () => NOW,
  });
  try {
    await settled();
    click(tabButton(app.root, "companies"));
    await nextTick();
    await dropCompany(app.root, "Acme");
    assert.equal(isInDroppedGroup(app.root, "Acme"), true, "the drop shows at once");

    round.land();
    await settled();
    assert.equal(
      isInDroppedGroup(app.root, "Acme"),
      true,
      "the round read Acme as still watched, and that is the stale half of the pair",
    );
  } finally {
    app.unmount();
    restoreFetch();
    restoreDom();
  }
});

test("a decision made while a round is in flight survives that round landing", async () => {
  // Ruling 3: the round was issued before he decided, so its answer cannot
  // hold the decision. Clearing the whole map on success would put the old
  // status back on a row he had just acted on.
  const restoreDom = stubDom();
  const restoreFetch = stubFetch(() => Promise.resolve(patchedOne()));
  const round = heldRound([
    jsonReply([QUEUE_ROW]),
    jsonReply([QUEUE_ROW]),
    jsonReply([]),
    jsonReply([CRITERIA_ROW]),
  ]);
  const app = mountRoot({
    config: CONFIG,
    store: storeWithRound([QUEUE_ROW], [QUEUE_ROW]),
    httpFetch: round.fetchImpl,
    now: () => NOW,
  });
  try {
    await settled();
    click(outcomeButton(cardIn(app.root, "list", "Acme"), "Applied — Acme"));
    await settled();
    assert.equal(listCards(app.root, "acme::1").length, 0, "the decided row left the queue");

    round.land();
    await settled();
    assert.equal(
      listCards(app.root, "acme::1").length,
      0,
      "the round read it as still waiting, and that is the stale half of the pair",
    );
    click(tabButton(app.root, "record"));
    await nextTick();
    assert.match(textOf(cardIn(app.root, "list", "Acme")), /Applied/);
  } finally {
    app.unmount();
    restoreFetch();
    restoreDom();
  }
});

test("the Companies tab counts what is waiting, so a decision takes its posting out of that count", async () => {
  // The queue read still holds a decided posting, carrying its new status;
  // "n in queue" is the number waiting on him, not the size of the round.
  const restoreDom = stubDom();
  const restoreFetch = stubFetch(() => Promise.resolve(patchedOne()));
  const store = storeWithRound([QUEUE_ROW, ACME_SECOND], [QUEUE_ROW, ACME_SECOND]);
  saveReads(store, {
    queue: [QUEUE_ROW, ACME_SECOND],
    postings: [QUEUE_ROW, ACME_SECOND],
    companies: [
      {
        name: "Acme",
        state: "watched",
        boards: [{ platform: "greenhouse", id: "acme" }],
        source: null,
        reason: null,
        first_seen: "2026-09-01T00:00:00Z",
        last_seen: "2026-09-15T00:00:00Z",
        dropped_at: null,
        alias_of: null,
      },
    ],
    criteria: CRITERIA_ROW,
  });
  const app = mountRoot({
    config: CONFIG,
    store,
    httpFetch: unanswered,
    now: () => NOW,
  });
  try {
    await settled();
    click(outcomeButton(cardIn(app.root, "list", "Staff Engineer"), "Applied — Acme"));
    await settled();
    click(tabButton(app.root, "companies"));
    await nextTick();
    assert.match(textOf(app.root), /1 in queue/, "one of Acme's two rows is still waiting");
  } finally {
    app.unmount();
    restoreFetch();
    restoreDom();
  }
});

test("deciding a posting in the Queue drops the tab pill by one", async () => {
  // #249, end to end: the pill used to read the round's size
  // (`queuePostings.length`), which a decided row still counts because it
  // stays in the read carrying its new status. It must read `waitingPostings`
  // instead, so a real write through the click handler has to move it.
  const restoreDom = stubDom();
  const restoreFetch = stubFetch(() => Promise.resolve(patchedOne()));
  const app = mountRoot({
    config: CONFIG,
    store: storeWithRound([QUEUE_ROW, ACME_SECOND], [QUEUE_ROW, ACME_SECOND]),
    httpFetch: unanswered,
    now: () => NOW,
  });
  try {
    await settled();
    assert.equal(queuePillCount(app.root), "2", "both rows are waiting before any decision");

    click(outcomeButton(cardIn(app.root, "list", "Staff Engineer"), "Applied — Acme"));
    await settled();

    assert.equal(queuePillCount(app.root), "1", "the decided row no longer counts as waiting");
  } finally {
    app.unmount();
    restoreFetch();
    restoreDom();
  }
});

const BETA_ROW = { ...QUEUE_ROW, key: "beta::1", company: "Beta", title: "Backend Engineer" };

test("typing in the queue's search box narrows the matched line and leaves the tab pill alone", async () => {
  // Ruling 1: the pill stays the number waiting on him in every view; only
  // the "n of n" line beside the search box follows what he typed.
  const restoreDom = stubDom();
  const app = mountRoot({
    config: CONFIG,
    store: storeWithRound([QUEUE_ROW, ACME_SECOND, BETA_ROW], [QUEUE_ROW, ACME_SECOND, BETA_ROW]),
    httpFetch: unanswered,
    now: () => NOW,
  });
  try {
    await settled();
    assert.equal(queuePillCount(app.root), "3");
    assert.equal(textOf(matchedLine(app.root)!), "", "no filter yet, nothing said");

    typeInto(searchInput(app.root), "acme");
    await nextTick();

    assert.equal(textOf(matchedLine(app.root)!), "2 of 3", "the filter narrows what matched");
    assert.equal(queuePillCount(app.root), "3", "the pill does not follow the search box");
  } finally {
    app.unmount();
    restoreDom();
  }
});

/** Every heading in the tree, in document order, as its level: `h2` is 2. */
function headingLevels(root: TreeNode): number[] {
  return allNodes(root)
    .filter((node) => /^h[1-6]$/.test(node.tag))
    .map((node) => Number(node.tag.slice(1)));
}

test("no view skips a heading level under the page's one h1", async () => {
  // The four view headings went when the tabs became the headings
  // (2026-09-23) and the group headers under them stayed `h3`, so the page
  // ran h1 straight to h3: the level a screen reader user navigating by
  // heading finds missing, and what an axe run flags as `heading-order`. A
  // tab is not a heading in the accessibility tree, so nothing was filling
  // it. Grouped order, so the Queue renders its company bands.
  const restoreDom = stubDom();
  const store = storeWithRound([QUEUE_ROW, BETA_ROW], [QUEUE_ROW, BETA_ROW], "company");
  saveReads(store, {
    queue: [QUEUE_ROW, BETA_ROW],
    postings: [QUEUE_ROW, BETA_ROW],
    companies: [
      {
        name: "Acme",
        state: "watched",
        boards: [{ platform: "greenhouse", id: "acme" }],
        source: null,
        reason: null,
        first_seen: "2026-09-01T00:00:00Z",
        last_seen: "2026-09-15T00:00:00Z",
        dropped_at: null,
        alias_of: null,
      },
    ],
    criteria: CRITERIA_ROW,
  });
  const app = mountRoot({ config: CONFIG, store, httpFetch: unanswered, now: () => NOW });
  try {
    await settled();
    const measured = new Map<string, number>();
    for (const tab of TABS) {
      click(tabButton(app.root, tab.id));
      await nextTick();
      const levels = headingLevels(app.root);
      measured.set(tab.id, levels.length);
      assert.equal(levels[0], 1, `${tab.id} opens on the page's h1`);
      for (const [index, level] of levels.entries()) {
        if (index === 0) continue;
        const before = levels[index - 1]!;
        assert.ok(
          level <= before + 1,
          `${tab.id} goes h${before} to h${level}, which skips h${before + 1}`,
        );
      }
    }
    // The two views that carry headings under the `h1` are the ones this is
    // for; a fixture that stopped rendering them would pass on the `h1`
    // alone and prove nothing.
    assert.equal(measured.get("queue"), 3, "the h1 and the Queue's two company bands");
    assert.equal(measured.get("companies"), 5, "the h1 and the four state groups");
  } finally {
    app.unmount();
    restoreDom();
  }
});

test("a decided row stays in the grouped Queue when the record read failed", async () => {
  // `history` comes from the record read. When that read fails it is empty
  // while the queue read is fine, so a row James just decided is excluded
  // from `waiting` by its own patch and has no history to reappear in: it
  // left the Queue with nothing on the tab saying why, because `tabError` is
  // per tab and the queue's own read succeeded.
  const restoreDom = stubDom();
  const restoreFetch = stubFetch(() => Promise.resolve(patchedOne()));
  const { fetchImpl } = recordingFetch([
    jsonReply([QUEUE_ROW, ACME_SECOND]),
    statusReply(500, "the record read is down"),
    jsonReply([]),
    jsonReply([CRITERIA_ROW]),
  ]);
  const app = mountRoot({
    config: CONFIG,
    store: memoryStore({ [SESSION_KEY]: sessionJson(), [QUEUE_ORDER_KEY]: "company" }),
    httpFetch: fetchImpl,
    now: () => NOW,
  });
  try {
    await settled();
    click(outcomeButton(cardIn(app.root, "list", "Staff Engineer"), "Applied — Acme"));
    await settled();

    const still = listCards(app.root, "acme::1");
    assert.equal(still.length, 1, "the row he just decided is still under its company");
    assert.match(textOf(still[0]!), /Applied/, "wearing the status he wrote");
    assert.equal(listCards(app.root, "acme::2").length, 1, "and the waiting row is untouched");
  } finally {
    app.unmount();
    restoreFetch();
    restoreDom();
  }
});
