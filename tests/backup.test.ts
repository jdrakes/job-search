import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import process from "node:process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { backupRecord } from "../src/backup.ts";
import { POSTING_FIELDS, type Company, type Criteria, type Posting } from "../src/schema.ts";
import { memoryStore } from "../src/store/memory.ts";
import type { Store } from "../src/store/store.ts";

function posting(key: string, overrides: Partial<Posting> = {}): Posting {
  return {
    key,
    company: "Acme",
    platform: "greenhouse",
    board: "acme",
    title: "Staff Engineer",
    url: "https://example.com/1",
    location: "Remote",
    comp_low: 200000,
    comp_high: 250000,
    posted_at: "2026-09-10",
    first_seen: "2026-09-10T00:00:00.000Z",
    last_seen: "2026-09-17T00:00:00.000Z",
    live: true,
    body: "the body",
    kept: true,
    reasons: [],
    evidence: {},
    judged_with: "2026-09-16T00:00:00.000Z",
    status: null,
    applied_at: null,
    status_at: null,
    note: null,
    body_hash: "abc",
    workplace: null,
    ...overrides,
  };
}

function company(name: string): Company {
  return {
    name,
    state: "watched",
    boards: [{ platform: "greenhouse", id: "acme" }],
    source: "hn",
    reason: null,
    first_seen: "2026-09-10T00:00:00.000Z",
    last_seen: "2026-09-17T00:00:00.000Z",
    dropped_at: null,
    alias_of: null,
  };
}

function criteria(): Criteria {
  return {
    id: 1,
    level_words: ["staff"],
    role_words: ["engineer"],
    excluded_title_words: [],
    team_name_words: [],
    excluded_states: [],
    missing_languages: [],
    comp_floor: 120000,
    max_age_days: 45,
    excluded_locations: [],
    product_words: ["payments"],
    assumed_bonus_pct: 10,
    updated_at: "2026-09-16T00:00:00.000Z",
  };
}

// The pre-commit hook runs `npm test` and exports GIT_DIR and
// GIT_INDEX_FILE, which git reads in preference to `-C`; left in, every
// git command here operates on the checkout being committed instead of
// the temporary repository. `src/backup.ts` strips the same list.
function bareGit(args: readonly string[], stdio?: "ignore"): string {
  const env = { ...process.env };
  for (const name of [
    "GIT_DIR",
    "GIT_INDEX_FILE",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  ]) {
    delete env[name];
  }
  return execFileSync("git", args, { encoding: "utf8", env, ...(stdio ? { stdio } : {}) }) ?? "";
}

// A real repository with a real remote: a fake would be testing the fake.
// `git init --bare` as the origin keeps it off the network.
function repoWithRemote(): string {
  const root = mkdtempSync(join(tmpdir(), "backup-test-"));
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  bareGit(["init", "--quiet", "--bare", origin]);
  // Cloning an empty bare repository warns, and thirteen of those warnings
  // bury whatever a real failure prints.
  bareGit(["clone", "--quiet", origin, work], "ignore");
  bareGit(["-C", work, "config", "user.email", "test@example.com"]);
  bareGit(["-C", work, "config", "user.name", "Test"]);
  return work;
}

async function storeWith(
  postings: readonly Posting[],
  companies: readonly Company[] = [company("Acme")],
): Promise<Store> {
  const store = memoryStore();
  if (postings.length > 0) await store.upsert("postings", postings);
  if (companies.length > 0) await store.upsert("companies", companies);
  await store.upsert("criteria", [criteria()]);
  return store;
}

function linesOf(repo: string, file: string): Record<string, unknown>[] {
  const text = readFileSync(join(repo, file), "utf8");
  return text
    .split("\n")
    .filter((each) => each !== "")
    .map((each) => JSON.parse(each) as Record<string, unknown>);
}

function bucketOf(key: string): string {
  return createHash("md5").update(key).digest("hex")[0]!;
}

test("a posting is written to the file the first hex digit of md5(its key) names", async () => {
  const repo = repoWithRemote();
  const keys = ["a::1", "b::2", "c::3", "d::4", "e::5"];
  const result = await backupRecord(await storeWith(keys.map((key) => posting(key))), repo);

  assert.equal(result.postings, 5);
  for (const key of keys) {
    const found = linesOf(repo, join("postings", `${bucketOf(key)}.jsonl`)).map(
      (row) => row["key"],
    );
    assert.ok(found.includes(key), `${key} belongs in ${bucketOf(key)}.jsonl and is not there`);
  }
});

test("all sixteen posting files are written, including the ones no row landed in", async () => {
  const repo = repoWithRemote();
  await backupRecord(await storeWith([posting("a::1")]), repo);
  for (const bucket of "0123456789abcdef") {
    assert.doesNotThrow(() => readFileSync(join(repo, "postings", `${bucket}.jsonl`), "utf8"));
  }
});

test("a posting's body is left out and every other field is kept", async () => {
  const repo = repoWithRemote();
  await backupRecord(await storeWith([posting("a::1", { note: "mine" })]), repo);

  const [row] = linesOf(repo, join("postings", `${bucketOf("a::1")}.jsonl`));
  assert.ok(row !== undefined);
  assert.equal("body" in row, false);
  assert.equal(row["body_hash"], "abc");
  assert.equal(row["title"], "Staff Engineer");
  assert.equal(row["note"], "mine");
});

test("last_seen is kept out of the posting files and written to its own, keyed back", async () => {
  const repo = repoWithRemote();
  await backupRecord(await storeWith([posting("a::1"), posting("b::2")]), repo);

  const [row] = linesOf(repo, join("postings", `${bucketOf("a::1")}.jsonl`));
  assert.ok(row !== undefined);
  assert.equal("last_seen" in row, false, "the field that churns is not in the file that must not");
  assert.equal(row["first_seen"], "2026-09-10T00:00:00.000Z", "the dates that do not churn stay");

  const seen = linesOf(repo, "last-seen.jsonl");
  assert.deepEqual(
    seen.map((each) => each["key"]),
    ["a::1", "b::2"],
  );
  assert.equal(seen[0]?.["last_seen"], "2026-09-17T00:00:00.000Z");
  assert.deepEqual(Object.keys(seen[0] ?? {}), ["key", "last_seen"]);
});

test("a run that only saw the same postings again rewrites one file, not sixteen", async () => {
  // With last_seen in the posting files an ordinary day touches every
  // file; held out, one.
  const repo = repoWithRemote();
  const store = await storeWith([posting("a::1"), posting("b::2"), posting("c::3")]);
  await backupRecord(store, repo);

  for (const key of ["a::1", "b::2", "c::3"]) {
    await store.update("postings", key, { last_seen: "2026-09-19T00:00:00.000Z" });
  }
  await backupRecord(store, repo);

  const changed = bareGit(["-C", repo, "diff", "--name-only", "HEAD~1", "HEAD"]).trim().split("\n");
  assert.deepEqual(changed, ["last-seen.jsonl"]);
});

test("a null field is dropped from the line rather than written as null", async () => {
  const repo = repoWithRemote();
  await backupRecord(await storeWith([posting("a::1", { status: null, posted_at: null })]), repo);

  const [row] = linesOf(repo, join("postings", `${bucketOf("a::1")}.jsonl`));
  assert.ok(row !== undefined);
  assert.equal("status" in row, false);
  assert.equal("posted_at" in row, false);
});

test("a line keeps the field order the schema names, so a rewrite is not a diff", async () => {
  const repo = repoWithRemote();
  await backupRecord(await storeWith([posting("a::1")]), repo);

  const text = readFileSync(join(repo, "postings", `${bucketOf("a::1")}.jsonl`), "utf8").trim();
  const written = Object.keys(JSON.parse(text) as object);
  const expected = POSTING_FIELDS.filter((field) => field !== "body" && written.includes(field));
  assert.deepEqual(written, expected);
});

test("lines are sorted by primary key whatever order the store returned them in", async () => {
  const repo = repoWithRemote();
  // All three md5 into the same bucket only by luck, so the ordering is
  // asserted inside whichever file each landed in.
  const store = await storeWith([posting("z::1"), posting("a::1"), posting("m::1")]);
  await backupRecord(store, repo);

  for (const bucket of "0123456789abcdef") {
    const keys = linesOf(repo, join("postings", `${bucket}.jsonl`)).map((row) =>
      String(row["key"]),
    );
    assert.deepEqual(
      keys,
      [...keys].sort((left, right) => left.localeCompare(right)),
    );
  }
});

test("companies and criteria are written whole, one row per line", async () => {
  const repo = repoWithRemote();
  const result = await backupRecord(
    await storeWith([posting("a::1")], [company("Acme"), company("Beta")]),
    repo,
  );

  assert.equal(result.companies, 2);
  assert.equal(result.criteria, 1);
  assert.deepEqual(
    linesOf(repo, "companies.jsonl").map((row) => row["name"]),
    ["Acme", "Beta"],
  );
  assert.equal(linesOf(repo, "criteria.jsonl").length, 1);
});

test("every line written is read back and parsed before anything is committed", async () => {
  const repo = repoWithRemote();
  const result = await backupRecord(
    await storeWith([posting("a::1"), posting("b::2")], [company("Acme")]),
    repo,
  );
  // Two postings, counted in their own file and again in `last-seen.jsonl`,
  // one company and one criteria row.
  assert.equal(result.verified, 6);
});

test("a body carrying quotes and backslashes survives the round trip", async () => {
  // `COPY TO STDOUT` escapes these and the line stops parsing. The body is
  // not written, so the value under test is a title with the same
  // characters.
  const repo = repoWithRemote();
  const awkward = 'Staff "Engineer" \\ Platform\ttabbed';
  await backupRecord(await storeWith([posting("a::1", { title: awkward })]), repo);

  const [row] = linesOf(repo, join("postings", `${bucketOf("a::1")}.jsonl`));
  assert.ok(row !== undefined);
  assert.equal(row["title"], awkward);
});

test("a store that returns no postings refuses rather than writing an empty copy", async () => {
  const repo = repoWithRemote();
  writeFileSync(join(repo, "keep-me"), "a copy that already exists\n");
  const empty = await storeWith([]);
  await assert.rejects(() => backupRecord(empty, repo), /no postings/);
  assert.equal(readFileSync(join(repo, "keep-me"), "utf8"), "a copy that already exists\n");
});

test("the snapshot is committed and pushed to the remote", async () => {
  const repo = repoWithRemote();
  const result = await backupRecord(await storeWith([posting("a::1")]), repo);

  assert.equal(result.committed, true);
  const subject = bareGit(["-C", repo, "log", "-1", "--format=%s"]).trim();
  assert.match(subject, /^Snapshot \d{4}-\d{2}-\d{2}: 1 postings, 1 companies$/);
  // Pushed, not merely committed: the remote's branch has to point at it.
  const local = bareGit(["-C", repo, "rev-parse", "HEAD"]).trim();
  const remote = bareGit(["-C", repo, "rev-parse", "@{upstream}"]).trim();
  assert.equal(remote, local);
});

test("a second copy of an unchanged store commits nothing", async () => {
  const repo = repoWithRemote();
  const store = await storeWith([posting("a::1")]);
  await backupRecord(store, repo);
  const first = bareGit(["-C", repo, "rev-parse", "HEAD"]).trim();

  const again = await backupRecord(store, repo);
  assert.equal(again.committed, false);
  const second = bareGit(["-C", repo, "rev-parse", "HEAD"]).trim();
  assert.equal(second, first);
});

test("a posting that really changed moves only its own file, leaving the other fifteen alone", async () => {
  // A status, not a re-sighting: `last_seen` lives in its own file, so a
  // change to it proves nothing about the split.
  const repo = repoWithRemote();
  const store = await storeWith([posting("a::1"), posting("b::2"), posting("c::3")]);
  await backupRecord(store, repo);

  await store.update("postings", "a::1", { status: "applied", status_at: "2026-09-18" });
  await backupRecord(store, repo);

  const changed = bareGit(["-C", repo, "diff", "--name-only", "HEAD~1", "HEAD"]).trim().split("\n");
  assert.deepEqual(changed, [join("postings", `${bucketOf("a::1")}.jsonl`)]);
});
