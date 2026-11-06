import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Result } from "./result.ts";

// Google's OAuth for an installed (Desktop) app, with PKCE. The only scope
// asked for is gmail.readonly: it reads mail and cannot change it. Nothing
// here is interactive, so a run can never open a consent screen; James gives
// consent once through scripts/job-email/consent.ts. The token lives in the
// macOS Keychain and never on disk.

export interface GmailCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly authUri: string;
  readonly tokenUri: string;
}

export interface Pkce {
  readonly verifier: string;
  readonly challenge: string;
}

export interface Token {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: string;
}

export interface SecurityOutcome {
  readonly exitCode: number;
  readonly stdout: string;
}

export type SecurityRunner = (
  args: readonly string[],
  stdin: string | null,
) => Promise<SecurityOutcome>;

export interface TokenStore {
  read(): Promise<Result<Token | null>>;
  write(token: Token): Promise<Result<void>>;
}

export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
// A token this close to expiry is refreshed first. One token serves a run's
// whole read of hundreds of threads, so it must outlast that read, not only the
// next request.
const REFRESH_MARGIN_MS = 600_000;

const KEYCHAIN_SERVICE = "job-search-gmail";
const KEYCHAIN_ACCOUNT = "token";
const KEYCHAIN_ITEM_NOT_FOUND = 44;
// `security -i` reads a line of at most this many bytes, newline included
// (measured). It runs the cut-off front of a longer line as a command and the
// rest as another, which would store a truncated token.
const SECURITY_LINE_LIMIT = 4095;

// JSON.parse's message quotes the text it failed on, so it is dropped: the
// text is a client secret or a token.
function parseJson(text: string): Result<unknown> {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, reason: "not JSON" };
  }
}

function stringField(object: unknown, key: string): string | null {
  if (typeof object !== "object" || object === null) return null;
  const value = (object as Record<string, unknown>)[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function numberField(object: unknown, key: string): number | null {
  if (typeof object !== "object" || object === null) return null;
  const value = (object as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// The credential is outside the repository; `home` is a parameter for tests.
export function gmailPaths(home: string = homedir()): { credentials: string } {
  return { credentials: join(home, ".config", "job-search", "gmail-credentials.json") };
}

// The file Google Cloud Console downloads for a Desktop app OAuth client.
export function readCredentials(text: string): Result<GmailCredentials> {
  const parsed = parseJson(text);
  if (!parsed.ok) return { ok: false, reason: `credentials file is ${parsed.reason}` };
  const installed =
    typeof parsed.value === "object" && parsed.value !== null
      ? (parsed.value as Record<string, unknown>)["installed"]
      : null;
  if (typeof installed !== "object" || installed === null) {
    return { ok: false, reason: 'credentials file has no "installed" client' };
  }
  const clientId = stringField(installed, "client_id");
  const clientSecret = stringField(installed, "client_secret");
  const authUri = stringField(installed, "auth_uri");
  const tokenUri = stringField(installed, "token_uri");
  if (clientId === null) return { ok: false, reason: "credentials file has no client_id" };
  if (clientSecret === null) return { ok: false, reason: "credentials file has no client_secret" };
  if (authUri === null) return { ok: false, reason: "credentials file has no auth_uri" };
  if (tokenUri === null) return { ok: false, reason: "credentials file has no token_uri" };
  return { ok: true, value: { clientId, clientSecret, authUri, tokenUri } };
}

// `random` is a parameter only so a test can fix the bytes.
export function generatePkce(random: (size: number) => Buffer = randomBytes): Pkce {
  const verifier = random(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function authorizationUrl(
  credentials: GmailCredentials,
  pkce: Pkce,
  redirectUri: string,
): string {
  const url = new URL(credentials.authUri);
  url.searchParams.set("client_id", credentials.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GMAIL_READONLY_SCOPE);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

interface TokenResponse {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresAt: string;
}

// A refused request (a bad code, a revoked refresh token) is an expected
// failure and comes back as a reason; a network failure throws.
async function postToTokenEndpoint(
  credentials: GmailCredentials,
  form: Record<string, string>,
  now: Date,
  fetch: typeof globalThis.fetch,
): Promise<Result<TokenResponse>> {
  const response = await fetch(credentials.tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  const parsed = parseJson(await response.text());
  const body = parsed.ok ? parsed.value : null;
  if (!response.ok) {
    const detail =
      stringField(body, "error_description") ??
      stringField(body, "error") ??
      `${response.status} ${response.statusText}`;
    return { ok: false, reason: `token request refused: ${detail}` };
  }
  const accessToken = stringField(body, "access_token");
  const expiresIn = numberField(body, "expires_in");
  if (accessToken === null) return { ok: false, reason: "token response has no access_token" };
  if (expiresIn === null) return { ok: false, reason: "token response has no expires_in" };
  return {
    ok: true,
    value: {
      accessToken,
      refreshToken: stringField(body, "refresh_token"),
      expiresAt: new Date(now.getTime() + expiresIn * 1000).toISOString(),
    },
  };
}

export async function exchangeCode(
  credentials: GmailCredentials,
  code: string,
  pkce: Pkce,
  redirectUri: string,
  now: Date,
  fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<Result<Token>> {
  const response = await postToTokenEndpoint(
    credentials,
    {
      grant_type: "authorization_code",
      code,
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      code_verifier: pkce.verifier,
      redirect_uri: redirectUri,
    },
    now,
    fetch,
  );
  if (!response.ok) return response;
  const { accessToken, refreshToken, expiresAt } = response.value;
  // Without a refresh token every later run would need James's consent
  // again, so an exchange that returns none is refused.
  if (refreshToken === null) return { ok: false, reason: "token response has no refresh_token" };
  return { ok: true, value: { accessToken, refreshToken, expiresAt } };
}

export async function refreshToken(
  credentials: GmailCredentials,
  token: Token,
  now: Date,
  fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<Result<Token>> {
  const response = await postToTokenEndpoint(
    credentials,
    {
      grant_type: "refresh_token",
      refresh_token: token.refreshToken,
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
    },
    now,
    fetch,
  );
  if (!response.ok) return response;
  const { accessToken, expiresAt } = response.value;
  return { ok: true, value: { accessToken, refreshToken: token.refreshToken, expiresAt } };
}

export function needsRefresh(token: Token, now: Date): boolean {
  return Date.parse(token.expiresAt) - now.getTime() <= REFRESH_MARGIN_MS;
}

function parseToken(text: string): Result<Token> {
  const parsed = parseJson(text);
  if (!parsed.ok) return parsed;
  const accessToken = stringField(parsed.value, "accessToken");
  const refresh = stringField(parsed.value, "refreshToken");
  const expiresAt = stringField(parsed.value, "expiresAt");
  if (accessToken === null) return { ok: false, reason: "no accessToken" };
  if (refresh === null) return { ok: false, reason: "no refreshToken" };
  if (expiresAt === null || Number.isNaN(Date.parse(expiresAt))) {
    return { ok: false, reason: "no valid expiresAt" };
  }
  return { ok: true, value: { accessToken, refreshToken: refresh, expiresAt } };
}

// The one line `security -i` runs to store a token. Its parser treats a
// backslash as an escape even inside single quotes (measured), so a backslash
// and a single quote are both escaped.
function addTokenCommand(token: Token): string {
  const { accessToken, refreshToken: refresh, expiresAt } = token;
  const json = JSON.stringify({ accessToken, refreshToken: refresh, expiresAt });
  const quoted = json.replace(/[\\']/g, "\\$&");
  return `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${KEYCHAIN_ACCOUNT} -w '${quoted}'\n`;
}

// A process that could not start, or died on a signal, has no exit code and
// reports -1. `binary` is a parameter so a test can run a stand-in.
export function securityRunner(binary: string = "/usr/bin/security"): SecurityRunner {
  return (args, stdin) =>
    new Promise((resolve) => {
      const child = execFile(binary, args, (error, stdout) => {
        if (error === null) {
          resolve({ exitCode: 0, stdout });
          return;
        }
        resolve({ exitCode: typeof error.code === "number" ? error.code : -1, stdout });
      });
      // A process that exits without reading its stdin raises EPIPE here; its
      // exit code above is the failure that gets reported.
      child.stdin?.on("error", () => {});
      if (stdin !== null) child.stdin?.write(stdin);
      child.stdin?.end();
    });
}

// The token as one Keychain item. A write goes on stdin because other
// processes can read a process's arguments. A reason names the item and the
// exit code and never carries `stdout`, which on a read is the token.
export function keychainStore(run: SecurityRunner = securityRunner()): TokenStore {
  return {
    async read() {
      const args = ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"];
      const { exitCode, stdout } = await run(args, null);
      if (exitCode === KEYCHAIN_ITEM_NOT_FOUND) return { ok: true, value: null };
      if (exitCode !== 0) {
        return {
          ok: false,
          reason: `could not read Keychain item ${KEYCHAIN_SERVICE} (security exit ${exitCode})`,
        };
      }
      const token = parseToken(stdout.trim());
      if (!token.ok) {
        return {
          ok: false,
          reason: `Keychain item ${KEYCHAIN_SERVICE} holds no valid token: ${token.reason}`,
        };
      }
      return token;
    },
    async write(token) {
      const command = addTokenCommand(token);
      if (Buffer.byteLength(command) > SECURITY_LINE_LIMIT) {
        return {
          ok: false,
          reason: `token is too long to store in Keychain item ${KEYCHAIN_SERVICE}; nothing written`,
        };
      }
      const { exitCode } = await run(["-i"], command);
      if (exitCode !== 0) {
        return {
          ok: false,
          reason: `could not write Keychain item ${KEYCHAIN_SERVICE} (security exit ${exitCode})`,
        };
      }
      return { ok: true, value: undefined };
    },
  };
}

export async function ensureAccessToken(
  credentials: GmailCredentials,
  store: TokenStore,
  now: Date,
  fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<Result<string>> {
  const stored = await store.read();
  if (!stored.ok) return stored;
  if (stored.value === null) {
    return {
      ok: false,
      reason:
        "no Gmail token in Keychain; James runs node scripts/job-email/consent.ts in a terminal",
    };
  }
  if (!needsRefresh(stored.value, now)) return { ok: true, value: stored.value.accessToken };
  // A refused refresh (consent revoked) cannot be recovered here, because a
  // run never opens a consent screen; the reason says how to start over.
  const fresh = await refreshToken(credentials, stored.value, now, fetch);
  if (!fresh.ok) {
    return {
      ok: false,
      reason: `${fresh.reason}; run security delete-generic-password -s ${KEYCHAIN_SERVICE}, then node scripts/job-email/consent.ts`,
    };
  }
  const saved = await store.write(fresh.value);
  if (!saved.ok) return saved;
  return { ok: true, value: fresh.value.accessToken };
}
