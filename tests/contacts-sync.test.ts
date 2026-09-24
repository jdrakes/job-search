import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { syncCaptureFile } from "../scripts/contacts-sync.ts";
import type { Capture, CaptureMessage, CaptureThread } from "../src/contacts/capture.ts";
import { syncContacts } from "../src/contacts/sync.ts";
import type { Contact } from "../src/schema.ts";
import { memoryStore } from "../src/store/memory.ts";
import type { Store } from "../src/store/store.ts";

const ACCOUNT = "operator@example.com";
const RECRUITER = "marguerite.olwen@thornbury.partners";

// Hand-written, invented names and addresses, never a real mailbox.
const FROM_HER: CaptureMessage = {
  id: "m-1",
  date: "2026-02-01T09:00:00Z",
  sender: RECRUITER,
  sender_name: "Marguerite Olwen",
  to: [ACCOUNT],
  labels: ["INBOX"],
  subject: "A founding engineer brief",
  body: "Hello,\n\nWorth a call?\n",
};

const FROM_JAMES: CaptureMessage = {
  id: "m-2",
  date: "2026-03-01T10:00:00Z",
  sender: ACCOUNT,
  labels: ["SENT"],
  subject: "Re: A founding engineer brief",
  body: "Happy to talk.\n",
};

const HER_FOLLOW_UP: CaptureMessage = {
  id: "m-3",
  date: "2026-04-15T08:00:00Z",
  sender: RECRUITER,
  sender_name: "Marguerite Olwen",
  to: [ACCOUNT],
  labels: ["INBOX"],
  subject: "Re: A founding engineer brief",
  body: "Thursday then.\n",
};

function capture(messages: readonly CaptureMessage[]): Capture {
  return {
    captured_at: "2026-04-20T08:00:00Z",
    account: ACCOUNT,
    query: "hand-written, invented addresses",
    threads: [{ id: "t-1", subject: "A founding engineer brief", messages }],
  };
}

const FIRST = capture([FROM_HER, FROM_JAMES]);
const NEWER = capture([FROM_HER, FROM_JAMES, HER_FOLLOW_UP]);

// Inside 90 days of the newest message in either capture, so `state` is
// `active` throughout and nothing below turns on the clock.
const NOW = new Date("2026-04-20T00:00:00Z");

async function contactRow(store: Store, email: string): Promise<Contact> {
  const [row] = await store.select<Contact>("contacts", { email });
  assert.ok(row !== undefined, `no contact row for ${email}`);
  return row;
}

// James sets these in the list, which writes the hosted store directly.
async function decideInTheList(hosted: Store): Promise<void> {
  const patched = await hosted.update("contacts", RECRUITER, {
    note: "met her at the Austin meetup",
    dropped_at: "2026-03-05T00:00:00.000Z",
    reason: "placing for agencies I do not want",
  });
  assert.equal(patched.ok, true);
}

test("a first sync writes the capture's contacts to both stores", async () => {
  const local = memoryStore();
  const hosted = memoryStore();

  const result = await syncContacts(local, hosted, FIRST, NOW);

  assert.deepEqual(result, { written: 1, skipped: 0 });
  const stored = await contactRow(local, RECRUITER);
  assert.equal(stored.name, "Marguerite Olwen");
  assert.equal(stored.company, "Thornbury");
  assert.equal(stored.state, "active");
  assert.equal(stored.first_contact, "2026-02-01T09:00:00.000Z");
  assert.equal(stored.last_contact, "2026-03-01T10:00:00.000Z");
  assert.equal((await contactRow(hosted, RECRUITER)).last_contact, "2026-03-01T10:00:00.000Z");
});

// The invariant the whole task exists for, and the 2026-09-18 bug in one
// test: a decision made in the list is still there after the same capture
// is synced again.
test("a note and a drop survive a second sync of the same capture", async () => {
  const local = memoryStore();
  const hosted = memoryStore();
  await syncContacts(local, hosted, FIRST, NOW);
  await decideInTheList(hosted);

  await syncContacts(local, hosted, FIRST, NOW);

  for (const store of [local, hosted]) {
    const row = await contactRow(store, RECRUITER);
    assert.equal(row.note, "met her at the Austin meetup");
    assert.equal(row.dropped_at, "2026-03-05T00:00:00.000Z");
    assert.equal(row.reason, "placing for agencies I do not want");
    assert.equal(row.last_contact, "2026-03-01T10:00:00.000Z");
  }
});

test("a newer capture moves last_contact and leaves the decision alone", async () => {
  const local = memoryStore();
  const hosted = memoryStore();
  await syncContacts(local, hosted, FIRST, NOW);
  await decideInTheList(hosted);

  await syncContacts(local, hosted, NEWER, NOW);

  for (const store of [local, hosted]) {
    const row = await contactRow(store, RECRUITER);
    assert.equal(row.last_contact, "2026-04-15T08:00:00.000Z");
    assert.equal(row.thread_count, 1);
    assert.equal(row.note, "met her at the Austin meetup");
    assert.equal(row.dropped_at, "2026-03-05T00:00:00.000Z");
  }
});

// The pull's `update` does name the operator's columns; that is its job, and it
// only ever writes downwards. Every upsert, in either direction, carries
// the processor's row, and naming one of his in it is the bug.
test("no upsert in either direction names a column James authors", async () => {
  const local = memoryStore();
  const hosted = memoryStore();
  await syncContacts(local, hosted, FIRST, NOW);
  await decideInTheList(hosted);

  const named: string[] = [];
  const recordingUpserts = (inner: Store): Store => ({
    select: <T>(...args: Parameters<Store["select"]>) => inner.select<T>(...args),
    upsert: (table, rows) => {
      for (const row of rows) named.push(...Object.keys(row));
      return inner.upsert(table, rows);
    },
    update: (table, key, patch) => inner.update(table, key, patch),
    delete: (table, keys) => inner.delete(table, keys),
  });

  await syncContacts(recordingUpserts(local), recordingUpserts(hosted), NEWER, NOW);

  assert.deepEqual(
    named.filter((column) =>
      ["dropped_at", "reason", "note", "contacted_at", "alias_of"].includes(column),
    ),
    [],
  );
  assert.ok(named.includes("state"), "an upsert carries the processor's columns");
});

test("a missing hosted store syncs the capture locally and is not an error", async () => {
  const local = memoryStore();

  const result = await syncContacts(local, null, FIRST, NOW);

  assert.deepEqual(result, { written: 1, skipped: 0 });
  assert.equal((await contactRow(local, RECRUITER)).state, "active");
});

test("a decision on a contact the local store has never seen is counted skipped", async () => {
  const local = memoryStore();
  const hosted = memoryStore({
    contacts: [{ email: "unknown@thornbury.partners", note: "from an older capture" }],
  });

  const result = await syncContacts(local, hosted, FIRST, NOW);

  assert.deepEqual(result, { written: 1, skipped: 1 });
  assert.equal(
    (await hosted.select("contacts", { email: "unknown@thornbury.partners" })).length,
    1,
  );
});

// A second window onto the same recruiter: a 2025 thread a 30-day capture
// cannot see, signed with the agency she was at then.
const OLD_THREAD: CaptureThread = {
  id: "t-2025",
  subject: "A staff role at Kestrelmoor",
  messages: [
    {
      id: "m-10",
      date: "2025-01-05T09:00:00Z",
      sender: RECRUITER,
      sender_name: "Marguerite Olwen",
      to: [ACCOUNT],
      labels: ["INBOX"],
      subject: "A staff role at Kestrelmoor",
      body: "Hello,\n\nWorth a look?\n\nBest,\nMarguerite Olwen\nKestrelmoor Search\n",
    },
    {
      id: "m-11",
      date: "2025-01-06T11:00:00Z",
      sender: ACCOUNT,
      labels: ["SENT"],
      subject: "Re: A staff role at Kestrelmoor",
      body: "Not this year.\n",
    },
  ],
};

const RECENT_THREAD: CaptureThread = {
  id: "t-2026",
  subject: "A platform lead in Austin",
  messages: [
    {
      id: "m-20",
      date: "2026-03-20T09:00:00Z",
      sender: RECRUITER,
      sender_name: "Marguerite Olwen",
      to: [ACCOUNT],
      labels: ["INBOX"],
      subject: "A platform lead in Austin",
      body: "Hello,\n\nThis one is remote.\n",
    },
    {
      id: "m-21",
      date: "2026-03-21T10:00:00Z",
      sender: ACCOUNT,
      labels: ["SENT"],
      subject: "Re: A platform lead in Austin",
      body: "Send the brief.\n",
    },
  ],
};

function captureOf(threads: readonly CaptureThread[]): Capture {
  return {
    captured_at: "2026-04-20T08:00:00Z",
    account: ACCOUNT,
    query: "hand-written, invented addresses",
    threads,
  };
}

const TWO_YEARS = captureOf([OLD_THREAD, RECENT_THREAD]);
const LAST_30_DAYS = captureOf([RECENT_THREAD]);
const OLD_ONLY = captureOf([OLD_THREAD]);

const KESTRELMOOR = {
  company: "Kestrelmoor Search",
  domain: "thornbury.partners",
  first_seen: "2025-01-05T09:00:00.000Z",
  last_seen: "2025-01-06T11:00:00.000Z",
};

// The finding this task exists for: a session will not always capture the
// same window, and the narrow one used to overwrite the wide one's row in
// both stores, silently.
test("a narrower capture adds to the stored contact instead of replacing it", async () => {
  const local = memoryStore();
  const hosted = memoryStore();
  await syncContacts(local, hosted, TWO_YEARS, NOW);

  await syncContacts(local, hosted, LAST_30_DAYS, NOW);

  for (const store of [local, hosted]) {
    const row = await contactRow(store, RECRUITER);
    assert.equal(row.first_contact, "2025-01-05T09:00:00.000Z");
    assert.equal(row.last_contact, "2026-03-21T10:00:00.000Z");
    assert.equal(row.thread_count, 2);
    assert.deepEqual(
      row.threads.map((thread) => thread.id),
      ["t-2025", "t-2026"],
    );
    assert.deepEqual(row.signals, ["replied-in-thread", "repeat-correspondent"]);
    assert.deepEqual(row.company_history, [KESTRELMOOR]);
    assert.equal(row.company, "Thornbury");
    assert.equal(row.name, "Marguerite Olwen");
    assert.equal(row.state, "active");
    assert.equal(row.last_subject, "A platform lead in Austin");
  }
});

// The same accumulation with the windows the other way round. What the
// capture in hand cannot see it must not undo: syncing 2025 on its own
// would otherwise file her back at Kestrelmoor and move her to `target`.
test("an older capture synced second rolls nothing back", async () => {
  const local = memoryStore();
  const hosted = memoryStore();
  await syncContacts(local, hosted, LAST_30_DAYS, NOW);

  await syncContacts(local, hosted, OLD_ONLY, NOW);

  for (const store of [local, hosted]) {
    const row = await contactRow(store, RECRUITER);
    assert.equal(row.first_contact, "2025-01-05T09:00:00.000Z");
    assert.equal(row.last_contact, "2026-03-21T10:00:00.000Z");
    assert.equal(row.thread_count, 2);
    assert.deepEqual(
      row.threads.map((thread) => thread.id),
      ["t-2025", "t-2026"],
    );
    assert.equal(row.company, "Thornbury");
    assert.equal(row.state, "active");
    assert.equal(row.last_subject, "A platform lead in Austin");
  }
});

// A thread a window cut short: the second capture holds her mail and not
// his reply, so on its own that thread reads as one James never answered.
// The 2025 thread beside it is what keeps her a contact at all.
test("a thread the window cut short keeps the reply it was stored with", async () => {
  const local = memoryStore();
  await syncContacts(local, null, TWO_YEARS, NOW);
  const cutShort = { ...RECENT_THREAD, messages: [RECENT_THREAD.messages[0]!] };

  await syncContacts(local, null, captureOf([OLD_THREAD, cutShort]), NOW);

  const [recent] = (await contactRow(local, RECRUITER)).threads.filter(
    (thread) => thread.id === "t-2026",
  );
  assert.equal(recent?.sent, true);
  assert.equal(recent?.date, "2026-03-21T10:00:00.000Z");
});

async function captureFile(name: string, body: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "contacts-sync-"));
  const path = join(directory, name);
  await writeFile(path, body, "utf8");
  return path;
}

test("the script syncs a capture file", async () => {
  const local = memoryStore();
  const path = await captureFile("good.json", JSON.stringify(FIRST));

  const outcome = await syncCaptureFile(local, null, path, NOW);

  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.ok && outcome.result, { written: 1, skipped: 0 });
  assert.equal((await contactRow(local, RECRUITER)).email, RECRUITER);
});

test("a capture missing a required field returns the reason and writes nothing", async () => {
  const local = memoryStore();
  const path = await captureFile(
    "no-account.json",
    JSON.stringify({ ...FIRST, account: undefined }),
  );

  const outcome = await syncCaptureFile(local, null, path, NOW);

  assert.equal(outcome.ok, false);
  assert.match(
    outcome.ok ? "" : outcome.reason,
    /capture field "account" must be a non-empty string/,
  );
  assert.deepEqual(await local.select("contacts"), []);
});

test("a capture file that is not there returns the reason and writes nothing", async () => {
  const local = memoryStore();

  const outcome = await syncCaptureFile(local, null, "captures/never-written.json", NOW);

  assert.equal(outcome.ok, false);
  assert.match(outcome.ok ? "" : outcome.reason, /captures\/never-written\.json/);
  assert.deepEqual(await local.select("contacts"), []);
});

test("no capture path named returns the usage line", async () => {
  const outcome = await syncCaptureFile(memoryStore(), null, undefined, NOW);

  assert.equal(outcome.ok, false);
  assert.match(outcome.ok ? "" : outcome.reason, /npm run contacts:sync -- <capture\.json>/);
});
