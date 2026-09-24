// The capture contract: the JSON a session writes to `captures/*.json` after
// driving the Gmail connector. `readCapture` is the boundary — everything
// past it reads a typed `Capture`, and nothing downstream touches the raw
// file again. A malformed capture is an expected failure (a session wrote a
// bad file), so this returns a reason rather than throwing.

export interface CaptureMessage {
  readonly id: string;
  readonly date: string;
  readonly sender: string;
  readonly sender_name?: string;
  readonly to?: readonly string[];
  readonly labels?: readonly string[];
  readonly subject?: string;
  readonly body?: string;
}

export interface CaptureThread {
  readonly id: string;
  readonly subject?: string;
  readonly messages: readonly CaptureMessage[];
}

export interface Capture {
  readonly captured_at: string;
  readonly account: string;
  readonly query: string;
  readonly threads: readonly CaptureThread[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// `typeof` alone tells a string apart from `{ error }`, so this is safe to
// call on every field-reader's result without a separate string check.
function isError(value: unknown): value is { error: string } {
  return typeof value === "object" && value !== null && "error" in value;
}

function readRequiredString(
  record: Record<string, unknown>,
  field: string,
): string | { error: string } {
  const value = record[field];
  if (typeof value !== "string" || value === "") {
    return { error: `capture field "${field}" must be a non-empty string` };
  }
  return value;
}

function readOptionalString(
  record: Record<string, unknown>,
  field: string,
): string | undefined | { error: string } {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    return { error: `capture field "${field}" must be a string` };
  }
  return value;
}

function readOptionalStringArray(
  record: Record<string, unknown>,
  field: string,
): readonly string[] | undefined | { error: string } {
  const value = record[field];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return { error: `capture field "${field}" must be an array of strings` };
  }
  return value;
}

function readCaptureMessage(value: unknown): CaptureMessage | { error: string } {
  if (!isRecord(value)) return { error: "capture message must be an object" };

  const id = readRequiredString(value, "id");
  if (isError(id)) return id;
  const date = readRequiredString(value, "date");
  if (isError(date)) return date;
  const sender = readRequiredString(value, "sender");
  if (isError(sender)) return sender;
  const senderName = readOptionalString(value, "sender_name");
  if (isError(senderName)) return senderName;
  const to = readOptionalStringArray(value, "to");
  if (isError(to)) return to;
  const labels = readOptionalStringArray(value, "labels");
  if (isError(labels)) return labels;
  const subject = readOptionalString(value, "subject");
  if (isError(subject)) return subject;
  const body = readOptionalString(value, "body");
  if (isError(body)) return body;

  return {
    id,
    date,
    sender,
    ...(senderName !== undefined ? { sender_name: senderName } : {}),
    ...(to !== undefined ? { to } : {}),
    ...(labels !== undefined ? { labels } : {}),
    ...(subject !== undefined ? { subject } : {}),
    ...(body !== undefined ? { body } : {}),
  };
}

function readCaptureThread(value: unknown): CaptureThread | { error: string } {
  if (!isRecord(value)) return { error: "capture thread must be an object" };

  const id = readRequiredString(value, "id");
  if (isError(id)) return id;
  const subject = readOptionalString(value, "subject");
  if (isError(subject)) return subject;

  const messagesRaw = value["messages"];
  if (!Array.isArray(messagesRaw)) {
    return { error: `capture thread "${id}" field "messages" must be an array` };
  }
  const messages: CaptureMessage[] = [];
  for (const messageRaw of messagesRaw) {
    const message = readCaptureMessage(messageRaw);
    if (isError(message)) return message;
    messages.push(message);
  }

  return {
    id,
    ...(subject !== undefined ? { subject } : {}),
    messages,
  };
}

export function readCapture(value: unknown): Capture | { error: string } {
  if (!isRecord(value)) return { error: "capture must be an object" };

  const capturedAt = readRequiredString(value, "captured_at");
  if (isError(capturedAt)) return capturedAt;
  const account = readRequiredString(value, "account");
  if (isError(account)) return account;
  const query = readRequiredString(value, "query");
  if (isError(query)) return query;

  const threadsRaw = value["threads"];
  if (!Array.isArray(threadsRaw)) {
    return { error: 'capture field "threads" must be an array' };
  }
  const threads: CaptureThread[] = [];
  for (const threadRaw of threadsRaw) {
    const thread = readCaptureThread(threadRaw);
    if (isError(thread)) return thread;
    threads.push(thread);
  }

  return {
    captured_at: capturedAt,
    account,
    query,
    threads,
  };
}
