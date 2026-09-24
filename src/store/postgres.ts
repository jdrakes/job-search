// The Postgres store adapter: `pg` straight onto the database, the archive
// container or Supabase's session pooler. Every verb is one statement, with
// the one exception the protocol forces in `upsert`. A failed query throws,
// as `pg` already does.
import pg from "pg";

import type { Table } from "../schema.ts";
import { recordStoreRequests } from "./stats.ts";
import { PRIMARY_KEYS, type Store } from "./store.ts";

// Postgres's OIDs for `date` and `timestamptz`. `pg` parses both into a JS
// `Date`, where `src/schema.ts` types them as strings and `judge` slices
// the day out; worse, a `date` becomes midnight local, so `2025-12-22` read
// east of Greenwich renders back as the 21st. Left unparsed, the text
// Postgres renders comes back.
const DATE_OID = 1082;
const TIMESTAMPTZ_OID = 1184;

// The extended query protocol carries a 16-bit parameter count, so one
// statement binds at most 65,535 values; past that the error names nothing.
// A large board's upsert comes within a column of it, so `upsert` splits on
// the parameter budget rather than a row count.
const MAX_BIND_PARAMETERS = 65535;

interface QueryResult {
  readonly rows: readonly Record<string, unknown>[];
  readonly rowCount: number | null;
}

type Query = (text: string, values: readonly unknown[]) => Promise<QueryResult>;

export interface PostgresConfig {
  readonly url: string;
  // Injected so a test reads the statement without a database; supplied,
  // no pool is opened.
  readonly queryImpl?: Query;
}

// Table and column names reach this adapter from typed callers, never from
// HTTP or argv; quoting is belt to the type system's braces.
function quote(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

// jsonb columns arrive as JS arrays and objects. `pg` renders an array
// parameter as a Postgres array literal, `{a,b}`, which a jsonb column
// refuses, so the JSON text is written out; the parameter goes over the
// wire untyped and the column decides.
function parameter(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  return JSON.stringify(value);
}

function typeParsers(): pg.CustomTypesConfig {
  return {
    getTypeParser: ((oid: number, format?: unknown) => {
      if (oid === DATE_OID) return (value: string) => value;
      if (oid === TIMESTAMPTZ_OID) return (value: string) => new Date(value).toISOString();
      return pg.types.getTypeParser(oid, format as "text");
    }) as typeof pg.types.getTypeParser,
  };
}

function pooledQuery(url: string): Query {
  const pool = new pg.Pool({
    connectionString: url,
    types: typeParsers(),
    // Nothing closes this pool: idle clients would hold the event loop open
    // and the process would never exit.
    allowExitOnIdle: true,
  });
  // An error on an idle client (server restart, a NAT drop) has no caller
  // waiting; `pg` discards the client and the next query opens a fresh one.
  // Left unlistened, node turns it into an uncaught exception.
  pool.on("error", () => {});
  return async (text, values) => {
    const result = await pool.query(text, [...values]);
    return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount };
  };
}

// Rows grouped by the columns they carry, in first-appearance order. The
// column list of an `INSERT … ON CONFLICT DO UPDATE` is fixed for the whole
// statement and has to be exactly the columns the payload names: that is
// what leaves `first_seen` to its DEFAULT on insert and to the stored row
// on update. A mixed batch gets a statement per shape.
function byColumns(rows: readonly object[]): readonly (readonly [readonly string[], object[]])[] {
  const groups = new Map<string, readonly [readonly string[], object[]]>();
  for (const row of rows) {
    const columns = Object.keys(row).filter(
      (column) => (row as Record<string, unknown>)[column] !== undefined,
    );
    // Column names are `[a-z_]` (`src/schema.ts`).
    const shape = columns.join(",");
    const group = groups.get(shape);
    if (group === undefined) groups.set(shape, [columns, [row]]);
    else group[1].push(row);
  }
  return [...groups.values()];
}

export function postgresStore(config: PostgresConfig): Store {
  const query = config.queryImpl ?? pooledQuery(config.url);

  async function run(text: string, values: readonly unknown[]): Promise<QueryResult> {
    const started = performance.now();
    try {
      return await query(text, values);
    } finally {
      recordStoreRequests(1, performance.now() - started);
    }
  }

  return {
    async select<T>(
      table: Table,
      eq?: Partial<Record<string, unknown>>,
      columns?: readonly string[],
    ) {
      const key = PRIMARY_KEYS[table];
      const values: unknown[] = [];
      const conditions: string[] = [];
      for (const [column, want] of Object.entries(eq ?? {})) {
        if (want === null) {
          conditions.push(`${quote(column)} IS NULL`);
          continue;
        }
        values.push(parameter(want));
        conditions.push(`${quote(column)} = $${values.length}`);
      }
      // The primary key comes back whether named or not: one contract.
      const named =
        columns === undefined
          ? "*"
          : (columns.includes(key) ? columns : [...columns, key]).map(quote).join(", ");
      // No LIMIT: a socket to Postgres has no row cap.
      const where = conditions.length === 0 ? "" : ` WHERE ${conditions.join(" AND ")}`;
      const result = await run(
        `SELECT ${named} FROM ${quote(table)}${where} ORDER BY ${quote(key)} ASC`,
        values,
      );
      // The caller's claim about the table's shape; the migration enforces it.
      return result.rows as T[];
    },

    async upsert(table, rows) {
      const key = PRIMARY_KEYS[table];
      for (const [columns, group] of byColumns(rows)) {
        const perRow = columns.length;
        const chunk = Math.max(1, Math.floor(MAX_BIND_PARAMETERS / perRow));
        for (let from = 0; from < group.length; from += chunk) {
          const values: unknown[] = [];
          const tuples = group.slice(from, from + chunk).map((row) => {
            const placeholders = columns.map((column) => {
              values.push(parameter((row as Record<string, unknown>)[column]));
              return `$${values.length}`;
            });
            return `(${placeholders.join(", ")})`;
          });
          // The primary key is what matched, so it is not assigned. A payload
          // of nothing but the key asks for the row to exist: DO NOTHING.
          const assignments = columns
            .filter((column) => column !== key)
            .map((column) => `${quote(column)} = EXCLUDED.${quote(column)}`);
          const resolution =
            assignments.length === 0 ? "DO NOTHING" : `DO UPDATE SET ${assignments.join(", ")}`;
          await run(
            `INSERT INTO ${quote(table)} (${columns.map(quote).join(", ")}) ` +
              `VALUES ${tuples.join(", ")} ON CONFLICT (${quote(key)}) ${resolution}`,
            values,
          );
        }
      }
    },

    async update(table, key, patch) {
      const column = PRIMARY_KEYS[table];
      const values: unknown[] = [];
      const assignments = Object.entries(patch).map(([name, value]) => {
        values.push(parameter(value));
        return `${quote(name)} = $${values.length}`;
      });
      // A bug in the caller: SQL has no `SET` with an empty list.
      if (assignments.length === 0) {
        throw new Error(`${table}: update was given no columns to set`);
      }
      values.push(key);
      const result = await run(
        `UPDATE ${quote(table)} SET ${assignments.join(", ")} ` +
          `WHERE ${quote(column)} = $${values.length}`,
        values,
      );
      if (result.rowCount === 0) {
        return { ok: false, reason: `${table}: no row with ${column} ${JSON.stringify(key)}` };
      }
      return { ok: true };
    },

    async delete(table, keys) {
      if (keys.length === 0) return;
      const column = PRIMARY_KEYS[table];
      // `::text` on both sides so one statement serves a text primary key and
      // `criteria.id`'s integer alike; Postgres elides a text-to-text cast,
      // so the text tables still use their index.
      await run(`DELETE FROM ${quote(table)} WHERE ${quote(column)}::text = ANY($1::text[])`, [
        [...keys],
      ]);
    },
  };
}
