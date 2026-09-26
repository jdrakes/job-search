/**
 * Sign-in: a link to the operator's address, over Supabase Auth's REST
 * endpoints; two POSTs and a JWT is the whole protocol, so no SDK. The
 * link comes back to this page carrying a `token_hash`, and the page
 * trades it for a session itself: a mail scanner that only GETs the link
 * does not spend it, and no token ever sits in the address bar. The
 * session lives in `localStorage` and is bounded by
 * `INACTIVITY_TIMEOUT_SECONDS`, not the tab's lifetime. The store is
 * injected so every function here runs without a browser.
 */
import type { AppConfig } from "./config.ts";

export const SESSION_KEY = "job-search.session";

export interface Session {
  email: string;
  accessToken: string;
  /** Unix seconds, as Supabase reports it. */
  expiresAt: number;
  /** Null only for a session stored before this field existed (see `loadSession`). */
  refreshToken: string | null;
  /** Unix seconds this session was last confirmed in use; the inactivity timeout runs off it, independent of the refresh token. */
  lastActiveAt: number;
}

/** All a test has to fake of `localStorage`. */
export interface SessionStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type AuthResult<T> = { ok: true; value: T } | { ok: false; reason: string };

function authHeaders(config: AppConfig): Record<string, string> {
  return {
    apikey: config.anonKey,
    "Content-Type": "application/json",
  };
}

/**
 * Supabase answers with `{error_description}` or `{msg}` depending on the
 * endpoint; both are shown as-is, because "Email logins are disabled" is
 * the sentence that tells James what to fix.
 */
async function failure(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => null);
  if (typeof body === "object" && body !== null) {
    const record = body as Record<string, unknown>;
    for (const field of ["error_description", "msg", "message", "error"]) {
      const value = record[field];
      if (typeof value === "string" && value !== "") {
        return value;
      }
    }
  }
  return `sign-in failed (HTTP ${response.status})`;
}

/** `create_user: false`: a typo'd address must fail rather than quietly enrol a new user. */
export async function requestLink(
  config: AppConfig,
  email: string,
  httpFetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<AuthResult<null>> {
  const response = await httpFetch(`${config.url}/auth/v1/otp`, {
    method: "POST",
    headers: authHeaders(config),
    body: JSON.stringify({ email, create_user: false }),
  });
  return response.ok ? { ok: true, value: null } : { ok: false, reason: await failure(response) };
}

export function parseSession(
  email: string,
  body: unknown,
  nowSeconds: number,
): AuthResult<Session> {
  if (typeof body !== "object" || body === null) {
    return { ok: false, reason: "the sign-in response was not an object" };
  }
  const record = body as Record<string, unknown>;
  const accessToken = record["access_token"];
  if (typeof accessToken !== "string" || accessToken === "") {
    return { ok: false, reason: "the sign-in response carried no access_token" };
  }
  const expiresAt = record["expires_at"];
  if (typeof expiresAt !== "number") {
    return { ok: false, reason: "the sign-in response carried no expires_at" };
  }
  const refreshToken = record["refresh_token"];
  if (typeof refreshToken !== "string" || refreshToken === "") {
    return { ok: false, reason: "the sign-in response carried no refresh_token" };
  }
  return {
    ok: true,
    value: { email, accessToken, expiresAt, refreshToken, lastActiveAt: nowSeconds },
  };
}

/**
 * The `token_hash` a sign-in link brought back, or null for any other
 * visit. The email template writes `type=email`; `magiclink` is what
 * Supabase's own templates have used for the same link.
 */
export function linkTokenFrom(search: string): string | null {
  const params = new URLSearchParams(search);
  const type = params.get("type");
  const tokenHash = params.get("token_hash");
  if (type !== "email" && type !== "magiclink") return null;
  return tokenHash === null || tokenHash === "" ? null : tokenHash;
}

/** The page never saw the address the link was sent to, so the session takes it from the response's `user`. */
export async function verifyLink(
  config: AppConfig,
  tokenHash: string,
  httpFetch: typeof globalThis.fetch = globalThis.fetch,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<AuthResult<Session>> {
  const response = await httpFetch(`${config.url}/auth/v1/verify`, {
    method: "POST",
    headers: authHeaders(config),
    body: JSON.stringify({ type: "email", token_hash: tokenHash }),
  });
  if (!response.ok) {
    return { ok: false, reason: await failure(response) };
  }
  const body: unknown = await response.json();
  const user =
    typeof body === "object" && body !== null ? (body as Record<string, unknown>)["user"] : null;
  const email =
    typeof user === "object" && user !== null ? (user as Record<string, unknown>)["email"] : null;
  if (typeof email !== "string" || email === "") {
    return { ok: false, reason: "the sign-in response carried no user email" };
  }
  return parseSession(email, body, nowSeconds);
}

export function saveSession(store: SessionStore, session: Session): void {
  store.setItem(SESSION_KEY, JSON.stringify(session));
}

export function clearSession(store: SessionStore): void {
  store.removeItem(SESSION_KEY);
}

/**
 * A session with no refresh token whose access token has expired is
 * dropped: the sign-in form beats an empty pipeline that looks like an
 * empty pipeline. One with a refresh token is kept past expiry;
 * `ensureFreshSession` refreshes it.
 */
export function loadSession(store: SessionStore, nowSeconds: number): Session | null {
  const text = store.getItem(SESSION_KEY);
  if (text === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    store.removeItem(SESSION_KEY);
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    store.removeItem(SESSION_KEY);
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const email = record["email"];
  const accessToken = record["accessToken"];
  const expiresAt = record["expiresAt"];
  if (
    typeof email !== "string" ||
    typeof accessToken !== "string" ||
    typeof expiresAt !== "number"
  ) {
    store.removeItem(SESSION_KEY);
    return null;
  }
  const rawRefreshToken = record["refreshToken"];
  const refreshToken =
    typeof rawRefreshToken === "string" && rawRefreshToken !== "" ? rawRefreshToken : null;
  const rawLastActiveAt = record["lastActiveAt"];
  const lastActiveAt = typeof rawLastActiveAt === "number" ? rawLastActiveAt : null;
  if (lastActiveAt === null || isInactive(lastActiveAt, nowSeconds)) {
    store.removeItem(SESSION_KEY);
    return null;
  }
  if (expiresAt <= nowSeconds && refreshToken === null) {
    store.removeItem(SESSION_KEY);
    return null;
  }
  return { email, accessToken, expiresAt, refreshToken, lastActiveAt };
}

const REFRESH_MARGIN_SECONDS = 30;

/** How long a session may sit unused before it must sign in again, whatever its refresh token's own validity. */
const INACTIVITY_TIMEOUT_SECONDS = 7 * 24 * 60 * 60;

export function needsRefresh(session: Session, nowSeconds: number): boolean {
  return session.expiresAt <= nowSeconds + REFRESH_MARGIN_SECONDS;
}

export function isInactive(lastActiveAt: number, nowSeconds: number): boolean {
  return nowSeconds - lastActiveAt > INACTIVITY_TIMEOUT_SECONDS;
}

/** A session with no refresh token fails without a network call. */
export async function refreshSession(
  config: AppConfig,
  session: Session,
  httpFetch: typeof globalThis.fetch = globalThis.fetch,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<AuthResult<Session>> {
  if (session.refreshToken === null) {
    return { ok: false, reason: "sign-in has no refresh token on record; sign in again" };
  }
  const response = await httpFetch(`${config.url}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: authHeaders(config),
    body: JSON.stringify({ refresh_token: session.refreshToken }),
  });
  if (!response.ok) {
    return { ok: false, reason: await failure(response) };
  }
  return parseSession(session.email, await response.json(), nowSeconds);
}

/** `refresh` is injected so this runs with no fetch and no `AppConfig`. */
export async function ensureFreshSession(
  session: Session,
  nowSeconds: number,
  refresh: (session: Session) => Promise<AuthResult<Session>>,
): Promise<AuthResult<Session>> {
  if (isInactive(session.lastActiveAt, nowSeconds)) {
    return {
      ok: false,
      reason: `signed out after ${INACTIVITY_TIMEOUT_SECONDS / 86_400} days of inactivity; sign in again`,
    };
  }
  if (!needsRefresh(session, nowSeconds)) {
    return { ok: true, value: session };
  }
  return refresh(session);
}

/**
 * False if a sign-out or a fresh sign-in landed while the refresh was in
 * flight: the result then belongs to a session nobody is using.
 */
export function refreshStillApplies(startedFor: Session, current: Session | null): boolean {
  return (
    current !== null &&
    current.email === startedFor.email &&
    current.accessToken === startedFor.accessToken
  );
}
