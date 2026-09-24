import assert from "node:assert/strict";
import { test } from "node:test";

import { focusAfterClose, nextFocusable } from "../src/focus-trap.ts";

/** `nextFocusable` only needs `.focus()` to exist. */
function fake(): { focus(): void } {
  return { focus(): void {} };
}

test("nextFocusable wraps from the last element to the first, going forward", () => {
  const [a, b, c] = [fake(), fake(), fake()];
  const elements = [a, b, c];
  assert.equal(nextFocusable(elements, c, false), a);
});

test("nextFocusable wraps from the first element to the last, going backward", () => {
  const [a, b, c] = [fake(), fake(), fake()];
  const elements = [a, b, c];
  assert.equal(nextFocusable(elements, a, true), c);
});

test("nextFocusable steps to the immediate neighbour in the middle of the list", () => {
  const [a, b, c] = [fake(), fake(), fake()];
  const elements = [a, b, c];
  assert.equal(nextFocusable(elements, b, false), c);
  assert.equal(nextFocusable(elements, b, true), a);
});

test("nextFocusable returns null for an empty list", () => {
  assert.equal(nextFocusable([], null, false), null);
  assert.equal(nextFocusable([], null, true), null);
});

test("nextFocusable returns the sole element of a single-element list, either direction", () => {
  const only = fake();
  assert.equal(nextFocusable([only], only, false), only);
  assert.equal(nextFocusable([only], only, true), only);
});

test("nextFocusable treats an active element absent from the list as before the start", () => {
  const [a, b] = [fake(), fake()];
  const elements = [a, b];
  const outsider = fake();
  assert.equal(nextFocusable(elements, outsider, false), a);
  assert.equal(nextFocusable(elements, outsider, true), b);
});

test("nextFocusable starts at the first element when nothing is active yet, going forward", () => {
  const [a, b] = [fake(), fake()];
  assert.equal(nextFocusable([a, b], null, false), a);
});

test("nextFocusable starts at the last element when nothing is active yet, going backward", () => {
  const [a, b] = [fake(), fake()];
  assert.equal(nextFocusable([a, b], null, true), b);
});

test("nextFocusable stops at the last element instead of wrapping, going forward, when wrap is false", () => {
  // Row scanning reused the dialog trap's wrapping nextFocusable as-is, so
  // ArrowDown on the last row jumped focus back to the first.
  const [a, b, c] = [fake(), fake(), fake()];
  const elements = [a, b, c];
  assert.equal(nextFocusable(elements, c, false, false), null);
});

test("nextFocusable stops at the first element instead of wrapping, going backward, when wrap is false", () => {
  const [a, b, c] = [fake(), fake(), fake()];
  const elements = [a, b, c];
  assert.equal(nextFocusable(elements, a, true, false), null);
});

test("nextFocusable still steps to the immediate neighbour in the middle when wrap is false", () => {
  const [a, b, c] = [fake(), fake(), fake()];
  const elements = [a, b, c];
  assert.equal(nextFocusable(elements, b, false, false), c);
  assert.equal(nextFocusable(elements, b, true, false), a);
});

test("nextFocusable defaults to wrapping when the wrap argument is omitted, preserving the dialog Tab-trap's behavior", () => {
  const [a, b, c] = [fake(), fake(), fake()];
  const elements = [a, b, c];
  assert.equal(nextFocusable(elements, c, false), a);
  assert.equal(nextFocusable(elements, a, true), c);
});

test("focusAfterClose returns a dismissed dialog's focus to the button that opened it", () => {
  const [trigger, anchor] = [fake(), fake()];
  assert.equal(focusAfterClose("dismissed", trigger, anchor), trigger);
});

test("focusAfterClose sends a committed dialog's focus to the anchor, not the trigger", () => {
  // The trigger is still there to focus at this moment and gone a tick
  // later: the write disables it, then the row unmounts.
  const [trigger, anchor] = [fake(), fake()];
  assert.equal(focusAfterClose("committed", trigger, anchor), anchor);
});

test("focusAfterClose falls back to the anchor when a dismissed dialog had no trigger", () => {
  const anchor = fake();
  assert.equal(focusAfterClose("dismissed", null, anchor), anchor);
});

test("focusAfterClose returns null when there is nothing left to focus", () => {
  assert.equal(focusAfterClose("committed", fake(), null), null);
  assert.equal(focusAfterClose("dismissed", null, null), null);
});
