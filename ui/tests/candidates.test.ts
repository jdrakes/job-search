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
  typeInto,
  type TreeNode,
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

/** The one row PostgREST hands back for `return=representation`, with the id the store assigned. */
const STORED = candidate({
  id: "7d3f2c1a-0000-4000-8000-000000000002",
  name: null,
  url: "https://acme.example.com/careers",
  evidence: "hiring for the platform team",
  added_at: "2026-09-27T09:00:00+00:00",
});

function postedOk(): Response {
  return { ok: true, status: 201, json: async () => [STORED] } as unknown as Response;
}

function formFields(root: TreeNode): { name: TreeNode; url: TreeNode; why: TreeNode } {
  // The template's order: Name, URL, then Why.
  const [name, url] = allNodes(root).filter((node) => node.tag === "input");
  const why = allNodes(root).find((node) => node.tag === "textarea");
  if (name === undefined || url === undefined || why === undefined) {
    throw new Error("the Add form's three fields are not all on screen");
  }
  return { name, url, why };
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
  const pending = candidate({
    id: "c2",
    name: null,
    url: "https://beta.example.com",
    outcome: null,
  });
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

test("the Add form posts a URL-only add and hands up the row the store returned", async () => {
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
    const fields = formFields(app.root);
    typeInto(fields.url, "https://acme.example.com/careers");
    fill(fields.why, "hiring for the platform team");
    const form = allNodes(app.root).find((node) => node.tag === "form");
    assert.ok(form !== undefined, "the Add form is on screen");
    submitForm(form);
    await settled();

    assert.equal(calls.length, 1, "a URL alone is posted, not refused");
    assert.deepEqual(calls[0]?.body, {
      name: null,
      url: "https://acme.example.com/careers",
      evidence: "hiring for the platform team",
      origin: "james",
    });

    // Breaks if the view goes back to building its own echo: a random id
    // never matches the row a later read brings back, so `AppRoot` could
    // not tell the two apart and showed the add twice. This view's
    // `candidates` prop is unchanged here; laying the row over the round is
    // `AppRoot`'s job, and only the toast says the write landed.
    assert.deepEqual(added, [STORED], "the stored row, id and all, handed up exactly once");
    assert.match(textOf(app.root), /Added\./);
  } finally {
    app.unmount();
    restoreFetch();
    restoreDom();
  }
});

test("a committed Add clears the three fields in place and sends focus to the panel", async () => {
  // Breaks if the form is remounted to clear it (the fields would be new
  // nodes, and focus would go with the old ones), or if focus is sent
  // anywhere but the panel: the Add button was disabled for the write, and
  // a browser drops focus from a disabled button.
  const restoreDom = stubDom();
  const restoreFetch = stubFetch(() => Promise.resolve(postedOk()));
  const app = mountTree(CandidatesView, {
    candidates: [],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
  });
  try {
    const fields = formFields(app.root);
    typeInto(fields.name, "Acme");
    typeInto(fields.url, "acme.example.com/careers");
    fill(fields.why, "hiring for the platform team");
    const form = allNodes(app.root).find((node) => node.tag === "form");
    assert.ok(form !== undefined, "the Add form is on screen");
    submitForm(form);
    await settled();

    const after = formFields(app.root);
    assert.equal(after.name, fields.name, "the Name field is the same node, not a remount");
    assert.equal(after.name.props["value"], "");
    assert.equal(after.url.props["value"], "");
    assert.equal(after.why.value, "", "v-model wrote the cleared Why back into its field");
    const panel = allNodes(app.root).find((node) => node.props["id"] === "panel-candidates");
    assert.ok(panel !== undefined, "the panel is on screen");
    assert.equal(panel.focused, true, "focus lands on the panel");
  } finally {
    app.unmount();
    restoreFetch();
    restoreDom();
  }
});

test("a refused Add keeps what was typed and says the URL is unreadable", async () => {
  const restoreDom = stubDom();
  let calls = 0;
  const restoreFetch = stubFetch(() => {
    calls += 1;
    return Promise.resolve(postedOk());
  });
  const app = mountTree(CandidatesView, {
    candidates: [],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
  });
  try {
    const fields = formFields(app.root);
    typeInto(fields.url, "not a url");
    const form = allNodes(app.root).find((node) => node.tag === "form");
    assert.ok(form !== undefined, "the Add form is on screen");
    submitForm(form);
    await settled();

    assert.equal(calls, 0);
    assert.match(textOf(app.root), /cannot read "not a url" as a URL/);
    assert.equal(formFields(app.root).url.props["value"], "not a url", "nothing he typed is lost");
  } finally {
    app.unmount();
    restoreFetch();
    restoreDom();
  }
});
