import assert from "node:assert/strict";
import { test } from "node:test";

import { capRows, scoreRemote, type Judge, type RemoteRow } from "../scripts/score-remote.ts";

// Two companies, three rows each. a2/a3 share a body (dedup); b3 is the
// only row with a status. Verdicts are chosen so lost/admitted/agreement
// all appear at least once and the expected numbers are hand-computed.
const ROWS: readonly RemoteRow[] = [
  {
    key: "a1",
    company: "Acme",
    platform: "ashby",
    body: "Acme's first posting, long enough to be a real body.",
    location: "Remote",
    comp_high: 200000,
    workplace: "remote",
    status: null,
  },
  {
    key: "a2",
    company: "Acme",
    platform: "ashby",
    body: "Duplicate body shared with a3.",
    location: "Remote",
    comp_high: 190000,
    workplace: "remote",
    status: null,
  },
  {
    key: "a3",
    company: "Acme",
    platform: "ashby",
    body: "Duplicate body shared with a3.",
    location: "New York",
    comp_high: 180000,
    workplace: "onsite",
    status: null,
  },
  {
    key: "b1",
    company: "Beta",
    platform: "lever",
    body: "Beta's onsite posting describing the office.",
    location: "San Francisco",
    comp_high: 210000,
    workplace: "onsite",
    status: null,
  },
  {
    key: "b2",
    company: "Beta",
    platform: "lever",
    body: "Beta's remote posting describing the role.",
    location: "Remote",
    comp_high: 220000,
    workplace: "remote",
    status: null,
  },
  {
    key: "b3",
    company: "Beta",
    platform: "lever",
    body: "Beta's second onsite posting, different text.",
    location: "Austin",
    comp_high: 150000,
    workplace: "onsite",
    status: "applied",
  },
];

// a1 in (agrees), a2 out (lost), a3 out (agrees), b1 out (agrees),
// b2 out (lost), b3 in (agrees, and is the wrongly-admitted onsite row),
// c1 in (kept, the acted-on row outside the labelled set).
const VERDICTS: Readonly<Record<string, "in" | "out">> = {
  a1: "in",
  a2: "out",
  a3: "out",
  b1: "out",
  b2: "out",
  b3: "in",
  c1: "in",
};

const stubJudge: Judge = (row) => ({
  criterion: "remote",
  verdict: VERDICTS[row.key],
  detail: `stub verdict for ${row.key}`,
});

// c1 carries a status but sits outside the labelled set entirely
// (workplace hidden even from the label, greenhouse platform), so it must
// count in actedOn and nowhere else.
const ACTED_ON_ROWS: readonly RemoteRow[] = [
  ROWS[5]!, // b3: the one labelled row with a status.
  {
    key: "c1",
    company: "Greenhouse Co",
    platform: "greenhouse",
    body: "A greenhouse posting outside the labelled set.",
    location: "Denver",
    comp_high: 160000,
    workplace: null,
    status: "interviewing",
  },
];

test("scoreRemote's full view scores every row against its label", () => {
  const { full } = scoreRemote(ROWS, stubJudge, ACTED_ON_ROWS);
  assert.equal(full.rows, 6);
  // remote-labelled: a1, a2, b2 — a2 and b2 lost.
  assert.deepEqual(full.remoteLost, { count: 2, pct: 66.7 });
  // onsite-labelled: a3, b1, b3 — b3 wrongly admitted.
  assert.deepEqual(full.onsiteAdmitted, { count: 1, pct: 33.3 });
  // agreements: a1, a3, b1 = 3 of 6.
  assert.deepEqual(full.accuracy, { count: 3, pct: 50.0 });
});

test("scoreRemote's capped view drops a3 as a3's body duplicates a2's", () => {
  const { capped } = scoreRemote(ROWS, stubJudge, ACTED_ON_ROWS);
  // a3 dropped by dedup (a2's key sorts first), so 5 rows remain.
  assert.equal(capped.rows, 5);
  // remote-labelled unaffected: a1, a2, b2 — same as full.
  assert.deepEqual(capped.remoteLost, { count: 2, pct: 66.7 });
  // onsite-labelled loses a3: only b1, b3 remain, b3 wrongly admitted.
  assert.deepEqual(capped.onsiteAdmitted, { count: 1, pct: 50.0 });
  // agreements: a1, b1 = 2 of 5.
  assert.deepEqual(capped.accuracy, { count: 2, pct: 40.0 });
});

test("scoreRemote's byPlatform view scores ashby and lever separately", () => {
  const { byPlatform } = scoreRemote(ROWS, stubJudge, ACTED_ON_ROWS);
  assert.deepEqual(byPlatform["ashby"], {
    rows: 3,
    remoteLost: { count: 1, pct: 50.0 }, // a2 lost of a1, a2
    onsiteAdmitted: { count: 0, pct: 0 }, // a3 correctly refused
    accuracy: { count: 2, pct: 66.7 }, // a1, a3 agree
  });
  assert.deepEqual(byPlatform["lever"], {
    rows: 3,
    remoteLost: { count: 1, pct: 100.0 }, // b2 lost, the only remote-labelled row
    onsiteAdmitted: { count: 1, pct: 50.0 }, // b3 wrongly admitted of b1, b3
    accuracy: { count: 1, pct: 33.3 }, // only b1 agrees
  });
});

test("scoreRemote's actedOn view counts every status-carrying row from the separate read, not the labelled set", () => {
  const { actedOn } = scoreRemote(ROWS, stubJudge, ACTED_ON_ROWS);
  // c1 sits outside the labelled set, which the views above never see.
  assert.deepEqual(actedOn, { rows: 2, kept: 2 });
});

test("scoreRemote hides workplace from the judge it calls, for both reads", () => {
  const seenWorkplaces: (string | null)[] = [];
  const recordingJudge: Judge = (row) => {
    seenWorkplaces.push(row.workplace);
    return { criterion: "remote", verdict: VERDICTS[row.key], detail: "" };
  };
  scoreRemote(ROWS, recordingJudge, ACTED_ON_ROWS);
  assert.ok(seenWorkplaces.every((workplace) => workplace === null));
});

test("capRows keeps the first-seen body and drops rows over the per-company cap", () => {
  // perCompany: 2, so both the dedup (a3) and the cap (b3) fire in one
  // call; the real cap (20) never fires on six rows.
  const result = capRows(ROWS, 2);
  assert.deepEqual(
    result.map((row) => row.key),
    ["a1", "a2", "b1", "b2"],
  );
});

test("capRows with no cap override applies the default per-company cap", () => {
  // With a cap of 20, only the body duplicate (a3) is dropped.
  const result = capRows(ROWS);
  assert.deepEqual(
    result.map((row) => row.key),
    ["a1", "a2", "b1", "b2", "b3"],
  );
});
