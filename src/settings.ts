// Per-operator configuration, gitignored, so one repo serves both an
// operator's own instance and a stranger's. This is the one place
// `settings/config.json` is read and parsed; everything downstream (the
// User-Agent in net/http.ts, the discovery source list in daily.ts) takes
// the typed `Settings` this returns rather than touching the file itself.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SETTINGS_DIR = join(REPO_ROOT, "settings");

export interface Settings {
  readonly userAgent?: string;
  readonly discoverySources?: readonly string[];
  readonly extraSourcePath?: string;
}

// `dir` defaults to `settings/` at the repo root; a caller (a test) passes
// its own directory instead. A missing `config.json` is an operator who has
// not configured anything yet, not an error: it returns `{}` and every
// downstream reader treats an absent field as "use the built-in behaviour".
// A `config.json` that exists but is malformed, unparsable JSON or a known
// field holding the wrong shape, throws naming the path: silently ignoring
// a typo is how an operator ends up running defaults without knowing it.
export function loadSettings(dir: string = DEFAULT_SETTINGS_DIR): Settings {
  const path = join(dir, "config.json");

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`settings: ${path} is not valid JSON`);
  }

  return parseSettings(parsed, path);
}

// Unknown keys are ignored rather than rejected, so an older build still
// reads a config.json written for a newer one.
function parseSettings(value: unknown, path: string): Settings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`settings: ${path} must contain a JSON object`);
  }
  const record = value as Record<string, unknown>;
  const settings: {
    userAgent?: string;
    discoverySources?: readonly string[];
    extraSourcePath?: string;
  } = {};

  if ("userAgent" in record) {
    if (typeof record.userAgent !== "string") {
      throw new Error(`settings: ${path} field "userAgent" must be a string`);
    }
    settings.userAgent = record.userAgent;
  }

  if ("discoverySources" in record) {
    const sources = record.discoverySources;
    if (!Array.isArray(sources) || sources.some((source) => typeof source !== "string")) {
      throw new Error(`settings: ${path} field "discoverySources" must be an array of strings`);
    }
    settings.discoverySources = sources;
  }

  if ("extraSourcePath" in record) {
    if (typeof record.extraSourcePath !== "string") {
      throw new Error(`settings: ${path} field "extraSourcePath" must be a string`);
    }
    settings.extraSourcePath = record.extraSourcePath;
  }

  return settings;
}
