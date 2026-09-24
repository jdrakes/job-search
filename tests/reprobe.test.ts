import assert from "node:assert/strict";
import { test } from "node:test";

import {
  backlog,
  parsePlatforms,
  platformsKey,
  priorRuns,
  reprobe,
  resumeFrom,
} from "../scripts/reprobe.ts";
import type { Company, ReprobeRun } from "../src/schema.ts";
import { memoryStore } from "../src/store/memory.ts";

// The client requires a configured User-Agent; these tests fake the network
// entirely, so any value satisfies it.
const TEST_USER_AGENT = "test-bot (+https://example.com)";

function company(name: string, overrides: Partial<Company> = {}): Company {
  return {
    name,
    state: "discovered",
    boards: [],
    source: "test",
    reason: null,
    first_seen: "2026-09-15T00:00:00Z",
    last_seen: "2026-09-15T00:00:00Z",
    dropped_at: null,
    alias_of: null,
    ...overrides,
  };
}

// Anything not listed answers 404, as a slug that does not exist does.
function fakeFetch(routes: Record<string, unknown>): typeof fetch {
  const impl: typeof fetch = async (input) => {
    const body = routes[String(input)];
    if (body === undefined) return new Response(null, { status: 404 });
    return typeof body === "string"
      ? new Response(body, { status: 200 })
      : new Response(JSON.stringify(body), { status: 200 });
  };
  return impl;
}

const noSleep = async () => {};

test("parsePlatforms: a comma-separated list of slug-probeable platforms is accepted", () => {
  assert.deepEqual(parsePlatforms("rippling,breezy"), {
    ok: true,
    platforms: ["rippling", "breezy"],
  });
});

test("parsePlatforms: no argument is refused, naming the usage", () => {
  const parsed = parsePlatforms(undefined);

  assert.equal(parsed.ok, false);
  assert.match(parsed.ok ? "" : parsed.message, /no platform named/);
  assert.match(parsed.ok ? "" : parsed.message, /npm run reprobe -- <platform>/);
});

test("parsePlatforms: a name that is not a platform at all is refused, naming it", () => {
  const parsed = parsePlatforms("taleo");

  assert.equal(parsed.ok, false);
  assert.match(parsed.ok ? "" : parsed.message, /"taleo" is not a platform/);
});

// Workday's board id is `wd/site/tenant`, which no rule derives from a
// name; naming it must refuse rather than probe nothing and report a clean
// pass.
test("parsePlatforms: a platform the probe cannot try is refused, naming the survey", () => {
  const parsed = parsePlatforms("workday");

  assert.equal(parsed.ok, false);
  assert.match(parsed.ok ? "" : parsed.message, /"workday" cannot be probed/);
  assert.match(parsed.ok ? "" : parsed.message, /survey/);
});

test("parsePlatforms: one bad name in a list refuses the whole list", () => {
  const parsed = parsePlatforms("rippling,personio");

  assert.equal(parsed.ok, false);
  assert.match(parsed.ok ? "" : parsed.message, /"personio" cannot be probed/);
});

test("backlog: a boardless discovered company is selected and a dropped one is not", async () => {
  const store = memoryStore({
    companies: [
      company("Boardless"),
      company("Dropped", { dropped_at: "2026-09-01T00:00:00Z", reason: "no engineering roles" }),
      company("Watched", { state: "watched", boards: [{ platform: "lever", id: "watched" }] }),
      company("Alias", { state: "alias", alias_of: "Watched" }),
    ],
  });

  assert.deepEqual(await backlog(store), ["Boardless"]);
});

test("reprobe: a discovered name whose board answers gains it and becomes watched", async () => {
  const store = memoryStore({ companies: [company("Acme")] });
  const fetchImpl = fakeFetch({
    "https://api.rippling.com/platform/api/ats/v1/board/acme/jobs": [{ uuid: "x" }],
  });

  const summary = await reprobe(store, ["Acme"], ["rippling"], {
    fetchImpl,
    userAgent: TEST_USER_AGENT,
    sleep: noSleep,
  });

  assert.deepEqual(summary, { probed: 1, watched: 1, aliases: 0, errors: [], refusedAt: null });
  const [acme] = await store.select<Company>("companies", { name: "Acme" });
  assert.equal(acme?.state, "watched");
  assert.deepEqual(acme?.boards, [{ platform: "rippling", id: "acme" }]);
});

test("reprobe: only the named platforms are asked, whatever else would answer", async () => {
  const requested: string[] = [];
  const answers = fakeFetch({
    "https://api.rippling.com/platform/api/ats/v1/board/acme/jobs": [{ uuid: "x" }],
    "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true": {
      jobs: [{ id: "1", company_name: "Acme" }],
    },
  });
  const fetchImpl: typeof fetch = async (input, init) => {
    requested.push(String(input));
    return answers(input, init);
  };

  await reprobe(memoryStore({ companies: [company("Acme")] }), ["Acme"], ["rippling"], {
    fetchImpl,
    userAgent: TEST_USER_AGENT,
    sleep: noSleep,
  });

  assert.deepEqual(requested, ["https://api.rippling.com/platform/api/ats/v1/board/acme/jobs"]);
});

test("reprobe: a board another company already carries makes the probed name its alias", async () => {
  const store = memoryStore({
    companies: [
      company("Tessera", { state: "watched", boards: [{ platform: "rippling", id: "pocketly" }] }),
      company("Pocketly"),
    ],
  });
  const fetchImpl = fakeFetch({
    "https://api.rippling.com/platform/api/ats/v1/board/pocketly/jobs": [{ uuid: "x" }],
  });

  const summary = await reprobe(store, ["Pocketly"], ["rippling"], {
    fetchImpl,
    userAgent: TEST_USER_AGENT,
    sleep: noSleep,
  });

  assert.deepEqual(summary, { probed: 1, watched: 0, aliases: 1, errors: [], refusedAt: null });
  const [cashApp] = await store.select<Company>("companies", { name: "Pocketly" });
  assert.equal(cashApp?.state, "alias");
  assert.equal(cashApp?.alias_of, "Tessera");
});

// The name is already on file here, unlike in discover.ts, so a board the
// row itself carries names no owner but itself: taken as an owner it would
// record the company as its own alias.
test("reprobe: a board the probed name already carries itself is not read as an alias", async () => {
  const board = { platform: "rippling" as const, id: "acme" };
  const store = memoryStore({ companies: [company("Acme", { boards: [board] })] });
  const fetchImpl = fakeFetch({
    "https://api.rippling.com/platform/api/ats/v1/board/acme/jobs": [{ uuid: "x" }],
  });

  const summary = await reprobe(store, ["Acme"], ["rippling"], {
    fetchImpl,
    userAgent: TEST_USER_AGENT,
    sleep: noSleep,
  });

  assert.deepEqual(summary, { probed: 1, watched: 1, aliases: 0, errors: [], refusedAt: null });
  const [acme] = await store.select<Company>("companies", { name: "Acme" });
  assert.equal(acme?.state, "watched");
  assert.equal(acme?.alias_of, null);
});

test("reprobe: a name with no board anywhere stays discovered and is counted probed", async () => {
  const store = memoryStore({ companies: [company("Nobody")] });

  const summary = await reprobe(store, ["Nobody"], ["rippling"], {
    fetchImpl: fakeFetch({}),
    sleep: noSleep,
  });

  assert.deepEqual(summary, { probed: 1, watched: 0, aliases: 0, errors: [], refusedAt: null });
  const [nobody] = await store.select<Company>("companies", { name: "Nobody" });
  assert.equal(nobody?.state, "discovered");
  assert.deepEqual(nobody?.boards, []);
});

// The defect this replaces: `probe` read a 429 as "no board", so a pass run
// while a vendor was rate-limiting reported every name it walked as a clean
// miss. The completed 2026-09-22 backlog pass did exactly that against
// Workable and reports 0 boards over 3,189 names with `errors: 0`.
test("reprobe: a vendor's 429 stops the pass and names where it stopped", async () => {
  const store = memoryStore();
  await store.upsert("companies", [company("Acme"), company("Beta"), company("Gamma")]);

  let requests = 0;
  const fetchImpl: typeof fetch = async () => {
    requests += 1;
    return new Response(null, { status: 429 });
  };

  const summary = await reprobe(store, ["Acme", "Beta", "Gamma"], ["rippling"], {
    fetchImpl,
    userAgent: TEST_USER_AGENT,
    sleep: noSleep,
  });

  // Stopped on the first name, so the other two were never asked.
  assert.equal(summary.refusedAt, "Acme");
  assert.equal(summary.probed, 1);
  assert.equal(summary.watched, 0);
  assert.equal(requests, 1);

  // And nothing was written that would read as "these have no board".
  const [beta] = await store.select<Company>("companies", { name: "Beta" });
  assert.equal(beta?.state, "discovered");
  assert.deepEqual(beta?.boards, []);
});

test("reprobe: a 404 is still a clean miss, so the pass carries on through it", async () => {
  const store = memoryStore();
  await store.upsert("companies", [company("Acme"), company("Beta")]);

  const fetchImpl = fakeFetch({});

  const summary = await reprobe(store, ["Acme", "Beta"], ["rippling"], {
    fetchImpl,
    userAgent: TEST_USER_AGENT,
    sleep: noSleep,
  });

  assert.equal(summary.refusedAt, null);
  assert.equal(summary.probed, 2);
});

// A pass costs thousands of vendor requests and hours, so "has this been
// asked already" has to be answerable from the store. On 2026-09-23 it was
// not: a pass re-probed six platforms the backlog had been cleared against
// the day before, ~14,000 requests, the prior pass's only trace a terminal
// log in a session that had ended.

test("platformsKey: the same platforms in a different order are the same pass", () => {
  assert.equal(platformsKey(["rippling", "breezy"]), platformsKey(["breezy", "rippling"]));
});

test("platformsKey: a different set of platforms is a different pass", () => {
  assert.notEqual(platformsKey(["rippling", "breezy"]), platformsKey(["rippling"]));
});

function run(overrides: Partial<ReprobeRun> = {}): ReprobeRun {
  return {
    started: "2026-09-23T12:00:00.000Z",
    platforms: "workable",
    names: 3132,
    probed: 40,
    watched: 0,
    aliases: 0,
    errors: 0,
    refused_at: null,
    finished: "2026-09-23T12:02:00.000Z",
    ...overrides,
  };
}

test("resumeFrom: a refused pass resumes at the name it stopped on", () => {
  assert.equal(
    resumeFrom([run({ refused_at: "Access | Information Management" })]),
    "Access | Information Management",
  );
});

test("resumeFrom: a pass that finished starts the next one from the top", () => {
  assert.equal(resumeFrom([run()]), null);
});

test("resumeFrom: no prior pass starts from the top", () => {
  assert.equal(resumeFrom([]), null);
});

// The latest pass wins: a refusal that was later cleared by a full sweep
// must not drag the next pass back to the old stopping point.
test("resumeFrom: a later finished pass overrides an earlier refusal", () => {
  const runs = [
    run({ started: "2026-09-23T12:00:00.000Z", refused_at: "Access | Information Management" }),
    run({ started: "2026-09-24T09:00:00.000Z", refused_at: null }),
  ];
  assert.equal(resumeFrom(runs), null);
});

test("priorRuns: only the passes naming exactly these platforms come back", async () => {
  const store = memoryStore();
  await store.upsert("reprobe_runs", [
    run({ started: "2026-09-23T12:00:00.000Z", platforms: "workable" }),
    run({ started: "2026-09-23T13:00:00.000Z", platforms: "breezy,rippling" }),
  ]);

  const workable = await priorRuns(store, ["workable"]);
  assert.deepEqual(
    workable.map((each) => each.started),
    ["2026-09-23T12:00:00.000Z"],
  );

  // Named in the other order, and still the same pass.
  const both = await priorRuns(store, ["rippling", "breezy"]);
  assert.deepEqual(
    both.map((each) => each.started),
    ["2026-09-23T13:00:00.000Z"],
  );
});

test("priorRuns: passes come back oldest first, so the latest is last", async () => {
  const store = memoryStore();
  await store.upsert("reprobe_runs", [
    run({ started: "2026-09-24T09:00:00.000Z", refused_at: null }),
    run({ started: "2026-09-23T12:00:00.000Z", refused_at: "Acme" }),
  ]);

  const runs = await priorRuns(store, ["workable"]);
  assert.deepEqual(
    runs.map((each) => each.started),
    ["2026-09-23T12:00:00.000Z", "2026-09-24T09:00:00.000Z"],
  );
  assert.equal(resumeFrom(runs), null);
});

// A killed pass leaves finished null, which is what stops it reading as a
// sweep. This is the distinction whose absence cost 2026-09-23 its morning.
test("resumeFrom: a killed pass still resumes from where it was refused", () => {
  assert.equal(resumeFrom([run({ refused_at: "Acme", finished: null })]), "Acme");
});
