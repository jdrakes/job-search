// Common Crawl's URL index as a discovery source: every board its latest
// crawl saved on the Ashby, Greenhouse and Lever board hosts. It names
// boards, not companies — `discover` asks each one it has not seen before,
// once, for the company name.
import { boardKey } from "../companies.ts";
import { getJson, getText, htmlToText, HttpError, type HttpOptions } from "../net/http.ts";
import type { Board } from "../schema.ts";
import type { BoardSource } from "./source.ts";

const COLLECTIONS_URL = "https://index.commoncrawl.org/collinfo.json";

const HOSTS: readonly { host: string; platform: "ashby" | "greenhouse" | "lever" }[] = [
  { host: "jobs.ashbyhq.com", platform: "ashby" },
  { host: "job-boards.greenhouse.io", platform: "greenhouse" },
  { host: "boards.greenhouse.io", platform: "greenhouse" },
  { host: "jobs.lever.co", platform: "lever" },
];

// First path segments on the board hosts that are not a board.
const NOT_BOARDS = new Set(["embed", "v1", "api"]);

// collinfo.json lists crawls newest first.
export function latestIndex(collections: unknown): string | null {
  if (!Array.isArray(collections)) return null;
  const first: unknown = collections[0];
  if (typeof first !== "object" || first === null) return null;
  const api = (first as Record<string, unknown>)["cdx-api"];
  return typeof api === "string" ? api : null;
}

// One JSON object per line, each with the captured `url`. A line that does
// not parse, or a url on another host, is skipped.
export function parseIndexPage(body: string, host: string): string[] {
  const ids: string[] = [];
  for (const line of body.split("\n")) {
    if (line.trim() === "") continue;
    let url: URL;
    try {
      const record: unknown = JSON.parse(line);
      const raw = (record as Record<string, unknown>)["url"];
      if (typeof raw !== "string") continue;
      url = new URL(raw);
    } catch {
      continue;
    }
    if (url.host !== host) continue;
    let segment: string;
    try {
      segment = decodeURIComponent(url.pathname.split("/")[1] ?? "");
    } catch {
      continue;
    }
    if (segment === "" || NOT_BOARDS.has(segment.toLowerCase())) continue;
    ids.push(segment);
  }
  return ids;
}

// An Ashby board page's title is "<Company> Jobs"; a Lever page's is the
// company's name.
export function pageTitle(html: string, platform: "ashby" | "lever"): string | null {
  const match = /<title>([^<]*)<\/title>/i.exec(html);
  if (match === null) return null;
  let title = htmlToText(match[1] ?? "").trim();
  if (platform === "ashby") title = title.replace(/\s+Jobs$/i, "").trim();
  return title === "" ? null : title;
}

async function boards(options?: HttpOptions): Promise<Board[]> {
  const collections = await getJson<unknown>(COLLECTIONS_URL, options);
  const index = latestIndex(collections);
  if (index === null) throw new Error("collinfo.json names no crawl index");

  const seen = new Set<string>();
  const found: Board[] = [];

  for (const { host, platform } of HOSTS) {
    const numPages = await getJson<{ pages?: unknown }>(
      `${index}?url=${host}/*&output=json&showNumPages=true`,
      options,
    );
    const pages = typeof numPages.pages === "number" ? numPages.pages : 0;

    for (let page = 0; page < pages; page++) {
      const body = await getText(`${index}?url=${host}/*&output=json&fl=url&page=${page}`, options);
      for (const rawId of parseIndexPage(body, host)) {
        // Every Greenhouse id on file is lowercase; Lever is case-sensitive
        // (18 Lever ids on file carry capitals), so its spelling is kept.
        const id = platform === "greenhouse" ? rawId.toLowerCase() : rawId;
        const board: Board = { platform, id };
        const key = boardKey(board).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        found.push(board);
      }
    }
  }

  if (found.length === 0) {
    throw new Error("no board parsed from the index: its answer shape has changed");
  }

  return found;
}

async function companyName(board: Board, options?: HttpOptions): Promise<string | null> {
  try {
    if (board.platform === "greenhouse") {
      const data = await getJson<{ name?: unknown }>(
        `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board.id)}`,
        options,
      );
      return typeof data.name === "string" && data.name !== "" ? data.name : null;
    }

    if (board.platform === "ashby") {
      const html = await getText(`https://jobs.ashbyhq.com/${board.id}`, options);
      return pageTitle(html, "ashby");
    }

    if (board.platform === "lever") {
      const html = await getText(`https://jobs.lever.co/${board.id}`, options);
      return pageTitle(html, "lever");
    }

    return null;
  } catch (error) {
    if (error instanceof HttpError) return null;
    throw error;
  }
}

export const commonCrawlSource: BoardSource = { name: "commoncrawl", boards, companyName };
