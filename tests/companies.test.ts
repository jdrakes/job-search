import assert from "node:assert/strict";
import { test } from "node:test";

import {
  boardGone,
  boardKey,
  boardsOf,
  isGone,
  readable,
  recordBoardsRead,
} from "../src/companies.ts";
import { HttpError } from "../src/net/http.ts";
import type { Company } from "../src/schema.ts";
import { memoryStore } from "../src/store/memory.ts";
import type { Store } from "../src/store/store.ts";

function company(name: string, overrides: Partial<Company> = {}): Company {
  return {
    name,
    boards: [],
    reason: null,
    dropped_at: null,
    ...overrides,
  };
}

test("readable: returns only undropped companies that carry at least one board", async () => {
  const store = memoryStore({
    companies: [
      company("HasBoard", { boards: [{ platform: "ashby", id: "x" }] }),
      company("NoBoard", { boards: [] }),
      company("Dropped", {
        boards: [{ platform: "ashby", id: "w" }],
        dropped_at: "2026-09-18T12:17:00.000Z",
        reason: "no remote roles",
      }),
    ],
  });

  const rows = await readable(store);
  assert.deepEqual(
    rows.map((row) => row.name),
    ["HasBoard"],
  );
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

test("boardGone: the first gone run marks the board and returns nothing", async () => {
  const board = { platform: "greenhouse", id: "acme" } as const;
  const store = memoryStore({
    companies: [company("Acme", { boards: [board] })],
  });

  const [before] = await store.select<Company>("companies", { name: "Acme" });
  assert.ok(before);
  const result = await boardGone(store, before, board);

  assert.deepEqual(result, { returned: false });
  const [row] = await store.select<Company>("companies", { name: "Acme" });
  assert.deepEqual(row?.boards, [{ platform: "greenhouse", id: "acme", gone: 1 }]);
});

test("boardGone: the second gone run removes the last board, keeps the row and reports it returned", async () => {
  const board = { platform: "greenhouse", id: "acme", gone: 1 } as const;
  const store = memoryStore({
    companies: [company("Acme", { boards: [board] })],
  });

  const [before] = await store.select<Company>("companies", { name: "Acme" });
  assert.ok(before);
  const result = await boardGone(store, before, board);

  assert.deepEqual(result, { returned: true });
  const [row] = await store.select<Company>("companies", { name: "Acme" });
  assert.deepEqual(row, company("Acme"));
  assert.deepEqual(await readable(store), []);
});

test("boardGone: a company with two boards loses only the dead one and is not returned", async () => {
  const dead = { platform: "greenhouse", id: "acme", gone: 1 } as const;
  const alive = { platform: "lever", id: "acme-inc" } as const;
  const store = memoryStore({
    companies: [company("Acme", { boards: [dead, alive] })],
  });

  const [before] = await store.select<Company>("companies", { name: "Acme" });
  assert.ok(before);
  const result = await boardGone(store, before, dead);

  assert.deepEqual(result, { returned: false });
  const [row] = await store.select<Company>("companies", { name: "Acme" });
  assert.deepEqual(row?.boards, [alive]);
});

test("boardGone: a mark written since the caller read the row survives a sibling's mark", async () => {
  const first = { platform: "greenhouse", id: "acme" } as const;
  const second = { platform: "lever", id: "acme-inc" } as const;
  const store = memoryStore({
    companies: [company("Acme", { boards: [first, second] })],
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
    companies: [company("Acme", { boards: [board] })],
  });

  const [before] = await store.select<Company>("companies", { name: "Acme" });
  assert.ok(before);
  await recordBoardsRead(store, before, [board], "2026-09-18T06:00:00.000Z");

  const [row] = await store.select<Company>("companies", { name: "Acme" });
  assert.deepEqual(row?.boards, [
    { platform: "greenhouse", id: "acme", last_read: "2026-09-18T06:00:00.000Z" },
  ]);
});

test("recordBoardsRead: a marked board that is read loses its mark", async () => {
  const board = { platform: "greenhouse", id: "acme", gone: 1 } as const;
  const store = memoryStore({
    companies: [company("Acme", { boards: [board] })],
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
    companies: [company("Acme", { boards: [board] })],
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
    companies: [company("Acme", { boards: [read, unread] })],
  });

  const [before] = await store.select<Company>("companies", { name: "Acme" });
  assert.ok(before);
  await recordBoardsRead(store, before, [read], "2026-09-18T06:00:00.000Z");

  const [row] = await store.select<Company>("companies", { name: "Acme" });
  assert.deepEqual(row?.boards, [
    { platform: "greenhouse", id: "acme", last_read: "2026-09-18T06:00:00.000Z" },
    { platform: "lever", id: "acme-inc", gone: 1 },
  ]);
});

test("recordBoardsRead: a mark written since the caller read the row survives the read's write", async () => {
  const read = { platform: "greenhouse", id: "acme" } as const;
  const dead = { platform: "lever", id: "acme-inc" } as const;
  const store = memoryStore({
    companies: [company("Acme", { boards: [read, dead] })],
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
    companies: [company("Acme", { boards: [board] })],
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
