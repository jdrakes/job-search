// A board URL is external input, parsed into a typed `Board` once at this
// boundary. It replaces the survey's hand-spelled columns (`workdayBoard`,
// `icimsBoard` in the deleted `scripts/watch-survey.ts`): a person pastes a
// public URL copied from a browser — the board's own page or one posting
// under it — and gets back the board a reader in `src/ats/` can read.
//
// Supported: Greenhouse, Ashby, Lever (the three Common Crawl already
// walks), Workday, Eightfold and iCIMS (the three the survey spelled by
// hand). Every other platform in `PLATFORMS`, and a company's own careers
// domain on any platform (a `gh_jid` or `ashby_jid` query on some other
// host, for instance), names no board a URL alone can identify: null.
import { getJson, getText, htmlToText, HttpError, type HttpOptions } from "../net/http.ts";
import type { Board } from "../schema.ts";

const GREENHOUSE_HOSTS = new Set(["boards.greenhouse.io", "job-boards.greenhouse.io"]);

// `{tenant}.wd{N}.myworkdayjobs.com`, the host `parseWorkdayId` in
// `src/ats/workday.ts` reads back out of `{wd}/{site}/{tenant}`.
const WORKDAY_HOST = /^([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com$/;

// A locale segment ("en-US") in front of a Workday site segment
// ("Cisco_Careers"). Real site names carry underscores or "Careers"; a
// locale is always two letters, a dash, two letters.
const WORKDAY_LOCALE = /^[a-z]{2}-[A-Z]{2}$/i;

function pathSegments(url: URL): string[] {
  return url.pathname.split("/").filter((segment) => segment !== "");
}

function workdaySite(segments: string[]): string | null {
  const [first, second] = segments;
  if (first === undefined) return null;
  if (WORKDAY_LOCALE.test(first)) return second ?? null;
  return first;
}

// The board a posting's or board's URL names, or null when the URL names no
// board the readers can read.
export function parseBoardUrl(url: string): Board | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const segments = pathSegments(parsed);

  if (GREENHOUSE_HOSTS.has(host)) {
    const id = segments[0];
    return id === undefined ? null : { platform: "greenhouse", id: id.toLowerCase() };
  }

  if (host === "jobs.ashbyhq.com") {
    const id = segments[0];
    return id === undefined ? null : { platform: "ashby", id };
  }

  if (host === "jobs.lever.co") {
    const id = segments[0];
    return id === undefined ? null : { platform: "lever", id };
  }

  if (host.endsWith(".eightfold.ai")) {
    return { platform: "eightfold", id: host };
  }

  if (host.endsWith(".jibeapply.com")) {
    const slug = host.slice(0, -".jibeapply.com".length);
    return slug === "" ? null : { platform: "icims", id: slug };
  }

  const workday = WORKDAY_HOST.exec(host);
  if (workday !== null) {
    const [, tenant, wd] = workday;
    const site = workdaySite(segments);
    return site === null ? null : { platform: "workday", id: `${wd}/${site}/${tenant}` };
  }

  return null;
}

// The board's public URL, for the platforms whose board page has one; used
// to write Common Crawl's candidates. Round-trips through `parseBoardUrl`
// for every platform it returns a URL for. Called only with a board one of
// those platforms named, so an unsupported platform is a bug, not an
// expected failure.
export function boardUrl(board: Board): string {
  switch (board.platform) {
    case "greenhouse":
      return `https://job-boards.greenhouse.io/${board.id}`;
    case "ashby":
      return `https://jobs.ashbyhq.com/${board.id}`;
    case "lever":
      return `https://jobs.lever.co/${board.id}`;
    case "eightfold":
      return `https://${board.id}`;
    case "icims":
      return `https://${board.id}.jibeapply.com`;
    case "workday": {
      const [wd, site, tenant] = board.id.split("/");
      return `https://${tenant}.${wd}.myworkdayjobs.com/${site}`;
    }
    default:
      throw new Error(`boardUrl: no public URL for platform ${board.platform}`);
  }
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

// The name a board's own page gives for the company that owns it:
// Greenhouse's board `name`, the Ashby and Lever page `<title>` (via
// `pageTitle`), null for every other platform or any `HttpError`.
export async function boardName(board: Board, options?: HttpOptions): Promise<string | null> {
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
