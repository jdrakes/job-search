import { loadSettings } from "../settings.ts";

export interface HttpOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  headers?: Record<string, string>;
  // Overrides the User-Agent this call would otherwise resolve from
  // `loadSettings()`. Every production caller leaves this unset; a test can
  // set it to exercise the request path without a real settings/config.json.
  userAgent?: string;
  // The directory `loadSettings()` reads when no `userAgent` is given. Every
  // production caller leaves this unset, taking the repo's own `settings/`.
  // A test that wants the unconfigured case points it at an empty directory,
  // rather than depending on the running clone not having a `settings/` of
  // its own; once an operator follows the README that dependency is false.
  settingsDir?: string;
  // How many times to climb the ladder below before giving up; omitted
  // means the whole of it, so every reader is unchanged. `0` is for a
  // caller whose request is a guess rather than a read of something known
  // to exist - `discovery/probe.ts` - where a failure is the answer, not a
  // fault to wait out. Above the ladder's own length adds nothing.
  retries?: number;
  // How long one attempt may take, headers and body together, before it is
  // aborted. Omitted means TIMEOUT_MS. A test sets it small so it can prove
  // the abort covers a stalled body without waiting the real timeout out.
  timeoutMs?: number;
}

// The one exception to "no classes": a status has to ride along on the
// throw, and an Error subclass is how a typed field survives a catch that
// only sees `unknown`.
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const TIMEOUT_MS = 30_000;
const DEFAULT_HOST_DELAY_MS = 500;
const RETRY_DELAYS = [2000, 4000, 8000, 16000];

// Node's fetch sends `User-Agent: node`; the URL gives a host deciding
// whether to serve us a contact point. There is no built-in default: every
// request this tool makes identifies an operator to a third-party job board,
// so the operator must say who they are before it will run at all.
function requiredUserAgent(settingsDir?: string): string {
  const { userAgent } = settingsDir === undefined ? loadSettings() : loadSettings(settingsDir);
  if (!userAgent) {
    throw new Error(
      'settings/config.json is missing the "userAgent" field. This tool ' +
        "identifies itself to third-party job boards on every request it " +
        "makes, so it needs to know who is running it before it will make " +
        "one.",
    );
  }
  return userAgent;
}

// Hosts whose published crawl policy asks for longer than the shared
// minimum; the delay is a fact about the host, so a second reader of the
// same host cannot forget it by omitting an option.
const HOST_DELAYS_MS: Record<string, number> = {
  // remoteok.com/robots.txt: `Crawl-delay: 1`.
  "remoteok.com": 1000,
  // Answers 404 for live postings under a burst; clean at one per 3 s.
  "apply.careers.microsoft.com": 3000,
  // Its robots.txt publishes no `Crawl-delay` (the whole body is
  // `User-agent: *`, a `Content-Signal` line and an empty `Disallow:`), and
  // the public widget endpoints return no `X-RateLimit-*` and no
  // `Retry-After`, so there is nothing here to self-tune from. What there
  // is: a run on 2026-09-22 made ~435 requests to this host in one pass -
  // 245 probe guesses plus 190 board reads - at the 500 ms floor, i.e. ~2 a
  // second sustained, and 28 of them came back 429 after the full ladder
  // (6.4%); the same morning's ~12 requests saw none. The host is
  // Cloudflare-fronted, so those are likelier edge bot-management than the
  // one documented limit, which is 10 requests per 10 s for an account
  // token on the authenticated `spi/v3` API, not these endpoints - but it
  // is the strictest figure the vendor publishes anywhere, and it is one a
  // second. 1500 ms is ~0.67 a second, under both that figure and the rate
  // that failed. The ceiling is evidenced; this exact number is judgement.
  "apply.workable.com": 1500,
};

export function hostDelayMs(host: string): number {
  return HOST_DELAYS_MS[host] ?? DEFAULT_HOST_DELAY_MS;
}

// A ceiling on what a `Retry-After` can cost, longer than the ladder's own
// longest wait and a request's timeout, so "Retry-After: 86400" cannot
// park a run for a day.
const MAX_RETRY_AFTER_MS = 60_000;

// RFC 9110 allows `Retry-After` as delay-seconds or an HTTP date; a date
// in the past reads as "go now". `null` means the header said nothing
// usable and the caller falls back to its own ladder.
export function retryAfterMs(header: string | null, now: number): number | null {
  if (header === null) return null;
  const value = header.trim();
  if (value === "") return null;

  if (/^\d+$/.test(value)) {
    return Math.min(Number(value) * 1000, MAX_RETRY_AFTER_MS);
  }

  const when = Date.parse(value);
  if (Number.isNaN(when)) return null;
  return Math.min(Math.max(when - now, 0), MAX_RETRY_AFTER_MS);
}

const hostQueues = new Map<string, { lastAt: number }>();

async function rateLimit(host: string, sleepFn: (ms: number) => Promise<void>): Promise<void> {
  let state = hostQueues.get(host);
  if (!state) {
    state = { lastAt: 0 };
    hostQueues.set(host, state);
  }

  const delay = hostDelayMs(host);
  const now = Date.now();
  const elapsed = now - state.lastAt;
  if (elapsed < delay) {
    await sleepFn(delay - elapsed);
  }
  state.lastAt = Date.now();
}

function getHost(urlString: string): string {
  const url = new URL(urlString);
  return url.hostname;
}

// `requests` counts every attempt the retry ladder makes, and `ms` is the
// whole time a caller waited, politeness delays and retry waits included.
export interface RequestTally {
  readonly requests: number;
  readonly ms: number;
}

export interface HttpStats extends RequestTally {
  readonly hosts: ReadonlyMap<string, RequestTally>;
}

const tallies = new Map<string, { requests: number; ms: number }>();

function tallyOf(host: string): { requests: number; ms: number } {
  let tally = tallies.get(host);
  if (tally === undefined) {
    tally = { requests: 0, ms: 0 };
    tallies.set(host, tally);
  }
  return tally;
}

// A copy, so two snapshots diff to one phase's share.
export function httpStats(): HttpStats {
  const hosts = new Map<string, RequestTally>();
  let requests = 0;
  let ms = 0;
  for (const [host, tally] of tallies) {
    hosts.set(host, { ...tally });
    requests += tally.requests;
    ms += tally.ms;
  }
  return { requests, ms, hosts };
}

// The ladder's length is the ceiling as well as the default: there is no
// fifth delay to sleep for.
function retryCount(asked: number | undefined): number {
  if (asked === undefined) return RETRY_DELAYS.length;
  return Math.min(Math.max(asked, 0), RETRY_DELAYS.length);
}

async function fetchWithRetry(
  url: string,
  fetchImpl: typeof fetch,
  sleepFn: (ms: number) => Promise<void>,
  userAgent: string,
  retries: number,
  timeoutMs: number,
  headers?: Record<string, string>,
  requestInit?: { method: string; body: string },
): Promise<{ status: number; ok: boolean; body: string }> {
  const host = getHost(url);
  const tally = tallyOf(host);
  const started = performance.now();
  let lastError: Error | null = null;

  try {
    for (let attempt = 0; attempt <= retries; attempt++) {
      // Before every attempt, not only the first, so a retry burst keeps the
      // politeness budget. After a ladder or Retry-After wait the gap is
      // already spent.
      await rateLimit(host, sleepFn);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const init: RequestInit = {
          signal: controller.signal,
          headers: { "User-Agent": userAgent, ...headers },
          ...requestInit,
        };

        tally.requests += 1;
        const response = await fetchImpl(url, init);

        // A 429 is the vendor stating a quota, not a transient fault, so it
        // is asked once and never retried. Measured on 2026-09-22: after
        // this tool sent ~9,300 requests to apply.workable.com in one day
        // that host answered 429 to everything, in 0.13s. A daily run then
        // spent over two and a half hours in its `list` phase without
        // finishing, because 77 Workable boards each burned a full ladder -
        // up to 240s apiece - against a host that was never going to
        // answer, and the run had to be killed; failing those 77 at once
        // would have cost 0.13s each. Failing fast is safe by the Gone
        // criterion (knowledge-base work/job-search/design.md, Processor):
        // a read that fails says nothing about any posting, so the company
        // is simply not refreshed this run and recovers at the next one.
        if (response.status === 429) {
          throw new HttpError(429, "HTTP 429");
        }

        if (response.status >= 500 && response.status < 600) {
          if (attempt < retries) {
            // A 5xx is transient server trouble, so the ladder is right
            // here; a `Retry-After` on it is honoured ahead of the ladder's
            // own guess, RFC 9110 defining the header for 503 as well as
            // for the 429 above.
            const asked = retryAfterMs(response.headers.get("retry-after"), Date.now());
            await sleepFn(asked ?? RETRY_DELAYS[attempt]);
            continue;
          }
          throw new HttpError(response.status, `HTTP ${response.status} after ${attempt} retries`);
        }

        // The body is read here, inside the timeout, rather than by the
        // caller. `fetch` resolves when the headers arrive, so a host that
        // sends headers and then stalls its body would otherwise hang a
        // caller that has no timer of its own: the one armed above was
        // cleared the moment the headers landed. Nothing else can read the
        // body afterwards, because no Response leaves this function.
        const body = await response.text();
        clearTimeout(timeoutId);
        return { status: response.status, ok: response.ok, body };
      } catch (err) {
        clearTimeout(timeoutId);
        lastError = err instanceof Error ? err : new Error(String(err));

        // An HttpError here is one this loop threw on a status it has
        // already decided about - the 429 above, or a 5xx with its ladder
        // spent - so it is the answer, not a fault to wait out. Without
        // this, the `includes("HTTP")` test below would catch a first-
        // attempt 429 straight back into the ladder it was just spared.
        if (lastError instanceof HttpError) throw lastError;

        // Node's fetch throws `TypeError: fetch failed` for a network-level
        // fault (ECONNRESET, EAI_AGAIN, a dropped TLS handshake), with the
        // real cause in `.cause`; a whole host's boards can fail this way
        // for a few minutes at a time.
        if (
          attempt < retries &&
          (lastError.name === "AbortError" ||
            lastError.message.includes("HTTP") ||
            (lastError instanceof TypeError && lastError.message === "fetch failed"))
        ) {
          // Rather than hot-looping against the host least able to answer.
          await sleepFn(RETRY_DELAYS[attempt]);
          continue;
        }

        throw lastError;
      }
    }

    throw lastError || new Error("Request failed after retries");
  } finally {
    tally.ms += performance.now() - started;
  }
}

export async function getJson<T>(url: string, options?: HttpOptions): Promise<T> {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const sleep =
    options?.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const userAgent = options?.userAgent ?? requiredUserAgent(options?.settingsDir);

  const response = await fetchWithRetry(
    url,
    fetchImpl,
    sleep,
    userAgent,
    retryCount(options?.retries),
    options?.timeoutMs ?? TIMEOUT_MS,
    options?.headers,
  );

  if (!response.ok) {
    throw new HttpError(response.status, `HTTP ${response.status}`);
  }

  return JSON.parse(response.body) as T;
}

// Workday's listing is a search endpoint taking its query as a POSTed JSON
// body; kept beside getJson/getText so one retry policy serves every verb.
export async function postJson<T>(
  url: string,
  payload: unknown,
  options?: HttpOptions,
): Promise<T> {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const sleep =
    options?.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const userAgent = options?.userAgent ?? requiredUserAgent(options?.settingsDir);

  const headers = { "Content-Type": "application/json", ...(options?.headers ?? {}) };
  const response = await fetchWithRetry(
    url,
    fetchImpl,
    sleep,
    userAgent,
    retryCount(options?.retries),
    options?.timeoutMs ?? TIMEOUT_MS,
    headers,
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
  );

  if (!response.ok) {
    throw new HttpError(response.status, `HTTP ${response.status}`);
  }

  return JSON.parse(response.body) as T;
}

export async function getText(url: string, options?: HttpOptions): Promise<string> {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const sleep =
    options?.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const userAgent = options?.userAgent ?? requiredUserAgent(options?.settingsDir);

  const response = await fetchWithRetry(
    url,
    fetchImpl,
    sleep,
    userAgent,
    retryCount(options?.retries),
    options?.timeoutMs ?? TIMEOUT_MS,
    options?.headers,
  );

  if (!response.ok) {
    throw new HttpError(response.status, `HTTP ${response.status}`);
  }

  return response.body;
}

// The tags that start a new block of text.
const BLOCK_TAGS = /<\/?(?:p|div|li|br|tr|h[1-6]|section|article|ul|ol|table)\b[^>]*>/gi;

// A placeholder for a block boundary while the whitespace collapse below
// runs: a character no posting body contains and no whitespace rule touches.
const BLOCK_BOUNDARY = "\u0000";

export function htmlToText(html: string): string {
  // A block tag becomes a line break and an inline tag a space. Deleting
  // tags glues `<li>Rust</li><li>Go</li>` into "RustGo"; a space for every
  // tag glues a bulleted list into one run with no punctuation, so the
  // per-sentence criteria in judge/text.ts take a stray "hybrid" in a
  // benefits bullet as the rule. A newline rather than an invented ".":
  // the text is quoted back to James in a reason.
  // Entities are decoded before tags are stripped: Greenhouse sends its
  // `content` as entity-encoded markup (`&lt;p&gt;`). Twice, because some
  // boards double-encode.
  let text = decodeEntities(decodeEntities(html));

  // Ashby and Lever hand over `descriptionPlain`, where the newlines are the
  // structure. Read as boundaries only when the input carries no tag: in
  // real markup a newline is usually wrapping, and breaking a wrapped
  // sentence would separate a "not" from the "remote" it negates.
  if (!/<[a-z!/][^>]*>/i.test(text)) {
    text = text.replace(/\n+/g, BLOCK_BOUNDARY);
  }

  text = text.replace(BLOCK_TAGS, BLOCK_BOUNDARY);
  text = text.replace(/<[^>]*>/g, " ");

  // A newline in the source HTML is not a block boundary; only after the
  // collapse do the placeholders become newlines.
  text = text.replace(/\s+/g, " ");
  text = text.replace(/ *\u0000[\u0000 ]*/g, "\n");
  text = text.replace(/^\n+|\n+$/g, "").trim();

  if (text.length > 12_000) {
    text = text.substring(0, 12_000);
  }

  return text;
}

function decodeEntities(str: string): string {
  // Both dashes are here because `COMP_RANGE` in ats.ts names both:
  // Greenhouse writes a range as `$204,000 &mdash; $255,000 USD`.
  const map: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&apos;": "'",
    "&nbsp;": " ",
    "&mdash;": "—",
    "&ndash;": "–",
  };

  let result = str;

  for (const [entity, char] of Object.entries(map)) {
    result = result.replace(new RegExp(entity, "g"), char);
  }

  result = result.replace(/&#(\d+);/g, (_match, code) => {
    return String.fromCharCode(parseInt(code, 10));
  });

  result = result.replace(/&#x([0-9a-f]+);/gi, (_match, code) => {
    return String.fromCharCode(parseInt(code, 16));
  });

  return result;
}
