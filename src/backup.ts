// The run's last phase: a copy of the store of record, off the machine it
// lives on. A git repository of JSONL, one row per line, bodies excluded:
// ingest re-reads every watched board each weekday, so a body is the most
// recoverable part of a row; the verdict, reasons, evidence and dates are
// not.
//
// Postings are split across 16 files by the first hex digit of md5(key), so
// a row stays in the same file for life. `psql`'s `COPY ... TO STDOUT` must
// not be used: it emits Postgres text format, which escapes backslashes, so
// every `\"` inside a JSON value becomes `\\"` and the line stops parsing
// while sizes and line counts look right. This serialises with
// `JSON.stringify` and parses every line back anyway.
import { createHash } from "node:crypto";
import process from "node:process";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  COMPANY_FIELDS,
  CRITERIA_FIELDS,
  POSTING_FIELDS,
  type Company,
  type Criteria,
  type Posting,
} from "./schema.ts";
import type { Store } from "./store/store.ts";

const run = promisify(execFile);

// Everything a posting is, less the text and less `last_seen`. `body_hash`
// stays: it says which text a row was judged against. `last_seen` is held
// out because it changes on almost every row every run, and left in it
// would rewrite all sixteen files every morning.
const POSTING_BACKUP_FIELDS = POSTING_FIELDS.filter(
  (field) => field !== "body" && field !== "last_seen",
);

// The held-out field, keyed back to its row; sorted by key so a day's churn
// is one file that compresses well.
const LAST_SEEN_FIELDS = ["key", "last_seen"] as const satisfies readonly (keyof Posting)[];

// Both files' fields together, everything but the body.
const POSTING_READ_FIELDS = POSTING_FIELDS.filter((field) => field !== "body");

// The width of a hex digit, not a tuning number.
const BUCKETS = "0123456789abcdef".split("");

export interface BackupResult {
  readonly postings: number;
  readonly companies: number;
  readonly criteria: number;
  // Lines read back off disk and parsed; a mismatch with the three counts
  // above throws before anything is committed.
  readonly verified: number;
  // False when the export matched what the repository held (a weekend, a
  // second run in one day).
  readonly committed: boolean;
}

function bucketOf(key: string): string {
  return createHash("md5").update(key).digest("hex")[0]!;
}

// Nulls dropped, which keeps the line stable when a column is added: an
// absent field reads back as null.
function line<T extends object>(row: T, fields: readonly (keyof T)[]): string {
  const present = fields.filter((field) => row[field] !== null && row[field] !== undefined);
  return JSON.stringify(Object.fromEntries(present.map((field) => [field, row[field]])));
}

// Sorted explicitly: the file's order has to be a property of the backup,
// not of whichever adapter produced it, or a snapshot becomes a rewrite.
function fileOf<T extends object>(
  rows: readonly T[],
  fields: readonly (keyof T)[],
  key: keyof T,
): string {
  const sorted = [...rows].sort((left, right) =>
    String(left[key]).localeCompare(String(right[key])),
  );
  return sorted.map((row) => line(row, fields)).join("\n") + (sorted.length > 0 ? "\n" : "");
}

// Every line, not a sample: a bad line is one with a backslash in it.
async function verify(directory: string, files: readonly string[]): Promise<number> {
  let parsed = 0;
  for (const file of files) {
    const path = join(directory, file);
    const text = await readFile(path, "utf8");
    const lines = text.split("\n").filter((each) => each !== "");
    for (const [index, each] of lines.entries()) {
      try {
        JSON.parse(each);
      } catch (error) {
        throw new Error(
          `${file} line ${index + 1} is not JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      parsed += 1;
    }
  }
  return parsed;
}

// git reads these in preference to `-C`, and they are set inside any git
// hook, so a `git -C <copy>` launched from this project's pre-commit hook
// (which runs `npm test`) would operate on the hook's repository.
const GIT_LOCATION_VARS = [
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
];

// `git -C`, so the run never changes its own working directory.
async function git(repo: string, ...args: readonly string[]): Promise<string> {
  const env = { ...process.env };
  for (const name of GIT_LOCATION_VARS) delete env[name];
  const { stdout } = await run("git", ["-C", repo, ...args], { env });
  return stdout;
}

export async function backupRecord(store: Store, repo: string): Promise<BackupResult> {
  const postings = await store.select<Posting>("postings", undefined, POSTING_READ_FIELDS);
  const companies = await store.select<Company>("companies", undefined, COMPANY_FIELDS);
  const criteria = await store.select<Criteria>("criteria", undefined, CRITERIA_FIELDS);

  // A store that answered with zero postings is a broken read, not an
  // empty history; it must not overwrite a good copy.
  if (postings.length === 0) {
    throw new Error("the store returned no postings; refusing to overwrite the copy with nothing");
  }

  await mkdir(join(repo, "postings"), { recursive: true });

  const written: string[] = [];
  for (const bucket of BUCKETS) {
    const mine = postings.filter((posting) => bucketOf(posting.key) === bucket);
    const file = join("postings", `${bucket}.jsonl`);
    await writeFile(join(repo, file), fileOf(mine, POSTING_BACKUP_FIELDS, "key"), "utf8");
    written.push(file);
  }
  await writeFile(join(repo, "last-seen.jsonl"), fileOf(postings, LAST_SEEN_FIELDS, "key"), "utf8");
  written.push("last-seen.jsonl");
  await writeFile(join(repo, "companies.jsonl"), fileOf(companies, COMPANY_FIELDS, "name"), "utf8");
  written.push("companies.jsonl");
  await writeFile(join(repo, "criteria.jsonl"), fileOf(criteria, CRITERIA_FIELDS, "id"), "utf8");
  written.push("criteria.jsonl");

  const verified = await verify(repo, written);
  // Once across the sixteen files, once in `last-seen.jsonl`.
  const expected = postings.length * 2 + companies.length + criteria.length;
  if (verified !== expected) {
    throw new Error(`read back ${verified} lines, wrote ${expected}`);
  }

  // Staged before the emptiness check: `git status` on an unstaged tree and
  // `git diff --cached` disagree about a file mode change.
  await git(repo, "add", "-A");
  const staged = await git(repo, "diff", "--cached", "--name-only");
  if (staged.trim() === "")
    return {
      postings: postings.length,
      companies: companies.length,
      criteria: criteria.length,
      verified,
      committed: false,
    };

  const today = new Date().toISOString().slice(0, 10);
  await git(
    repo,
    "commit",
    "-q",
    "-m",
    `Snapshot ${today}: ${postings.length} postings, ${companies.length} companies`,
  );
  await git(repo, "push", "--quiet");

  return {
    postings: postings.length,
    companies: companies.length,
    criteria: criteria.length,
    verified,
    committed: true,
  };
}
