import assert from "node:assert/strict";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

// A fixture is written from a platform's documented response shape, not
// captured from a real board. The difference is visible in the file size
// before it is visible in the content: a captured page carries a real
// employer's advert, their benefits text, their legal boilerplate and their
// tracking markup, and lands somewhere between ten and forty kilobytes. One
// written to exercise a parser carries a handful of entries and lands under
// five.
//
// That gap is what this test watches, because the alternative checks do not
// work. `tests/no-personal-data.test.ts` denies known terms, so it cannot see
// a company nobody thought to deny. Reading the fixtures catches a great deal
// and catches nothing on the day nobody reads them. A size ceiling needs no
// list and no reader.
//
// It is a proxy rather than a proof: a small fixture can still be a trimmed
// capture. What it stops is the common case, which is a whole page pasted in
// while adding a reader, and that is the case this repository actually met.
const CEILING_BYTES = 8 * 1024;

const FIXTURES = join(import.meta.dirname, "fixtures");

test("no fixture is large enough to be a captured page", () => {
  const oversized = readdirSync(FIXTURES)
    .map((name) => ({ name, bytes: statSync(join(FIXTURES, name)).size }))
    .filter((file) => file.bytes > CEILING_BYTES)
    .map((file) => `${file.name} (${file.bytes} bytes)`);

  assert.deepEqual(
    oversized,
    [],
    `A fixture over ${CEILING_BYTES} bytes is usually a real page pasted in. ` +
      "Write one from the platform's response shape instead, keeping the " +
      "envelope, the escaping and one entry per case the tests prove, and " +
      "drop the advert prose that is not read by anything.",
  );
});

test("the ceiling is above every fixture, with room to write a real one", () => {
  // A ceiling set flush against the largest fixture fails the next honest
  // addition rather than the next captured page, so it is worth knowing how
  // much room is left. If this margin gets thin, the fixtures have grown and
  // the answer is to look at them, not to raise the ceiling.
  const largest = Math.max(
    ...readdirSync(FIXTURES).map((name) => statSync(join(FIXTURES, name)).size),
  );
  assert.ok(
    largest < CEILING_BYTES,
    `the largest fixture is ${largest} bytes against a ceiling of ${CEILING_BYTES}`,
  );
});
