import assert from "node:assert/strict";
import { test } from "node:test";

import {
  extractItems,
  MODEL,
  NUM_CTX,
  ollamaReady,
  parseItems,
  SCHEMA,
} from "../scripts/job-email/extract.ts";

// Every company, title and quote here is invented; the fetch is fake.
const GOOD_ITEM = {
  kind: "recruiter_role",
  company: "Fernwood Labs",
  title: "Platform Engineer",
  location: null,
  pay: "$150k",
  status: "none",
  quote: "We would like to talk about a Platform Engineer role.",
};

function chatReply(content: string, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ message: { content }, prompt_eval_count: 900, ...extra }));
}

function recordingFetch(reply: () => Response | Promise<Response>) {
  const calls: { url: string; body: unknown }[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null });
    return reply();
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

test("extractItems posts think false, the schema and 32768 context to local Ollama", async () => {
  const { fetch, calls } = recordingFetch(() => chatReply(JSON.stringify({ items: [] })));
  await extractItems("hello", fetch);
  const body = calls[0].body as Record<string, any>;
  assert.equal(calls[0].url, "http://127.0.0.1:11434/api/chat");
  assert.equal(body.think, false);
  assert.deepEqual(body.format, SCHEMA);
  assert.equal(body.options.num_ctx, 32768);
  assert.equal(NUM_CTX, 32768);
  assert.equal(body.model, MODEL);
  assert.equal(body.messages[1].content, "hello");
});

test("extractItems parses a good reply into items", async () => {
  const { fetch } = recordingFetch(() => chatReply(JSON.stringify({ items: [GOOD_ITEM] })));
  const result = await extractItems("mail", fetch);
  assert.deepEqual(result, { ok: true, value: [GOOD_ITEM] });
});

test("extractItems rejects an item whose kind is not in the enum", async () => {
  const bad = { ...GOOD_ITEM, kind: "cold_call" };
  const { fetch } = recordingFetch(() => chatReply(JSON.stringify({ items: [bad] })));
  const result = await extractItems("mail", fetch);
  assert.equal(result.ok, false);
});

test("extractItems returns ok false for a reply that is not JSON", async () => {
  const { fetch } = recordingFetch(() => chatReply("not json at all"));
  const result = await extractItems("mail", fetch);
  assert.equal(result.ok, false);
});

test("extractItems returns ok false when the body is not JSON", async () => {
  const { fetch } = recordingFetch(() => new Response("<html>oops</html>"));
  const result = await extractItems("mail", fetch);
  assert.equal(result.ok, false);
});

test("extractItems returns ok false with the error for a 500", async () => {
  const { fetch } = recordingFetch(
    () => new Response(JSON.stringify({ error: "model crashed" }), { status: 500 }),
  );
  const result = await extractItems("mail", fetch);
  assert.deepEqual(result, { ok: false, reason: "status 500: model crashed" });
});

test("extractItems returns ok false when the network fails", async () => {
  const fetch = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof globalThis.fetch;
  const result = await extractItems("mail", fetch);
  assert.equal(result.ok, false);
});

test("extractItems refuses a thread that filled the context window", async () => {
  const { fetch } = recordingFetch(() =>
    chatReply(JSON.stringify({ items: [GOOD_ITEM] }), { prompt_eval_count: 32768 }),
  );
  const result = await extractItems("mail", fetch);
  assert.deepEqual(result, {
    ok: false,
    reason: "thread reached the model's context of 32768 tokens and may have been cut",
  });
});

test("extractItems accepts a thread one token under the context window", async () => {
  const { fetch } = recordingFetch(() =>
    chatReply(JSON.stringify({ items: [] }), { prompt_eval_count: 32767 }),
  );
  assert.deepEqual(await extractItems("mail", fetch), { ok: true, value: [] });
});

test("parseItems rejects a missing items array and a null field of the wrong type", () => {
  assert.equal(parseItems({}).ok, false);
  assert.equal(parseItems({ items: [{ ...GOOD_ITEM, pay: 150 }] }).ok, false);
  assert.equal(parseItems({ items: [{ ...GOOD_ITEM, status: "ghosted" }] }).ok, false);
});

test("ollamaReady is ok when the model is listed", async () => {
  const { fetch, calls } = recordingFetch(
    () => new Response(JSON.stringify({ models: [{ name: "other:1b" }, { name: MODEL }] })),
  );
  assert.deepEqual(await ollamaReady(fetch), { ok: true, value: null });
  assert.equal(calls[0].url, "http://127.0.0.1:11434/api/tags");
});

test("ollamaReady reports a refused connection", async () => {
  const fetch = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof globalThis.fetch;
  assert.deepEqual(await ollamaReady(fetch), {
    ok: false,
    reason: "Ollama is not answering at 127.0.0.1:11434",
  });
});

test("ollamaReady reports a missing model", async () => {
  const { fetch } = recordingFetch(
    () => new Response(JSON.stringify({ models: [{ name: "other:1b" }] })),
  );
  assert.deepEqual(await ollamaReady(fetch), {
    ok: false,
    reason: "Ollama has no gemma4:26b-mlx",
  });
});
