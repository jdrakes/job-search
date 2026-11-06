import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const AGENTS = [".claude/agents/job-email-status.md", ".claude/agents/job-email-suggestions.md"];
const SKILL = read(".claude/skills/job-email/SKILL.md");
const DISPATCH_KEYS = ["after", "rows", "store", "threads"];

function frontmatterLines(text: string): readonly string[] {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(match, "file opens with frontmatter");
  return (match[1] ?? "").split("\n");
}

function jsonKeys(text: string): readonly string[] {
  return [...text.matchAll(/"(\w+)":/g)].map((match) => match[1] ?? "");
}

for (const path of AGENTS) {
  const text = read(path);

  // Breaks if a mail or store tool is added back: the agents must only read files.
  test(`${path} holds exactly Read, Grep and Glob`, () => {
    const tools = frontmatterLines(text).filter((line) => line.startsWith("tools:"));
    assert.deepEqual(tools, ["tools: Read, Grep, Glob"]);
  });

  // Breaks if the frontmatter's model changes: the local model extracts, Sonnet matches.
  test(`${path} stays on Sonnet`, () => {
    assert.ok(frontmatterLines(text).includes("model: sonnet"));
  });

  // Breaks if the body or description goes back to naming a connector tool.
  test(`${path} names no connector tool`, () => {
    assert.ok(!text.includes("mcp__"));
  });

  // Breaks if the agent's dispatch line drops rows or store, or takes a project ref again.
  test(`${path} takes rows and store in its dispatch`, () => {
    const dispatch = /One JSON object: `(\{.*\})`/.exec(text);
    assert.ok(dispatch, "agent states its dispatch");
    assert.deepEqual(jsonKeys(dispatch[1] ?? ""), DISPATCH_KEYS);
    assert.ok(!text.includes("project_id"));
  });

  const prose = text.replace(/\s+/g, " ");

  // Breaks if the agent loses the way past a row too long for offset and limit to split.
  test(`${path} re-reads a refused long row with allow_large`, () => {
    assert.ok(prose.includes("Read that row again with `allow_large: true`"));
  });

  // Breaks if the date limit goes back to cutting older messages out of full_text.
  test(`${path} reads full_text whole and limits only what it reports`, () => {
    assert.ok(prose.includes("full_text is read whole"));
    assert.ok(prose.includes("a hold in an older message still counts"));
    assert.ok(prose.includes("report only its messages dated on or after `after`"));
    assert.ok(!prose.includes("use only its messages"));
  });

  // Breaks if the agent stops being told a hold or a pause differs from a rejection.
  test(`${path} does not read a hold as a rejection`, () => {
    assert.ok(prose.includes("which is not a rejection"));
  });

  // Breaks if the agent goes back to assuming threads lists every id in the rows file.
  test(`${path} reports only the thread ids it was given`, () => {
    assert.ok(prose.includes("the file may hold others, so report only these"));
    assert.ok(!prose.includes("every thread id in the rows file"));
    assert.ok(!prose.includes("the skill listed and sorted"));
  });
}

// Breaks if the skill's dispatch and the agents' dispatch drift apart.
test("the skill dispatches the shape the agents take", () => {
  const block = /```json\n([\s\S]*?)\n```/.exec(SKILL);
  assert.ok(block, "skill shows its dispatch");
  assert.deepEqual(jsonKeys(block[1] ?? ""), DISPATCH_KEYS);
});

// Breaks if the skill stops running the script or stops showing what it could not read.
test("the skill runs the script and shows what it could not read", () => {
  for (const word of ["scripts/job-email/run.ts", "unclassified", "failed"]) {
    assert.ok(SKILL.includes(word), word);
  }
});

// Breaks if the skill goes back to listing or opening mail through the connector.
test("the skill reads no mail itself", () => {
  for (const word of ["search_threads", "get_thread"]) {
    assert.ok(!SKILL.includes(word), word);
  }
});

// Breaks if the rewrite removes the writes step or the stop before it.
test("the skill keeps its writes and its stop", () => {
  for (const word of ["execute_sql", "Which do I write?"]) {
    assert.ok(SKILL.includes(word), word);
  }
});
