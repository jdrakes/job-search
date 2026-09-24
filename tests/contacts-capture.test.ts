import assert from "node:assert/strict";
import { test } from "node:test";

import { readCapture, type Capture } from "../src/contacts/capture.ts";

// A hand-written fixture, not produced by the code under test: every field
// present, so the "well-formed" and "optional fields absent" tests have a
// baseline to diverge from.
function validCapture(): Record<string, unknown> {
  return {
    captured_at: "2026-09-23T09:00:00Z",
    account: "operator@example.com",
    query: "recruiter",
    threads: [
      {
        id: "t1",
        subject: "Following up",
        messages: [
          {
            id: "m1",
            date: "2026-01-05T00:00:00Z",
            sender: "juno@arvelo.partners",
            sender_name: "Priya Okafor",
            to: ["operator@example.com"],
            labels: ["INBOX"],
            subject: "Following up",
            body: "Hi James, still open to a look?",
          },
        ],
      },
    ],
  };
}

function withoutCaptureField(field: string): unknown {
  const capture = validCapture();
  delete capture[field];
  return capture;
}

function withCaptureField(field: string, value: unknown): unknown {
  const capture = validCapture();
  capture[field] = value;
  return capture;
}

function firstMessage(capture: Record<string, unknown>): Record<string, unknown> {
  const threads = capture["threads"] as Record<string, unknown>[];
  const messages = threads[0]!["messages"] as Record<string, unknown>[];
  return messages[0]!;
}

function withoutMessageField(field: string): unknown {
  const capture = validCapture();
  delete firstMessage(capture)[field];
  return capture;
}

function withMessageField(field: string, value: unknown): unknown {
  const capture = validCapture();
  firstMessage(capture)[field] = value;
  return capture;
}

function isError(value: unknown): value is { error: string } {
  return typeof value === "object" && value !== null && "error" in value;
}

test("readCapture: a well-formed capture parses", () => {
  const result = readCapture(validCapture());
  assert.deepEqual(result, {
    captured_at: "2026-09-23T09:00:00Z",
    account: "operator@example.com",
    query: "recruiter",
    threads: [
      {
        id: "t1",
        subject: "Following up",
        messages: [
          {
            id: "m1",
            date: "2026-01-05T00:00:00Z",
            sender: "juno@arvelo.partners",
            sender_name: "Priya Okafor",
            to: ["operator@example.com"],
            labels: ["INBOX"],
            subject: "Following up",
            body: "Hi James, still open to a look?",
          },
        ],
      },
    ],
  });
});

test("readCapture: optional fields the input omitted are absent, not present-and-undefined", () => {
  const capture = validCapture();
  const thread = (capture["threads"] as Record<string, unknown>[])[0]!;
  delete thread["subject"];
  const message = firstMessage(capture);
  delete message["sender_name"];
  delete message["to"];
  delete message["labels"];
  delete message["subject"];
  delete message["body"];

  const result = readCapture(capture);
  if (isError(result)) throw new Error(`expected a parsed capture, got ${result.error}`);

  const parsedThread = result.threads[0]!;
  const parsedMessage = parsedThread.messages[0]!;
  assert.equal("subject" in parsedThread, false);
  assert.equal("sender_name" in parsedMessage, false);
  assert.equal("to" in parsedMessage, false);
  assert.equal("labels" in parsedMessage, false);
  assert.equal("subject" in parsedMessage, false);
  assert.equal("body" in parsedMessage, false);
});

test("readCapture: a missing captured_at returns its reason", () => {
  assert.deepEqual(readCapture(withoutCaptureField("captured_at")), {
    error: 'capture field "captured_at" must be a non-empty string',
  });
});

test("readCapture: an empty captured_at returns its reason", () => {
  assert.deepEqual(readCapture(withCaptureField("captured_at", "")), {
    error: 'capture field "captured_at" must be a non-empty string',
  });
});

test("readCapture: a missing account returns its reason", () => {
  assert.deepEqual(readCapture(withoutCaptureField("account")), {
    error: 'capture field "account" must be a non-empty string',
  });
});

test("readCapture: an empty account returns its reason", () => {
  assert.deepEqual(readCapture(withCaptureField("account", "")), {
    error: 'capture field "account" must be a non-empty string',
  });
});

test("readCapture: a missing query returns its reason", () => {
  assert.deepEqual(readCapture(withoutCaptureField("query")), {
    error: 'capture field "query" must be a non-empty string',
  });
});

test("readCapture: an empty query returns its reason", () => {
  assert.deepEqual(readCapture(withCaptureField("query", "")), {
    error: 'capture field "query" must be a non-empty string',
  });
});

test("readCapture: a missing message id returns its reason", () => {
  assert.deepEqual(readCapture(withoutMessageField("id")), {
    error: 'capture field "id" must be a non-empty string',
  });
});

test("readCapture: an empty message id returns its reason", () => {
  assert.deepEqual(readCapture(withMessageField("id", "")), {
    error: 'capture field "id" must be a non-empty string',
  });
});

test("readCapture: a missing message date returns its reason", () => {
  assert.deepEqual(readCapture(withoutMessageField("date")), {
    error: 'capture field "date" must be a non-empty string',
  });
});

test("readCapture: an empty message date returns its reason", () => {
  assert.deepEqual(readCapture(withMessageField("date", "")), {
    error: 'capture field "date" must be a non-empty string',
  });
});

test("readCapture: a missing message sender returns its reason", () => {
  assert.deepEqual(readCapture(withoutMessageField("sender")), {
    error: 'capture field "sender" must be a non-empty string',
  });
});

test("readCapture: an empty message sender returns its reason", () => {
  assert.deepEqual(readCapture(withMessageField("sender", "")), {
    error: 'capture field "sender" must be a non-empty string',
  });
});

test("readCapture: threads not an array returns an error", () => {
  assert.deepEqual(readCapture(withCaptureField("threads", "not-an-array")), {
    error: 'capture field "threads" must be an array',
  });
});

test("readCapture: a thread's messages not an array returns an error naming the thread id", () => {
  const capture = validCapture();
  const thread = (capture["threads"] as Record<string, unknown>[])[0]!;
  thread["messages"] = "not-an-array";
  assert.deepEqual(readCapture(capture), {
    error: 'capture thread "t1" field "messages" must be an array',
  });
});

test("readCapture: a non-object capture returns its reason", () => {
  assert.deepEqual(readCapture("not-an-object"), { error: "capture must be an object" });
});

test("readCapture: a non-object thread returns its reason", () => {
  const capture = validCapture();
  (capture["threads"] as unknown[])[0] = "not-an-object";
  assert.deepEqual(readCapture(capture), { error: "capture thread must be an object" });
});

test("readCapture: a non-object message returns its reason", () => {
  const capture = validCapture();
  const thread = (capture["threads"] as Record<string, unknown>[])[0]!;
  (thread["messages"] as unknown[])[0] = "not-an-object";
  assert.deepEqual(readCapture(capture), { error: "capture message must be an object" });
});

test("readCapture: sender_name as a number returns its reason", () => {
  assert.deepEqual(readCapture(withMessageField("sender_name", 5)), {
    error: 'capture field "sender_name" must be a string',
  });
});

test("readCapture: to as a string rather than an array returns its reason", () => {
  assert.deepEqual(readCapture(withMessageField("to", "operator@example.com")), {
    error: 'capture field "to" must be an array of strings',
  });
});

test("readCapture: labels containing a non-string returns its reason", () => {
  assert.deepEqual(readCapture(withMessageField("labels", ["SENT", 5])), {
    error: 'capture field "labels" must be an array of strings',
  });
});

test("readCapture: one bad message in the second thread fails the whole capture", () => {
  const capture = validCapture();
  (capture["threads"] as Record<string, unknown>[]).push({
    id: "t2",
    messages: [
      {
        id: "m2",
        date: "2026-01-06T00:00:00Z",
        sender: "",
      },
    ],
  });
  assert.deepEqual(readCapture(capture), {
    error: 'capture field "sender" must be a non-empty string',
  });
});

test("readCapture: a JSON round trip deep-equals the original parsed capture", () => {
  const original = readCapture(validCapture());
  if (isError(original)) throw new Error(`expected a parsed capture, got ${original.error}`);

  const roundTripped = readCapture(JSON.parse(JSON.stringify(validCapture())));
  assert.deepEqual(roundTripped, original satisfies Capture);
});
