// Recruitee's public offers API: one request per board returns every open
// posting, body and structured compensation included - one-phase, like
// ashby.ts (Ruling 2, plan). The board's top-level `location` string is a
// placeholder ("Remote job") on every remote posting checked (one board,
// live 2026-09-22); the real place is `city`/`state_name`/`country`, read
// independently below.
import { getJson, htmlToText, type HttpOptions } from "../net/http.ts";
import type { Board } from "../schema.ts";
import {
  asArray,
  asRecord,
  asText,
  compInText,
  isoDate,
  isUsd,
  type Listing,
  type Reader,
} from "./ats.ts";

function location(offer: Record<string, unknown>): string | null {
  const parts = [
    asText(offer["city"]),
    asText(offer["state_name"]),
    asText(offer["country"]),
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(", ") : null;
}

// `min`/`max` read null on every live posting checked even when `currency`
// and `period` are set (one board's 11 offers, live 2026-09-22); the
// structured path below is real but only exercised by a written fixture.
function structuredComp(
  salary: Record<string, unknown>,
): { compLow: number; compHigh: number } | null {
  const min = salary["min"];
  const max = salary["max"];
  if (
    typeof min !== "number" ||
    !Number.isFinite(min) ||
    typeof max !== "number" ||
    !Number.isFinite(max) ||
    !isUsd(salary["currency"]) ||
    salary["period"] !== "year"
  ) {
    return null;
  }
  return { compLow: min, compHigh: max };
}

// Recruitee states three independent booleans (`remote`/`hybrid`/`on_site`)
// rather than one word. One live board (2026-09-22) states more than one
// true at once on two of its eleven offers - one states all three true,
// another states `hybrid`+`on_site` together - neither is a single answer,
// so only an exactly-one-true offer reads as that workplace; anything else
// records null rather than guessing.
export function recruiteeWorkplace(
  offer: Record<string, unknown>,
): "remote" | "hybrid" | "onsite" | null {
  const flags: Array<["remote" | "hybrid" | "onsite", boolean]> = [
    ["remote", offer["remote"] === true],
    ["hybrid", offer["hybrid"] === true],
    ["onsite", offer["on_site"] === true],
  ];
  const trueFlags = flags.filter(([, value]) => value);
  return trueFlags.length === 1 ? trueFlags[0][0] : null;
}

function toListing(raw: unknown): Listing {
  const offer = asRecord(raw);
  const body = htmlToText(asText(offer["description"]) ?? "");
  const comp = structuredComp(asRecord(offer["salary"])) ?? compInText(body);
  return {
    id: String(offer["id"] ?? ""),
    title: asText(offer["title"]),
    url: asText(offer["careers_url"]),
    location: location(offer),
    compLow: comp?.compLow ?? null,
    compHigh: comp?.compHigh ?? null,
    postedAt: isoDate(offer["published_at"]),
    body: asText(body),
    workplace: recruiteeWorkplace(offer),
  };
}

export function parseRecruiteeListing(data: unknown): Listing[] {
  return asArray(asRecord(data)["offers"]).map(toListing);
}

async function list(board: Board, options?: HttpOptions): Promise<Listing[]> {
  const data = await getJson<unknown>(`https://${board.id}.recruitee.com/api/offers`, options);
  return parseRecruiteeListing(data);
}

export const recruiteeReader: Reader = { platform: "recruitee", list };
