// The read-only copy of the store the job email agents compare rows with.
// They hold no connection; this only selects. Columns are named so a
// posting's body is not copied.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Store } from "../../src/store/store.ts";

const POSTING_COLUMNS = [
  "key",
  "company",
  "title",
  "location",
  "comp_low",
  "comp_high",
  "status",
  "applied_at",
  "status_at",
  "kept",
  "reasons",
  "gone_at",
  "note",
];
const COMPANY_COLUMNS = ["name", "boards", "dropped_at"];
const CANDIDATE_COLUMNS = ["name", "url", "origin", "outcome", "company"];

export async function writeStoreCopy(store: Store, directory: string): Promise<void> {
  const tables = {
    postings: await store.select<object>("postings", {}, POSTING_COLUMNS),
    companies: await store.select<object>("companies", {}, COMPANY_COLUMNS),
    candidates: await store.select<object>("candidates", {}, CANDIDATE_COLUMNS),
    criteria: await store.select<object>("criteria"),
  };
  mkdirSync(directory, { recursive: true });
  for (const [name, rows] of Object.entries(tables)) {
    const lines = rows.map((row) => `${JSON.stringify(row)}\n`).join("");
    writeFileSync(join(directory, `${name}.jsonl`), lines);
  }
}
