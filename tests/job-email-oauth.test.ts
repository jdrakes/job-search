import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { readCredentialFile, redirectCode } from "../scripts/job-email/consent.ts";
import {
  authorizationUrl,
  ensureAccessToken,
  exchangeCode,
  generatePkce,
  GMAIL_READONLY_SCOPE,
  gmailPaths,
  keychainStore,
  needsRefresh,
  readCredentials,
  refreshToken,
  securityRunner,
  type GmailCredentials,
  type SecurityOutcome,
  type SecurityRunner,
  type Token,
} from "../scripts/job-email/oauth.ts";

// Every client id, secret, code and token here is invented. No test reads a
// real credential or runs /usr/bin/security: every fetch and every Keychain
// call is fake, and securityRunner's own test runs a stand-in script.
const CREDENTIALS: GmailCredentials = {
  clientId: "1234-fake.apps.example.test",
  clientSecret: "fake-secret-quill",
  authUri: "https://auth.example.test/o/oauth2/auth",
  tokenUri: "https://auth.example.test/token",
};

const PKCE = { verifier: "fake-verifier-lantern", challenge: "fake-challenge-lantern" };
const REDIRECT = "http://127.0.0.1:53117";
const NOW = new Date("2026-09-25T12:00:00Z");

const STORED: Token = {
  accessToken: "fake-access-stored",
  refreshToken: "fake-refresh-stored",
  expiresAt: "2026-09-25T13:00:00.000Z",
};
const STORED_JSON =
  '{"accessToken":"fake-access-stored","refreshToken":"fake-refresh-stored","expiresAt":"2026-09-25T13:00:00.000Z"}';
const EXPIRED_JSON =
  '{"accessToken":"fake-access-stored","refreshToken":"fake-refresh-stored","expiresAt":"2026-09-25T11:00:00.000Z"}';

const READ_ARGS = ["find-generic-password", "-s", "job-search-gmail", "-a", "token", "-w"];

interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly form: Record<string, string>;
}

// A fetch that records each request and answers with one fixed response.
function fakeFetch(status: number, body: unknown, calls: FetchCall[]): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      form: Object.fromEntries(new URLSearchParams(String(init?.body ?? ""))),
    });
    return new Response(JSON.stringify(body), { status });
  }) as typeof globalThis.fetch;
}

interface RunnerCall {
  readonly args: readonly string[];
  readonly stdin: string | null;
}

// A runner that records each call and answers from a list, in order.
function fakeRunner(answers: readonly SecurityOutcome[], calls: RunnerCall[]): SecurityRunner {
  return async (args, stdin) => {
    calls.push({ args, stdin });
    const answer = answers[calls.length - 1];
    if (answer === undefined) throw new Error(`no answer for call ${calls.length}`);
    return answer;
  };
}

test("readCredentials takes the installed client from a downloaded credentials file", () => {
  const text = JSON.stringify({
    installed: {
      client_id: "1234-fake.apps.example.test",
      project_id: "fake-project",
      auth_uri: "https://auth.example.test/o/oauth2/auth",
      token_uri: "https://auth.example.test/token",
      client_secret: "fake-secret-quill",
      redirect_uris: ["http://localhost"],
    },
  });
  assert.deepEqual(readCredentials(text), { ok: true, value: CREDENTIALS });
});

test("readCredentials refuses a file with no installed client or a missing field", () => {
  assert.deepEqual(readCredentials('{"web": {}}'), {
    ok: false,
    reason: 'credentials file has no "installed" client',
  });
  assert.deepEqual(readCredentials('{"installed": {"client_id": "x"}}'), {
    ok: false,
    reason: "credentials file has no client_secret",
  });
});

// Breaks if parseJson goes back to including JSON.parse's message, which
// quotes the text it failed on.
test("readCredentials on broken JSON does not repeat the file's text", () => {
  assert.deepEqual(readCredentials('fake-secret-quill{"installed"'), {
    ok: false,
    reason: "credentials file is not JSON",
  });
});

test("gmailPaths returns only the credential path, under the given home", () => {
  assert.deepEqual(gmailPaths("/home/x"), {
    credentials: "/home/x/.config/job-search/gmail-credentials.json",
  });
});

test("generatePkce's challenge is the base64url SHA-256 of the base64url verifier", () => {
  // 32 zero bytes: the verifier and challenge were computed by hand with
  // `head -c 32 /dev/zero | openssl base64` and `openssl dgst -sha256`.
  const pkce = generatePkce((size) => Buffer.alloc(size));
  assert.deepEqual(pkce, {
    verifier: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    challenge: "DwBzhbb51LfusnSGBa_hqYSgo7-j8BTQnip4TOnlzRo",
  });
});

test("generatePkce makes a fresh 43-character verifier each call", () => {
  const first = generatePkce();
  const second = generatePkce();
  assert.equal(first.verifier.length, 43);
  assert.notEqual(first.verifier, second.verifier);
});

test("authorizationUrl asks for exactly gmail.readonly, offline access and an S256 challenge", () => {
  const url = new URL(authorizationUrl(CREDENTIALS, PKCE, REDIRECT));
  assert.equal(`${url.origin}${url.pathname}`, "https://auth.example.test/o/oauth2/auth");
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    client_id: "1234-fake.apps.example.test",
    redirect_uri: "http://127.0.0.1:53117",
    response_type: "code",
    scope: "https://www.googleapis.com/auth/gmail.readonly",
    access_type: "offline",
    prompt: "consent",
    code_challenge: "fake-challenge-lantern",
    code_challenge_method: "S256",
  });
  assert.equal(GMAIL_READONLY_SCOPE, "https://www.googleapis.com/auth/gmail.readonly");
});

test("exchangeCode posts the code and verifier and dates the token from now", async () => {
  const calls: FetchCall[] = [];
  const fetch = fakeFetch(
    200,
    { access_token: "fake-access-new", refresh_token: "fake-refresh-new", expires_in: 3599 },
    calls,
  );
  const result = await exchangeCode(CREDENTIALS, "fake-code-otter", PKCE, REDIRECT, NOW, fetch);
  assert.deepEqual(result, {
    ok: true,
    value: {
      accessToken: "fake-access-new",
      refreshToken: "fake-refresh-new",
      expiresAt: "2026-09-25T12:59:59.000Z",
    },
  });
  assert.deepEqual(calls, [
    {
      url: "https://auth.example.test/token",
      method: "POST",
      form: {
        grant_type: "authorization_code",
        code: "fake-code-otter",
        client_id: "1234-fake.apps.example.test",
        client_secret: "fake-secret-quill",
        code_verifier: "fake-verifier-lantern",
        redirect_uri: "http://127.0.0.1:53117",
      },
    },
  ]);
});

test("exchangeCode refuses a response with no refresh token", async () => {
  const fetch = fakeFetch(200, { access_token: "fake-access-new", expires_in: 3599 }, []);
  const result = await exchangeCode(CREDENTIALS, "fake-code-otter", PKCE, REDIRECT, NOW, fetch);
  assert.deepEqual(result, { ok: false, reason: "token response has no refresh_token" });
});

test("exchangeCode returns the endpoint's own reason when it refuses", async () => {
  const fetch = fakeFetch(400, { error: "invalid_grant", error_description: "Bad Request" }, []);
  const result = await exchangeCode(CREDENTIALS, "fake-code-otter", PKCE, REDIRECT, NOW, fetch);
  assert.deepEqual(result, { ok: false, reason: "token request refused: Bad Request" });
});

test("refreshToken posts the refresh token and keeps it in the result", async () => {
  const calls: FetchCall[] = [];
  const fetch = fakeFetch(200, { access_token: "fake-access-refreshed", expires_in: 3600 }, calls);
  const result = await refreshToken(CREDENTIALS, STORED, NOW, fetch);
  assert.deepEqual(result, {
    ok: true,
    value: {
      accessToken: "fake-access-refreshed",
      refreshToken: "fake-refresh-stored",
      expiresAt: "2026-09-25T13:00:00.000Z",
    },
  });
  assert.deepEqual(calls, [
    {
      url: "https://auth.example.test/token",
      method: "POST",
      form: {
        grant_type: "refresh_token",
        refresh_token: "fake-refresh-stored",
        client_id: "1234-fake.apps.example.test",
        client_secret: "fake-secret-quill",
      },
    },
  ]);
});

test("needsRefresh is true within 60 seconds of expiry and false an hour out", () => {
  const expiringIn = (seconds: number): Token => ({
    ...STORED,
    expiresAt: new Date(NOW.getTime() + seconds * 1000).toISOString(),
  });
  assert.equal(needsRefresh(expiringIn(30), NOW), true);
  assert.equal(needsRefresh(expiringIn(-30), NOW), true);
  assert.equal(needsRefresh(expiringIn(3600), NOW), false);
});

test("keychainStore reads the named item and parses its JSON, ignoring the trailing newline", async () => {
  const calls: RunnerCall[] = [];
  const store = keychainStore(fakeRunner([{ exitCode: 0, stdout: `${STORED_JSON}\n` }], calls));
  assert.deepEqual(await store.read(), { ok: true, value: STORED });
  assert.deepEqual(calls, [{ args: READ_ARGS, stdin: null }]);
});

test("keychainStore reads exit 44 as no token", async () => {
  const store = keychainStore(fakeRunner([{ exitCode: 44, stdout: "" }], []));
  assert.deepEqual(await store.read(), { ok: true, value: null });
});

test("keychainStore's failed read names the item and leaves the runner's output out", async () => {
  const store = keychainStore(fakeRunner([{ exitCode: 36, stdout: "fake-access-leaked" }], []));
  assert.deepEqual(await store.read(), {
    ok: false,
    reason: "could not read Keychain item job-search-gmail (security exit 36)",
  });
});

// Breaks if the item's text reaches the reason through JSON.parse's message.
test("keychainStore's unparseable item names the item and leaves its text out", async () => {
  const unparseable = keychainStore(
    fakeRunner([{ exitCode: 0, stdout: "fake-access-leaked{" }], []),
  );
  assert.deepEqual(await unparseable.read(), {
    ok: false,
    reason: "Keychain item job-search-gmail holds no valid token: not JSON",
  });
  const incomplete = keychainStore(
    fakeRunner([{ exitCode: 0, stdout: '{"accessToken":"fake-access-leaked"}' }], []),
  );
  assert.deepEqual(await incomplete.read(), {
    ok: false,
    reason: "Keychain item job-search-gmail holds no valid token: no refreshToken",
  });
});

test("keychainStore writes the token only on stdin, never in the arguments", async () => {
  const calls: RunnerCall[] = [];
  const store = keychainStore(fakeRunner([{ exitCode: 0, stdout: "" }], calls));
  assert.deepEqual(await store.write(STORED), { ok: true, value: undefined });
  assert.deepEqual(calls, [
    {
      args: ["-i"],
      stdin: `add-generic-password -U -s job-search-gmail -a token -w '${STORED_JSON}'\n`,
    },
  ]);
});

// The expected line follows what `security -i` was measured to do with a
// backslash and a single quote inside single quotes. Breaks if the escaping
// goes, which would store a different token or end the quoted value early.
test("keychainStore escapes a backslash and a single quote in the value", async () => {
  const calls: RunnerCall[] = [];
  const store = keychainStore(fakeRunner([{ exitCode: 0, stdout: "" }], calls));
  await store.write({ ...STORED, accessToken: `it's"x` });
  assert.equal(
    calls[0]?.stdin,
    `add-generic-password -U -s job-search-gmail -a token -w '{"accessToken":"it\\'s\\\\"x","refreshToken":"fake-refresh-stored","expiresAt":"2026-09-25T13:00:00.000Z"}'\n`,
  );
});

// `security -i` cuts a line at 4095 bytes and runs the front as a command,
// which would store a truncated token. Breaks if the guard goes or moves.
test("keychainStore refuses a line longer than security reads, and runs nothing", async () => {
  // The command around the access token is 153 bytes, so 3942 fills 4095.
  const longest = { ...STORED, accessToken: "x".repeat(3942) };
  const fits: RunnerCall[] = [];
  const fitting = keychainStore(fakeRunner([{ exitCode: 0, stdout: "" }], fits));
  assert.equal((await fitting.write(longest)).ok, true);
  assert.equal(Buffer.byteLength(fits[0]?.stdin ?? ""), 4095);

  const calls: RunnerCall[] = [];
  const store = keychainStore(fakeRunner([], calls));
  assert.deepEqual(await store.write({ ...STORED, accessToken: "x".repeat(3943) }), {
    ok: false,
    reason: "token is too long to store in Keychain item job-search-gmail; nothing written",
  });
  assert.equal(calls.length, 0);
});

test("keychainStore's failed write names the item and leaves the runner's output out", async () => {
  const store = keychainStore(fakeRunner([{ exitCode: 1, stdout: "fake-access-leaked" }], []));
  assert.deepEqual(await store.write(STORED), {
    ok: false,
    reason: "could not write Keychain item job-search-gmail (security exit 1)",
  });
});

test("ensureAccessToken with no token names consent.ts and calls no fetch", async () => {
  const calls: FetchCall[] = [];
  const runnerCalls: RunnerCall[] = [];
  const result = await ensureAccessToken(
    CREDENTIALS,
    keychainStore(fakeRunner([{ exitCode: 44, stdout: "" }], runnerCalls)),
    NOW,
    fakeFetch(500, {}, calls),
  );
  assert.deepEqual(result, {
    ok: false,
    reason:
      "no Gmail token in Keychain; James runs node scripts/job-email/consent.ts in a terminal",
  });
  assert.equal(calls.length, 0);
  assert.equal(runnerCalls.length, 1);
});

test("ensureAccessToken returns a stored live token without refreshing or writing", async () => {
  const calls: FetchCall[] = [];
  const runnerCalls: RunnerCall[] = [];
  const result = await ensureAccessToken(
    CREDENTIALS,
    keychainStore(fakeRunner([{ exitCode: 0, stdout: `${STORED_JSON}\n` }], runnerCalls)),
    NOW,
    fakeFetch(500, {}, calls),
  );
  assert.deepEqual(result, { ok: true, value: "fake-access-stored" });
  assert.equal(calls.length, 0);
  assert.deepEqual(
    runnerCalls.map((call) => call.args),
    [READ_ARGS],
  );
});

test("ensureAccessToken passes on a Keychain read failure and calls no fetch", async () => {
  const calls: FetchCall[] = [];
  const result = await ensureAccessToken(
    CREDENTIALS,
    keychainStore(fakeRunner([{ exitCode: 36, stdout: "" }], [])),
    NOW,
    fakeFetch(500, {}, calls),
  );
  assert.deepEqual(result, {
    ok: false,
    reason: "could not read Keychain item job-search-gmail (security exit 36)",
  });
  assert.equal(calls.length, 0);
});

test("ensureAccessToken writes a refreshed token back through the store", async () => {
  const calls: FetchCall[] = [];
  const runnerCalls: RunnerCall[] = [];
  const result = await ensureAccessToken(
    CREDENTIALS,
    keychainStore(
      fakeRunner(
        [
          { exitCode: 0, stdout: `${EXPIRED_JSON}\n` },
          { exitCode: 0, stdout: "" },
        ],
        runnerCalls,
      ),
    ),
    NOW,
    fakeFetch(200, { access_token: "fake-access-refreshed", expires_in: 3600 }, calls),
  );
  assert.deepEqual(result, { ok: true, value: "fake-access-refreshed" });
  assert.equal(calls[0]?.form["grant_type"], "refresh_token");
  assert.deepEqual(runnerCalls[1], {
    args: ["-i"],
    stdin:
      'add-generic-password -U -s job-search-gmail -a token -w \'{"accessToken":"fake-access-refreshed","refreshToken":"fake-refresh-stored","expiresAt":"2026-09-25T13:00:00.000Z"}\'\n',
  });
});

test("ensureAccessToken reports a failed write of a refreshed token", async () => {
  const result = await ensureAccessToken(
    CREDENTIALS,
    keychainStore(
      fakeRunner(
        [
          { exitCode: 0, stdout: EXPIRED_JSON },
          { exitCode: 1, stdout: "" },
        ],
        [],
      ),
    ),
    NOW,
    fakeFetch(200, { access_token: "fake-access-refreshed", expires_in: 3600 }, []),
  );
  assert.deepEqual(result, {
    ok: false,
    reason: "could not write Keychain item job-search-gmail (security exit 1)",
  });
});

test("ensureAccessToken's refused refresh says how to start over, without any secret", async () => {
  const runnerCalls: RunnerCall[] = [];
  const result = await ensureAccessToken(
    CREDENTIALS,
    keychainStore(fakeRunner([{ exitCode: 0, stdout: EXPIRED_JSON }], runnerCalls)),
    NOW,
    fakeFetch(400, { error: "invalid_grant" }, []),
  );
  assert.deepEqual(result, {
    ok: false,
    reason:
      "token request refused: invalid_grant; run security delete-generic-password -s job-search-gmail, then node scripts/job-email/consent.ts",
  });
  assert.equal(runnerCalls.length, 1);
});

test("redirectCode returns the code, a refusal, or null for any other request", () => {
  assert.deepEqual(redirectCode("/?code=fake-code-otter&scope=x", REDIRECT), {
    ok: true,
    value: "fake-code-otter",
  });
  assert.deepEqual(redirectCode("/?error=access_denied", REDIRECT), {
    ok: false,
    reason: "consent refused: access_denied",
  });
  assert.equal(redirectCode("/favicon.ico", REDIRECT), null);
});

test("readCredentialFile makes the directory and names the path when the file is missing", async () => {
  const home = await mkdtemp(join(tmpdir(), "job-email-oauth-"));
  const directory = join(home, "config", "job-search");
  const path = join(directory, "gmail-credentials.json");
  assert.deepEqual(await readCredentialFile(path), {
    ok: false,
    reason: `no Gmail credentials at ${path}; copy the Desktop OAuth client file there`,
  });
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
});

test("readCredentialFile tightens a downloaded file to mode 0600 and parses it", async () => {
  const home = await mkdtemp(join(tmpdir(), "job-email-oauth-"));
  const path = join(home, "gmail-credentials.json");
  await writeFile(path, '{"web": {}}');
  await chmod(path, 0o644);
  assert.deepEqual(await readCredentialFile(path), {
    ok: false,
    reason: 'credentials file has no "installed" client',
  });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

// A stand-in for the security binary, so the process plumbing is tested
// without the Keychain. Breaks if stdin stops reaching the process or the
// exit code stops coming back.
test("securityRunner passes arguments and stdin and returns the exit code and stdout", async () => {
  const directory = await mkdtemp(join(tmpdir(), "job-email-oauth-"));
  const binary = join(directory, "stand-in.sh");
  const received = join(directory, "received");
  await writeFile(
    binary,
    `#!/bin/sh\nprintf '%s\\n' "$*" > "${received}"\ncat >> "${received}"\nprintf 'stand-in out'\nexit 44\n`,
    { mode: 0o700 },
  );
  assert.deepEqual(await securityRunner(binary)(["-i"], "fake line\n"), {
    exitCode: 44,
    stdout: "stand-in out",
  });
  assert.equal(await readFile(received, "utf8"), "-i\nfake line\n");
});

test("securityRunner reports -1 for a binary that cannot start", async () => {
  const directory = await mkdtemp(join(tmpdir(), "job-email-oauth-"));
  assert.deepEqual(await securityRunner(join(directory, "absent"))(["-i"], "fake line\n"), {
    exitCode: -1,
    stdout: "",
  });
});
