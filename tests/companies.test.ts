import assert from "node:assert/strict";
import { test } from "node:test";

import {
  aliased,
  boardGone,
  boardKey,
  boardsOf,
  isGone,
  recordBoardsRead,
  seen,
  watched,
} from "../src/companies.ts";
import { HttpError } from "../src/net/http.ts";
import type { Company } from "../src/schema.ts";
import { memoryStore } from "../src/store/memory.ts";
import type { Store } from "../src/store/store.ts";

function company(name: string, overrides: Partial<Company> = {}): Company {
  return {
    name,
    state: "discovered",
    boards: [],
    source: "test",
    reason: null,
    first_seen: "2026-09-15T00:00:00Z",
    last_seen: "2026-09-15T00:00:00Z",
    dropped_at: null,
    alias_of: null,
    ...overrides,
  };
}

test("seen: a name never seen before lands as discovered, carrying its boards", async () => {
  const store = memoryStore();
  await seen(store, "Acme", "discovery", [{ platform: "greenhouse", id: "acme" }]);

  const [row] = await store.select<Company>("companies", { name: "Acme" });
  assert.ok(row);
  assert.equal(row?.state, "discovered");
  assert.equal(row?.source, "discovery");
  assert.deepEqual(row?.boards, [{ platform: "greenhouse", id: "acme" }]);
});

test("seen: a second sighting adds a new board without changing state", async () => {
  const store = memoryStore({
    companies: [
      company("Acme", {
        state: "watched",
        boards: [{ platform: "greenhouse", id: "acme" }],
      }),
    ],
  });

  await seen(store, "Acme", "discovery", [{ platform: "lever", id: "acme-inc" }]);

  const [row] = await store.select<Company>("companies", { name: "Acme" });
  assert.ok(row);
  assert.equal(row?.state, "watched");
  assert.deepEqual(row?.boards, [
    { platform: "greenhouse", id: "acme" },
    { platform: "lever", id: "acme-inc" },
  ]);
});

test("seen: a board the company already carries is not duplicated", async () => {
  const store = memoryStore({
    companies: [company("Acme", { boards: [{ platform: "greenhouse", id: "acme" }] })],
  });

  await seen(store, "Acme", "discovery", [{ platform: "greenhouse", id: "acme" }]);

  const [row] = await store.select<Company>("companies", { name: "Acme" });
  assert.deepEqual(row?.boards, [{ platform: "greenhouse", id: "acme" }]);
});

test("seen: an alias stays an alias and gains nothing", async () => {
  const store = memoryStore({
    companies: [
      company("Acme", {
        state: "alias",
        alias_of: "Acme Inc",
        boards: [],
        last_seen: "2026-01-01T00:00:00Z",
      }),
    ],
  });

  await seen(store, "Acme", "discovery", [{ platform: "greenhouse", id: "acme" }]);

  const [row] = await store.select<Company>("companies", { name: "Acme" });
  assert.equal(row?.state, "alias");
  assert.deepEqual(row?.boards, []);
  // Even last_seen does not move.
  assert.equal(row?.last_seen, "2026-01-01T00:00:00Z");
});

test("watched: returns only watched, undropped companies that carry at least one board", async () => {
  const store = memoryStore({
    companies: [
      company("HasBoard", { state: "watched", boards: [{ platform: "ashby", id: "x" }] }),
      company("NoBoard", { state: "watched", boards: [] }),
      company("Discovered", { state: "discovered", boards: [{ platform: "ashby", id: "y" }] }),
      company("Alias", { state: "alias", boards: [{ platform: "ashby", id: "z" }] }),
      company("Dropped", {
        state: "watched",
        boards: [{ platform: "ashby", id: "w" }],
        dropped_at: "2026-09-18T12:17:00.000Z",
        reason: "no remote roles",
      }),
    ],
  });

  const rows = await watched(store);
  assert.deepEqual(
    rows.map((row) => row.name),
    ["HasBoard"],
  );
});

test("seen: a dropped company's boards merge and last_seen moves; the drop stays as it was", async () => {
  const store = memoryStore({
    companies: [
      company("Acme", {
        state: "watched",
        boards: [{ platform: "greenhouse", id: "acme" }],
        dropped_at: "2026-09-18T12:17:00.000Z",
        reason: "no remote roles",
        last_seen: "2026-01-01T00:00:00Z",
      }),
    ],
  });

  await seen(store, "Acme", "discovery", [{ platform: "lever", id: "acme-inc" }]);

  const [row] = await store.select<Company>("companies", { name: "Acme" });
  assert.equal(row?.state, "watched");
  assert.deepEqual(row?.boards, [
    { platform: "greenhouse", id: "acme" },
    { platform: "lever", id: "acme-inc" },
  ]);
  assert.notEqual(row?.last_seen, "2026-01-01T00:00:00Z");
  assert.equal(row?.dropped_at, "2026-09-18T12:17:00.000Z");
  assert.equal(row?.reason, "no remote roles");
});

test("aliased: a new name lands as alias naming its owner, with no reason and no drop", async () => {
  const store = memoryStore();
  const boards = [{ platform: "greenhouse", id: "acme" } as const];

  await aliased(store, "Acme Inc", "discovery", boards, "Acme");

  const [row] = await store.select<Company>("companies", { name: "Acme Inc" });
  assert.equal(row?.state, "alias");
  assert.equal(row?.alias_of, "Acme");
  assert.equal(row?.reason, null);
  assert.equal(row?.dropped_at, null);
  assert.equal(row?.source, "discovery");
  assert.deepEqual(row?.boards, boards);
});

test("aliased: a dropped name becomes an alias and keeps its dropped_at and reason", async () => {
  const store = memoryStore({
    companies: [
      company("Acme Inc", {
        state: "watched",
        boards: [{ platform: "greenhouse", id: "acme" }],
        dropped_at: "2026-09-18T12:17:00.000Z",
        reason: "no remote roles",
      }),
    ],
  });

  await aliased(store, "Acme Inc", "survey", [{ platform: "greenhouse", id: "acme" }], "Acme");

  const [row] = await store.select<Company>("companies", { name: "Acme Inc" });
  assert.equal(row?.state, "alias");
  assert.equal(row?.alias_of, "Acme");
  assert.equal(row?.dropped_at, "2026-09-18T12:17:00.000Z");
  assert.equal(row?.reason, "no remote roles");
  assert.equal(row?.source, "test");
});

test("boardsOf: reads a company's boards", () => {
  const boards = [{ platform: "greenhouse", id: "acme" } as const];
  assert.deepEqual(boardsOf(company("Acme", { boards })), boards);
});

test("boardKey: combines platform and id into one string, so two boards agree on the same key only when both match", () => {
  assert.equal(boardKey({ platform: "greenhouse", id: "acme" }), "greenhouse::acme");
  assert.notEqual(
    boardKey({ platform: "greenhouse", id: "acme" }),
    boardKey({ platform: "lever", id: "acme" }),
  );
});

test("isGone: a 404 is gone on greenhouse, ashby, lever and eightfold; workday is gone on 400, 404 or 422", () => {
  const notFound = new HttpError(404, "HTTP 404");
  const badRequest = new HttpError(400, "HTTP 400");
  const unprocessable = new HttpError(422, "HTTP 422");
  assert.equal(isGone("greenhouse", notFound), true);
  assert.equal(isGone("ashby", notFound), true);
  assert.equal(isGone("lever", notFound), true);
  assert.equal(isGone("eightfold", notFound), true);
  assert.equal(isGone("workday", badRequest), true);
  assert.equal(isGone("workday", notFound), true);
  assert.equal(isGone("workday", unprocessable), true);
  assert.equal(isGone("greenhouse", badRequest), false);
  assert.equal(isGone("greenhouse", unprocessable), false);
});

test("isGone: a 404 is gone on workable and rippling; 500 is not", () => {
  const notFound = new HttpError(404, "HTTP 404");
  const serverError = new HttpError(500, "HTTP 500");
  assert.equal(isGone("workable", notFound), true);
  assert.equal(isGone("rippling", notFound), true);
  assert.equal(isGone("workable", serverError), false);
  assert.equal(isGone("rippling", serverError), false);
});

test("isGone: smartrecruiters and amazon give no gone signal", () => {
  const notFound = new HttpError(404, "HTTP 404");
  assert.equal(isGone("smartrecruiters", notFound), false);
  assert.equal(isGone("amazon", notFound), false);
});

test("isGone: a rate limit, a server error and a plain error are never gone", () => {
  assert.equal(isGone("greenhouse", new HttpError(429, "HTTP 429")), false);
  assert.equal(isGone("greenhouse", new HttpError(503, "HTTP 503 after 3 retries")), false);
  assert.equal(isGone("greenhouse", new Error("HTTP 404")), false);
  assert.equal(isGone("greenhouse", "HTTP 404"), false);
});

test("boardGone: the first gone run marks the board and the company stays watched", async () => {
  const board = { platform: "greenhouse", id: "acme" } as const;
  const store = memoryStore({
    companies: [company("Acme", { state: "watched", boards: [board] })],
  });

  const [before] = await store.select<Company>("companies", { name: "Acme" });
  assert.ok(before);
  const result = await boardGone(store, before, board);

  assert.deepEqual(result, { returned: false });
  const [row] = await store.select<Company>("companies", { name: "Acme" });
  assert.equal(row?.state, "watched");
  assert.deepEqual(row?.boards, [{ platform: "greenhouse", id: "acme", gone: 1 }]);
});

test("boardGone: the second gone run removes the board and returns the company to discovered", async () => {
  const board = { platform: "greenhouse", id: "acme", gone: 1 } as const;
  const store = memoryStore({
    companies: [company("Acme", { state: "watched", boards: [board] })],
  });

  const [before] = await store.select<Company>("companies", { name: "Acme" });
  assert.ok(before);
  const result = await boardGone(store, before, board);

  assert.deepEqual(result, { returned: true });
  const [row] = await store.select<Company>("companies", { name: "Acme" });
  assert.equal(row?.state, "discovered");
  assert.deepEqual(row?.boards, []);
});

test("boardGone: a company with two boards loses only the dead one and stays watched", async () => {
  const dead = { platform: "greenhouse", id: "acme", gone: 1 } as const;
  const alive = { platform: "lever", id: "acme-inc" } as const;
  const store = memoryStore({
    companies: [company("Acme", { state: "watched", boards: [dead, alive] })],
  });

  const [before] = await store.select<Company>("companies", { name: "Acme" });
  assert.ok(before);
  const result = await boardGone(store, before, dead);

  assert.deepEqual(result, { returned: false });
  const [row] = await store.select<Company>("companies", { name: "Acme" });
  assert.equal(row?.state, "watched");
  assert.deepEqual(row?.boards, [alive]);
});

test("boardGone: a mark written since the caller read the row survives a sibling's mark", async () => {
  const first = { platform: "greenhouse", id: "acme" } as const;
  const second = { platform: "lever", id: "acme-inc" } as const;
  const store = memoryStore({
    companies: [company("Acme", { state: "watched", boards: [first, second] })],
  });

  const [before] = await store.select<Company>("companies", { name: "Acme" });
  assert.ok(before);
  await boardGone(store, before, first);
  await boardGone(store, before, second);

  const [row] = await store.select<Company>("companies", { name: "Acme" });
  assert.deepEqual(row?.boards, [
    { platform: "greenhouse", id: "acme", gone: 1 },
    { platform: "lever", id: "acme-inc", gone: 1 },
  ]);
});

test("recordBoardsRead: a read board carries the run's start as last_read", async () => {
  const board = { platform: "greenhouse", id: "acme" } as const;
  const store = memoryStore({
    companies: [company("Acme", { state: "watched", boards: [board] })],
  });

  const [before] = await store.select<Company>("companies", { name: "Acme" });
  assert.ok(before);
  await recordBoardsRead(store, before, [board], "2026-09-18T06:00:00.000Z");

  const [row] = await store.select<Company>("companies", { name: "Acme" });
  assert.equal(row?.state, "watched");
  assert.deepEqual(row?.boards, [
    { platform: "greenhouse", id: "acme", last_read: "2026-09-18T06:00:00.000Z" },
  ]);
});

test("recordBoardsRead: a marked board that is read loses its mark", async () => {
  const board = { platform: "greenhouse", id: "acme", gone: 1 } as const;
  const store = memoryStore({
    companies: [company("Acme", { state: "watched", boards: [board] })],
  });

  const [before] = await store.select<Company>("companies", { name: "Acme" });
  assert.ok(before);
  await recordBoardsRead(store, before, [board], "2026-09-18T06:00:00.000Z");

  const [row] = await store.select<Company>("companies", { name: "Acme" });
  assert.deepEqual(row?.boards, [
    { platform: "greenhouse", id: "acme", last_read: "2026-09-18T06:00:00.000Z" },
  ]);
});

test("recordBoardsRead: a later read replaces the earlier last_read", async () => {
  const board = {
    platform: "greenhouse",
    id: "acme",
    last_read: "2026-09-17T06:00:00.000Z",
  } as const;
  const store = memoryStore({
    companies: [company("Acme", { state: "watched", boards: [board] })],
  });

  const [before] = await store.select<Company>("companies", { name: "Acme" });
  assert.ok(before);
  await recordBoardsRead(store, before, [board], "2026-09-18T06:00:00.000Z");

  const [row] = await store.select<Company>("companies", { name: "Acme" });
  assert.deepEqual(row?.boards, [
    { platform: "greenhouse", id: "acme", last_read: "2026-09-18T06:00:00.000Z" },
  ]);
});

test("recordBoardsRead: only the boards read are written; a sibling keeps its mark and its own last_read", async () => {
  const read = { platform: "greenhouse", id: "acme" } as const;
  const unread = { platform: "lever", id: "acme-inc", gone: 1 } as const;
  const store = memoryStore({
    companies: [company("Acme", { state: "watched", boards: [read, unread] })],
  });

  const [before] = await store.select<Company>("companies", { name: "Acme" });
  assert.ok(before);
  await recordBoardsRead(store, before, [read], "2026-09-18T06:00:00.000Z");

  const [row] = await store.select<Company>("companies", { name: "Acme" });
  assert.equal(row?.state, "watched");
  assert.deepEqual(row?.boards, [
    { platform: "greenhouse", id: "acme", last_read: "2026-09-18T06:00:00.000Z" },
    { platform: "lever", id: "acme-inc", gone: 1 },
  ]);
});

test("recordBoardsRead: a mark written since the caller read the row survives the read's write", async () => {
  const read = { platform: "greenhouse", id: "acme" } as const;
  const dead = { platform: "lever", id: "acme-inc" } as const;
  const store = memoryStore({
    companies: [company("Acme", { state: "watched", boards: [read, dead] })],
  });

  const [before] = await store.select<Company>("companies", { name: "Acme" });
  assert.ok(before);
  await boardGone(store, before, dead);
  await recordBoardsRead(store, before, [read], "2026-09-18T06:00:00.000Z");

  const [row] = await store.select<Company>("companies", { name: "Acme" });
  assert.deepEqual(row?.boards, [
    { platform: "greenhouse", id: "acme", last_read: "2026-09-18T06:00:00.000Z" },
    { platform: "lever", id: "acme-inc", gone: 1 },
  ]);
});

test("recordBoardsRead: no boards read costs no write", async () => {
  const board = { platform: "greenhouse", id: "acme" } as const;
  const inner = memoryStore({
    companies: [company("Acme", { state: "watched", boards: [board] })],
  });
  let writes = 0;
  const store: Store = {
    ...inner,
    async upsert(table, rows) {
      writes += 1;
      return inner.upsert(table, rows);
    },
  };

  const [before] = await store.select<Company>("companies", { name: "Acme" });
  assert.ok(before);
  await recordBoardsRead(store, before, [], "2026-09-18T06:00:00.000Z");

  assert.equal(writes, 0);
});
