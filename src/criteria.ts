// The only reader of the `criteria` table: one row, id 1, read once per
// run. Not written here: the row is authored in the Criteria view.
import type { Criteria } from "./schema.ts";
import type { Store } from "./store/store.ts";

// Refuses rather than throws: no criteria row is a setup defect, and the
// entry point decides how loudly to say so.
export async function loadCriteria(
  store: Store,
): Promise<{ ok: true; value: Criteria } | { ok: false; reason: string }> {
  const rows = await store.select<Criteria>("criteria", { id: 1 });
  const row = rows[0];
  if (row === undefined) {
    return {
      ok: false,
      reason: "criteria: no row with id 1 — a run must not judge against nothing",
    };
  }
  return { ok: true, value: row };
}
