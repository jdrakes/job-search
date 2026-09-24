/**
 * The project URL and the anon key are public by design: row-level
 * security is the guard. `scripts/write-ui-config.ts` writes them, plus the
 * status vocabulary from `config/rules.json`, into a JSON script tag at
 * build time, so the vocabulary has one source and the page fetches no
 * second file.
 */

export const CONFIG_ELEMENT_ID = "app-config";

export interface AppConfig {
  url: string;
  anonKey: string;
  /** `config/rules.json`'s `statuses`, copied in at build time. */
  statuses: string[];
}

export type ConfigResult = { ok: true; config: AppConfig } | { ok: false; reason: string };

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** A missing or empty field is a deploy whose environment variables were not set, so it returns a reason the page can show rather than throwing into a blank screen. */
export function parseConfig(text: string): ConfigResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, reason: "the page config is not JSON" };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { ok: false, reason: "the page config is not an object" };
  }
  const record = data as Record<string, unknown>;
  const url = nonEmptyString(record["url"]);
  if (url === null) {
    return { ok: false, reason: "the page config has no url; was SUPABASE_URL set at build time?" };
  }
  const anonKey = nonEmptyString(record["anonKey"]);
  if (anonKey === null) {
    return {
      ok: false,
      reason: "the page config has no anonKey; was SUPABASE_ANON_KEY set at build time?",
    };
  }
  const statuses = record["statuses"];
  if (!Array.isArray(statuses) || !statuses.every((item) => typeof item === "string")) {
    return { ok: false, reason: "the page config has no statuses list" };
  }
  return { ok: true, config: { url: url.replace(/\/+$/, ""), anonKey, statuses } };
}
