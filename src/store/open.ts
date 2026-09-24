// A run with no URL gets no store at all, rather than a memory adapter that
// looks open but holds nothing: a scheduled job silently reporting a clean,
// empty day is worse than one that stops at startup naming the variable.
import process from "node:process";

import { postgresStore } from "./postgres.ts";
import type { Store } from "./store.ts";

export function openStore(env: Readonly<Record<string, string | undefined>> = process.env): Store {
  // An empty string is an unset secret in GitHub Actions, not a URL.
  const url = env["JOB_SEARCH_DB_URL"];
  if (url === undefined || url === "") {
    throw new Error("JOB_SEARCH_DB_URL is not set; the run has no store of record");
  }
  return postgresStore({ url });
}

// The hosted store the list writes into, reached over the same `pg`
// adapter: Supabase is a Postgres, and `SUPABASE_DB_URL` names its session
// pooler. Null means no second store (a test, a fresh checkout), and a
// caller skips whatever it would have done with it rather than failing.
export function openHostedStore(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Store | null {
  const url = env["SUPABASE_DB_URL"];
  if (url === undefined || url === "") return null;
  return postgresStore({ url });
}
