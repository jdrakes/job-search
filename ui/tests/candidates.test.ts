import assert from "node:assert/strict";
import { test } from "node:test";
import { createSSRApp } from "vue";
import { renderToString } from "vue/server-renderer";

import { STATUSES, type Candidate } from "../../src/schema.ts";
import { CandidatesView, candidateLabel, outcomeText } from "../src/candidates.ts";
import type { AppConfig } from "../src/config.ts";
import {
  allNodes,
  fill,
  mountTree,
  patchBody,
  settled,
  stubDom,
  stubFetch,
  submitForm,
  textOf,
} from "./render-tree.ts";

function render(component: object, props: Record<string, unknown>): Promise<string> {
  return renderToString(createSSRApp(component, props));
}

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    id: "candidate-1",
    name: "Acme Corp",
    url: null,
    origin: "james",
    evidence: null,
    added_at: "2026-09-20T00:00:00Z",
    outcome: null,
    outcome_at: null,
    company: null,
    ...overrides,
  };
}

const CONFIG: AppConfig = {
  url: "https://project.supabase.co",
  anonKey: "anon-key",
  statuses: [...STATUSES],
};
const ACCESS_TOKEN = "user-jwt";

/** `addCandidate` never reads the response body; only `ok` matters. */
function postedOk(): Response {
  return { ok: true, status: 200, json: async () => [] } as unknown as Response;
}

test("outcomeText words every outcome, alias naming the company it is another name for", () => {
  assert.equal(outcomeText(candidate({ outcome: null })), "waiting for the next run");
  assert.equal(outcomeText(candidate({ outcome: "watched" })), "watched");
  assert.equal(outcomeText(candidate({ outcome: "added" })), "board added");
  assert.equal(outcomeText(candidate({ outcome: "known" })), "already known");
  assert.equal(
    outcomeText(candidate({ outcome: "alias", company: "Acme" })),
    "another name for Acme",
  );
  assert.equal(outcomeText(candidate({ outcome: "no_board" })), "no board found");
  assert.equal(outcomeText(candidate({ outcome: "wrong_company" })), "board names another company");
  assert.equal(outcomeText(candidate({ outcome: "gone" })), "board gone");
  assert.equal(outcomeText(candidate({ outcome: "dropped" })), "dropped");
  assert.equal(outcomeText(candidate({ outcome: "bad_url" })), "URL names no board");
});

test("candidateLabel leads with the name, falling back to the url", () => {
  assert.equal(candidateLabel(candidate({ name: "Acme", url: null })), "Acme");
  assert.equal(
    candidateLabel(candidate({ name: null, url: "https://acme.example.com/careers" })),
    "https://acme.example.com/careers",
  );
});

test("CandidatesView renders every candidate's outcome in words, newest first as handed in", async () => {
  const watched = candidate({ id: "c1", name: "Acme", outcome: "watched", company: "Acme" });
  const pending = candidate({ id: "c2", name: null, url: "https://beta.example.com", outcome: null });
  const alias = candidate({ id: "c3", name: "Beta Inc", outcome: "alias", company: "Beta" });

  const html = await render(CandidatesView, {
    candidates: [watched, pending, alias],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
  });

  assert.match(html, /watched/);
  assert.match(html, /waiting for the next run/);
  assert.match(html, /another name for Beta/);
  assert.match(html, /https:\/\/beta\.example\.com/);
});

test("the Add form refuses an empty submit and sends nothing", async () => {
  const restoreDom = stubDom();
  let calls = 0;
  const restoreFetch = stubFetch(() => {
    calls += 1;
    return Promise.resolve(postedOk());
  });
  const added: Candidate[] = [];
  const app = mountTree(CandidatesView, {
    candidates: [],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    onAdded: (candidate: Candidate) => {
      added.push(candidate);
    },
  });
  try {
    const form = allNodes(app.root).find((node) => node.tag === "form");
    assert.ok(form !== undefined, "the Add form is on screen");
    submitForm(form);
    await settled();

    assert.equal(calls, 0, "an empty submit is refused before any request goes out");
    assert.equal(added.length, 0, "nothing was added");
    assert.match(textOf(app.root), /name or a URL/);
  } finally {
    app.unmount();
    restoreFetch();
    restoreDom();
  }
});

test("the Add form posts a URL-only add and hands the new candidate up", async () => {
  const restoreDom = stubDom();
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const restoreFetch = stubFetch((url, init) => {
    calls.push({ url, body: patchBody(init) });
    return Promise.resolve(postedOk());
  });
  const added: Candidate[] = [];
  const app = mountTree(CandidatesView, {
    candidates: [],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    onAdded: (candidate: Candidate) => {
      added.push(candidate);
    },
  });
  try {
    // The template's order: Name first, URL second.
    const urlField = allNodes(app.root).filter((node) => node.tag === "input")[1];
    assert.ok(urlField !== undefined, "the URL field is on screen");
    fill(urlField, "https://acme.example.com/careers");
    const form = allNodes(app.root).find((node) => node.tag === "form");
    assert.ok(form !== undefined, "the Add form is on screen");
    submitForm(form);
    await settled();

    assert.equal(calls.length, 1, "a URL alone is posted, not refused");
    assert.equal(calls[0]?.url, `${CONFIG.url}/rest/v1/candidates`);
    assert.deepEqual(calls[0]?.body, {
      name: null,
      url: "https://acme.example.com/careers",
      evidence: null,
      origin: "james",
    });

    // The view keeps no copy of its own (the same discipline `companies.ts`
    // documents for a Drop): showing the new row is `AppRoot`'s job, once it
    // lays the emitted candidate over the round the way it lays a drop over
    // companies. This view's `candidates` prop is unchanged here, so nothing
    // new is on screen yet — only the toast says the write landed.
    assert.equal(added.length, 1, "the new candidate was handed up exactly once");
    assert.equal(added[0]?.url, "https://acme.example.com/careers");
    assert.equal(added[0]?.outcome, null, "unresolved until the next run");
    assert.equal(added[0]?.origin, "james");
    assert.match(textOf(app.root), /Added\./);
  } finally {
    app.unmount();
    restoreFetch();
    restoreDom();
  }
});
