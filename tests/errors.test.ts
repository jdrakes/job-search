import assert from "node:assert/strict";
import { test } from "node:test";

import { describeError } from "../src/errors.ts";

test("describeError: a plain error with no cause returns its message", () => {
  assert.equal(describeError(new Error("board unavailable")), "board unavailable");
});

test("describeError: a chained cause is joined with '<-'", () => {
  const error = new Error("fetch failed", { cause: new Error("read ECONNRESET") });
  assert.equal(describeError(error), "fetch failed <- read ECONNRESET");
});

test("describeError: a cause carrying a code names it in parentheses", () => {
  const cause = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
  const error = new Error("fetch failed", { cause });
  assert.equal(describeError(error), "fetch failed <- read ECONNRESET (ECONNRESET)");
});

test("describeError: a non-Error value stringifies directly", () => {
  assert.equal(describeError("board unavailable"), "board unavailable");
});
