// Greenhouse's public job board API: one request per company returns every
// open posting, body included. No structured compensation field on this
// endpoint, so `compInText` is the only source.
import { getJson, htmlToText, type HttpOptions } from "../net/http.ts";
import type { Board } from "../schema.ts";
import {
  asArray,
  asRecord,
  asText,
  compInText,
  isoDate,
  type Listing,
  type Reader,
} from "./ats.ts";

function toListing(raw: unknown): Listing {
  const job = asRecord(raw);
  const location = asRecord(job["location"]);
  const body = htmlToText(asText(job["content"]) ?? "");
  const comp = compInText(body);
  return {
    id: String(job["id"] ?? ""),
    title: asText(job["title"]),
    url: asText(job["absolute_url"]),
    location: asText(location["name"]),
    compLow: comp?.compLow ?? null,
    compHigh: comp?.compHigh ?? null,
    postedAt: isoDate(job["first_published"]),
    body: asText(body),
    workplace: null,
  };
}

export function parseGreenhouse(data: unknown): Listing[] {
  return asArray(asRecord(data)["jobs"]).map(toListing);
}

async function list(board: Board, options?: HttpOptions): Promise<Listing[]> {
  const data = await getJson<unknown>(
    `https://boards-api.greenhouse.io/v1/boards/${board.id}/jobs?content=true`,
    options,
  );
  return parseGreenhouse(data);
}

export const greenhouseReader: Reader = { platform: "greenhouse", list };
