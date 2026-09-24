// Remote OK's published jobs API as a discovery source: every job's
// company name, no judgment. One request for the whole feed; the host's
// robots.txt asks for `Crawl-delay: 1` (`HOST_DELAYS_MS`, src/net/http.ts).
import { getJson, htmlToText, type HttpOptions } from "../net/http.ts";
import { asArray, asRecord, asText } from "../ats/ats.ts";
import type { Source } from "./source.ts";

const API_URL = "https://remoteok.com/api";

// The array's first element is Remote OK's API terms of service, with no
// `company`. Nothing special-cases position 0: an element with no readable
// `company` is skipped, which also covers anything the vendor adds later.
export function parseRemoteOkJobs(data: unknown): string[] {
  const names: string[] = [];
  for (const entry of asArray(data)) {
    const company = asText(asRecord(entry)["company"]);
    if (company === null) continue;

    // `htmlToText` because the vendor sends a name as it was typed: an
    // ampersand arrives entity-encoded ("Wide World Importers &amp;
    // Logistics") and a name arrives padded ("Adventure Works ").
    const name = htmlToText(company).trim();
    if (name !== "") names.push(name);
  }
  return names;
}

async function companies(options?: HttpOptions): Promise<string[]> {
  return parseRemoteOkJobs(await getJson<unknown>(API_URL, options));
}

export const remoteOkSource: Source = { name: "remoteok", companies };
