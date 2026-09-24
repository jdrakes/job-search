// Ashby's public job board API: one request per company returns every open
// posting, body and structured compensation included. This reader takes the
// widest range across every annual-US-dollar `Salary` component of every
// tier; which figure is base and which on-target is the processor's
// judgment. Another currency or period is not read (`isUsd`, ats.ts).
import { getJson, htmlToText, type HttpOptions } from "../net/http.ts";
import type { Board } from "../schema.ts";
import {
  asArray,
  asRecord,
  asText,
  compInText,
  isoDate,
  isUsd,
  workplaceOf,
  type Listing,
  type Reader,
} from "./ats.ts";

// How Ashby spells "a year" in a component's `interval`.
const ANNUAL = "1 YEAR";

function tierSalaryValues(tiers: readonly unknown[]): number[] {
  const values: number[] = [];
  for (const tierRaw of tiers) {
    for (const componentRaw of asArray(asRecord(tierRaw)["components"])) {
      const component = asRecord(componentRaw);
      if (component["compensationType"] !== "Salary") continue;
      if (!isUsd(component["currencyCode"]) || component["interval"] !== ANNUAL) continue;
      for (const key of ["minValue", "maxValue"]) {
        const value = component[key];
        if (typeof value === "number" && Number.isFinite(value)) values.push(value);
      }
    }
  }
  return values;
}

function toListing(raw: unknown): Listing {
  const job = asRecord(raw);
  const body = htmlToText(asText(job["descriptionPlain"]) ?? asText(job["descriptionHtml"]) ?? "");
  const tiers = asArray(asRecord(job["compensation"])["compensationTiers"]);
  const values = tierSalaryValues(tiers);
  // Structured wins over a range in the prose.
  const structured =
    values.length > 0 ? { compLow: Math.min(...values), compHigh: Math.max(...values) } : null;
  const comp = structured ?? compInText(body);
  return {
    id: String(job["id"] ?? ""),
    title: asText(job["title"]),
    url: asText(job["jobUrl"]),
    location: asText(job["location"]),
    compLow: comp?.compLow ?? null,
    compHigh: comp?.compHigh ?? null,
    postedAt: isoDate(job["publishedAt"]),
    body: asText(body),
    workplace: workplaceOf(job["workplaceType"]),
  };
}

export function parseAshby(data: unknown): Listing[] {
  return asArray(asRecord(data)["jobs"]).map(toListing);
}

async function list(board: Board, options?: HttpOptions): Promise<Listing[]> {
  const data = await getJson<unknown>(
    `https://api.ashbyhq.com/posting-api/job-board/${board.id}?includeCompensation=true`,
    options,
  );
  return parseAshby(data);
}

export const ashbyReader: Reader = { platform: "ashby", list };
