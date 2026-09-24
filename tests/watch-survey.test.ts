import assert from "node:assert/strict";
import { test } from "node:test";

import { answering, surveyRows, watchSurvey } from "../scripts/watch-survey.ts";
import type { Reader } from "../src/ats/ats.ts";
import { HttpError } from "../src/net/http.ts";
import type { Company, Platform } from "../src/schema.ts";
import { memoryStore } from "../src/store/memory.ts";

// Records how many times `list` ran, so a test can assert once-per-row.
function fakeReader(
  platform: Platform,
  behavior: () => Promise<never[]>,
): { reader: Reader; calls: () => number } {
  let count = 0;
  const reader: Reader = {
    platform,
    list: async () => {
      count += 1;
      return behavior();
    },
  };
  return { reader, calls: () => count };
}

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

const HEADER =
  "name\tsource\tdomain\tdomain_check\tcareers_url\tfinal_host\tbucket\tats\tslug\tslug_guessed\ttenant_url\tall_ats\terror";

function row(fields: {
  name: string;
  bucket: string;
  ats: string;
  slug?: string;
  tenantUrl?: string;
}): string {
  return [
    fields.name,
    "builtin",
    "",
    "",
    "",
    "",
    fields.bucket,
    fields.ats,
    fields.slug ?? "",
    "",
    fields.tenantUrl ?? "",
    "",
    "",
  ].join("\t");
}

test("surveyRows: maps bucket-a rows and bucket-b rows on newly read platforms, and drops unlisted ats", () => {
  const tsv = [
    HEADER,
    row({ name: "Greenline", bucket: "a", ats: "greenhouse", slug: "greenline" }),
    row({ name: "Ashbrook", bucket: "a", ats: "ashby", slug: "ashbrook" }),
    row({ name: "Leverage", bucket: "a", ats: "lever", slug: "leverage" }),
    row({ name: "Smartco", bucket: "a", ats: "smartrecruiters", slug: "Smartco" }),
    row({ name: "Widget Co", bucket: "a", ats: "workday", slug: "acme/wd5/Careers" }),
    row({
      name: "Foldco",
      bucket: "a",
      ats: "eightfold",
      tenantUrl: "acme.eightfold.ai/careers",
    }),
    row({ name: "Beacondex", bucket: "b", ats: "workable", slug: "beacondex" }),
    row({ name: "Helionet", bucket: "b", ats: "rippling", slug: "helionet-careers" }),
    // Taleo stays cut, so it is still an ats value PLATFORMS never admits,
    // unlike icims, which became a real reader.
    row({ name: "NotOnPlatform", bucket: "b", ats: "taleo", slug: "notonplatform" }),
  ].join("\n");

  const { rows, malformed } = surveyRows(tsv);

  assert.deepEqual(rows, [
    { name: "Greenline", board: { platform: "greenhouse", id: "greenline" } },
    { name: "Ashbrook", board: { platform: "ashby", id: "ashbrook" } },
    { name: "Leverage", board: { platform: "lever", id: "leverage" } },
    { name: "Smartco", board: { platform: "smartrecruiters", id: "Smartco" } },
    { name: "Widget Co", board: { platform: "workday", id: "wd5/Careers/acme" } },
    { name: "Foldco", board: { platform: "eightfold", id: "acme.eightfold.ai" } },
    { name: "Beacondex", board: { platform: "workable", id: "beacondex" } },
    { name: "Helionet", board: { platform: "rippling", id: "helionet-careers" } },
  ]);
  assert.deepEqual(malformed, []);
});

test("surveyRows: a bucket-a row whose board cannot be formed is reported malformed, not returned", () => {
  const tsv = [
    HEADER,
    row({ name: "Two Parts", bucket: "a", ats: "workday", slug: "acme/wd5" }),
    row({ name: "No Slug", bucket: "a", ats: "lever" }),
    row({ name: "Fine", bucket: "a", ats: "lever", slug: "fine" }),
  ].join("\n");

  const { rows, malformed } = surveyRows(tsv);

  assert.deepEqual(rows, [{ name: "Fine", board: { platform: "lever", id: "fine" } }]);
  assert.deepEqual(malformed, ["Two Parts: workday acme/wd5", "No Slug: lever"]);
});

// Personio is not probed at all (a guess at a nonexistent subdomain answers
// 429, not 404), so the survey is the only way one of its boards arrives.
// Its id is the full listing host, `.de` or `.com`, which the slug column
// carries as written and personio.ts fetches as `https://${id}/xml`.
test("surveyRows: a personio row carries its full listing host as the board id", () => {
  const tsv = [
    HEADER,
    row({
      name: "Alpine Ski House",
      bucket: "a",
      ats: "personio",
      slug: "alpineskihouse.jobs.personio.de",
    }),
  ].join("\n");

  const { rows, malformed } = surveyRows(tsv);

  assert.deepEqual(rows, [
    {
      name: "Alpine Ski House",
      board: { platform: "personio", id: "alpineskihouse.jobs.personio.de" },
    },
  ]);
  assert.deepEqual(malformed, []);
});

// BambooHR is not probed at all (nothing on its listing or its
// client-rendered careers page states a company name, so a slug that answers
// cannot be tied to the company that was asked for), so the survey is the
// only way one of its boards arrives. Its id is the plain subdomain slug a
// person confirmed by eye, which bamboohr.ts fetches as
// `https://${id}.bamboohr.com/careers/list`.
test("surveyRows: a bamboohr row carries its subdomain slug as the board id", () => {
  const tsv = [
    HEADER,
    row({ name: "Best For You Organics", bucket: "a", ats: "bamboohr", slug: "bestforyou" }),
  ].join("\n");

  const { rows, malformed } = surveyRows(tsv);

  assert.deepEqual(rows, [
    { name: "Best For You Organics", board: { platform: "bamboohr", id: "bestforyou" } },
  ]);
  assert.deepEqual(malformed, []);
});

test("surveyRows: an icims row forms its board from tenant_url's jibeapply.com host, not slug", () => {
  const tsv = [
    HEADER,
    row({
      name: "First Up Consultants",
      bucket: "a",
      ats: "icims",
      slug: "firstup",
      tenantUrl: "firstup.jibeapply.com",
    }),
  ].join("\n");

  const { rows, malformed } = surveyRows(tsv);

  assert.deepEqual(rows, [
    { name: "First Up Consultants", board: { platform: "icims", id: "firstup" } },
  ]);
  assert.deepEqual(malformed, []);
});

test("surveyRows: an icims row whose tenant_url has no jibeapply.com suffix is malformed", () => {
  const tsv = [
    HEADER,
    row({ name: "Bad Host", bucket: "a", ats: "icims", tenantUrl: "firstup.example.com" }),
    row({ name: "No Tenant", bucket: "a", ats: "icims" }),
  ].join("\n");

  const { rows, malformed } = surveyRows(tsv);

  assert.deepEqual(rows, []);
  assert.deepEqual(malformed, ["Bad Host: icims firstup.example.com", "No Tenant: icims"]);
});

test("watchSurvey: a discovered company gains the survey board and becomes watched", async () => {
  const store = memoryStore({ companies: [company("Acme")] });
  const rows = [{ name: "Acme", board: { platform: "greenhouse" as const, id: "acme" } }];

  const summary = await watchSurvey(store, rows);

  assert.deepEqual(summary, { watched: 1, aliases: 0, unchanged: 0, errors: [] });
  const [acme] = await store.select<Company>("companies", { name: "Acme" });
  assert.equal(acme?.state, "watched");
  assert.deepEqual(acme?.boards, [{ platform: "greenhouse", id: "acme" }]);
});

test("watchSurvey: a board a watched company already carries makes the row's name its alias", async () => {
  const store = memoryStore({
    companies: [
      company("Tessera", {
        state: "watched",
        boards: [{ platform: "greenhouse", id: "pocketly" }],
      }),
    ],
  });
  const rows = [{ name: "Pocketly", board: { platform: "greenhouse" as const, id: "pocketly" } }];

  const summary = await watchSurvey(store, rows);

  assert.deepEqual(summary, { watched: 0, aliases: 1, unchanged: 0, errors: [] });
  const [pocketly] = await store.select<Company>("companies", { name: "Pocketly" });
  assert.equal(pocketly?.state, "alias");
  assert.equal(pocketly?.alias_of, "Tessera");
  assert.equal(pocketly?.reason, null);
  assert.deepEqual(pocketly?.boards, [{ platform: "greenhouse", id: "pocketly" }]);
});

test("watchSurvey: two rows sharing a board are one watched company and one alias", async () => {
  const store = memoryStore();
  const board = { platform: "lever" as const, id: "acme" };
  const rows = [
    { name: "Acme Inc", board },
    { name: "Acme", board },
  ];

  const summary = await watchSurvey(store, rows);

  assert.deepEqual(summary, { watched: 1, aliases: 1, unchanged: 0, errors: [] });
  const [first] = await store.select<Company>("companies", { name: "Acme Inc" });
  assert.equal(first?.state, "watched");
  const [second] = await store.select<Company>("companies", { name: "Acme" });
  assert.equal(second?.state, "alias");
  assert.equal(second?.alias_of, "Acme Inc");
  assert.equal(second?.reason, null);
});

test("watchSurvey: running the same rows twice writes nothing the second time", async () => {
  const store = memoryStore();
  const board = { platform: "lever" as const, id: "acme" };
  const rows = [
    { name: "Acme Inc", board },
    { name: "Acme", board },
  ];

  await watchSurvey(store, rows);
  const before = await store.select<Company>("companies");

  const second = await watchSurvey(store, rows);

  assert.deepEqual(second, { watched: 0, aliases: 0, unchanged: 2, errors: [] });
  const after = await store.select<Company>("companies");
  assert.deepEqual(after, before);
});

test("watchSurvey: an alias with a survey row naming another board stays an alias, untouched", async () => {
  const dropped = company("Gone", {
    state: "alias",
    alias_of: "Gone Inc",
    boards: [{ platform: "lever", id: "old" }],
  });
  const store = memoryStore({ companies: [dropped] });
  const rows = [{ name: "Gone", board: { platform: "greenhouse" as const, id: "gone" } }];

  const summary = await watchSurvey(store, rows);

  assert.deepEqual(summary, { watched: 0, aliases: 0, unchanged: 1, errors: [] });
  const [after] = await store.select<Company>("companies", { name: "Gone" });
  assert.deepEqual(after, dropped);
});

test("watchSurvey: aliasing a company already on file keeps its source and first_seen", async () => {
  const store = memoryStore({
    companies: [
      company("Tessera", {
        state: "watched",
        boards: [{ platform: "greenhouse", id: "pocketly" }],
      }),
      company("Pocketly", { source: "builtin", first_seen: "2026-09-01T00:00:00Z" }),
    ],
  });
  const rows = [{ name: "Pocketly", board: { platform: "greenhouse" as const, id: "pocketly" } }];

  const summary = await watchSurvey(store, rows);

  assert.deepEqual(summary, { watched: 0, aliases: 1, unchanged: 0, errors: [] });
  const [pocketly] = await store.select<Company>("companies", { name: "Pocketly" });
  assert.equal(pocketly?.state, "alias");
  assert.equal(pocketly?.alias_of, "Tessera");
  assert.equal(pocketly?.reason, null);
  assert.equal(pocketly?.source, "builtin");
  assert.equal(pocketly?.first_seen, "2026-09-01T00:00:00Z");
});

test("watchSurvey: a discovered company that already carries the survey board is still written watched", async () => {
  const board = { platform: "greenhouse" as const, id: "pocketly" };
  const store = memoryStore({
    companies: [company("Pocketly", { state: "discovered", boards: [board] })],
  });
  const rows = [{ name: "Pocketly", board }];

  const summary = await watchSurvey(store, rows);

  assert.deepEqual(summary, { watched: 1, aliases: 0, unchanged: 0, errors: [] });
  const [pocketly] = await store.select<Company>("companies", { name: "Pocketly" });
  assert.equal(pocketly?.state, "watched");
});

test("watchSurvey: a discovered company assigned a board another company owns is written as the alias", async () => {
  const board = { platform: "greenhouse" as const, id: "pocketly" };
  const store = memoryStore({
    companies: [
      company("Tessera", { state: "watched", boards: [board] }),
      company("Pocketly", { state: "discovered", reason: null }),
    ],
  });
  const rows = [{ name: "Pocketly", board }];

  const summary = await watchSurvey(store, rows);

  assert.deepEqual(summary, { watched: 0, aliases: 1, unchanged: 0, errors: [] });
  const [pocketly] = await store.select<Company>("companies", { name: "Pocketly" });
  assert.equal(pocketly?.state, "alias");
  assert.equal(pocketly?.alias_of, "Tessera");
  assert.equal(pocketly?.reason, null);
});

test("watchSurvey: an alias row that already names its owner is unchanged", async () => {
  const board = { platform: "lever" as const, id: "acme" };
  const store = memoryStore({
    companies: [
      company("Acme", { state: "watched", boards: [board] }),
      company("Acme Inc", { state: "alias", alias_of: "Acme", boards: [board] }),
    ],
  });
  const rows = [{ name: "Acme Inc", board }];

  const summary = await watchSurvey(store, rows);

  assert.deepEqual(summary, { watched: 0, aliases: 0, unchanged: 1, errors: [] });
});

test("watchSurvey: a James-dropped company already carrying the survey board stays dropped and unchanged", async () => {
  const board = { platform: "greenhouse" as const, id: "gone" };
  const dropped = company("Gone", {
    state: "watched",
    dropped_at: "2026-09-01T00:00:00Z",
    reason: "no engineering roles",
    boards: [board],
  });
  const store = memoryStore({ companies: [dropped] });
  const rows = [{ name: "Gone", board }];

  const summary = await watchSurvey(store, rows);

  assert.deepEqual(summary, { watched: 0, aliases: 0, unchanged: 1, errors: [] });
  const [after] = await store.select<Company>("companies", { name: "Gone" });
  assert.deepEqual(after, dropped);
});

test("watchSurvey: an alias whose owner James dropped is unchanged, not rewritten", async () => {
  const board = { platform: "lever" as const, id: "acme" };
  const droppedOwner = company("Acme", {
    state: "watched",
    dropped_at: "2026-09-01T00:00:00Z",
    reason: "no engineering roles",
  });
  const droppedAlias = company("Acme Inc", { state: "alias", alias_of: "Acme", boards: [board] });
  const store = memoryStore({ companies: [droppedOwner, droppedAlias] });
  const rows = [{ name: "Acme Inc", board }];

  const summary = await watchSurvey(store, rows);

  assert.deepEqual(summary, { watched: 0, aliases: 0, unchanged: 1, errors: [] });
  const [owner] = await store.select<Company>("companies", { name: "Acme" });
  const [alias] = await store.select<Company>("companies", { name: "Acme Inc" });
  assert.deepEqual(owner, droppedOwner);
  assert.deepEqual(alias, droppedAlias);
});

test("watchSurvey: an alias names the company that carries the board, never an earlier alias", async () => {
  const board = { platform: "lever" as const, id: "acme" };
  const store = memoryStore({
    companies: [
      company("Acme", { state: "watched", boards: [board] }),
      company("Acme Inc", { state: "alias", alias_of: "Acme", boards: [board] }),
    ],
  });
  const rows = [{ name: "Acme Corp", board }];

  const summary = await watchSurvey(store, rows);

  assert.deepEqual(summary, { watched: 0, aliases: 1, unchanged: 0, errors: [] });
  const [corp] = await store.select<Company>("companies", { name: "Acme Corp" });
  assert.equal(corp?.state, "alias");
  assert.equal(corp?.alias_of, "Acme");
  assert.equal(corp?.reason, null);
});

test("watchSurvey: a watched row whose board another company also carries becomes that company's alias", async () => {
  const board = { platform: "greenhouse" as const, id: "fission-labs" };
  const store = memoryStore({
    companies: [
      company("Fission Labs", { state: "watched", boards: [board] }),
      company("Fission Labs Inc", { state: "watched", boards: [board] }),
    ],
  });
  const rows = [{ name: "Fission Labs Inc", board }];

  const summary = await watchSurvey(store, rows);

  assert.deepEqual(summary, { watched: 0, aliases: 1, unchanged: 0, errors: [] });
  const [inc] = await store.select<Company>("companies", { name: "Fission Labs Inc" });
  assert.equal(inc?.state, "alias");
  assert.equal(inc?.alias_of, "Fission Labs");
  assert.equal(inc?.reason, null);
  const [fissionLabs] = await store.select<Company>("companies", { name: "Fission Labs" });
  assert.equal(fissionLabs?.state, "watched");
});

test("watchSurvey: a board only an alias carries has no owner, so a new name with it is watched, not aliased", async () => {
  const board = { platform: "lever" as const, id: "acme" };
  const store = memoryStore({
    companies: [company("Acme Inc", { state: "alias", alias_of: "Acme", boards: [board] })],
  });
  const rows = [{ name: "Acme Corp", board }];

  const summary = await watchSurvey(store, rows);

  assert.deepEqual(summary, { watched: 1, aliases: 0, unchanged: 0, errors: [] });
  const [corp] = await store.select<Company>("companies", { name: "Acme Corp" });
  assert.equal(corp?.state, "watched");
  assert.equal(corp?.alias_of, null);
  assert.deepEqual(corp?.boards, [board]);
});

test("answering: a row whose board answers is kept, one that is gone is reported gone, one that errors is reported unreachable", async () => {
  const greenhouse = fakeReader("greenhouse", async () => []);
  const lever = fakeReader("lever", async () => {
    throw new HttpError(404, "HTTP 404");
  });
  const ashby = fakeReader("ashby", async () => {
    throw new HttpError(500, "HTTP 500");
  });
  const rows = [
    { name: "Greenline", board: { platform: "greenhouse" as const, id: "greenline" } },
    { name: "Leverage", board: { platform: "lever" as const, id: "leverage" } },
    { name: "Ashbrook", board: { platform: "ashby" as const, id: "ashbrook" } },
  ];

  const result = await answering(rows, {
    greenhouse: greenhouse.reader,
    lever: lever.reader,
    ashby: ashby.reader,
  });

  assert.deepEqual(result.rows, [rows[0]]);
  assert.deepEqual(result.gone, ["Leverage lever::leverage: HTTP 404"]);
  assert.deepEqual(result.unreachable, ["Ashbrook ashby::ashbrook: HTTP 500"]);
  assert.equal(greenhouse.calls(), 1);
  assert.equal(lever.calls(), 1);
  assert.equal(ashby.calls(), 1);
});

test("answering: a row on a platform with no reader is unreachable, not checked", async () => {
  const rows = [
    { name: "Foldco", board: { platform: "eightfold" as const, id: "acme.eightfold.ai" } },
  ];

  const result = await answering(rows, {});

  assert.deepEqual(result.rows, []);
  assert.deepEqual(result.gone, []);
  assert.deepEqual(result.unreachable, ["Foldco eightfold::acme.eightfold.ai: no reader"]);
});
