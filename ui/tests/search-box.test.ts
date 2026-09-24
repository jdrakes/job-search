import assert from "node:assert/strict";
import { test } from "node:test";
import { createSSRApp } from "vue";
import { renderToString } from "vue/server-renderer";

import { SearchBox } from "../src/search-box.ts";
import { allNodes, mountTree, stubDom, textOf, typeInto } from "./render-tree.ts";

function render(props: Record<string, unknown>): Promise<string> {
  return renderToString(createSSRApp(SearchBox, props));
}

function inputOf(root: Parameters<typeof allNodes>[0]) {
  return allNodes(root).find((node) => node.tag === "input");
}

test("the box renders a labelled search field showing the value it was given", async () => {
  const html = await render({ value: "streamly", label: "Search", placeholder: "Company or role" });
  assert.match(html, /<label class="search-box">/);
  assert.match(html, /<span>Search<\/span>/);
  assert.match(html, /type="search"/);
  assert.match(html, /placeholder="Company or role"/);
  assert.match(html, /value="streamly"/);
});

test("the label is a label, not a placeholder, so it survives being typed into", async () => {
  const html = await render({ value: "", label: "Find a company" });
  assert.match(html, /<span>Find a company<\/span>/);
  // The field sits inside the label, which pairs them without an id.
  assert.match(html, /<label class="search-box">[^]*<input/);
});

test("autocorrect and autocapitalize are off, because a company name is not a word to fix", async () => {
  const html = await render({ value: "" });
  assert.match(html, /autocorrect="off"/);
  assert.match(html, /autocapitalize="off"/);
});

test("typing emits the new text and changes nothing itself, so the view stays the owner", async () => {
  const restoreDom = stubDom();
  const emitted: string[] = [];
  const app = mountTree(SearchBox, {
    value: "acme",
    onSearch: (next: string) => emitted.push(next),
  });
  try {
    const input = inputOf(app.root);
    assert.ok(input !== undefined, "the field renders");

    typeInto(input, "acme p");
    typeInto(input, "acme pay");

    assert.deepEqual(emitted, ["acme p", "acme pay"]);
    // The parent has not handed back a new value, and the box does not get
    // ahead of it.
    assert.equal(input.props["value"], "acme");
  } finally {
    app.unmount();
    restoreDom();
  }
});

test("the value the parent passes is what shows, so a cleared filter clears the field", async () => {
  const restoreDom = stubDom();
  const app = mountTree(SearchBox, { value: "acme" });
  try {
    assert.equal(inputOf(app.root)?.props["value"], "acme");
  } finally {
    app.unmount();
    restoreDom();
  }
});

test("the label defaults to Search and the placeholder to nothing", async () => {
  const html = await render({ value: "" });
  assert.match(html, /<span>Search<\/span>/);
  assert.doesNotMatch(html, /placeholder="[^"]+"/);
});

test("it renders no state of its own beyond the field", async () => {
  const restoreDom = stubDom();
  const app = mountTree(SearchBox, { value: "x", label: "Search" });
  try {
    assert.equal(textOf(app.root).trim(), "Search");
  } finally {
    app.unmount();
    restoreDom();
  }
});
