import assert from "node:assert/strict";
import { test } from "node:test";
import { createSSRApp } from "vue";
import { renderToString } from "vue/server-renderer";

import type { Contact } from "../../src/schema.ts";
import type { AppConfig } from "../src/config.ts";
import {
  ContactsView,
  dropRefusal,
  duplicateEmails,
  emptyContactsLabel,
  filteredContacts,
  lastContactLabel,
  stateLabelOf,
  type ContactFilters,
} from "../src/contacts.ts";
import {
  allNodes,
  fill,
  mountTree,
  patchBody,
  patchedOne,
  settled,
  stubDom,
  stubFetch,
  submitForm,
  textOf,
  type TreeNode,
} from "./render-tree.ts";

function render(component: object, props: Record<string, unknown>): Promise<string> {
  return renderToString(createSSRApp(component, props));
}

function contact(email: string, overrides: Partial<Contact> = {}): Contact {
  return {
    email,
    name: null,
    company: null,
    company_history: [],
    state: "target",
    signals: [],
    first_contact: "2026-09-01T00:00:00Z",
    last_contact: "2026-09-01T00:00:00Z",
    thread_count: 1,
    threads: [],
    last_subject: null,
    dropped_at: null,
    reason: null,
    note: null,
    contacted_at: null,
    alias_of: null,
    ...overrides,
  };
}

const CONFIG: AppConfig = {
  url: "https://project.supabase.co",
  anonKey: "anon-key",
  statuses: [],
};
const ACCESS_TOKEN = "user-jwt";

/** `@change` is bound directly (not `v-model`), so `fill` cannot reach it; this is its pair. */
function change(target: TreeNode, value: string): void {
  const handler = target.props["onChange"];
  if (typeof handler !== "function") throw new Error(`<${target.tag}> has no @change handler`);
  (handler as (event: object) => void)({ target: { value } });
}

// --- pure functions ---

test("stateLabelOf names each of the three states", () => {
  assert.equal(stateLabelOf("target"), "Target");
  assert.equal(stateLabelOf("active"), "Active");
  assert.equal(stateLabelOf("employer"), "Employer");
});

test("lastContactLabel takes the date off the timestamp, or an em dash when there is none", () => {
  assert.equal(
    lastContactLabel(contact("a@b.com", { last_contact: "2026-09-15T08:30:00Z" })),
    "2026-09-15",
  );
  assert.equal(lastContactLabel(contact("a@b.com", { last_contact: null })), "—");
});

test("filteredContacts narrows by state exactly", () => {
  const target = contact("t@agency.com", { state: "target" });
  const active = contact("a@agency.com", { state: "active" });
  const employer = contact("e@heb.com", { state: "employer" });
  const filters: ContactFilters = { state: "active", query: "" };
  assert.deepEqual(filteredContacts([target, active, employer], filters), [active]);
});

test("filteredContacts with state '' returns every contact, in every state", () => {
  const target = contact("t@agency.com", { state: "target" });
  const active = contact("a@agency.com", { state: "active" });
  const filters: ContactFilters = { state: "", query: "" };
  assert.equal(filteredContacts([target, active], filters).length, 2);
});

test("filteredContacts's query matches name, company or the address itself", () => {
  const byName = contact("juno@arvelo.partners", { name: "Juno Alderwick", company: "Arvelo" });
  const byCompany = contact("sable@finchcrest.io", { name: "Sable Merrow", company: "Finchcrest" });
  const filters: ContactFilters = { state: "", query: "arvelo" };
  assert.deepEqual(filteredContacts([byName, byCompany], filters), [byName]);
});

test("filteredContacts orders by name, falling back to the address when there is none", () => {
  const zed = contact("zed@agency.com", { name: "Zed Okafor" });
  const anon = contact("anon@agency.com", { name: null });
  const beta = contact("beta@agency.com", { name: "Beta Ruiz" });
  const filters: ContactFilters = { state: "", query: "" };
  assert.deepEqual(
    filteredContacts([zed, anon, beta], filters).map((c) => c.email),
    ["anon@agency.com", "beta@agency.com", "zed@agency.com"],
  );
});

test("emptyContactsLabel names the filter that emptied the list", () => {
  assert.equal(emptyContactsLabel({ state: "", query: "" }), "No contacts yet.");
  assert.equal(emptyContactsLabel({ state: "employer", query: "" }), "No employer contacts.");
  assert.equal(emptyContactsLabel({ state: "target", query: "juno" }), "Nothing matches.");
});

test("dropRefusal refuses an empty or whitespace-only reason", () => {
  assert.match(dropRefusal("") ?? "", /judgement, not a fact/);
  assert.match(dropRefusal("   ") ?? "", /judgement, not a fact/);
});

test("dropRefusal allows a real reason", () => {
  assert.equal(dropRefusal("went quiet for a year"), null);
});

test("duplicateEmails flags two rows sharing a name on different domains", () => {
  const atAgency = contact("juno@arvelo.partners", { name: "Juno Alderwick" });
  const atNewAgency = contact("juno.alderwick@brightpath.partners", { name: "Juno Alderwick" });
  const unrelated = contact("sable@finchcrest.io", { name: "Sable Merrow" });
  const flagged = duplicateEmails([atAgency, atNewAgency, unrelated]);
  assert.equal(flagged.has("juno@arvelo.partners"), true);
  assert.equal(flagged.has("juno.alderwick@brightpath.partners"), true);
  assert.equal(flagged.has("sable@finchcrest.io"), false);
});

test("duplicateEmails does not flag two rows sharing a name on the same domain", () => {
  const one = contact("juno@arvelo.partners", { name: "Juno Alderwick" });
  const two = contact("juno.a@arvelo.partners", { name: "Juno Alderwick" });
  assert.deepEqual([...duplicateEmails([one, two])], []);
});

test("duplicateEmails leaves a contact with no name alone", () => {
  const one = contact("juno@arvelo.partners", { name: null });
  const two = contact("juno.a@brightpath.partners", { name: null });
  assert.deepEqual([...duplicateEmails([one, two])], []);
});

// --- ContactsView ---

test("ContactsView filters to target by default, leaving active and employer contacts off the page", async () => {
  const target = contact("t@agency.com", { name: "Target Contact", state: "target" });
  const active = contact("a@agency.com", { name: "Active Contact", state: "active" });
  const employer = contact("e@heb.com", { name: "Employer Contact", state: "employer" });

  const html = await render(ContactsView, {
    contacts: [target, active, employer],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
  });

  assert.match(html, /Target Contact/);
  assert.doesNotMatch(html, /Active Contact/);
  assert.doesNotMatch(html, /Employer Contact/);
});

test("ContactsView marks both rows of a name split across two domains, and marks neither for a unique name", async () => {
  const atAgency = contact("juno@arvelo.partners", { name: "Juno Alderwick", state: "target" });
  const atNewAgency = contact("juno.alderwick@brightpath.partners", {
    name: "Juno Alderwick",
    state: "target",
  });
  const unrelated = contact("sable@finchcrest.io", { name: "Sable Merrow", state: "target" });

  const html = await render(ContactsView, {
    contacts: [atAgency, atNewAgency, unrelated],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
  });

  const hints = (html.match(/class="duplicate-hint"/g) ?? []).length;
  assert.equal(hints, 2, "both of Juno's rows carry the hint");
  assert.match(html, /Sable Merrow/);
  const sableCard = html.slice(
    html.indexOf("Sable Merrow") - 400,
    html.indexOf("Sable Merrow") + 400,
  );
  assert.doesNotMatch(sableCard, /duplicate-hint/, "Sable's card carries no hint");
});

test("state renders as read-only text; no control in a contact's card can write it", async () => {
  const target = contact("t@agency.com", { name: "Target Contact", state: "target" });

  const html = await render(ContactsView, {
    contacts: [target],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
  });

  assert.match(html, /class="state tag">Target</);
  // The one <select> on the page is the state filter, not bound to any row.
  const selects = (html.match(/<select/g) ?? []).length;
  assert.equal(selects, 1, "only the filter's select renders");
});

test("editing a contact's note commits just the note, and hands the patch up", async () => {
  const restoreDom = stubDom();
  let sentBody: Record<string, unknown> | null = null;
  const restoreFetch = stubFetch((_url, init) => {
    sentBody = patchBody(init);
    return Promise.resolve(patchedOne());
  });
  const target = contact("t@agency.com", { name: "Target Contact", state: "target", note: null });
  const handed: { email: string; patch: Record<string, unknown> }[] = [];
  const app = mountTree(ContactsView, {
    contacts: [target],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    onPatched: (patched: { email: string; patch: Record<string, unknown> }) => {
      handed.push(patched);
    },
  });
  try {
    const note = allNodes(app.root).find((node) => node.tag === "textarea");
    assert.ok(note !== undefined, "the note field renders");
    change(note, "met him at a conference");
    await settled();

    assert.deepEqual(sentBody, { note: "met him at a conference" });
    assert.equal(handed.length, 1);
    assert.equal(handed[0]?.email, "t@agency.com");
    assert.deepEqual(handed[0]?.patch, { note: "met him at a conference" });
  } finally {
    app.unmount();
    restoreFetch();
    restoreDom();
  }
});

test("dropping a contact refuses an empty reason, then commits dropped_at and reason on a real one", async () => {
  const restoreDom = stubDom();
  let sentBody: Record<string, unknown> | null = null;
  const restoreFetch = stubFetch((_url, init) => {
    sentBody = patchBody(init);
    return Promise.resolve(patchedOne());
  });
  const target = contact("t@agency.com", { name: "Target Contact", state: "target" });
  const handed: { email: string; patch: Record<string, unknown> }[] = [];
  const app = mountTree(ContactsView, {
    contacts: [target],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    onPatched: (patched: { email: string; patch: Record<string, unknown> }) => {
      handed.push(patched);
    },
  });
  try {
    const dropButton = allNodes(app.root).find(
      (node) => node.tag === "button" && textOf(node).includes("Drop"),
    );
    assert.ok(dropButton !== undefined, "the drop button renders");
    const onClick = dropButton.props["onClick"];
    assert.equal(typeof onClick, "function");
    (onClick as () => void)();
    await settled();

    const form = allNodes(app.root).find((node) => node.tag === "form");
    assert.ok(form !== undefined, "the drop form opens");
    submitForm(form);
    await settled();
    assert.equal(handed.length, 0, "an empty reason writes nothing");
    assert.match(textOf(app.root), /judgement, not a fact/);

    const reason = allNodes(form).find((node) => node.tag === "textarea");
    assert.ok(reason !== undefined, "the reason field is in the open form");
    fill(reason, "went quiet for a year");
    submitForm(form);
    await settled();

    assert.equal(handed.length, 1);
    assert.equal(handed[0]?.email, "t@agency.com");
    assert.equal(sentBody?.["reason"], "went quiet for a year");
    assert.ok(sentBody?.["dropped_at"], "the patch carries when it was dropped");
  } finally {
    app.unmount();
    restoreFetch();
    restoreDom();
  }
});

test("with no duplicates in the round, no card carries the duplicate class", async () => {
  const one = contact("juno@arvelo.partners", { name: "Juno Alderwick" });
  const two = contact("sable@finchcrest.io", { name: "Sable Merrow" });

  const html = await render(ContactsView, {
    contacts: [one, two],
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
  });

  assert.doesNotMatch(html, /class="card contact duplicate"/);
});
