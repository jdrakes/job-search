import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// The guard that keeps the operator's own job-search data out of a public
// repository. A scrub fixes the tree once; this fails the build the next time
// a denied term arrives.
//
// Two designs were tried and rejected before this one.
//
// A pattern ban on figures that look like pay does not work: `src/ats/ats.ts`
// carries page sizes, the migrations carry row counts, `src/store/postgres.ts`
// carries 65,535, and every one of those is honest code. Nor can the denied
// terms be committed in plaintext, because a public file listing them
// republishes precisely what the scrub removed. So the terms live in
// `tests/personal-data-denylist.json` as SHA-256 digests of their normalised
// form, and a failure names the file and the line but never the term, because
// the CI log of a public repository is public too.
//
// What the list may not hold, because the guard scans honest code and a
// collision fails the build on it: anything under `minLength` characters,
// ordinary English, generic industry vocabulary, the names of the ATS vendors
// this tool reads, and the names of tools and platforms a technical repository
// has reason to mention. Whole-token matching is what lets a company name be
// denied while an ordinary word that begins with it stays legal, which is the
// difference between a denied employer and the English verb one letter longer.
//
// Every line is read as written and again with its escapes decoded. A captured
// JSON document may write a letter of a name as an escape, and an ATS search
// URL writes the space inside a two-word name as one, and neither spelling
// normalises to the tokens the plain spelling does.
//
// The scan reads the working tree and nothing else. It does not read commit
// messages, and it cannot reach what an earlier commit carried, so a term that
// arrives and is then removed still has to be dealt with by rewriting history.
//
// To add a term, hash it on the command line so it is never written to a file:
//
//   node -e 'const t = process.argv[1].toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
//   console.log(require("node:crypto").createHash("sha256").update(t).digest("hex"))' "Term Here"
//
// then append the digest to `digests` and raise `count`.

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DENYLIST = "tests/personal-data-denylist.json";

// Lowercase, then every run of characters that is neither a letter nor a digit
// becomes one space. `999_888`, `999,888` and `999 888` therefore reduce to the
// same two tokens, and a term is compared token for token rather than as a
// substring.
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function digestOf(normalised: string): string {
  return createHash("sha256").update(normalised).digest("hex");
}

// A captured JSON document can write any letter of a name as a four-digit `u`
// escape, and a name with one letter written that way normalises to a single
// token that matches nothing. Only the escapes JSON itself defines are decoded,
// so a doubled backslash before a `u` stays the literal characters it means
// rather than becoming a letter that was never in the file.
const JSON_SIMPLE_ESCAPES: Record<string, string> = {
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  '"': '"',
  "/": "/",
  "\\": "\\",
};

function decodeJsonEscapes(text: string): string {
  return text.replace(
    /\\u([0-9a-fA-F]{4})|\\([bfnrt"/\\])/g,
    (whole, hex: string, simple: string) =>
      typeof hex === "string"
        ? String.fromCharCode(Number.parseInt(hex, 16))
        : (JSON_SIMPLE_ESCAPES[simple] ?? whole),
  );
}

// An ATS search URL writes the space inside a two-word employer as `%20`, which
// normalises to a token between the two words and defeats the n-gram. Each run
// of escapes is decoded on its own so that one malformed run cannot discard the
// rest of the line, and a run that is not valid UTF-8 is left as written: a
// stray `%` in ordinary prose is ordinary prose, and a guard that threw on one
// would be worse than the gap it closes.
function decodePercentEncoding(text: string): string {
  return text.replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

// The line as written, plus every distinct decoding of it. Decoding only adds
// readings. The written form is always scanned, so a decoder that reads a line
// differently than its format intended can raise a false match but can never
// hide a term that is plainly there.
function readingsOf(line: string): string[] {
  const unescaped = decodeJsonEscapes(line);
  return [
    ...new Set([line, unescaped, decodePercentEncoding(line), decodePercentEncoding(unescaped)]),
  ];
}

interface Denylist {
  readonly minLength: number;
  readonly maxWords: number;
  readonly digests: ReadonlySet<string>;
}

// Parsed once, here, so the scan below works on a typed value. A malformed
// denylist is a bug in a committed file rather than a condition to report, so
// this throws.
function parseDenylist(text: string, path: string): Denylist {
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== "object" || raw === null) throw new Error(`${path} is not an object`);
  const fields = raw as Record<string, unknown>;
  if (fields.algorithm !== "sha256")
    throw new Error(`${path} names an algorithm this test cannot compute`);
  const { minLength, maxWords, count, digests } = fields;
  if (typeof minLength !== "number" || typeof maxWords !== "number") {
    throw new Error(`${path} is missing minLength or maxWords`);
  }
  if (!Array.isArray(digests) || digests.some((entry) => typeof entry !== "string")) {
    throw new Error(`${path} has no digests array`);
  }
  if (digests.length !== count)
    throw new Error(`${path} says ${String(count)} digests and holds ${digests.length}`);
  return { minLength, maxWords, digests: new Set(digests as string[]) };
}

// The 1-based lines carrying a denied term, each reported once however many
// terms it carries. An n-gram is built within a line, so a term split across
// two lines is not found; the terms are company names, email addresses and
// figures, none of which wrap.
function deniedLines(text: string, denylist: Denylist): number[] {
  const lines: number[] = [];
  text.split("\n").forEach((line, index) => {
    if (readingsOf(line).some((reading) => carriesDeniedTerm(reading, denylist))) {
      lines.push(index + 1);
    }
  });
  return lines;
}

function carriesDeniedTerm(reading: string, denylist: Denylist): boolean {
  const tokens = normalise(reading).split(" ").filter(Boolean);
  for (let at = 0; at < tokens.length; at += 1) {
    for (let words = 1; words <= denylist.maxWords && at + words <= tokens.length; words += 1) {
      const gram = tokens.slice(at, at + words).join(" ");
      if (gram.length < denylist.minLength) continue;
      if (denylist.digests.has(digestOf(gram))) return true;
    }
  }
  return false;
}

// Tracked files plus anything untracked that is not ignored, which is what one
// `git add .` would commit. The ignored paths the operator keeps their real
// data in are outside the scan for the same reason they are outside the repo.
//
// There is no list of files the scan skips, and there should never be one. A
// skip list in a public repository is a signpost: it tells a reader which file
// holds the thing the digests are hiding. When a file and a term collide,
// either the file loses the term or the term leaves the list, and the commit
// that did it says which and why.
function scannablePaths(): string[] {
  const listed = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  return listed.split("\0").filter((path) => path !== "");
}

const denylist = parseDenylist(
  readFileSync(new URL(`../${DENYLIST}`, import.meta.url), "utf8"),
  DENYLIST,
);

// A fixture denylist, its digests computed by `shasum -a 256` rather than by
// the code under test.
const FIXTURE: Denylist = {
  minLength: 4,
  maxWords: 3,
  digests: new Set([
    "9fecbc782c71fffa567d4db55c80a888175e6dab75a043a4272b61bc10abe734", // umbrella corporation
    "24992d41718747ba863a7c73321c7f96eaf695518e1b636cfe8c2fcb3e769ebc", // acmecorp
    "a238b1d44f3d7fd2e253b63c3b7707c2e60c6f546b84bf4ba0aa96bac4df9fa6", // 999 888
    "6b4f1b441411981f88156ed472c19de3395f8a2d899f5bc3e376946848108253", // 750k
  ]),
};

test("normalise lowercases and reduces every run of other characters to one space", () => {
  assert.equal(normalise("Umbrella Corporation"), "umbrella corporation");
  assert.equal(normalise("  The Acme Group.  "), "the acme group");
  assert.equal(normalise("comp_floor: 999_888,"), "comp floor 999 888");
  assert.equal(normalise("someone@example.com"), "someone example com");
  assert.equal(normalise("---"), "");
});

test("a one-word term is found on the line that carries it", () => {
  assert.deepEqual(deniedLines("const board = 'acmecorp';", FIXTURE), [1]);
  assert.deepEqual(deniedLines("first\nsecond\nAcmeCorp Inc\nfourth", FIXTURE), [3]);
});

test("a term is matched as whole tokens, so a longer word carrying it is not a match", () => {
  assert.deepEqual(deniedLines("The judge cleared acmecorporation and acmecorps.", FIXTURE), []);
  assert.deepEqual(deniedLines("umbrellas corporation", FIXTURE), []);
});

test("a multi-word term is found across the punctuation between its words", () => {
  assert.deepEqual(deniedLines('company: "Umbrella Corporation",', FIXTURE), [1]);
  assert.deepEqual(deniedLines("umbrella-corporation.example.com", FIXTURE), [1]);
  assert.deepEqual(deniedLines("Umbrella is a corporation", FIXTURE), []);
});

test("a figure is found in each of its spellings, because they normalise alike", () => {
  assert.deepEqual(deniedLines("floor: 999,888", FIXTURE), [1]);
  assert.deepEqual(deniedLines("floor: 999_888", FIXTURE), [1]);
  assert.deepEqual(deniedLines("floor: $999 888", FIXTURE), [1]);
  assert.deepEqual(deniedLines("floor: 999888", FIXTURE), []);
});

test("a k-suffixed figure is its own token, distinct from the comma-separated spelling of the same number", () => {
  assert.deepEqual(deniedLines("floor: 750k", FIXTURE), [1]);
  assert.deepEqual(deniedLines("floor: $750k a year", FIXTURE), [1]);
  assert.deepEqual(deniedLines("floor: 750,000", FIXTURE), []);
});

test("a term written with a JSON unicode escape is found, and an escaped backslash is not decoded", () => {
  assert.deepEqual(deniedLines('{"company": "\\u0041cmeCorp"}', FIXTURE), [1]);
  assert.deepEqual(deniedLines('{"company": "Umbrella\\u0020Corporation"}', FIXTURE), [1]);
  // `\\u0041` is the six characters JSON writes for a literal backslash and a
  // `u`, not the letter A, so this line carries no term.
  assert.deepEqual(deniedLines('{"path": "\\\\u0041cmeCorp"}', FIXTURE), []);
  // Whole-token matching still holds after decoding.
  assert.deepEqual(deniedLines('{"company": "\\u0041cmeCorporation"}', FIXTURE), []);
});

test("a percent-encoded term is found, including the space inside a multi-word term", () => {
  assert.deepEqual(
    deniedLines("https://boards.example.com/search?q=Umbrella%20Corporation", FIXTURE),
    [1],
  );
  assert.deepEqual(deniedLines("?employer=Acme%43orp", FIXTURE), [1]);
  assert.deepEqual(deniedLines("?employer=Umbrella%20is%20a%20corporation", FIXTURE), []);
});

test("a percent sign that encodes nothing is left as written rather than throwing", () => {
  assert.deepEqual(deniedLines("acmecorp took 40% of the queue", FIXTURE), [1]);
  assert.deepEqual(deniedLines("acmecorp and a truncated %2", FIXTURE), [1]);
  // `%c0%80` is a well-formed escape run that is not valid UTF-8, which is the
  // case that makes a whole-line decode throw.
  assert.deepEqual(deniedLines("acmecorp shipped %c0%80 bytes", FIXTURE), [1]);
  assert.deepEqual(deniedLines("100%% of %c0%80 is not a term", FIXTURE), []);
});

test("a line is reported once however many denied terms it carries", () => {
  assert.deepEqual(deniedLines("acmecorp and Umbrella Corporation and 999,888", FIXTURE), [1]);
});

test("the committed denylist carries digests and nothing that could read as a term", () => {
  const raw = JSON.parse(
    readFileSync(new URL(`../${DENYLIST}`, import.meta.url), "utf8"),
  ) as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(raw).sort(),
    ["algorithm", "comment", "count", "digests", "maxWords", "minLength"],
    "a field outside this set is how a plaintext term would get into a public file",
  );
  const digests = raw.digests as string[];
  assert.ok(digests.length > 0, "an empty denylist guards nothing");
  assert.deepEqual(
    digests.filter((digest) => !/^[0-9a-f]{64}$/.test(digest)),
    [],
    "an entry that is not 64 hex characters is not a digest, and may be readable",
  );
  assert.equal(
    new Set(digests).size,
    digests.length,
    "a duplicated digest means a term was added twice",
  );
});

// A NUL byte is the working definition of "not text" for this scan: a
// `.gz`, `.xlsx` or `.sqlite` file carries one almost immediately, and the
// line-by-line scan below cannot read a term out of bytes it cannot decode
// as text. No tracked file is binary today, but a guard whose whole job is
// to be noisy should not go quiet exactly when it stops being able to look.
function isBinary(bytes: Buffer): boolean {
  return bytes.includes(0);
}

test("a binary file is detected by its NUL byte rather than assumed absent", () => {
  assert.equal(isBinary(Buffer.from("plain text carries no null byte")), false);
  assert.equal(isBinary(Buffer.from([0x50, 0x4b, 0x00, 0x03])), true);
});

test("no file this repository would publish carries a denied term, in its text or its path", () => {
  const found: string[] = [];
  const unscannedBinary: string[] = [];
  for (const path of scannablePaths()) {
    const full = `${ROOT}${path}`;
    if (!existsSync(full)) continue;
    if (deniedLines(path, denylist).length > 0) found.push(`${path} (the name itself)`);
    const bytes = readFileSync(full);
    if (isBinary(bytes)) {
      unscannedBinary.push(path);
      continue;
    }
    for (const line of deniedLines(bytes.toString("utf8"), denylist)) found.push(`${path}:${line}`);
  }
  if (unscannedBinary.length > 0) {
    // A file name is not a denied term, so this is safe to print. The point
    // is that this guard cannot see inside these files, not what they hold.
    console.warn(
      `personal data guard: ${unscannedBinary.length} tracked file(s) carry a NUL byte and were not scanned as text: ` +
        `${unscannedBinary.join(", ")}. A denied term inside one would not be caught by this guard.`,
    );
  }
  assert.deepEqual(
    found,
    [],
    `personal data denylist matched at ${found.join(", ")}. The matched text is withheld on purpose: this log is as public as the repository. Read the line, remove what it says about the operator, and commit that.`,
  );
});
