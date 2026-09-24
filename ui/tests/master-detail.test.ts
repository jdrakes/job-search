import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { computed, ref } from "vue";

import type { Posting } from "../../src/schema.ts";
import { useMasterDetail } from "../src/master-detail.ts";

function posting(key: string, overrides: Partial<Posting> = {}): Posting {
  return {
    key,
    company: key.split("::")[0] ?? key,
    platform: "greenhouse",
    board: "acme",
    title: "Engineer",
    url: null,
    location: null,
    comp_low: null,
    comp_high: null,
    posted_at: null,
    first_seen: "2026-09-15T00:00:00Z",
    last_seen: "2026-09-15T00:00:00Z",
    live: null,
    body: null,
    kept: true,
    reasons: [],
    evidence: {},
    judged_with: null,
    status: null,
    applied_at: null,
    status_at: null,
    note: null,
    body_hash: null,
    workplace: null,
    ...overrides,
  };
}

test("useMasterDetail auto-selects the first posting with no prior click", () => {
  const postings = [posting("a::1"), posting("b::2")];
  const { selected } = useMasterDetail(computed(() => postings));
  assert.equal(selected.value, postings[0]);
});

test("useMasterDetail's advanceSelection moves the selection to the successor of the decided posting", () => {
  const postings = [posting("a::1"), posting("b::2"), posting("c::3")];
  const { selectedKey, selected, advanceSelection } = useMasterDetail(computed(() => postings));
  selectedKey.value = "b::2";
  advanceSelection("b::2");
  assert.equal(selectedKey.value, "c::3");
  assert.equal(selected.value, postings[2]);
});

test("useMasterDetail's advanceSelection leaves the selection alone when a different posting was decided", () => {
  const postings = [posting("a::1"), posting("b::2"), posting("c::3")];
  const { selectedKey, advanceSelection } = useMasterDetail(computed(() => postings));
  selectedKey.value = "a::1";
  advanceSelection("b::2");
  assert.equal(selectedKey.value, "a::1");
});

test("useMasterDetail's selection self-heals once its list is regenerated to drop the decided posting", () => {
  // `postings` is a computed the caller updates, not a plain array swapped
  // out from under the composable.
  const source = ref([posting("a::1"), posting("b::2"), posting("c::3")]);
  const { selectedKey, selected, advanceSelection } = useMasterDetail(computed(() => source.value));
  selectedKey.value = "b::2";
  advanceSelection("b::2");
  source.value = source.value.filter((p) => p.key !== "b::2");
  assert.equal(selected.value?.key, "c::3");
});

test("useMasterDetail's reveal is per posting and outlives the click that made it", () => {
  const { onRevealed, isRevealed } = useMasterDetail(
    computed(() => [posting("a::1"), posting("b::2")]),
  );
  assert.equal(isRevealed("a::1"), false);
  onRevealed("a::1");
  assert.equal(isRevealed("a::1"), true, "the posting is revealed");
  assert.equal(isRevealed("b::2"), false, "a different posting is not");
  onRevealed("a::1");
  assert.equal(isRevealed("a::1"), true, "and a second reveal of the same posting is a no-op");
});

test("the list wraps a keydown handler that steps head buttons with nextFocusable", () => {
  // Arrow-key navigation needs a live DOM no test here creates, so this
  // checks the handler delegates to `nextFocusable`.
  const source = readFileSync(new URL("../src/master-detail.ts", import.meta.url), "utf8");
  assert.match(source, /nextFocusable\(heads, target, event\.key === "ArrowUp", false\)/);
});
