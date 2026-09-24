// The one contract every store adapter implements. `tests/store.test.ts`
// runs one contract suite against every adapter, so a caller tested
// against `memoryStore()` works unchanged against `postgresStore()`.
import type { Table } from "../schema.ts";

export interface Store {
  // Omitted, a select reads every column; naming them is how a caller
  // stops paying for a posting's body. There is no `order`: rows come back
  // by primary key ascending in both adapters.
  select<T>(
    table: Table,
    eq?: Partial<Record<string, unknown>>,
    columns?: readonly string[],
  ): Promise<T[]>;
  // An omitted column keeps its stored value on update and takes its
  // default on insert. A batch mixing shapes is grouped by the adapter
  // into one call per shape; the caller sends one batch either way.
  upsert(table: Table, rows: readonly object[]): Promise<void>;
  update(
    table: Table,
    key: string,
    patch: object,
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
  // Unlike `update`, a key with no row is not a refusal. Keys are strings
  // for every table: `criteria.id` is an integer column, and the adapters
  // let Postgres read "1" as the integer 1, as on update.
  delete(table: Table, keys: readonly string[]): Promise<void>;
}

// Exactly as the migration declares it (`src/schema.ts`'s header).
export const PRIMARY_KEYS = {
  postings: "key",
  companies: "name",
  criteria: "id",
  reprobe_runs: "started",
} as const satisfies Record<Table, string>;
