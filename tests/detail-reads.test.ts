import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { DetailRead, Listing, Reader } from "../src/ats/ats.ts";
import { READERS, withDetailReads } from "../src/ats/readers.ts";
import { resolveReaders } from "../src/daily.ts";

// A one-phase reader standing in for a board API that returns every posting
// with its body, and a detail read an operator supplies for one of its
// boards. Neither touches the network.
const LISTING: Listing = {
  id: "101",
  title: "Staff Software Engineer",
  url: "https://example.com/jobs/101",
  location: "N/A",
  compLow: 100_000,
  compHigh: 120_000,
  postedAt: "2026-09-01",
  body: "Build products.",
  workplace: null,
};

const PAGE: Listing = {
  ...LISTING,
  location: "Remote in United States",
  compLow: 224_000,
  compHigh: 336_000,
  body: "Build products, from the page.",
  workplace: "remote",
};

const ONE_PHASE: Reader = { platform: "greenhouse", list: async () => [LISTING] };

function detailRead(asked: string[]): DetailRead {
  return {
    platform: "greenhouse",
    board: "northgate",
    body: async (id) => {
      asked.push(id);
      return PAGE;
    },
  };
}

function readersWith(reads: readonly DetailRead[]) {
  return withDetailReads({ ...READERS, greenhouse: ONE_PHASE }, reads);
}

test("withDetailReads: a named board lists without body, band or workplace, so the judge reads its page", async () => {
  const readers = readersWith([detailRead([])]);
  const [listing] = await readers.greenhouse.list({ platform: "greenhouse", id: "northgate" });
  assert.equal(listing?.title, "Staff Software Engineer");
  assert.equal(listing?.location, "N/A");
  assert.equal(listing?.body, null);
  assert.equal(listing?.compLow, null);
  assert.equal(listing?.compHigh, null);
  assert.equal(listing?.workplace, null);
});

test("withDetailReads: a named board's body is the operator's read of its page", async () => {
  const asked: string[] = [];
  const readers = readersWith([detailRead(asked)]);
  const detail = await readers.greenhouse.body?.(
    { platform: "greenhouse", id: "northgate" },
    "101",
  );
  assert.deepEqual(detail, PAGE);
  assert.deepEqual(asked, ["101"]);
});

test("withDetailReads: another board on the platform keeps its listing and never reads a page", async () => {
  const asked: string[] = [];
  const readers = readersWith([detailRead(asked)]);
  const board = { platform: "greenhouse" as const, id: "acme" };
  assert.deepEqual(await readers.greenhouse.list(board), [LISTING]);
  assert.equal(await readers.greenhouse.body?.(board, "101"), null);
  assert.deepEqual(asked, []);
});

test("withDetailReads: a platform no read names keeps its reader untouched", () => {
  const readers = readersWith([detailRead([])]);
  assert.equal(readers.lever, READERS.lever);
  assert.equal(readersWith([]).greenhouse, ONE_PHASE);
  assert.equal(readersWith([]).greenhouse.body, undefined);
});

test("resolveReaders: no extraDetailPath returns the readers as given", async () => {
  assert.equal(await resolveReaders({}), READERS);
});

test("resolveReaders: an extraDetailPath's reads are applied to the named board", async () => {
  const dir = mkdtempSync(join(tmpdir(), "job-search-extra-detail-"));
  const modulePath = join(dir, "details.ts");
  writeFileSync(
    modulePath,
    [
      "export default [",
      "  {",
      '    platform: "greenhouse",',
      '    board: "northgate",',
      '    body: async (id) => ({ id, title: null, url: null, location: null, compLow: null, compHigh: null, postedAt: null, body: "page", workplace: "remote" }),',
      "  },",
      "];",
      "",
    ].join("\n"),
  );
  const readers = await resolveReaders(
    { extraDetailPath: modulePath },
    { ...READERS, greenhouse: ONE_PHASE },
  );
  const detail = await readers.greenhouse.body?.({ platform: "greenhouse", id: "northgate" }, "7");
  assert.equal(detail?.workplace, "remote");
});

test("resolveReaders: an extraDetailPath that does not resolve throws naming the path", async () => {
  const missingPath = join(tmpdir(), "job-search-extra-detail-does-not-exist.ts");
  await assert.rejects(
    () => resolveReaders({ extraDetailPath: missingPath }),
    (error: unknown) => error instanceof Error && error.message.includes(missingPath),
  );
});

test("resolveReaders: an export that is not an array of detail reads throws", async () => {
  const dir = mkdtempSync(join(tmpdir(), "job-search-extra-detail-"));
  for (const [name, source] of [
    ["not-an-array.ts", "export default 42;\n"],
    [
      "unknown-platform.ts",
      'export default [{ platform: "nowhere", board: "x", body: async () => null }];\n',
    ],
    ["no-body.ts", 'export default [{ platform: "greenhouse", board: "x" }];\n'],
  ] as const) {
    const modulePath = join(dir, name);
    writeFileSync(modulePath, source);
    await assert.rejects(
      () => resolveReaders({ extraDetailPath: modulePath }),
      (error: unknown) => error instanceof Error && error.message.includes("detail reads"),
      name,
    );
  }
});
