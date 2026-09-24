// Lever's public postings API: one request per company returns every open
// posting, body and a structured salary range included. `createdAt` is
// epoch milliseconds (`isoDate`, ats.ts).
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

// How Lever spells "a year" in `salaryRange.interval`.
const ANNUAL = "per-year-salary";

function salary(job: Record<string, unknown>): { compLow: number; compHigh: number } | null {
  const range = asRecord(job["salaryRange"]);
  if (!isUsd(range["currency"]) || range["interval"] !== ANNUAL) return null;
  const low = range["min"];
  const high = range["max"];
  if (typeof low !== "number" || typeof high !== "number") return null;
  if (!Number.isFinite(low) || !Number.isFinite(high)) return null;
  return { compLow: low, compHigh: high };
}

function toListing(raw: unknown): Listing {
  const job = asRecord(raw);
  const body = htmlToText(asText(job["descriptionPlain"]) ?? "");
  const categories = asRecord(job["categories"]);
  // Structured wins over a range in the prose.
  const comp = salary(job) ?? compInText(body);
  return {
    id: String(job["id"] ?? ""),
    title: asText(job["text"]),
    url: asText(job["hostedUrl"]),
    location: asText(categories["location"]),
    compLow: comp?.compLow ?? null,
    compHigh: comp?.compHigh ?? null,
    postedAt: isoDate(job["createdAt"]),
    body: asText(body),
    workplace: workplaceOf(job["workplaceType"]),
  };
}

export function parseLever(data: unknown): Listing[] {
  return asArray(data).map(toListing);
}

async function list(board: Board, options?: HttpOptions): Promise<Listing[]> {
  const data = await getJson<unknown>(
    `https://api.lever.co/v0/postings/${board.id}?mode=json`,
    options,
  );
  return parseLever(data);
}

export const leverReader: Reader = { platform: "lever", list };
