/**
 * The list's conversation with the store, over PostgREST as the signed-in
 * user; row-level security is the guard and the anon key is public by
 * design. The one REST client in the repo: the engine reaches the same
 * database over `pg` with a password the browser must never hold. The field
 * lists come from `src/schema.ts` and `PRIMARY_KEYS` from
 * `src/store/store.ts`, so nothing here restates a column.
 *
 * A failed read returns its reason rather than throwing, so one view
 * failing leaves the others as they were.
 */
import {
  COMPANY_FIELDS,
  CONTACT_FIELDS,
  CRITERIA_FIELDS,
  POSTING_LIST_FIELDS,
  type Company,
  type Contact,
  type Criteria,
  type PostingSummary,
  type Status,
  type Table,
} from "../../src/schema.ts";
import { PRIMARY_KEYS } from "../../src/store/store.ts";
import type { AppConfig } from "./config.ts";

export type ReadResult<T> = { ok: true; value: T } | { ok: false; reason: string };
export type WriteResult = { ok: true } | { ok: false; reason: string };

/**
 * PostgREST caps a response at `db.max_rows` and returns the first page
 * with no error and no marker, so `selectAll` reads pages of this size and
 * stops on a short one. It must not exceed the server's cap, or a capped
 * full page would look short and stop the loop. `ui/tests/api.test.ts` pins
 * it equal to `max_rows` in `supabase/config.toml`; the live project's cap
 * is a dashboard setting kept at the same number by hand.
 */
export const PAGE_SIZE = 1000;

/**
 * The caller's order with the primary key appended as the final tiebreak:
 * Postgres promises no order between statements, so a paged read over an
 * order that leaves rows tied can place one row on two pages and another
 * on none. Skipped when the caller already ordered by it.
 */
export function totalOrder(table: Table, order?: string): string {
  const key = PRIMARY_KEYS[table];
  if (order === undefined) return `${key}.asc`;
  const columns = order.split(",").map((term) => term.split(".")[0]);
  return columns.includes(key) ? order : `${order},${key}.asc`;
}

const ERROR_BODY_MAX = 500;

function headers(
  config: AppConfig,
  accessToken: string,
  extra?: Record<string, string>,
): Record<string, string> {
  return {
    apikey: config.anonKey,
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    ...extra,
  };
}

async function errorDetail(response: Response): Promise<string> {
  return (await response.text()).slice(0, ERROR_BODY_MAX);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function selectAll<T>(
  config: AppConfig,
  accessToken: string,
  table: Table,
  params: URLSearchParams,
  httpFetch: typeof fetch,
): Promise<ReadResult<T[]>> {
  const all: T[] = [];
  try {
    for (let offset = 0; ; offset += PAGE_SIZE) {
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String(offset));
      const url = `${config.url}/rest/v1/${table}?${params.toString()}`;
      const response = await httpFetch(url, { headers: headers(config, accessToken) });
      if (!response.ok) {
        return {
          ok: false,
          reason: `${table}: HTTP ${response.status}: ${await errorDetail(response)}`,
        };
      }
      const parsed: unknown = await response.json();
      if (!Array.isArray(parsed)) {
        return { ok: false, reason: `${table}: expected an array of rows` };
      }
      all.push(...(parsed as T[]));
      if (parsed.length < PAGE_SIZE) return { ok: true, value: all };
    }
  } catch (error) {
    return { ok: false, reason: `${table}: ${messageOf(error)}` };
  }
}

export async function loadQueue(
  config: AppConfig,
  accessToken: string,
  httpFetch: typeof fetch = fetch,
): Promise<ReadResult<PostingSummary[]>> {
  const params = new URLSearchParams();
  params.set("select", POSTING_LIST_FIELDS.join(","));
  params.set("kept", "is.true");
  params.set("status", "is.null");
  params.set("order", totalOrder("postings", "posted_at.desc"));
  return selectAll<PostingSummary>(config, accessToken, "postings", params, httpFetch);
}

export interface PostingFilters {
  readonly status?: Status;
  readonly company?: string;
  readonly title?: string;
}

/**
 * Every posting the processor kept, and every posting James has acted on
 * whatever the processor now says of it: most of his applications predate
 * the current criteria.
 */
export async function loadPostings(
  config: AppConfig,
  accessToken: string,
  filters: PostingFilters = {},
  httpFetch: typeof fetch = fetch,
): Promise<ReadResult<PostingSummary[]>> {
  const params = new URLSearchParams();
  params.set("select", POSTING_LIST_FIELDS.join(","));
  params.set("or", "(kept.is.true,status.not.is.null)");
  if (filters.status !== undefined) params.set("status", `eq.${filters.status}`);
  if (filters.company !== undefined) params.set("company", `eq.${filters.company}`);
  if (filters.title !== undefined) params.set("title", `ilike.*${filters.title}*`);
  params.set("order", totalOrder("postings"));
  return selectAll<PostingSummary>(config, accessToken, "postings", params, httpFetch);
}

export async function loadCompanies(
  config: AppConfig,
  accessToken: string,
  httpFetch: typeof fetch = fetch,
): Promise<ReadResult<Company[]>> {
  const params = new URLSearchParams();
  params.set("select", COMPANY_FIELDS.join(","));
  params.set("order", totalOrder("companies", "state.asc"));
  return selectAll<Company>(config, accessToken, "companies", params, httpFetch);
}

export async function loadContacts(
  config: AppConfig,
  accessToken: string,
  httpFetch: typeof fetch = fetch,
): Promise<ReadResult<Contact[]>> {
  const params = new URLSearchParams();
  params.set("select", CONTACT_FIELDS.join(","));
  params.set("order", totalOrder("contacts"));
  return selectAll<Contact>(config, accessToken, "contacts", params, httpFetch);
}

export async function loadCriteria(
  config: AppConfig,
  accessToken: string,
  httpFetch: typeof fetch = fetch,
): Promise<ReadResult<Criteria>> {
  const params = new URLSearchParams();
  params.set("select", CRITERIA_FIELDS.join(","));
  params.set("order", totalOrder("criteria"));
  const result = await selectAll<Criteria>(config, accessToken, "criteria", params, httpFetch);
  if (!result.ok) return result;
  const [row] = result.value;
  if (row === undefined) return { ok: false, reason: "criteria: no row found" };
  return { ok: true, value: row };
}

/**
 * `return=representation` is the only way PostgREST tells a caller whether
 * the filter matched any row: with `return=minimal` a zero-row PATCH and a
 * one-row PATCH both come back 204 empty.
 */
async function patchOne(
  config: AppConfig,
  accessToken: string,
  table: Table,
  column: string,
  key: string,
  patch: object,
  httpFetch: typeof fetch,
): Promise<WriteResult> {
  const url = `${config.url}/rest/v1/${table}?${column}=eq.${encodeURIComponent(key)}`;
  try {
    const response = await httpFetch(url, {
      method: "PATCH",
      headers: headers(config, accessToken, {
        "Content-Type": "application/json",
        Prefer: "return=representation",
      }),
      body: JSON.stringify(patch),
    });
    if (!response.ok) {
      return {
        ok: false,
        reason: `${table}: HTTP ${response.status}: ${await errorDetail(response)}`,
      };
    }
    const parsed: unknown = await response.json();
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return { ok: false, reason: `${table}: no row with ${column} ${JSON.stringify(key)}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `${table}: ${messageOf(error)}` };
  }
}

export type StatusPatch = Pick<PostingSummary, "status_at" | "applied_at" | "note"> & {
  readonly status: Status;
};

export async function setStatus(
  config: AppConfig,
  accessToken: string,
  key: string,
  patch: StatusPatch,
  httpFetch: typeof fetch = fetch,
): Promise<WriteResult> {
  return patchOne(config, accessToken, "postings", "key", key, { ...patch }, httpFetch);
}

// James's two columns on a company; `state` is the processor's and the
// hosted grant refuses it.
export type CompanyDropPatch = Pick<Company, "dropped_at" | "reason">;

export async function setCompanyDrop(
  config: AppConfig,
  accessToken: string,
  name: string,
  patch: CompanyDropPatch,
  httpFetch: typeof fetch = fetch,
): Promise<WriteResult> {
  return patchOne(config, accessToken, "companies", "name", name, { ...patch }, httpFetch);
}

// James's five columns on a contact; `state` is the processor's and the
// hosted grant refuses it. One writer for all five: the grant is one
// `UPDATE (...)` naming exactly this set, so a note-only edit and a drop
// both go through the same PATCH shape, carrying only what changed.
export type ContactPatch = Partial<
  Pick<Contact, "dropped_at" | "reason" | "note" | "contacted_at" | "alias_of">
>;

export async function setContactPatch(
  config: AppConfig,
  accessToken: string,
  email: string,
  patch: ContactPatch,
  httpFetch: typeof fetch = fetch,
): Promise<WriteResult> {
  return patchOne(config, accessToken, "contacts", "email", email, { ...patch }, httpFetch);
}

export type CriteriaPatch = Omit<Criteria, "id" | "updated_at">;

/** Stamps `updated_at` to now: saving re-judges every posting at the next run. */
export async function saveCriteria(
  config: AppConfig,
  accessToken: string,
  id: number,
  patch: CriteriaPatch,
  httpFetch: typeof fetch = fetch,
  now: () => string = () => new Date().toISOString(),
): Promise<WriteResult> {
  return patchOne(
    config,
    accessToken,
    "criteria",
    "id",
    String(id),
    { ...patch, updated_at: now() },
    httpFetch,
  );
}
