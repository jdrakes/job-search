// Contacts in both directions, in the order a past bug forced: the
// operator's columns come down from the hosted store before anything is
// judged, and the processor's rows go up after. That bug was a
// drop made during a run and lost when publish put the processor's copy of
// the column back, so the two writers here never share a column and the
// publish payload never names one of his.
//
// `src/sync.ts` is the daily's version of this and `pullColumns` is its
// mechanism, reused rather than restated: the shape of the problem is the
// same, only the table and the column list change.
//
// The other rule this file owns is that a capture is a window, not the
// truth: `contactsOf` derives every parser column from the one capture in
// hand, so a 30-day capture knows nothing of a two-year one. Every row is
// therefore merged onto the row already stored before it is written.
import {
  CONTACT_FIELDS,
  type CompanyObservation,
  type Contact,
  type ContactThread,
} from "../schema.ts";
import type { Store } from "../store/store.ts";
import { pullColumns } from "../sync.ts";
import type { Capture } from "./capture.ts";
import { contactsOf } from "./contact.ts";

// the operator's five, named once and used both to pull them down and to subtract
// them from everything that goes up, so the two cannot drift apart.
const JAMES_COLUMNS = [
  "dropped_at",
  "reason",
  "note",
  "contacted_at",
  "alias_of",
] as const satisfies readonly (keyof Contact)[];

// Everything else: what the parser derives from a capture. This is the
// shape of both writes, the local upsert and the publish, because an
// omitted column keeps its stored value on either side.
const PARSER_FIELDS = CONTACT_FIELDS.filter(
  (field) => !(JAMES_COLUMNS as readonly string[]).includes(field),
);

// The parser's half of a stored row: what earlier captures wrote, read
// back so this capture can add to it rather than stand in for it.
type StoredContact = Omit<Contact, (typeof JAMES_COLUMNS)[number]>;

export interface ContactSyncResult {
  // Contacts the capture produced and wrote to the local store.
  readonly written: number;
  // Decisions the hosted store holds for a contact the local store has
  // never seen. They stay hosted; the next sync after a capture that names
  // the person carries them down.
  readonly skipped: number;
}

function parserRowOf(contact: Contact): Record<string, unknown> {
  return Object.fromEntries(PARSER_FIELDS.map((field) => [field, contact[field]]));
}

// A null is a column only the other window witnessed. Both adapters hand
// back ISO-8601 in UTC (`src/store/postgres.ts` normalises timestamptz on
// the way out), so these strings order the way the instants do.
function earliest(first: string | null, second: string | null): string | null {
  if (first === null || second === null) return first ?? second;
  return first < second ? first : second;
}

function latest(first: string | null, second: string | null): string | null {
  if (first === null || second === null) return first ?? second;
  return first > second ? first : second;
}

// One thread seen by two captures is one thread. A window that cut it
// short must not move its date back or unset `sent`: James answering it
// happened, whether or not this capture's window holds his message.
function mergeThreads(
  stored: readonly ContactThread[],
  fresh: readonly ContactThread[],
): readonly ContactThread[] {
  const merged = new Map(stored.map((thread) => [thread.id, thread]));
  for (const thread of fresh) {
    const before = merged.get(thread.id);
    merged.set(
      thread.id,
      before === undefined
        ? thread
        : { ...(thread.date >= before.date ? thread : before), sent: before.sent || thread.sent },
    );
  }
  // The order `contactsOf` builds: oldest thread first, ties by id.
  return [...merged.values()].sort(
    (first, second) => first.date.localeCompare(second.date) || first.id.localeCompare(second.id),
  );
}

// An agency the capture in hand never saw is still one they worked at, so
// the stored observations are kept and this capture's are laid over them.
function historyKeyOf(observation: CompanyObservation): string {
  return `${observation.company ?? ""}\u0000${observation.domain}`;
}

function mergeHistory(
  stored: readonly CompanyObservation[],
  fresh: readonly CompanyObservation[],
): readonly CompanyObservation[] {
  const merged = new Map(stored.map((observation) => [historyKeyOf(observation), observation]));
  for (const observation of fresh) {
    const key = historyKeyOf(observation);
    const before = merged.get(key);
    if (before === undefined) {
      merged.set(key, observation);
      continue;
    }
    merged.set(key, {
      ...observation,
      first_seen:
        before.first_seen < observation.first_seen ? before.first_seen : observation.first_seen,
      last_seen:
        before.last_seen > observation.last_seen ? before.last_seen : observation.last_seen,
    });
  }
  return [...merged.values()];
}

// The stored row and this capture are two windows onto one relationship,
// so what is written is both of them. The columns that accumulate take
// both sides; the ones that say where the relationship stands now come
// from whichever window saw it last, so an older capture synced second
// cannot roll the name, the company or the state back.
function mergeContacts(stored: StoredContact, fresh: Contact): Contact {
  const storedIsNewer =
    stored.last_contact !== null &&
    (fresh.last_contact === null || stored.last_contact > fresh.last_contact);
  const newer = storedIsNewer ? stored : fresh;
  const older = storedIsNewer ? fresh : stored;
  const threads = mergeThreads(stored.threads, fresh.threads);

  return {
    ...fresh,
    name: newer.name ?? older.name,
    company: newer.company ?? older.company,
    company_history: mergeHistory(stored.company_history, fresh.company_history),
    state: newer.state,
    signals: [...new Set([...fresh.signals, ...stored.signals])],
    first_contact: earliest(stored.first_contact, fresh.first_contact),
    last_contact: latest(stored.last_contact, fresh.last_contact),
    thread_count: threads.length,
    threads,
    last_subject: newer.last_subject ?? older.last_subject,
  };
}

export async function syncContacts(
  local: Store,
  hosted: Store | null,
  capture: Capture,
  now: Date,
): Promise<ContactSyncResult> {
  // Down, first and always: every hosted contact, nulls included, because a
  // cleared drop is a decision too and no processor write ever touches
  // these five. The same rule `src/sync.ts` applies to a company's drop.
  const pulled =
    hosted === null
      ? { written: 0, skipped: 0 }
      : await pullColumns(local, hosted, "contacts", JAMES_COLUMNS, () => true);

  // Judged only now, against a local store that already carries whatever
  // James decided in the list since the last run.
  const stored = new Map(
    (await local.select<StoredContact>("contacts", undefined, PARSER_FIELDS)).map((row) => [
      row.email,
      row,
    ]),
  );
  const rows = contactsOf(capture, now).map((contact) => {
    const before = stored.get(contact.email);
    return parserRowOf(before === undefined ? contact : mergeContacts(before, contact));
  });
  if (rows.length > 0) await local.upsert("contacts", rows);

  // A capture is one search over one mailbox, so the local table is the
  // union of every capture so far and the whole of it is published.
  // Nothing is deleted from the hosted store: unlike a posting, a contact
  // does not go stale because a later capture did not mention them.
  if (hosted !== null) {
    const published = await local.select<Record<string, unknown>>(
      "contacts",
      undefined,
      PARSER_FIELDS,
    );
    if (published.length > 0) await hosted.upsert("contacts", published);
  }

  return { written: rows.length, skipped: pulled.skipped };
}
