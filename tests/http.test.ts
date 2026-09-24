import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HttpError,
  getJson,
  getText,
  hostDelayMs,
  htmlToText,
  httpStats,
  retryAfterMs,
} from "../src/net/http.ts";

// The client no longer carries a built-in User-Agent; it is required from
// settings and most of this file's tests supply it through
// `HttpOptions.userAgent` so they exercise the real header-building path
// without touching the real, gitignored `settings/config.json`. The two that
// are about the settings read itself pass `HttpOptions.settingsDir` instead.
const TEST_USER_AGENT = "test-bot (+https://example.com)";

// A mock sleep records what it was asked to wait but does not advance the
// clock, so the per-host delay (which reads Date.now()) fires before every
// retry. The "host delay" entries are "500ms minus however long the last
// step really took", so they land a few milliseconds under 500 and are
// named rather than asserted exactly; the ladder and Retry-After waits are
// exact.
function sleepShape(calls: readonly number[]): string[] {
  return calls.map((ms) => (ms > 0 && ms <= 500 ? "host delay" : String(ms)));
}

// A 429 is a quota the host has stated, so it costs one request and no
// wait: 77 Workable boards each burning a 240s ladder against a host
// answering 429 to everything is what killed a `list` phase on 2026-09-22.
test("HTTP: a 429 is asked once, throws, and waits for nothing", async () => {
  let callCount = 0;
  const mockFetch: typeof fetch = async () => {
    callCount++;
    return new Response(null, { status: 429 });
  };

  const sleepCalls: number[] = [];
  const mockSleep = async (ms: number) => {
    sleepCalls.push(ms);
  };

  await assert.rejects(
    getJson("http://quota-test.com", {
      fetchImpl: mockFetch,
      userAgent: TEST_USER_AGENT,
      sleep: mockSleep,
    }),
    (err: unknown) => {
      assert(err instanceof HttpError);
      assert.equal(err.status, 429);
      assert.equal(err.message, "HTTP 429");
      return true;
    },
  );

  assert.equal(callCount, 1);
  // No ladder wait, and no politeness wait either: this host has not been
  // asked before, so its first attempt owes nothing.
  assert.deepEqual(sleepShape(sleepCalls), []);
});

// The header a 429 carries is not read at all now, so a host naming a wait
// cannot buy one: the request still costs exactly one attempt.
test("HTTP: a 429's Retry-After does not buy it a retry", async () => {
  let callCount = 0;
  const mockFetch: typeof fetch = async () => {
    callCount++;
    return new Response(null, { status: 429, headers: { "Retry-After": "7" } });
  };

  const sleepCalls: number[] = [];
  await assert.rejects(
    getText("http://quota-retryafter-test.com", {
      fetchImpl: mockFetch,
      userAgent: TEST_USER_AGENT,
      sleep: async (ms: number) => {
        sleepCalls.push(ms);
      },
    }),
    HttpError,
  );

  assert.equal(callCount, 1);
  assert.deepEqual(sleepShape(sleepCalls), []);
});

test("HTTP: four failures throwing", async () => {
  let callCount = 0;
  const mockFetch: typeof fetch = async () => {
    callCount++;
    return new Response(null, { status: 500 });
  };

  let sleepCalls: number[] = [];
  const mockSleep = async (ms: number) => {
    sleepCalls.push(ms);
  };

  try {
    await getText("http://failures-test.com", {
      fetchImpl: mockFetch,
      userAgent: TEST_USER_AGENT,
      sleep: mockSleep,
    });
    assert.fail("Should have thrown");
  } catch (err) {
    assert(err instanceof Error);
    assert(err.message.includes("HTTP 500"));
    assert.equal(callCount, 5);
    // Four ladder sleeps (2s, 4s, 8s, 16s), each followed by the host delay.
    assert.deepEqual(sleepShape(sleepCalls), [
      "2000",
      "host delay",
      "4000",
      "host delay",
      "8000",
      "host delay",
      "16000",
      "host delay",
    ]);
  }
});

test("HTTP: a 404 rejects with an HttpError carrying the status", async () => {
  const mockFetch: typeof fetch = async () => new Response(null, { status: 404 });

  try {
    await getJson("http://not-found-test.com", {
      fetchImpl: mockFetch,
      userAgent: TEST_USER_AGENT,
      sleep: async () => {},
    });
    assert.fail("Should have thrown");
  } catch (err) {
    assert(err instanceof HttpError);
    assert.equal(err.status, 404);
    assert.equal(err.message, "HTTP 404");
  }
});

test("HTTP: the retry ladder's exhaustion on 503 rejects with an HttpError carrying the status", async () => {
  let callCount = 0;
  const mockFetch: typeof fetch = async () => {
    callCount++;
    return new Response(null, { status: 503 });
  };
  const sleepCalls: number[] = [];
  const mockSleep = async (ms: number) => {
    sleepCalls.push(ms);
  };

  try {
    await getText("http://exhausted-test.com", {
      fetchImpl: mockFetch,
      userAgent: TEST_USER_AGENT,
      sleep: mockSleep,
    });
    assert.fail("Should have thrown");
  } catch (err) {
    assert(err instanceof HttpError);
    assert.equal(err.status, 503);
    assert.equal(err.message, "HTTP 503 after 4 retries");
    assert.equal(callCount, 5);
    // The 429 above lost its ladder; a 503's is unchanged.
    assert.deepEqual(sleepShape(sleepCalls), [
      "2000",
      "host delay",
      "4000",
      "host delay",
      "8000",
      "host delay",
      "16000",
      "host delay",
    ]);
  }
});

test("HTTP: every request names the tool and a contact URL in its user-agent", async () => {
  const sent: Array<Record<string, string>> = [];
  const mockFetch: typeof fetch = async (_input, init) => {
    sent.push((init?.headers ?? {}) as Record<string, string>);
    return new Response("ok", { status: 200 });
  };

  await getText("http://useragent-test.com", {
    fetchImpl: mockFetch,
    userAgent: TEST_USER_AGENT,
    sleep: async () => {},
  });

  assert.deepEqual(sent, [{ "User-Agent": TEST_USER_AGENT }]);
});

test("HTTP: a caller's own headers are sent alongside the user-agent", async () => {
  const sent: Array<Record<string, string>> = [];
  const mockFetch: typeof fetch = async (_input, init) => {
    sent.push((init?.headers ?? {}) as Record<string, string>);
    return new Response("ok", { status: 200 });
  };

  await getText("http://useragent-merge-test.com", {
    fetchImpl: mockFetch,
    userAgent: TEST_USER_AGENT,
    sleep: async () => {},
    headers: { Accept: "application/json" },
  });

  assert.deepEqual(sent, [
    {
      "User-Agent": TEST_USER_AGENT,
      Accept: "application/json",
    },
  ]);
});

// The two tests below drive the settings read itself rather than the
// `userAgent` override, so they need a settings directory of their own. They
// must not read the repository's `settings/`, because an operator who has
// followed the README has one and it carries a real User-Agent.
function settingsDirWith(config?: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "job-search-http-settings-"));
  if (config !== undefined) {
    writeFileSync(join(dir, "config.json"), JSON.stringify(config));
  }
  return dir;
}

test("HTTP: the User-Agent comes from the configured settings directory", async () => {
  const sent: Array<Record<string, string>> = [];
  const mockFetch: typeof fetch = async (_input, init) => {
    sent.push((init?.headers ?? {}) as Record<string, string>);
    return new Response("ok", { status: 200 });
  };

  await getText("http://settings-useragent-test.com", {
    fetchImpl: mockFetch,
    sleep: async () => {},
    settingsDir: settingsDirWith({ userAgent: "configured-bot (+https://example.com/operator)" }),
  });

  assert.deepEqual(sent, [{ "User-Agent": "configured-bot (+https://example.com/operator)" }]);
});

test("HTTP: with no User-Agent configured, the request is never made and the failure names the setting", async () => {
  let called = false;
  const mockFetch: typeof fetch = async () => {
    called = true;
    return new Response("ok", { status: 200 });
  };

  await assert.rejects(
    getText("http://no-useragent-test.com", {
      fetchImpl: mockFetch,
      sleep: async () => {},
      settingsDir: settingsDirWith(),
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /settings\/config\.json/);
      assert.match(error.message, /userAgent/);
      return true;
    },
  );

  assert.equal(called, false, "no request should be attempted without a configured User-Agent");
});

test("HTTP: a 503's Retry-After is waited instead of the ladder's own guess", async () => {
  let callCount = 0;
  const mockFetch: typeof fetch = async () => {
    callCount++;
    if (callCount === 1) {
      return new Response(null, { status: 503, headers: { "Retry-After": "7" } });
    }
    return new Response("ok", { status: 200 });
  };

  const sleepCalls: number[] = [];
  await getText("http://retryafter-test.com", {
    fetchImpl: mockFetch,
    userAgent: TEST_USER_AGENT,
    sleep: async (ms: number) => {
      sleepCalls.push(ms);
    },
  });

  // 7s as asked, not the ladder's 2s.
  assert.deepEqual(sleepShape(sleepCalls), ["7000", "host delay"]);
});

test("HTTP: a 503 with no readable Retry-After still walks the ladder", async () => {
  let callCount = 0;
  const mockFetch: typeof fetch = async () => {
    callCount++;
    if (callCount === 1) {
      return new Response(null, { status: 503, headers: { "Retry-After": "not a delay" } });
    }
    return new Response("ok", { status: 200 });
  };

  const sleepCalls: number[] = [];
  await getText("http://retryafter-junk-test.com", {
    fetchImpl: mockFetch,
    userAgent: TEST_USER_AGENT,
    sleep: async (ms: number) => {
      sleepCalls.push(ms);
    },
  });

  assert.deepEqual(sleepShape(sleepCalls), ["2000", "host delay"]);
});

test("retryAfterMs: delay-seconds read as milliseconds", () => {
  assert.equal(retryAfterMs("30", 0), 30_000);
  assert.equal(retryAfterMs("  30  ", 0), 30_000);
});

test("retryAfterMs: an HTTP date reads as the wait from now", () => {
  const now = Date.parse("Tue, 15 Sep 2026 12:00:00 GMT");
  assert.equal(retryAfterMs("Tue, 15 Sep 2026 12:00:10 GMT", now), 10_000);
});

test("retryAfterMs: a date already past reads as no wait, never a negative one", () => {
  const now = Date.parse("Tue, 15 Sep 2026 12:00:00 GMT");
  assert.equal(retryAfterMs("Tue, 15 Sep 2026 11:59:00 GMT", now), 0);
});

test("retryAfterMs: a hostile wait is capped at 60s in either form", () => {
  const now = Date.parse("Tue, 15 Sep 2026 12:00:00 GMT");
  assert.equal(retryAfterMs("86400", now), 60_000);
  assert.equal(retryAfterMs("Wed, 16 Sep 2026 12:00:00 GMT", now), 60_000);
});

test("retryAfterMs: an absent or unreadable header reads as null", () => {
  assert.equal(retryAfterMs(null, 0), null);
  assert.equal(retryAfterMs("", 0), null);
  assert.equal(retryAfterMs("soon", 0), null);
});

test("HTTP: a timed-out request waits before it is retried", async () => {
  let callCount = 0;
  const mockFetch: typeof fetch = async () => {
    callCount++;
    if (callCount <= 2) {
      const aborted = new Error("The operation was aborted");
      aborted.name = "AbortError";
      throw aborted;
    }
    return new Response("ok", { status: 200 });
  };

  const sleepCalls: number[] = [];
  const body = await getText("http://abort-test.com", {
    fetchImpl: mockFetch,
    userAgent: TEST_USER_AGENT,
    sleep: async (ms: number) => {
      sleepCalls.push(ms);
    },
  });

  assert.equal(body, "ok");
  assert.equal(callCount, 3);
  // Two ladder waits, not a hot loop.
  assert.deepEqual(sleepShape(sleepCalls), ["2000", "host delay", "4000", "host delay"]);
});

test("HTTP: a network-level failure is retried like a timeout", async () => {
  let callCount = 0;
  const mockFetch: typeof fetch = async () => {
    callCount++;
    if (callCount <= 2) {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
      });
    }
    return new Response("ok", { status: 200 });
  };

  const sleepCalls: number[] = [];
  const body = await getText("http://econnreset-test.com", {
    fetchImpl: mockFetch,
    userAgent: TEST_USER_AGENT,
    sleep: async (ms: number) => {
      sleepCalls.push(ms);
    },
  });

  assert.equal(body, "ok");
  assert.equal(callCount, 3);
  assert.deepEqual(sleepShape(sleepCalls), ["2000", "host delay", "4000", "host delay"]);
});

// A network-level failure is exactly what a probe's wrong slug guess looks
// like: a DNS failure for a subdomain nobody registered. The pair below
// fixes both halves - `retries: 0` asks once, and a caller that names no
// count still climbs the whole ladder.
function alwaysFetchFails(counter: { calls: number }): typeof fetch {
  return async () => {
    counter.calls++;
    throw Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }),
    });
  };
}

test("HTTP: retries: 0 attempts a network-level failure exactly once", async () => {
  const counter = { calls: 0 };
  const sleepCalls: number[] = [];

  await assert.rejects(
    getText("http://no-retries-test.com", {
      fetchImpl: alwaysFetchFails(counter),
      userAgent: TEST_USER_AGENT,
      sleep: async (ms: number) => {
        sleepCalls.push(ms);
      },
      retries: 0,
    }),
    TypeError,
  );

  assert.equal(counter.calls, 1);
  // No ladder wait, and no politeness wait either: this host has not been
  // asked before, so its first attempt owes nothing.
  assert.deepEqual(sleepShape(sleepCalls), []);
});

test("HTTP: a caller naming no retry count still gets the whole ladder", async () => {
  const counter = { calls: 0 };
  const sleepCalls: number[] = [];

  await assert.rejects(
    getText("http://default-retries-test.com", {
      fetchImpl: alwaysFetchFails(counter),
      userAgent: TEST_USER_AGENT,
      sleep: async (ms: number) => {
        sleepCalls.push(ms);
      },
    }),
    TypeError,
  );

  assert.equal(counter.calls, 5);
  assert.deepEqual(sleepShape(sleepCalls), [
    "2000",
    "host delay",
    "4000",
    "host delay",
    "8000",
    "host delay",
    "16000",
    "host delay",
  ]);
});

test("hostDelayMs: a host that declares nothing gets the shared 500ms", () => {
  assert.equal(hostDelayMs("example.com"), 500);
});

test("hostDelayMs: remoteok.com gets the 1s its robots.txt asks for", () => {
  // remoteok.com/robots.txt: `Crawl-delay: 1`.
  assert.equal(hostDelayMs("remoteok.com"), 1000);
});

test("hostDelayMs: Microsoft's Eightfold host gets the 3s that keeps its 404s away", () => {
  assert.equal(hostDelayMs("apply.careers.microsoft.com"), 3000);
});

test("hostDelayMs: Workable's board host gets the 1.5s its 429s asked for", () => {
  // 28 of ~435 requests at the 500ms floor came back 429 on 2026-09-22.
  assert.equal(hostDelayMs("apply.workable.com"), 1500);
});

test("hostDelayMs: Workable's delay is keyed to that host alone, not the domain", () => {
  // An entry matched by suffix rather than by exact host would slow every
  // other Workable host to 1500ms; only `apply.workable.com` answered 429.
  assert.equal(hostDelayMs("workable.com"), 500);
  assert.equal(hostDelayMs("www.workable.com"), 500);
  assert.equal(hostDelayMs("careers.workable.com"), 500);
});
test("HTTP: a host that declares a longer delay is waited that long between requests", async () => {
  const mockFetch: typeof fetch = async () => new Response("ok", { status: 200 });

  const sleepCalls: number[] = [];
  const mockSleep = async (ms: number) => {
    sleepCalls.push(ms);
  };

  await getText("https://remoteok.com/api", {
    fetchImpl: mockFetch,
    sleep: mockSleep,
    userAgent: TEST_USER_AGENT,
  });
  await getText("https://remoteok.com/api", {
    fetchImpl: mockFetch,
    sleep: mockSleep,
    userAgent: TEST_USER_AGENT,
  });

  // The declared 1s, not the shared 500ms, before the second.
  assert.equal(sleepCalls.length, 1);
  assert.ok(sleepCalls[0] > 500 && sleepCalls[0] <= 1000, `slept ${sleepCalls[0]}ms`);
});

test("HTTP: rate limiting on same host", async () => {
  const timings: number[] = [];
  const mockFetch: typeof fetch = async () => {
    timings.push(Date.now());
    return new Response("ok", { status: 200 });
  };

  const sleepTimes: number[] = [];
  const mockSleep = async (ms: number) => {
    sleepTimes.push(ms);
    await new Promise((resolve) => setTimeout(resolve, ms));
  };

  await getText("http://ratelimit-test.com/1", {
    fetchImpl: mockFetch,
    userAgent: TEST_USER_AGENT,
    sleep: mockSleep,
  });

  const firstTime = timings[0];

  await getText("http://ratelimit-test.com/2", {
    fetchImpl: mockFetch,
    userAgent: TEST_USER_AGENT,
    sleep: mockSleep,
  });

  const secondTime = timings[1];
  const elapsed = secondTime - firstTime;

  assert(elapsed >= 450 && elapsed <= 600, `Elapsed: ${elapsed}ms`);
  assert(sleepTimes.some((ms) => ms >= 450 && ms <= 550));
});

test("HTTP: no rate limiting across different hosts", async () => {
  const timings: number[] = [];
  const mockFetch: typeof fetch = async () => {
    timings.push(Date.now());
    return new Response("ok", { status: 200 });
  };

  const mockSleep = async (_ms: number) => {
    // Records nothing and waits for nothing.
  };

  await getText("http://diffhost1-test.com/1", {
    fetchImpl: mockFetch,
    userAgent: TEST_USER_AGENT,
    sleep: mockSleep,
  });

  const firstTime = timings[0];

  await getText("http://diffhost2-test.com/1", {
    fetchImpl: mockFetch,
    userAgent: TEST_USER_AGENT,
    sleep: mockSleep,
  });

  const secondTime = timings[1];
  const elapsed = secondTime - firstTime;

  assert(elapsed < 100, `Elapsed: ${elapsed}ms, should be < 100ms`);
});

test("htmlToText: double-encoded entities decoded", () => {
  // &amp;nbsp; is double-encoded.
  const html = "Hello&amp;nbsp;World";
  const result = htmlToText(html);
  assert.equal(result, "Hello World");
});

test("htmlToText: a dash entity decodes to the dash, so a pay range reads as one", () => {
  assert.equal(htmlToText("$204,000 &mdash; $255,000 USD"), "$204,000 — $255,000 USD");
  assert.equal(htmlToText("$198,000 &ndash; $233,000"), "$198,000 – $233,000");
});

test("htmlToText: strips tags", () => {
  const html = "<p>Hello <b>World</b></p>";
  const result = htmlToText(html);
  assert.equal(result, "Hello World");
});

test("htmlToText: adjacent blocks keep the boundary between them", () => {
  // Deleting the tags glued these into "Compensation$150,000" and "RustGo".
  assert.equal(htmlToText("<p>Compensation</p><p>$150,000</p>"), "Compensation\n$150,000");
  assert.equal(htmlToText("<li>Rust</li><li>Go</li>"), "Rust\nGo");
});

test("htmlToText: a block tag ends a line and an inline tag does not", () => {
  // A bulleted list carries no sentence-ending punctuation, so with every
  // tag as a space one stray word in it decides the posting.
  assert.equal(
    htmlToText("<ul><li>Fully remote</li><li>Commuter benefits</li></ul>"),
    "Fully remote\nCommuter benefits",
  );
  assert.equal(htmlToText("Work<br/>from<br />home"), "Work\nfrom\nhome");
  assert.equal(htmlToText('<div class="row"><h2>Logistics</h2>Remote</div>'), "Logistics\nRemote");
  assert.equal(htmlToText("<p>Ruby, <b>Perl</b> and <i>Lisp</i></p>"), "Ruby, Perl and Lisp");
  assert.equal(
    htmlToText('<p>This is a <a href="/x">fully remote</a> role</p>'),
    "This is a fully remote role",
  );
});

test("htmlToText: a newline in the source is not a block boundary", () => {
  // Only a block tag ends a line: a body wrapped at 80 columns would
  // otherwise arrive as a clause per line.
  assert.equal(htmlToText("<p>This role is\nfully\n\nremote.</p>"), "This role is fully remote.");
});

test("htmlToText: collapses runs of spaces within a line", () => {
  // With no tags in the input a newline is a clause boundary; horizontal
  // whitespace still collapses, which is what this test is for.
  assert.equal(htmlToText("Hello      World"), "Hello World");
  assert.equal(htmlToText("<p>Hello  \t  World</p>"), "Hello World");
});

test("htmlToText: caps at 12000 characters", () => {
  const text = "a".repeat(15000);
  const result = htmlToText(text);
  assert.equal(result.length, 12000);
  assert.equal(result, "a".repeat(12000));
});

test("htmlToText: combination of transformations", () => {
  const html = "<p>Test&amp;nbsp;&amp;nbsp;<b>content</b>   with   \n  spaces</p>";
  const result = htmlToText(html);
  assert.equal(result, "Test content with spaces");
});

test("htmlToText: markup that arrives entity-encoded is stripped, not left as text", () => {
  // Greenhouse sends its `content` this way. Stripping tags before decoding
  // leaves "<p>" in the text the criteria read.
  const result = htmlToText("&lt;p&gt;Remote-first&lt;/p&gt;&lt;p&gt;#LI-Remote&lt;/p&gt;");
  assert.equal(result, "Remote-first\n#LI-Remote");
});

test("htmlToText: in a body with no tags, a newline is a clause boundary", () => {
  // Ashby and Lever hand over `descriptionPlain`: no markup, and the
  // newlines carry the list structure.
  const result = htmlToText(
    "What we offer:\n- Fully remote within the US\n- Commuter benefits for hybrid staff",
  );
  assert.equal(
    result,
    "What we offer:\n- Fully remote within the US\n- Commuter benefits for hybrid staff",
  );
});

test("htmlToText: in real markup, a wrapped line is not a clause boundary", () => {
  // Breaking a wrapped sentence would separate a "not" from the "remote"
  // it negates.
  const result = htmlToText("<p>We are not offering relocation,\nsponsorship, or remote work.</p>");
  assert.equal(result, "We are not offering relocation, sponsorship, or remote work.");
});

test("httpStats counts every attempt by host and the time a caller waited", async () => {
  let callCount = 0;
  const mockFetch: typeof fetch = async () => {
    callCount++;
    if (callCount === 1) return new Response(null, { status: 503 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const noSleep = async () => {};
  const before = httpStats();

  await getJson("http://tally-a.test/one", {
    fetchImpl: mockFetch,
    sleep: noSleep,
    userAgent: TEST_USER_AGENT,
  });
  await getJson("http://tally-b.test/two", {
    fetchImpl: mockFetch,
    sleep: noSleep,
    userAgent: TEST_USER_AGENT,
  });

  const after = httpStats();
  assert.equal(after.requests - before.requests, 3, "one retry makes three attempts");
  assert.equal(after.hosts.get("tally-a.test")?.requests, 2);
  assert.equal(after.hosts.get("tally-b.test")?.requests, 1);
  assert.ok((after.hosts.get("tally-a.test")?.ms ?? 0) >= 0);
  assert.ok(after.ms >= before.ms);
});

// `fetch` resolves when the response headers arrive, which is before any of
// the body has been read. An earlier version cleared the abort timer at that
// moment and handed the Response to the caller, so a host that sent headers
// and then stalled its body left the caller waiting on `.text()` with no
// timer left to interrupt it. The body is now read inside the timeout, and
// no Response escapes for anyone to read it later.
test("HTTP: a response whose body never arrives is aborted, not waited on forever", async () => {
  // Node's fetch ties the request's signal to the body stream, so an abort
  // rejects a read in flight. The mock has to do the same or it would hang
  // whatever the client does, and prove nothing.
  const mockFetch: typeof fetch = async (_input, init) => {
    const signal = init?.signal ?? null;
    const stalled = new ReadableStream({
      start(controller) {
        signal?.addEventListener("abort", () => {
          controller.error(new DOMException("The operation was aborted.", "AbortError"));
        });
      },
    });
    return new Response(stalled, { status: 200 });
  };

  const started = Date.now();
  await assert.rejects(
    getText("http://stalled-body-test.com", {
      fetchImpl: mockFetch,
      userAgent: TEST_USER_AGENT,
      sleep: async () => {},
      retries: 0,
      timeoutMs: 100,
    }),
  );
  // Far under the real timeout, so this shows the short one governed the
  // body read rather than the request failing for some other reason.
  assert.ok(Date.now() - started < 5000, "the stalled body was not waited out");
});
