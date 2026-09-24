// Reads one capture file and syncs it.
//
//   npm run contacts:sync -- captures/2026-09-23.json
//
// The capture is written by a session driving the Gmail connector, which no
// cron can do, so this is invoked by hand and the list is as fresh as the
// last capture. `captures/` is gitignored: captured mail never enters git.
//
// A bad capture is an expected failure, not a bug: a session wrote the
// file. The reason is returned up to `main`, which prints it and exits
// non-zero. Only `main` catches.
import { readFile } from "node:fs/promises";
import process from "node:process";

import { readCapture } from "../src/contacts/capture.ts";
import { syncContacts, type ContactSyncResult } from "../src/contacts/sync.ts";
import { describeError } from "../src/errors.ts";
import { openHostedStore, openStore } from "../src/store/open.ts";
import type { Store } from "../src/store/store.ts";

const USAGE = "usage: npm run contacts:sync -- <capture.json>";

export type SyncOutcome =
  | { readonly ok: true; readonly result: ContactSyncResult; readonly threads: number }
  | { readonly ok: false; readonly reason: string };

// The file is read and parsed before either store is touched, so a capture
// this refuses writes nothing anywhere.
export async function syncCaptureFile(
  local: Store,
  hosted: Store | null,
  path: string | undefined,
  now: Date,
): Promise<SyncOutcome> {
  if (path === undefined || path.trim() === "") {
    return { ok: false, reason: `no capture named. ${USAGE}` };
  }

  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    return { ok: false, reason: `${path}: ${describeError(error)}` };
  }

  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    return { ok: false, reason: `${path}: ${describeError(error)}` };
  }

  const capture = readCapture(value);
  if ("error" in capture) return { ok: false, reason: `${path}: ${capture.error}` };

  const result = await syncContacts(local, hosted, capture, now);
  return { ok: true, result, threads: capture.threads.length };
}

async function main(): Promise<void> {
  const local = openStore();
  // No hosted store is not an error, as everywhere else: the pull and the
  // publish are skipped and the capture still reaches the store of record.
  const hosted = openHostedStore();

  const outcome = await syncCaptureFile(local, hosted, process.argv[2], new Date());
  if (!outcome.ok) {
    console.error(`contacts:sync: ${outcome.reason}`);
    process.exitCode = 1;
    return;
  }

  console.log(`threads: ${outcome.threads}`);
  console.log(`written: ${outcome.result.written}`);
  console.log(`skipped: ${outcome.result.skipped}`);
  if (hosted === null) console.log("hosted: none; SUPABASE_DB_URL is not set");
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(`contacts:sync: ${describeError(error)}`);
    process.exitCode = 1;
  }
}
