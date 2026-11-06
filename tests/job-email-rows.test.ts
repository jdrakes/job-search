import assert from "node:assert/strict";
import { test } from "node:test";

import type { Item } from "../scripts/job-email/extract.ts";
import type { GmailMessage, GmailThread } from "../scripts/job-email/gmail.ts";
import { isUnclassified, rowOf, threadText, windowMessages } from "../scripts/job-email/rows.ts";

// Every name, address and quote here is invented.
function message(overrides: Partial<GmailMessage> = {}): GmailMessage {
  return {
    sender: "recruiter@fernwood.example",
    subject: "Platform Engineer",
    date: "2026-11-02T15:00:00Z",
    labels: ["INBOX"],
    text: "We would like to talk about a Platform Engineer role.",
    ...overrides,
  };
}

function item(overrides: Partial<Item> = {}): Item {
  return {
    kind: "recruiter_role",
    company: "Fernwood Labs",
    title: "Platform Engineer",
    location: null,
    pay: null,
    status: "none",
    quote: "talk about a Platform Engineer role",
    ...overrides,
  };
}

const OLD = message({
  date: "2026-10-20T09:00:00Z",
  text: "Earlier note about the Quillfeather team.",
});
const THREAD: GmailThread = { id: "t1", messages: [OLD, message()] };

test("windowMessages keeps messages from UTC midnight of the start day", () => {
  const edge = message({ date: "2026-11-01T00:00:00Z" });
  const justBefore = message({ date: "2026-10-31T23:59:59Z" });
  const kept = windowMessages({ id: "t", messages: [justBefore, edge] }, "2026-11-01");
  assert.deepEqual(kept, [edge]);
});

test("threadText joins messages in the replay shape", () => {
  const first = message({ sender: "a@x.example", subject: "S1", date: "D1", text: "one" });
  const second = message({ sender: "b@x.example", subject: "S2", date: "D2", text: "two" });
  assert.equal(
    threadText([first, second]),
    "From: a@x.example\nSubject: S1\nDate: D1\n\none\n\n---\n\nFrom: b@x.example\nSubject: S2\nDate: D2\n\ntwo",
  );
});

test("a message before the window is left out of messages and of the checked text", () => {
  const row = rowOf(THREAD, "2026-11-01", [item({ quote: "Quillfeather team" })]);
  assert.equal(row.messages.length, 1);
  assert.equal(row.messages[0]?.date, "2026-11-02T15:00:00Z");
  assert.equal(row.items[0]?.quote_verified, false);
});

test("a listing site moves from company to listing_site", () => {
  const row = rowOf(THREAD, "2026-11-01", [item({ company: "Jobgether Inc" })]);
  assert.equal(row.items[0]?.company, null);
  assert.equal(row.items[0]?.listing_site, "Jobgether Inc");
});

test("a real company keeps company and has no listing_site", () => {
  const row = rowOf(THREAD, "2026-11-01", [item({ company: "Laddersmith Works" })]);
  assert.equal(row.items[0]?.company, "Laddersmith Works");
  assert.equal(row.items[0]?.listing_site, null);
});

test('the string "null" becomes null in every text field', () => {
  const row = rowOf(THREAD, "2026-11-01", [
    item({ company: "null", title: "null", location: "null", pay: "null", quote: "null" }),
  ]);
  const first = row.items[0];
  assert.deepEqual(
    [first?.company, first?.title, first?.location, first?.pay, first?.quote, first?.listing_site],
    [null, null, null, null, null, null],
  );
});

test("a curly apostrophe and a line break still verify a quote", () => {
  const thread: GmailThread = {
    id: "t2",
    messages: [message({ text: "We’re hiring a Platform\nEngineer now." })],
  };
  const row = rowOf(thread, "2026-11-01", [item({ quote: "We're hiring a platform engineer" })]);
  assert.equal(row.items[0]?.quote_verified, true);
});

test("an altered quote is not verified", () => {
  const row = rowOf(THREAD, "2026-11-01", [item({ quote: "talk about a Staff Engineer role" })]);
  assert.equal(row.items[0]?.quote_verified, false);
});

test("a null quote is not verified", () => {
  const row = rowOf(THREAD, "2026-11-01", [item({ quote: null })]);
  assert.equal(row.items[0]?.quote_verified, false);
});

test("a rejected item gives full_text that carries the older message", () => {
  const row = rowOf(THREAD, "2026-11-01", [item({ status: "rejected" })]);
  assert.ok(row.full_text?.includes("Quillfeather team"));
  assert.equal(row.messages.length, 1);
});

test("a SENT thread with a recruiter_role item gives full_text", () => {
  const sent = message({ labels: ["SENT"], text: "Thanks, I am interested." });
  const row = rowOf({ id: "t3", messages: [message(), sent] }, "2026-11-01", [item()]);
  assert.ok(row.full_text?.includes("Thanks, I am interested."));
});

test("a SENT thread with no items has no full_text and is unclassified", () => {
  const sent = message({ labels: ["SENT"] });
  const row = rowOf({ id: "t4", messages: [message(), sent] }, "2026-11-01", []);
  assert.equal(row.full_text, null);
  assert.equal(isUnclassified(row), true);
});

test("a plain applied item with no SENT has no full_text and is classified", () => {
  const row = rowOf(THREAD, "2026-11-01", [
    item({ kind: "application_update", status: "applied" }),
  ]);
  assert.equal(row.full_text, null);
  assert.equal(isUnclassified(row), false);
});
