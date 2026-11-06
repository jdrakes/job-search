import assert from "node:assert/strict";
import { test } from "node:test";

import { getThread, listWindow, parseThread, utcDays } from "../scripts/job-email/gmail.ts";

// Every address, subject, id and token here is invented; the fetch is fake.
const TOKEN = "fake-access-token-marigold";

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function recordingFetch(replies: (url: URL) => Response) {
  const urls: URL[] = [];
  const fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    urls.push(url);
    return replies(url);
  }) as typeof globalThis.fetch;
  return { fetch, urls };
}

test("utcDays runs from since through today across a month end", () => {
  assert.deepEqual(utcDays("2026-10-30", new Date("2026-11-02T23:59:00Z")), [
    "2026-10-30",
    "2026-10-31",
    "2026-11-01",
    "2026-11-02",
  ]);
});

test("utcDays gives one day when since is today", () => {
  assert.deepEqual(utcDays("2026-11-02", new Date("2026-11-02T00:00:00Z")), ["2026-11-02"]);
});

test("listWindow queries a day by UTC epoch seconds, not by date", async () => {
  const { fetch, urls } = recordingFetch(() => jsonResponse({}));
  await listWindow(TOKEN, ["2026-11-03"], fetch);
  // 2026-11-03T00:00:00Z = 1793664000; the next midnight is 86400 later.
  assert.equal(urls[0].searchParams.get("q"), "after:1793664000 before:1793750400");
  assert.equal(urls[0].searchParams.get("maxResults"), "500");
  assert.equal(urls[0].pathname, "/gmail/v1/users/me/threads");
});

test("listWindow follows nextPageToken until none remains", async () => {
  const { fetch, urls } = recordingFetch((url) =>
    url.searchParams.get("pageToken") === null
      ? jsonResponse({ threads: [{ id: "t1" }], nextPageToken: "page-two" })
      : jsonResponse({ threads: [{ id: "t2" }] }),
  );
  const result = await listWindow(TOKEN, ["2026-11-03"], fetch);
  assert.deepEqual(result, { ok: true, value: ["t1", "t2"] });
  assert.equal(urls.length, 2);
  assert.equal(urls[1].searchParams.get("pageToken"), "page-two");
});

test("listWindow dedupes a thread that spans two days", async () => {
  const { fetch } = recordingFetch((url) =>
    url.searchParams.get("q")?.startsWith("after:1793664000")
      ? jsonResponse({ threads: [{ id: "t1" }, { id: "t2" }] })
      : jsonResponse({ threads: [{ id: "t2" }, { id: "t3" }] }),
  );
  const result = await listWindow(TOKEN, ["2026-11-03", "2026-11-04"], fetch);
  assert.deepEqual(result, { ok: true, value: ["t1", "t2", "t3"] });
});

test("listWindow fails whole when any page fails, and the reason hides the token", async () => {
  const { fetch } = recordingFetch((url) =>
    url.searchParams.get("pageToken") === null
      ? jsonResponse({ threads: [{ id: "t1" }], nextPageToken: "page-two" })
      : jsonResponse({ error: { message: "Backend Error" } }, 500),
  );
  const result = await listWindow(TOKEN, ["2026-11-03"], fetch);
  assert.deepEqual(result, { ok: false, reason: "Gmail request failed: Backend Error" });
});

test("listWindow fails when the network does", async () => {
  const fetch = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof globalThis.fetch;
  const result = await listWindow(TOKEN, ["2026-11-03"], fetch);
  assert.equal(result.ok, false);
});

const MULTIPART = {
  id: "thread-1",
  messages: [
    {
      internalDate: "1793664000123",
      labelIds: ["INBOX", "UNREAD"],
      payload: {
        mimeType: "multipart/mixed",
        headers: [
          { name: "FROM", value: "Pat Example <A@Example.com>" },
          { name: "subject", value: "Interview invite" },
        ],
        parts: [
          {
            mimeType: "multipart/alternative",
            filename: "",
            parts: [
              { mimeType: "text/plain", body: { data: b64("Plain one.") } },
              { mimeType: "text/html", body: { data: b64("<p>Html one.</p>") } },
            ],
          },
          { mimeType: "text/plain", filename: "notes.txt", body: { data: b64("ATTACHMENT") } },
          { mimeType: "text/plain", body: { data: b64("Plain two.") } },
        ],
      },
    },
  ],
};

test("parseThread picks plain text, skips attachments, and normalises headers and date", () => {
  const result = parseThread(MULTIPART);
  assert.deepEqual(result, {
    ok: true,
    value: {
      id: "thread-1",
      messages: [
        {
          sender: "a@example.com",
          subject: "Interview invite",
          date: "2026-11-03T00:00:00Z",
          labels: ["INBOX", "UNREAD"],
          text: "Plain one.\nPlain two.",
        },
      ],
    },
  });
});

function singleMessage(payload: unknown, extra: object = {}) {
  return { id: "t", messages: [{ internalDate: "1793664000000", payload, ...extra }] };
}

test("parseThread strips an HTML-only message and decodes entities", () => {
  const html =
    "<style>p{color:red}</style><script>alert(1)</script><p>Tom &amp; Jerry &lt;3 &quot;hi&quot; it&#39;s&nbsp;ok &#65;</p><div>Next<br>line</div>";
  const result = parseThread(
    singleMessage({
      mimeType: "text/html",
      headers: [{ name: "From", value: "b@example.com" }],
      body: { data: b64(html) },
    }),
  );
  assert.equal(
    result.ok && result.value.messages[0].text,
    'Tom & Jerry <3 "hi" it\'s ok A\nNext\nline\n',
  );
  assert.equal(result.ok && result.value.messages[0].sender, "b@example.com");
  assert.equal(result.ok && result.value.messages[0].subject, "");
  assert.deepEqual(result.ok && result.value.messages[0].labels, []);
});

test("parseThread gives an empty text for a message with no body", () => {
  const result = parseThread(singleMessage({ mimeType: "multipart/mixed", headers: [] }));
  assert.equal(result.ok && result.value.messages[0].text, "");
});

test("parseThread fails on a thread with no messages array", () => {
  assert.equal(parseThread({ id: "t" }).ok, false);
  assert.equal(parseThread(null).ok, false);
});

test("parseThread fails on a message with no internalDate", () => {
  assert.equal(parseThread({ id: "t", messages: [{ payload: { headers: [] } }] }).ok, false);
});

test("getThread requests format=full and parses the reply", async () => {
  const { fetch, urls } = recordingFetch(() => jsonResponse(MULTIPART));
  const result = await getThread(TOKEN, "thread-1", fetch);
  assert.equal(result.ok, true);
  assert.equal(urls[0].pathname, "/gmail/v1/users/me/threads/thread-1");
  assert.equal(urls[0].searchParams.get("format"), "full");
});

test("getThread on a 401 returns the API message and never the token", async () => {
  const { fetch } = recordingFetch(() =>
    jsonResponse({ error: { message: "Invalid Credentials" } }, 401),
  );
  const result = await getThread(TOKEN, "thread-1", fetch);
  assert.deepEqual(result, { ok: false, reason: "Gmail request failed: Invalid Credentials" });
  assert.ok(!JSON.stringify(result).includes(TOKEN));
});

test("getThread falls back to the status line, and catches a network failure", async () => {
  const noBody = recordingFetch(() => new Response("", { status: 503, statusText: "Unavailable" }));
  const status = await getThread(TOKEN, "t", noBody.fetch);
  assert.deepEqual(status, { ok: false, reason: "Gmail request failed: 503 Unavailable" });

  const down = (async () => {
    throw new TypeError("fetch failed", { cause: new Error("ECONNRESET") });
  }) as typeof globalThis.fetch;
  const network = await getThread(TOKEN, "t", down);
  assert.equal(network.ok, false);
  assert.ok(!network.ok && network.reason.includes("ECONNRESET"));
  assert.ok(!network.ok && !network.reason.includes(TOKEN));
});
