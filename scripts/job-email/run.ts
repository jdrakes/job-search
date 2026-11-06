// Everything the job email check does before its agents, as one command:
//
//   node --env-file=.env scripts/job-email/run.ts [since]
//
// `since` is YYYY-MM-DD or Nd, default 7d. This script sends mail only to the
// local model, and writes rows to files under captures/job-email/<since>/, which
// .gitignore covers. Those rows are not private to this machine: the agents read
// them, so their quotes and full_text reach the agents' model. The one printed
// line is the path of summary.json; the log carries thread ids only.
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

import { describeError } from "../../src/errors.ts";
import { openStore } from "../../src/store/open.ts";
import type { Store } from "../../src/store/store.ts";
import { extractItems, ollamaReady } from "./extract.ts";
import { getThread, listWindow, utcDays, type GmailMessage, type GmailThread } from "./gmail.ts";
import {
  ensureAccessToken,
  gmailPaths,
  keychainStore,
  readCredentials,
  type GmailCredentials,
} from "./oauth.ts";
import type { Result } from "./result.ts";
import { isUnclassified, rowOf, threadText, windowMessages, type Row } from "./rows.ts";
import { writeStoreCopy } from "./snapshot.ts";
import { sortThread, type Lists } from "./sort.ts";

export interface ThreadLine {
  readonly thread: string;
  readonly sender: string | null;
  readonly subject: string | null;
  readonly date: string | null;
}

export interface Batch {
  readonly rows: string; // absolute path
  readonly threads: readonly string[];
}

export interface Summary {
  readonly after: string; // "YYYY/MM/DD"
  readonly store: string; // absolute path of the store copy
  readonly daysSearched: number;
  readonly threadsListed: number;
  readonly status: Batch;
  readonly suggestions: readonly Batch[];
  readonly neitherCount: number;
  readonly neither: string; // absolute path of neither.jsonl
  readonly unclassified: readonly ThreadLine[]; // no items and no full_text
  readonly failed: readonly (ThreadLine & { readonly reason: string })[];
}

export interface RunDependencies {
  readonly store: Store;
  readonly accessToken: () => Promise<Result<string>>;
  readonly fetch: typeof globalThis.fetch;
  readonly today: Date;
  readonly log: (line: string) => void;
}

type FailedLine = ThreadLine & { readonly reason: string };

interface SortedThread {
  readonly thread: GmailThread;
  readonly inWindow: readonly GmailMessage[];
  readonly lists: Lists;
}

const DAY_MS = 86_400_000;
const SUGGESTIONS_BATCH_SIZE = 10;
const DEFAULT_SINCE = "7d";

function isCalendarDate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const time = Date.parse(`${text}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === text;
}

export function parseSince(argument: string | null, today: Date): Result<string> {
  const text = argument ?? DEFAULT_SINCE;
  if (isCalendarDate(text)) return { ok: true, value: text };
  const daysAgo = /^(\d{1,4})d$/.exec(text);
  if (daysAgo === null) {
    return { ok: false, reason: `since must be YYYY-MM-DD or a number of days like 7d: ${text}` };
  }
  const start = new Date(today.getTime() - Number(daysAgo[1]) * DAY_MS);
  return { ok: true, value: start.toISOString().slice(0, 10) };
}

function lineOf(id: string, first: GmailMessage | null): ThreadLine {
  return {
    thread: id,
    sender: first?.sender ?? null,
    subject: first?.subject ?? null,
    date: first?.date ?? null,
  };
}

function firstInWindow(sorted: SortedThread): ThreadLine {
  return lineOf(sorted.thread.id, sorted.inWindow[0] ?? null);
}

function writeLines(path: string, values: readonly object[]): void {
  writeFileSync(path, values.map((value) => `${JSON.stringify(value)}\n`).join(""));
}

// A shorter run must not leave an earlier run's later batches beside its own.
function removeSuggestionBatches(directory: string): void {
  for (const name of readdirSync(directory)) {
    if (/^rows-suggestions-\d+\.jsonl$/.test(name)) rmSync(join(directory, name));
  }
}

function batchOf(path: string, rows: readonly Row[]): Batch {
  writeLines(path, rows);
  return { rows: path, threads: rows.map((row) => row.thread) };
}

function writeSuggestionBatches(directory: string, rows: readonly Row[]): readonly Batch[] {
  removeSuggestionBatches(directory);
  const byDate = rows.toSorted((first, second) =>
    (first.messages[0]?.date ?? "").localeCompare(second.messages[0]?.date ?? ""),
  );
  const batches: Batch[] = [];
  for (let start = 0; start < byDate.length; start += SUGGESTIONS_BATCH_SIZE) {
    const path = join(directory, `rows-suggestions-${batches.length + 1}.jsonl`);
    batches.push(batchOf(path, byDate.slice(start, start + SUGGESTIONS_BATCH_SIZE)));
  }
  return batches;
}

export async function runCheck(
  since: string,
  root: string,
  dependencies: RunDependencies,
): Promise<Result<Summary>> {
  const { fetch, log, store, today } = dependencies;

  // An unstarted Ollama is found out before any Gmail call.
  const ready = await ollamaReady(fetch);
  if (!ready.ok) return ready;

  const accessToken = await dependencies.accessToken();
  if (!accessToken.ok) return accessToken;

  const days = utcDays(since, today);
  const listed = await listWindow(accessToken.value, days, fetch);
  if (!listed.ok) return listed;

  // Before the slow part, so a dead store fails early.
  const directory = resolve(root, "captures", "job-email", since);
  const storeCopy = join(directory, "store");
  await writeStoreCopy(store, storeCopy);

  const failed: FailedLine[] = [];

  // All reads before any model call, so the access token cannot expire during
  // a long extraction.
  const threads: GmailThread[] = [];
  for (const id of listed.value) {
    const thread = await getThread(accessToken.value, id, fetch);
    if (thread.ok) threads.push(thread.value);
    else failed.push({ ...lineOf(id, null), reason: thread.reason });
  }

  const neither: ThreadLine[] = [];
  const toExtract: SortedThread[] = [];
  for (const thread of threads) {
    const inWindow = windowMessages(thread, since);
    if (inWindow.length === 0) {
      failed.push({ ...lineOf(thread.id, null), reason: "no message in the window" });
      continue;
    }
    const sorted = { thread, inWindow, lists: sortThread(thread, inWindow) };
    if (sorted.lists === "neither") neither.push(firstInWindow(sorted));
    else toExtract.push(sorted);
  }

  const statusRows: Row[] = [];
  const suggestionRows: Row[] = [];
  const unclassified: ThreadLine[] = [];
  for (const [index, sorted] of toExtract.entries()) {
    log(`${index + 1}/${toExtract.length} ${sorted.thread.id}`);
    const items = await extractItems(threadText(sorted.inWindow), fetch);
    if (!items.ok) {
      failed.push({ ...firstInWindow(sorted), reason: items.reason });
      continue;
    }
    const row = rowOf(sorted.thread, since, items.value);
    // In the summary only: the thread cannot vanish, and a personal thread
    // with no job content stays out of the agents.
    if (isUnclassified(row)) {
      unclassified.push(firstInWindow(sorted));
      continue;
    }
    if (sorted.lists === "status" || sorted.lists === "both") statusRows.push(row);
    if (sorted.lists === "suggestions" || sorted.lists === "both") suggestionRows.push(row);
  }

  const neitherPath = join(directory, "neither.jsonl");
  writeLines(neitherPath, neither);
  const summary: Summary = {
    after: since.replaceAll("-", "/"),
    store: storeCopy,
    daysSearched: days.length,
    threadsListed: listed.value.length,
    status: batchOf(join(directory, "rows-status.jsonl"), statusRows),
    suggestions: writeSuggestionBatches(directory, suggestionRows),
    neitherCount: neither.length,
    neither: neitherPath,
    unclassified,
    failed,
  };
  writeFileSync(join(directory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  return { ok: true, value: summary };
}

export function withOllamaHint(reason: string, ollamaDirectory: string | undefined): string {
  if (!reason.startsWith("Ollama ")) return reason;
  const command =
    ollamaDirectory === undefined || ollamaDirectory === ""
      ? "ollama serve"
      : `cd ${ollamaDirectory} && ./ollama serve`;
  return `${reason}; start it in its own terminal: ${command}`;
}

export function credentialsAt(path: string): Result<GmailCredentials> {
  if (!existsSync(path)) return { ok: false, reason: `no Gmail credentials file at ${path}` };
  return readCredentials(readFileSync(path, "utf8"));
}

async function main(): Promise<Result<string>> {
  const today = new Date();
  const since = parseSince(process.argv[2] ?? null, today);
  if (!since.ok) return since;
  const credentials = credentialsAt(gmailPaths().credentials);
  if (!credentials.ok) return credentials;
  const root = process.cwd();
  const summary = await runCheck(since.value, root, {
    store: openStore(),
    accessToken: () => ensureAccessToken(credentials.value, keychainStore(), new Date()),
    fetch: globalThis.fetch,
    today,
    log: (line) => console.error(line),
  });
  if (!summary.ok) return summary;
  return { ok: true, value: resolve(root, "captures", "job-email", since.value, "summary.json") };
}

if (import.meta.main) {
  try {
    const outcome = await main();
    if (outcome.ok) {
      console.log(outcome.value);
    } else {
      console.error(`job-email: ${withOllamaHint(outcome.reason, process.env["OLLAMA_DIR"])}`);
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`job-email: ${describeError(error)}`);
    process.exitCode = 1;
  }
}
