// The Muse's public jobs API as a discovery source: every result's
// company name, no judgment. Modelled on remoteok.ts (clean JSON, one
// field wanted). `page_count` was 20649 live (412,979 postings total,
// confirmed 2026-09-22) — walked from page=0, capped at a source-local
// MAX_PAGES the same way builtin.ts caps its own walk against a listing
// with no practical end; the design page's "added whenever one is found
// and never removed for yielding little" already covers seeing only a
// thin slice of the total each run.
import { getJson, type HttpOptions } from "../net/http.ts";
import { asArray, asRecord, asText } from "../ats/ats.ts";
import type { Source } from "./source.ts";

const JOBS_URL = "https://www.themuse.com/api/public/jobs";

// robots.txt (checked live) carries no bot-specific rules and doesn't
// block /api/public/jobs; no Crawl-delay published, so no HOST_DELAYS_MS
// entry is needed (src/net/http.ts).
const MAX_PAGES = 50;

export function parseTheMuseJobs(data: unknown): string[] {
  const names: string[] = [];
  for (const result of asArray(asRecord(data)["results"])) {
    const company = asText(asRecord(asRecord(result)["company"])["name"]);
    if (company === null) continue;
    names.push(company.trim());
  }
  return names;
}

async function companies(options?: HttpOptions): Promise<string[]> {
  const names: string[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await getJson<unknown>(`${JOBS_URL}?page=${page}`, options);
    const found = parseTheMuseJobs(data);
    if (found.length === 0) break;
    names.push(...found);
  }
  return names;
}

export const theMuseSource: Source = { name: "themuse", companies };
