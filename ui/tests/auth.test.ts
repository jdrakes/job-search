import assert from "node:assert/strict";
import { test } from "node:test";
import { createSSRApp } from "vue";
import { renderToString } from "vue/server-renderer";

import { STATUSES } from "../../src/schema.ts";
import { linkTokenFrom, requestLink, verifyLink } from "../src/auth.ts";
import type { AppConfig } from "../src/config.ts";
import { SignIn } from "../src/sign-in.ts";

const CONFIG: AppConfig = {
  url: "https://project.supabase.co",
  anonKey: "anon-key",
  statuses: [...STATUSES],
};

const NOW = 1_800_000_000;

function capturingFetch(reply: () => Response): {
  requests: { url: string; body: unknown }[];
  fetchImpl: typeof fetch;
} {
  const requests: { url: string; body: unknown }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return reply();
  };
  return { requests, fetchImpl };
}

function json(status: number, value: unknown): () => Response {
  return () => new Response(JSON.stringify(value), { status });
}

test("linkTokenFrom reads the token_hash of an email or magiclink link", () => {
  assert.equal(linkTokenFrom("?token_hash=abc&type=email"), "abc");
  assert.equal(linkTokenFrom("?type=magiclink&token_hash=abc&tab=record"), "abc");
});

test("linkTokenFrom ignores any other visit", () => {
  assert.equal(linkTokenFrom(""), null);
  assert.equal(linkTokenFrom("?tab=record"), null);
  assert.equal(linkTokenFrom("?token_hash=abc"), null);
  assert.equal(linkTokenFrom("?token_hash=abc&type=recovery"), null);
  assert.equal(linkTokenFrom("?token_hash=&type=email"), null);
});

test("requestLink asks for a link without enrolling a new user", async () => {
  const { requests, fetchImpl } = capturingFetch(json(200, {}));

  const result = await requestLink(CONFIG, "someone@example.com", fetchImpl);

  assert.deepEqual(result, { ok: true, value: null });
  assert.deepEqual(requests, [
    {
      url: `${CONFIG.url}/auth/v1/otp`,
      body: { email: "someone@example.com", create_user: false },
    },
  ]);
});

test("verifyLink trades the token_hash for a session named for the response's user", async () => {
  const { requests, fetchImpl } = capturingFetch(
    json(200, {
      access_token: "jwt",
      expires_at: NOW + 3600,
      refresh_token: "refresh",
      user: { email: "someone@example.com" },
    }),
  );

  const result = await verifyLink(CONFIG, "hash", fetchImpl, NOW);

  assert.deepEqual(requests, [
    { url: `${CONFIG.url}/auth/v1/verify`, body: { type: "email", token_hash: "hash" } },
  ]);
  assert.deepEqual(result, {
    ok: true,
    value: {
      email: "someone@example.com",
      accessToken: "jwt",
      expiresAt: NOW + 3600,
      refreshToken: "refresh",
      lastActiveAt: NOW,
    },
  });
});

test("verifyLink passes Supabase's reason through for a spent link", async () => {
  const { fetchImpl } = capturingFetch(json(403, { msg: "Email link is invalid or has expired" }));

  const result = await verifyLink(CONFIG, "hash", fetchImpl, NOW);

  assert.deepEqual(result, { ok: false, reason: "Email link is invalid or has expired" });
});

test("verifyLink fails a response with no user email", async () => {
  const { fetchImpl } = capturingFetch(
    json(200, { access_token: "jwt", expires_at: NOW + 3600, refresh_token: "refresh" }),
  );

  const result = await verifyLink(CONFIG, "hash", fetchImpl, NOW);

  assert.equal(result.ok, false);
});

test("SignIn's sent stage says where the link went and asks for no code", async () => {
  const html = await renderToString(
    createSSRApp(SignIn, { stage: "sent", email: "someone@example.com", busy: false }),
  );

  assert.match(html, /Check someone@example.com for a sign-in link\./);
  assert.match(html, /Use a different address/);
  assert.doesNotMatch(html, /<input/);
});
