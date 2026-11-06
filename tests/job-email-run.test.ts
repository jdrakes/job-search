import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";

import { MODEL } from "../scripts/job-email/extract.ts";
import {
  credentialsAt,
  parseSince,
  runCheck,
  withOllamaHint,
  type RunDependencies,
} from "../scripts/job-email/run.ts";
import { memoryStore } from "../src/store/memory.ts";

// Every name, address and text here is invented. Nothing reaches Gmail,
// Ollama, the Keychain or a store.
const TOKEN = "fake-access-token-q7x";
const SINCE = "2026-01-01";
const TODAY = new Date("2026-01-03T12:00:00Z");

const ALERT_SENDER = "alerts@glassdoor.com"; // sorts to suggestions
const STATUS_SENDER = "no-reply@ashbyhq.com"; // sorts to status
const PERSON_SENDER = "marlow@fernwood.example"; // sorts to both
const ROLE_ITEM = {
  kind: "suggested_role",
  company: "Fernwood Labs",
  title: "Platform Engineer",
  location: null,
  pay: null,
  status: "none",
  quote: "Platform Engineer at Fernwood Labs",
};

interface FakeThread {
  readonly id: string;
  readonly sender?: string;
  readonly subject?: string;
  readonly date?: string;
  readonly labels?: readonly string[];
  readonly items?: readonly object[];
  readonly chatFails?: boolean;
  readonly readFails?: boolean;
}

interface FakeWorld {
  readonly threads: readonly FakeThread[];
  readonly ollamaDown?: boolean;
  readonly listingFails?: boolean;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function apiThread(thread: FakeThread): object {
  const text = `Body of ${thread.id}. Platform Engineer at Fernwood Labs.`;
  return {
    id: thread.id,
    messages: [
      {
        internalDate: String(Date.parse(thread.date ?? "2026-01-02T08:00:00Z")),
        labelIds: thread.labels ?? [],
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "From", value: thread.sender ?? PERSON_SENDER },
            { name: "Subject", value: thread.subject ?? `Subject of ${thread.id}` },
          ],
          body: { data: Buffer.from(text).toString("base64url") },
        },
      },
    ],
  };
}

// One fetch, routed by URL, recording each call in order.
function fakeFetch(world: FakeWorld): { fetch: typeof globalThis.fetch; calls: string[] } {
  const calls: string[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/tags")) {
      calls.push("tags");
      if (world.ollamaDown === true) throw new Error("connection refused");
      return jsonResponse({ models: [{ name: MODEL }] });
    }
    if (url.endsWith("/api/chat")) {
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
      const email = body.messages[1]?.content ?? "";
      const thread = world.threads.find((candidate) => email.includes(`Body of ${candidate.id}.`));
      assert.ok(thread, "the model was sent a thread the test does not know");
      calls.push(`chat ${thread.id}`);
      if (thread.chatFails === true) return jsonResponse({ error: "model fell over" }, 500);
      return jsonResponse({
        prompt_eval_count: 10,
        message: { content: JSON.stringify({ items: thread.items ?? [ROLE_ITEM] }) },
      });
    }
    assert.ok(url.startsWith("https://gmail.googleapis.com/"), `unexpected URL ${url}`);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), `Bearer ${TOKEN}`);
    const read = /\/threads\/([^?]+)\?format=full$/.exec(url);
    if (read === null) {
      calls.push("gmail list");
      if (world.listingFails === true) return jsonResponse({ error: { message: "quota" } }, 429);
      return jsonResponse({ threads: world.threads.map(({ id }) => ({ id })) });
    }
    calls.push(`gmail read ${read[1]}`);
    const thread = world.threads.find(({ id }) => id === read[1]);
    assert.ok(thread);
    if (thread.readFails === true) return jsonResponse({ error: { message: "gone" } }, 404);
    return jsonResponse(apiThread(thread));
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

function dependencies(fetch: typeof globalThis.fetch, logged: string[] = []): RunDependencies {
  return {
    store: memoryStore(),
    accessToken: async () => ({ ok: true, value: TOKEN }),
    fetch,
    today: TODAY,
    log: (line) => logged.push(line),
  };
}

async function withRoot(body: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "job-email-run-"));
  try {
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function runOk(root: string, world: FakeWorld) {
  const { fetch, calls } = fakeFetch(world);
  const logged: string[] = [];
  const result = await runCheck(SINCE, root, dependencies(fetch, logged));
  assert.ok(result.ok, result.ok ? "" : result.reason);
  return { summary: result.value, calls, logged };
}

function threadIdsIn(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => (JSON.parse(line) as { thread: string }).thread);
}

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

// Breaks if the batch size changes, or the date sort is dropped: the threads
// are listed newest first.
test("12 suggestions threads give batches of 10 and 2, oldest first", async () => {
  await withRoot(async (root) => {
    const threads = [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map((hour) => ({
      id: `s${String(hour).padStart(2, "0")}`,
      sender: ALERT_SENDER,
      date: `2026-01-02T${String(hour).padStart(2, "0")}:00:00Z`,
    }));
    const { summary } = await runOk(root, { threads });
    const directory = join(root, "captures", "job-email", SINCE);
    const first = ["s01", "s02", "s03", "s04", "s05", "s06", "s07", "s08", "s09", "s10"];
    assert.deepEqual(
      summary.suggestions.map(({ rows }) => rows),
      [join(directory, "rows-suggestions-1.jsonl"), join(directory, "rows-suggestions-2.jsonl")],
    );
    assert.deepEqual(summary.suggestions[0]?.threads, first);
    assert.deepEqual(summary.suggestions[1]?.threads, ["s11", "s12"]);
    assert.deepEqual(threadIdsIn(join(directory, "rows-suggestions-1.jsonl")), first);
    assert.deepEqual(threadIdsIn(join(directory, "rows-suggestions-2.jsonl")), ["s11", "s12"]);
    assert.deepEqual(summary.status.threads, []);
    assert.equal(readFileSync(summary.status.rows, "utf8"), "");
  });
});

// Breaks if a both thread is routed to one list or extracted once per list.
test("a both thread is in the status file and a suggestions file, with one model call", async () => {
  await withRoot(async (root) => {
    const { summary, calls } = await runOk(root, { threads: [{ id: "b1" }] });
    assert.deepEqual(summary.status.threads, ["b1"]);
    assert.deepEqual(threadIdsIn(summary.status.rows), ["b1"]);
    assert.deepEqual(summary.suggestions[0]?.threads, ["b1"]);
    assert.deepEqual(threadIdsIn(summary.suggestions[0]?.rows ?? ""), ["b1"]);
    assert.deepEqual(
      calls.filter((call) => call.startsWith("chat")),
      ["chat b1"],
    );
  });
});

// Breaks if status-only threads reach the suggestions list, or the reverse.
test("a status thread goes only to status and a suggestions thread only to suggestions", async () => {
  await withRoot(async (root) => {
    const { summary } = await runOk(root, {
      threads: [
        { id: "st1", sender: STATUS_SENDER },
        { id: "su1", sender: ALERT_SENDER },
      ],
    });
    assert.deepEqual(summary.status.threads, ["st1"]);
    assert.deepEqual(
      summary.suggestions.map(({ threads }) => threads),
      [["su1"]],
    );
  });
});

// Breaks if a thread with no items is routed to the agents, or dropped.
test("a thread with no items is unclassified and in no rows file or threads list", async () => {
  await withRoot(async (root) => {
    const { summary } = await runOk(root, {
      threads: [{ id: "u1", subject: "Lunch on Friday", items: [] }],
    });
    assert.deepEqual(summary.unclassified, [
      {
        thread: "u1",
        sender: PERSON_SENDER,
        subject: "Lunch on Friday",
        date: "2026-01-02T08:00:00Z",
      },
    ]);
    assert.deepEqual(summary.status.threads, []);
    assert.deepEqual(summary.suggestions, []);
    assert.equal(readFileSync(summary.status.rows, "utf8"), "");
  });
});

// Breaks if neither threads are sent to the model or go uncounted.
test("a neither thread gets no model call and counts in neitherCount and neither.jsonl", async () => {
  await withRoot(async (root) => {
    const { summary, calls, logged } = await runOk(root, {
      threads: [{ id: "n1", sender: "sale@quillfeather.example", labels: ["CATEGORY_PROMOTIONS"] }],
    });
    assert.equal(summary.neitherCount, 1);
    assert.deepEqual(threadIdsIn(summary.neither), ["n1"]);
    assert.deepEqual(
      calls.filter((call) => call.startsWith("chat")),
      [],
    );
    assert.deepEqual(logged, []);
    assert.deepEqual(summary.status.threads, []);
  });
});

// Breaks if one failed thread stops the run, or fails without a trace.
test("a model failure and a thread fetch failure are in failed and the run continues", async () => {
  await withRoot(async (root) => {
    const { summary } = await runOk(root, {
      threads: [
        { id: "gone", readFails: true },
        { id: "broken", subject: "Your application", chatFails: true },
        { id: "fine" },
      ],
    });
    assert.deepEqual(summary.failed, [
      {
        thread: "gone",
        sender: null,
        subject: null,
        date: null,
        reason: "Gmail request failed: gone",
      },
      {
        thread: "broken",
        sender: PERSON_SENDER,
        subject: "Your application",
        date: "2026-01-02T08:00:00Z",
        reason: "status 500: model fell over",
      },
    ]);
    assert.deepEqual(summary.status.threads, ["fine"]);
    assert.equal(summary.threadsListed, 3);
  });
});

// Breaks if the window check is dropped: the model would read a thread whose
// every message is older than the window.
test("a thread with no message in the window is failed and gets no model call", async () => {
  await withRoot(async (root) => {
    const { summary, calls } = await runOk(root, {
      threads: [{ id: "old", date: "2025-12-20T08:00:00Z" }],
    });
    assert.deepEqual(summary.failed, [
      {
        thread: "old",
        sender: null,
        subject: null,
        date: null,
        reason: "no message in the window",
      },
    ]);
    assert.deepEqual(
      calls.filter((call) => call.startsWith("chat")),
      [],
    );
  });
});

// Breaks if a partial listing passes as complete.
test("a failed day listing returns ok false", async () => {
  await withRoot(async (root) => {
    const { fetch } = fakeFetch({ threads: [{ id: "t1" }], listingFails: true });
    assert.deepEqual(await runCheck(SINCE, root, dependencies(fetch)), {
      ok: false,
      reason: "Gmail request failed: quota",
    });
  });
});

// Breaks if the Ollama check moves after any Gmail call or the token.
test("Ollama down returns ok false with no call to a Gmail URL", async () => {
  await withRoot(async (root) => {
    const { fetch, calls } = fakeFetch({ threads: [{ id: "t1" }], ollamaDown: true });
    let tokenAsked = false;
    const result = await runCheck(SINCE, root, {
      ...dependencies(fetch),
      accessToken: async () => {
        tokenAsked = true;
        return { ok: true, value: TOKEN };
      },
    });
    assert.deepEqual(result, {
      ok: false,
      reason: "Ollama is not answering at 127.0.0.1:11434",
    });
    assert.deepEqual(calls, ["tags"]);
    assert.equal(tokenAsked, false);
  });
});

// Breaks if the token's failure is ignored.
test("a refused access token returns its reason with no call to a Gmail URL", async () => {
  await withRoot(async (root) => {
    const { fetch, calls } = fakeFetch({ threads: [{ id: "t1" }] });
    const result = await runCheck(SINCE, root, {
      ...dependencies(fetch),
      accessToken: async () => ({ ok: false, reason: "no Gmail token in Keychain" }),
    });
    assert.deepEqual(result, { ok: false, reason: "no Gmail token in Keychain" });
    assert.deepEqual(calls, ["tags"]);
  });
});

// Breaks if the store copy moves after the thread reads.
test("a dead store fails before any thread is read", async () => {
  await withRoot(async (root) => {
    const { fetch, calls } = fakeFetch({ threads: [{ id: "t1" }] });
    const dead = {
      ...memoryStore(),
      select: async () => {
        throw new Error("connection refused");
      },
    };
    await assert.rejects(runCheck(SINCE, root, { ...dependencies(fetch), store: dead }), {
      message: "connection refused",
    });
    assert.deepEqual(calls, ["tags", "gmail list", "gmail list", "gmail list"]);
  });
});

// Breaks if a thread is read inside the extraction loop, where the access
// token could expire.
test("all thread reads happen before the first model call", async () => {
  await withRoot(async (root) => {
    const { calls } = await runOk(root, { threads: [{ id: "t1" }, { id: "t2" }] });
    assert.deepEqual(calls.slice(4), ["gmail read t1", "gmail read t2", "chat t1", "chat t2"]);
  });
});

// Breaks if the log carries a subject or sender, or its count is wrong.
test("the log carries the count and the thread id only", async () => {
  await withRoot(async (root) => {
    const { logged } = await runOk(root, {
      threads: [
        { id: "t1", subject: "A private subject" },
        { id: "t2", subject: "Another private subject" },
      ],
    });
    assert.deepEqual(logged, ["1/2 t1", "2/2 t2"]);
  });
});

// Breaks if a write lands outside the since directory, or a file goes missing.
test("no file exists under root outside captures/job-email/<since>/", async () => {
  await withRoot(async (root) => {
    await runOk(root, { threads: [{ id: "t1" }] });
    const files = filesUnder(root)
      .map((path) => relative(root, path))
      .toSorted();
    const directory = join("captures", "job-email", SINCE);
    assert.deepEqual(
      files,
      [
        "neither.jsonl",
        "rows-status.jsonl",
        "rows-suggestions-1.jsonl",
        join("store", "candidates.jsonl"),
        join("store", "companies.jsonl"),
        join("store", "criteria.jsonl"),
        join("store", "postings.jsonl"),
        "summary.json",
      ]
        .map((name) => join(directory, name))
        .toSorted(),
    );
  });
});

// Breaks if the token is ever copied into the summary or a file. The fake
// fetch asserts the token was sent, so its absence here is not vacuous.
test("the summary and every written file lack the token", async () => {
  await withRoot(async (root) => {
    const { summary } = await runOk(root, {
      threads: [{ id: "t1" }, { id: "gone", readFails: true }, { id: "broken", chatFails: true }],
    });
    assert.ok(!JSON.stringify(summary).includes(TOKEN));
    for (const path of filesUnder(root)) {
      assert.ok(!readFileSync(path, "utf8").includes(TOKEN), path);
    }
  });
});

// Breaks if summary.json on disk stops matching what the skill is told.
test("summary.json holds the returned summary with absolute paths", async () => {
  await withRoot(async (root) => {
    const { summary } = await runOk(root, { threads: [{ id: "t1" }] });
    const directory = join(root, "captures", "job-email", SINCE);
    assert.deepEqual(JSON.parse(readFileSync(join(directory, "summary.json"), "utf8")), summary);
    assert.equal(summary.after, "2026/01/01");
    assert.equal(summary.daysSearched, 3);
    assert.equal(summary.threadsListed, 1);
    assert.equal(summary.store, join(directory, "store"));
    assert.equal(summary.neither, join(directory, "neither.jsonl"));
    assert.equal(summary.status.rows, join(directory, "rows-status.jsonl"));
  });
});

// Breaks if a later run leaves an earlier run's batch 2 beside its own batch 1.
test("a later run with the same since replaces the files it writes", async () => {
  await withRoot(async (root) => {
    const many = Array.from({ length: 11 }, (_, index) => ({
      id: `s${index}`,
      sender: ALERT_SENDER,
    }));
    await runOk(root, { threads: many });
    const directory = join(root, "captures", "job-email", SINCE);
    assert.ok(existsSync(join(directory, "rows-suggestions-2.jsonl")));
    await runOk(root, { threads: [{ id: "only", sender: ALERT_SENDER }] });
    assert.deepEqual(threadIdsIn(join(directory, "rows-suggestions-1.jsonl")), ["only"]);
    assert.equal(existsSync(join(directory, "rows-suggestions-2.jsonl")), false);
  });
});

// Each breaks if its form of the argument stops parsing or starts passing.
test("parseSince takes a date, Nd and null, and refuses anything else", () => {
  const today = new Date("2026-03-10T23:30:00Z");
  assert.deepEqual(parseSince("2026-02-28", today), { ok: true, value: "2026-02-28" });
  assert.deepEqual(parseSince("7d", today), { ok: true, value: "2026-03-03" });
  assert.deepEqual(parseSince("10d", today), { ok: true, value: "2026-02-28" });
  assert.deepEqual(parseSince("0d", today), { ok: true, value: "2026-03-10" });
  assert.deepEqual(parseSince(null, today), { ok: true, value: "2026-03-03" });
  for (const garbage of ["soon", "", "7", "d", "-7d", "2026-02-30", "2026-13-01", "26-01-01"]) {
    const parsed = parseSince(garbage, today);
    assert.equal(parsed.ok, false, garbage);
  }
});

// Breaks if the hint stops naming the directory, or attaches to Gmail reasons.
test("withOllamaHint appends how to start Ollama only to Ollama's reasons", () => {
  const reason = "Ollama is not answering at 127.0.0.1:11434";
  const bare = `${reason}; start it in its own terminal: ollama serve`;
  assert.equal(withOllamaHint(reason, undefined), bare);
  assert.equal(withOllamaHint(reason, ""), bare);
  assert.equal(
    withOllamaHint(reason, "/opt/fernwood"),
    `${reason}; start it in its own terminal: cd /opt/fernwood && ./ollama serve`,
  );
  assert.equal(
    withOllamaHint("Gmail request failed: quota", "/opt/fernwood"),
    "Gmail request failed: quota",
  );
});

// Breaks if a missing credentials file throws or stops naming its path.
test("credentialsAt names the path of a missing credentials file", async () => {
  await withRoot(async (root) => {
    const path = join(root, "gmail-credentials.json");
    assert.deepEqual(credentialsAt(path), {
      ok: false,
      reason: `no Gmail credentials file at ${path}`,
    });
  });
});
