import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { memoryStore } from "../src/store/memory.ts";
import { writeStoreCopy } from "../scripts/job-email/snapshot.ts";

// Every name, URL and text here is invented.
const BODY = "Invented body: the Quillfeather posting asks for Rust and calls itself rare.";

const POSTING = {
  key: "fernwood-labs-platform-engineer",
  company: "Fernwood Labs",
  platform: "greenhouse",
  board: "fernwood-labs",
  title: "Platform Engineer",
  location: "Remote",
  comp_low: 150000,
  comp_high: 180000,
  status: "none",
  applied_at: null,
  status_at: null,
  kept: true,
  reasons: ["invented reason"],
  gone_at: null,
  note: null,
  body: BODY,
};

const COMPANY = {
  name: "Fernwood Labs",
  boards: ["fernwood-labs"],
  reason: null,
  dropped_at: null,
};

const CANDIDATE = {
  id: 1,
  name: "Marlow Tessel",
  url: "https://fernwood.example/jobs/1",
  origin: "email",
  outcome: "none",
  company: "Fernwood Labs",
};

const CRITERIA = { id: 1, level_words: ["senior"], role_words: ["platform"] };

// The thirteen posting columns the copy names, written out by hand.
const POSTING_KEYS = [
  "applied_at",
  "comp_high",
  "comp_low",
  "company",
  "gone_at",
  "kept",
  "key",
  "location",
  "note",
  "reasons",
  "status",
  "status_at",
  "title",
];

async function copyInto(): Promise<{ directory: string; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), "job-email-snapshot-"));
  const store = memoryStore({
    postings: [POSTING],
    companies: [COMPANY],
    candidates: [CANDIDATE],
    criteria: [CRITERIA],
  });
  const copy = join(directory, "copy");
  await writeStoreCopy(store, copy);
  return { directory: copy, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

function parseLines(text: string): unknown[] {
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

test("writes the four table files, each line parsing as JSON", async () => {
  const { directory, cleanup } = await copyInto();
  try {
    for (const name of ["postings", "companies", "candidates", "criteria"]) {
      const text = await readFile(join(directory, `${name}.jsonl`), "utf8");
      assert.equal(text.endsWith("\n"), true, `${name} ends with a newline`);
      assert.equal(parseLines(text).length, 1, `${name} has one line`);
    }
  } finally {
    await cleanup();
  }
});

test("postings.jsonl holds exactly the named posting columns", async () => {
  const { directory, cleanup } = await copyInto();
  try {
    const [row] = parseLines(await readFile(join(directory, "postings.jsonl"), "utf8")) as Record<
      string,
      unknown
    >[];
    assert.deepEqual(Object.keys(row ?? {}).sort(), POSTING_KEYS);
    assert.equal(row?.title, "Platform Engineer");
    assert.equal(row?.comp_high, 180000);
  } finally {
    await cleanup();
  }
});

test("a posting's body text is in no copied file", async () => {
  const { directory, cleanup } = await copyInto();
  try {
    for (const name of ["postings", "companies", "candidates", "criteria"]) {
      const text = await readFile(join(directory, `${name}.jsonl`), "utf8");
      assert.equal(text.includes(BODY), false, `${name} holds no body text`);
      assert.equal(text.includes("body"), false, `${name} has no body column`);
    }
  } finally {
    await cleanup();
  }
});

test("a store with two postings writes two posting lines", async () => {
  const directory = await mkdtemp(join(tmpdir(), "job-email-snapshot-"));
  try {
    const store = memoryStore({
      postings: [POSTING, { ...POSTING, key: "second-key", title: "Second Title" }],
    });
    await writeStoreCopy(store, directory);
    const lines = parseLines(await readFile(join(directory, "postings.jsonl"), "utf8"));
    assert.equal(lines.length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
