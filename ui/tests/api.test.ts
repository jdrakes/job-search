import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { CANDIDATE_FIELDS, STATUSES } from "../../src/schema.ts";
import {
  PAGE_SIZE,
  addCandidate,
  loadCandidates,
  loadCompanies,
  loadCriteria,
  loadPostings,
  loadQueue,
  saveCriteria,
  setCompanyDrop,
  setStatus,
  totalOrder,
} from "../src/api.ts";
import type { AppConfig } from "../src/config.ts";

test("totalOrder appends the table's primary key when the caller gives no order", () => {
  assert.equal(totalOrder("postings"), "key.asc");
  assert.equal(totalOrder("companies"), "name.asc");
});

test("totalOrder appends the primary key as a second term when the caller's order omits it", () => {
  assert.equal(totalOrder("postings", "posted_at.desc"), "posted_at.desc,key.asc");
});

test("totalOrder leaves the caller's order alone when it already names the primary key", () => {
  assert.equal(totalOrder("postings", "key.desc"), "key.desc");
});

test("PAGE_SIZE equals the local PostgREST max_rows in supabase/config.toml", () => {
  const match = readFileSync("supabase/config.toml", "utf8").match(/^max_rows = (\d+)$/m);
  assert.ok(match !== null, "no max_rows in supabase/config.toml");
  assert.equal(PAGE_SIZE, Number(match[1]));
});

// Records every call and replays the responses handed to it in order.

interface Call {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
  readonly body: string | null;
}

function recordingFetch(replies: readonly (() => Response)[]): {
  calls: Call[];
  fetchImpl: typeof fetch;
} {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const reply = replies[calls.length];
    calls.push({
      method: init?.method ?? "GET",
      url: String(input),
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : null,
    });
    if (reply === undefined) throw new Error(`unexpected request ${calls.length}`);
    return reply();
  };
  return { calls, fetchImpl };
}

function jsonReply(value: unknown): () => Response {
  return () =>
    new Response(JSON.stringify(value), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
}

function statusReply(code: number, body: string): () => Response {
  return () => new Response(body, { status: code });
}

const CONFIG: AppConfig = {
  url: "https://project.supabase.co",
  anonKey: "anon-key",
  statuses: [...STATUSES],
};
const ACCESS_TOKEN = "user-jwt";

test("loadQueue asks PostgREST for kept, unacted postings ordered by posted_at then the primary key", async () => {
  const { calls, fetchImpl } = recordingFetch([jsonReply([])]);

  await loadQueue(CONFIG, ACCESS_TOKEN, fetchImpl);

  assert.equal(calls[0]?.method, "GET");
  const url = new URL(calls[0]?.url ?? "");
  assert.equal(url.searchParams.get("kept"), "is.true");
  assert.equal(url.searchParams.get("status"), "is.null");
  assert.equal(url.searchParams.get("order"), "posted_at.desc,key.asc");
  assert.equal(calls[0]?.headers.get("apikey"), "anon-key");
  assert.equal(calls[0]?.headers.get("Authorization"), "Bearer user-jwt");
});

test("loadPostings reads what the processor kept or James acted on, with no other filter by default", async () => {
  const { calls, fetchImpl } = recordingFetch([jsonReply([])]);

  await loadPostings(CONFIG, ACCESS_TOKEN, {}, fetchImpl);

  const url = new URL(calls[0]?.url ?? "");
  assert.equal(url.searchParams.get("or"), "(kept.is.true,status.not.is.null)");
  assert.equal(url.searchParams.has("kept"), false);
  assert.equal(url.searchParams.has("status"), false);
  assert.equal(url.searchParams.has("company"), false);
  assert.equal(url.searchParams.has("title"), false);
  assert.equal(url.searchParams.get("order"), "key.asc");
});

test("the two posting reads select every column but body, which the list never renders", async () => {
  const { calls, fetchImpl } = recordingFetch([jsonReply([]), jsonReply([])]);
  await loadQueue(CONFIG, ACCESS_TOKEN, fetchImpl);
  await loadPostings(CONFIG, ACCESS_TOKEN, {}, fetchImpl);
  for (const call of calls) {
    const select = new URL(call.url).searchParams.get("select")?.split(",") ?? [];
    assert.ok(select.length > 0, "select is set");
    assert.ok(!select.includes("body"), "body is not selected");
    assert.ok(
      select.includes("evidence") && select.includes("status_at"),
      "the list's columns are",
    );
  }
});

test("loadPostings encodes status, company and title filters", async () => {
  const { calls, fetchImpl } = recordingFetch([jsonReply([])]);

  await loadPostings(
    CONFIG,
    ACCESS_TOKEN,
    { status: "applied", company: "Acme", title: "engineer" },
    fetchImpl,
  );

  const url = new URL(calls[0]?.url ?? "");
  assert.equal(url.searchParams.get("status"), "eq.applied");
  assert.equal(url.searchParams.get("company"), "eq.Acme");
  assert.equal(url.searchParams.get("title"), "ilike.*engineer*");
});

test("loadCompanies orders by name, the primary key, and adds no second term", async () => {
  const { calls, fetchImpl } = recordingFetch([jsonReply([])]);

  await loadCompanies(CONFIG, ACCESS_TOKEN, fetchImpl);

  const url = new URL(calls[0]?.url ?? "");
  assert.equal(url.searchParams.get("order"), "name.asc");
});

test("loadCandidates orders newest first, with the primary key appended as the tiebreak", async () => {
  const { calls, fetchImpl } = recordingFetch([jsonReply([])]);

  await loadCandidates(CONFIG, ACCESS_TOKEN, fetchImpl);

  const url = new URL(calls[0]?.url ?? "");
  assert.equal(url.searchParams.get("order"), "added_at.desc,id.asc");
  assert.equal(url.searchParams.get("select"), CANDIDATE_FIELDS.join(","));
});

test("loadCriteria returns the one row, unwrapped from the array PostgREST sends", async () => {
  const row = {
    id: 1,
    level_words: ["senior"],
    role_words: ["engineer"],
    excluded_title_words: [],
    team_name_words: [],
    excluded_states: [],
    missing_languages: [],
    comp_floor: 150000,
    max_age_days: null,
    excluded_locations: [],
    product_words: [],
    assumed_bonus_pct: null,
    updated_at: "2026-09-01T00:00:00Z",
  };
  const { fetchImpl } = recordingFetch([jsonReply([row])]);

  const result = await loadCriteria(CONFIG, ACCESS_TOKEN, fetchImpl);

  assert.deepEqual(result, { ok: true, value: row });
});

test("loadCriteria fails by name when the store has no criteria row", async () => {
  const { fetchImpl } = recordingFetch([jsonReply([])]);

  const result = await loadCriteria(CONFIG, ACCESS_TOKEN, fetchImpl);

  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.reason : "", /no row/);
});

test("a failed read returns its reason instead of throwing, so one view failing does not blank the others", async () => {
  const { fetchImpl } = recordingFetch([statusReply(500, "relation does not exist")]);

  const result = await loadQueue(CONFIG, ACCESS_TOKEN, fetchImpl);

  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.reason : "", /500/);
  assert.match(!result.ok ? result.reason : "", /relation does not exist/);
});

test("a read that cannot reach the network returns its reason rather than rejecting", async () => {
  const fetchImpl: typeof fetch = async () => {
    throw new Error("fetch failed: getaddrinfo ENOTFOUND");
  };

  const result = await loadCompanies(CONFIG, ACCESS_TOKEN, fetchImpl);

  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.reason : "", /ENOTFOUND/);
});

test("reads a full page then the next, and assembles every page into one array", async () => {
  const firstPage = Array.from({ length: PAGE_SIZE }, (_, index) => ({ name: `Company ${index}` }));
  const secondPage = [{ name: `Company ${PAGE_SIZE}` }];
  const { calls, fetchImpl } = recordingFetch([jsonReply(firstPage), jsonReply(secondPage)]);

  const result = await loadCompanies(CONFIG, ACCESS_TOKEN, fetchImpl);

  assert.equal(calls.length, 2, "a full first page must trigger a second request");
  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.value.length : 0, PAGE_SIZE + 1);
  assert.match(calls[0]?.url ?? "", new RegExp(`limit=${PAGE_SIZE}`));
  assert.match(calls[0]?.url ?? "", /offset=0/);
  assert.match(calls[1]?.url ?? "", new RegExp(`offset=${PAGE_SIZE}`));
});

test("setStatus patches status, status_at, applied_at and note on the one posting", async () => {
  const patched = {
    key: "acme::123",
    status: "applied",
    status_at: "2026-09-15T00:00:00Z",
    applied_at: "2026-09-15T00:00:00Z",
    note: null,
  };
  const { calls, fetchImpl } = recordingFetch([jsonReply([patched])]);

  const result = await setStatus(
    CONFIG,
    ACCESS_TOKEN,
    "acme::123",
    {
      status: "applied",
      status_at: "2026-09-15T00:00:00Z",
      applied_at: "2026-09-15T00:00:00Z",
      note: null,
    },
    fetchImpl,
  );

  assert.equal(calls[0]?.method, "PATCH");
  const url = new URL(calls[0]?.url ?? "");
  assert.equal(url.searchParams.get("key"), "eq.acme::123");
  assert.deepEqual(JSON.parse(calls[0]?.body ?? "{}"), {
    status: "applied",
    status_at: "2026-09-15T00:00:00Z",
    applied_at: "2026-09-15T00:00:00Z",
    note: null,
  });
  assert.deepEqual(result, { ok: true });
});

test("setStatus reports failure when PostgREST matches no row", async () => {
  const { fetchImpl } = recordingFetch([jsonReply([])]);

  const result = await setStatus(
    CONFIG,
    ACCESS_TOKEN,
    "acme::missing",
    { status: "rejected", status_at: "2026-09-15T00:00:00Z", applied_at: null, note: null },
    fetchImpl,
  );

  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.reason : "", /no row/);
});

test("setStatus sends whatever note it is given, closed's reason included", async () => {
  // Refusing an empty closed reason is the posting card's job.
  const { calls, fetchImpl } = recordingFetch([jsonReply([{ key: "acme::1" }])]);

  await setStatus(
    CONFIG,
    ACCESS_TOKEN,
    "acme::1",
    {
      status: "closed",
      status_at: "2026-09-15T00:00:00Z",
      applied_at: null,
      note: "role was filled",
    },
    fetchImpl,
  );

  assert.deepEqual(JSON.parse(calls[0]?.body ?? "{}"), {
    status: "closed",
    status_at: "2026-09-15T00:00:00Z",
    applied_at: null,
    note: "role was filled",
  });
});

test("setCompanyDrop patches dropped_at and reason on the one company, never boards", async () => {
  const { calls, fetchImpl } = recordingFetch([jsonReply([{ name: "Acme" }])]);

  const result = await setCompanyDrop(
    CONFIG,
    ACCESS_TOKEN,
    "Acme",
    { dropped_at: "2026-09-18T12:17:00.000Z", reason: "acquired, boards gone dark" },
    fetchImpl,
  );

  assert.equal(calls[0]?.method, "PATCH");
  const url = new URL(calls[0]?.url ?? "");
  assert.equal(url.searchParams.get("name"), "eq.Acme");
  assert.deepEqual(JSON.parse(calls[0]?.body ?? "{}"), {
    dropped_at: "2026-09-18T12:17:00.000Z",
    reason: "acquired, boards gone dark",
  });
  assert.deepEqual(result, { ok: true });
});

const STORED_CANDIDATE = {
  id: "7d3f2c1a-0000-4000-8000-000000000001",
  name: "Acme",
  url: "https://acme.example.com/careers",
  origin: "james",
  evidence: "a friend mentioned it",
  added_at: "2026-09-20T12:00:00+00:00",
  outcome: null,
  outcome_at: null,
  company: null,
};

test("addCandidate posts name, url and evidence with origin james, and returns the row the store wrote", async () => {
  // Breaks if the POST stops asking for the row back, or the result drops
  // it: the caller keys its echo on this id, so a random one of its own
  // would never match the next read and the add would show twice.
  const { calls, fetchImpl } = recordingFetch([jsonReply([STORED_CANDIDATE])]);

  const result = await addCandidate(
    CONFIG,
    ACCESS_TOKEN,
    { name: "Acme", url: "https://acme.example.com/careers", evidence: "a friend mentioned it" },
    fetchImpl,
  );

  assert.equal(calls[0]?.method, "POST");
  const url = new URL(calls[0]?.url ?? "");
  assert.equal(`${url.origin}${url.pathname}`, `${CONFIG.url}/rest/v1/candidates`);
  assert.equal(url.searchParams.get("select"), CANDIDATE_FIELDS.join(","));
  assert.equal(calls[0]?.headers.get("Prefer"), "return=representation");
  assert.deepEqual(JSON.parse(calls[0]?.body ?? "{}"), {
    name: "Acme",
    url: "https://acme.example.com/careers",
    evidence: "a friend mentioned it",
    origin: "james",
  });
  assert.deepEqual(result, { ok: true, value: STORED_CANDIDATE });
});

test("addCandidate reports failure when the store answers with no row", async () => {
  const { fetchImpl } = recordingFetch([jsonReply([])]);

  const result = await addCandidate(
    CONFIG,
    ACCESS_TOKEN,
    { name: "Acme", url: null, evidence: null },
    fetchImpl,
  );

  assert.equal(result.ok, false);
});

test("addCandidate accepts a URL alone, with no name", async () => {
  const { calls, fetchImpl } = recordingFetch([jsonReply([STORED_CANDIDATE])]);

  const result = await addCandidate(
    CONFIG,
    ACCESS_TOKEN,
    { name: null, url: "https://acme.example.com", evidence: null },
    fetchImpl,
  );

  assert.equal(calls.length, 1, "a valid URL alone is sent, not refused");
  assert.equal(result.ok, true);
});

test("addCandidate reads a URL typed without a scheme as https and sends it that way", async () => {
  // Breaks if the https:// retry goes: "acme.example.com/careers" is how a
  // careers page is usually copied, and `new URL` refuses it bare.
  const { calls, fetchImpl } = recordingFetch([jsonReply([STORED_CANDIDATE])]);

  const result = await addCandidate(
    CONFIG,
    ACCESS_TOKEN,
    { name: null, url: "acme.example.com/careers", evidence: null },
    fetchImpl,
  );

  assert.equal(calls.length, 1, "sent, not refused");
  assert.equal(JSON.parse(calls[0]?.body ?? "{}").url, "https://acme.example.com/careers");
  assert.equal(result.ok, true);
});

test("addCandidate refuses and sends nothing when both name and url are empty", async () => {
  const { calls, fetchImpl } = recordingFetch([jsonReply([STORED_CANDIDATE])]);

  const result = await addCandidate(
    CONFIG,
    ACCESS_TOKEN,
    { name: null, url: null, evidence: null },
    fetchImpl,
  );

  assert.equal(calls.length, 0, "refused before any request went out");
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.reason : "", /name or a URL/);
});

test("addCandidate refuses a url that parses neither as typed nor with https://, naming it unreadable", async () => {
  // Breaks if the message goes back to "needs a name or a URL", which told
  // James the field was empty when he had typed something into it.
  const { calls, fetchImpl } = recordingFetch([jsonReply([STORED_CANDIDATE])]);

  const result = await addCandidate(
    CONFIG,
    ACCESS_TOKEN,
    { name: null, url: "not a url", evidence: null },
    fetchImpl,
  );

  assert.equal(calls.length, 0, "an unreadable url is refused before sending");
  assert.deepEqual(result, { ok: false, reason: 'cannot read "not a url" as a URL' });
});

test("addCandidate reports failure when the store refuses the insert", async () => {
  const { fetchImpl } = recordingFetch([
    statusReply(403, "new row violates row-level security policy"),
  ]);

  const result = await addCandidate(
    CONFIG,
    ACCESS_TOKEN,
    { name: "Acme", url: null, evidence: null },
    fetchImpl,
  );

  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.reason : "", /403/);
});

test("saveCriteria patches the row and stamps updated_at from the injected clock", async () => {
  const { calls, fetchImpl } = recordingFetch([jsonReply([{ id: 1 }])]);

  await saveCriteria(
    CONFIG,
    ACCESS_TOKEN,
    1,
    {
      level_words: ["senior", "staff"],
      role_words: ["engineer"],
      excluded_title_words: ["intern"],
      team_name_words: [],
      excluded_states: [],
      missing_languages: [],
      comp_floor: 160000,
      max_age_days: null,
      excluded_locations: [],
      product_words: [],
      assumed_bonus_pct: null,
    },
    fetchImpl,
    () => "2026-09-15T12:00:00Z",
  );

  assert.equal(calls[0]?.method, "PATCH");
  const url = new URL(calls[0]?.url ?? "");
  assert.equal(url.searchParams.get("id"), "eq.1");
  assert.deepEqual(JSON.parse(calls[0]?.body ?? "{}"), {
    level_words: ["senior", "staff"],
    role_words: ["engineer"],
    excluded_title_words: ["intern"],
    team_name_words: [],
    excluded_states: [],
    missing_languages: [],
    max_age_days: null,
    excluded_locations: [],
    product_words: [],
    assumed_bonus_pct: null,
    comp_floor: 160000,
    updated_at: "2026-09-15T12:00:00Z",
  });
});
