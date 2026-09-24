// In-memory store adapter, so a test runs the real code path without a
// database. Its job is to be indistinguishable from Postgres through
// `Store`: `tests/store.test.ts` runs one contract suite against both.
import { TABLE_FIELDS, type Table } from "../schema.ts";
import { PRIMARY_KEYS, type Store } from "./store.ts";

// A stored row's shape is whatever the caller upserted, so reading a named
// column is a cast.
function field(row: object, column: string): unknown {
  return (row as Record<string, unknown>)[column] ?? null;
}

// Absent columns read as null: a row here holds only the columns someone
// upserted (`ingest` writes a partial row on every re-list), where a
// Postgres row always has every column. A column with a migration DEFAULT
// (`reasons`, `evidence`, `first_seen`) still reads null here until
// written, since the default is not restated here.
function complete(table: Table, row: object): Record<string, unknown> {
  const full: Record<string, unknown> = {};
  for (const column of TABLE_FIELDS[table]) full[column] = field(row, column);
  return full;
}

// Postgres orders NULLS LAST ascending and NULLS FIRST descending by
// default. A select orders by the primary key only; the null arms stay
// because a seeded row may omit its key.
function compare(left: unknown, right: unknown, ascending: boolean): number {
  if (left === null && right === null) return 0;
  if (left === null) return ascending ? 1 : -1;
  if (right === null) return ascending ? -1 : 1;
  if (typeof left === "number" && typeof right === "number") {
    return ascending ? left - right : right - left;
  }
  const [a, b] = [String(left), String(right)];
  if (a === b) return 0;
  return a < b === ascending ? -1 : 1;
}

export function memoryStore(seed?: Partial<Record<Table, readonly object[]>>): Store {
  const tables = new Map<Table, object[]>();
  for (const [table, rows] of Object.entries(seed ?? {})) {
    tables.set(
      table as Table,
      (rows ?? []).map((row) => ({ ...row })),
    );
  }

  function rowsOf(table: Table): object[] {
    const existing = tables.get(table);
    if (existing !== undefined) return existing;
    const fresh: object[] = [];
    tables.set(table, fresh);
    return fresh;
  }

  return {
    async select<T>(
      table: Table,
      eq?: Partial<Record<string, unknown>>,
      columns?: readonly string[],
    ) {
      const key = PRIMARY_KEYS[table];
      let rows = rowsOf(table).map((row) => complete(table, row));
      for (const [column, want] of Object.entries(eq ?? {})) {
        rows = rows.filter((row) => field(row, column) === want);
      }
      rows.sort((left, right) => compare(field(left, key), field(right, key), true));
      // Filtering and ordering run over the whole row, then the caller's
      // columns come back, the primary key always among them: `src/sync.ts`
      // maps every row it reads by that key.
      const kept = columns === undefined || columns.includes(key) ? columns : [...columns, key];
      const narrowed =
        kept === undefined
          ? rows
          : rows.map((row) => Object.fromEntries(kept.map((column) => [column, row[column]])));
      // The caller's claim about the table's shape; neither adapter can
      // check it.
      return narrowed as T[];
    },

    // Merges, as the Postgres adapter's `ON CONFLICT DO UPDATE` sets only
    // the columns the object names: `src/ingest.ts` writes a partial row on
    // every re-list, and replacing would erase a stored body and status.
    async upsert(table, rows) {
      const column = PRIMARY_KEYS[table];
      const stored = rowsOf(table);
      for (const row of rows) {
        const id = field(row, column);
        const at = stored.findIndex((candidate) => field(candidate, column) === id);
        const existing = at === -1 ? undefined : stored[at];
        if (existing === undefined) stored.push({ ...row });
        else stored[at] = { ...existing, ...row };
      }
    },

    async update(table, key, patch) {
      const column = PRIMARY_KEYS[table];
      const stored = rowsOf(table);
      const at = stored.findIndex((row) => String(field(row, column)) === key);
      if (at === -1) {
        return { ok: false, reason: `${table}: no row with ${column} ${JSON.stringify(key)}` };
      }
      const existing = stored[at];
      if (existing === undefined) {
        return { ok: false, reason: `${table}: no row with ${column} ${JSON.stringify(key)}` };
      }
      stored[at] = { ...existing, ...patch };
      return { ok: true };
    },

    async delete(table, keys) {
      const column = PRIMARY_KEYS[table];
      const wanted = new Set(keys);
      const stored = rowsOf(table);
      const kept = stored.filter((row) => !wanted.has(String(field(row, column))));
      // `rowsOf` handed back the stored array, so it is spliced in place.
      stored.splice(0, stored.length, ...kept);
    },
  };
}
