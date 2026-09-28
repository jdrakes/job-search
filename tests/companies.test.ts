import assert from "node:assert/strict";
import { test } from "node:test";

import { boardKey, boardsOf, isGone, readable } from "../src/companies.ts";
import { HttpError } from "../src/net/http.ts";
import type { Company } from "../src/schema.ts";
import { memoryStore } from "../src/store/memory.ts";

function company(name: string, overrides: Partial<Company> = {}): Company {
  return {
    name,
    boards: [],
    reason: null,
    dropped_at: null,
    peers_searched_at: null,
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
