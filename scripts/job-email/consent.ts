// James's one-time consent for reading Gmail, run in a terminal:
//
//   node scripts/job-email/consent.ts
//
// A one-shot listener on the loopback address catches Google's redirect and
// hands its code to the token exchange, and the token goes to the Keychain.
// The consent URL carries the client id from the credential file, so it goes
// only to `open` and is never printed. Nothing prints the token.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { dirname } from "node:path";
import process from "node:process";

import { describeError } from "../../src/errors.ts";
import {
  authorizationUrl,
  exchangeCode,
  generatePkce,
  gmailPaths,
  keychainStore,
  readCredentials,
  type GmailCredentials,
} from "./oauth.ts";
import type { Result } from "./result.ts";

// `null` is a request that is not the redirect: the browser's favicon request.
export function redirectCode(requestUrl: string, redirectUri: string): Result<string> | null {
  const query = new URL(requestUrl, redirectUri).searchParams;
  const code = query.get("code");
  const refused = query.get("error");
  if (code !== null) return { ok: true, value: code };
  if (refused !== null) return { ok: false, reason: `consent refused: ${refused}` };
  return null;
}

// The directory is made first so the path a missing-file reason names can be
// copied to. The file holds a client secret, so only James's user can read it,
// whatever mode the download came with.
export async function readCredentialFile(path: string): Promise<Result<GmailCredentials>> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if (!existsSync(path)) {
    return {
      ok: false,
      reason: `no Gmail credentials at ${path}; copy the Desktop OAuth client file there`,
    };
  }
  await chmod(path, 0o600);
  return readCredentials(await readFile(path, "utf8"));
}

// Not covered by a test; it needs a browser and James's click.
function awaitRedirect(server: Server, redirectUri: string, url: string): Promise<Result<string>> {
  return new Promise((resolve) => {
    server.on("request", (request, response) => {
      const outcome = redirectCode(request.url ?? "/", redirectUri);
      if (outcome === null) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(
        "<!doctype html><title>job-search</title><p>Done. You can close this tab and return to the terminal.</p>",
      );
      resolve(outcome);
    });
    // The error's message quotes the command line, which holds the URL.
    execFile("open", [url], (error) => {
      if (error !== null) resolve({ ok: false, reason: "could not open the browser" });
    });
  });
}

async function consent(): Promise<Result<void>> {
  const credentials = await readCredentialFile(gmailPaths().credentials);
  if (!credentials.ok) return credentials;

  const pkce = generatePkce();
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("the loopback listener has no port");
  }
  const redirectUri = `http://127.0.0.1:${address.port}`;
  const url = authorizationUrl(credentials.value, pkce, redirectUri);
  console.log("Allow read-only Gmail access in the browser window that opened.");
  const code = await awaitRedirect(server, redirectUri, url);
  server.close();
  server.closeAllConnections();
  if (!code.ok) return code;

  const token = await exchangeCode(credentials.value, code.value, pkce, redirectUri, new Date());
  if (!token.ok) return token;
  return keychainStore().write(token.value);
}

if (import.meta.main) {
  try {
    const outcome = await consent();
    if (outcome.ok) {
      console.log("Gmail token saved to Keychain");
    } else {
      console.error(`consent: ${outcome.reason}`);
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`consent: ${describeError(error)}`);
    process.exitCode = 1;
  }
}
