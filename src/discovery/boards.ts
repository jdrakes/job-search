// A board URL is external input, parsed into a typed `Board` once at this
// boundary. With the survey gone, a pasted URL is the only way in for a
// board whose id no company name derives: a person pastes a public URL
// copied from a browser (the board's own page or one posting under it)
// and gets back the board a reader in `src/ats/` can read.
//
// Every platform in `PLATFORMS` is parsed. A URL that carries no board is
// null: a Workable `/j/{shortcode}` posting, Eightfold's shared
// `app.eightfold.ai`, and a company's own careers domain on any platform
// (a `gh_jid` or `ashby_jid` query on some other host, or an Eightfold
// board served from the company's own host: nothing in such a URL says
// Eightfold, so it cannot be told apart from any other careers site).
import { getJson, getText, htmlToText, HttpError, type HttpOptions } from "../net/http.ts";
import type { Board, Platform } from "../schema.ts";

const GREENHOUSE_HOSTS = new Set(["boards.greenhouse.io", "job-boards.greenhouse.io"]);

// Boards named by the path's first segment on the vendor's own host; the
// segment is the id the platform's reader reads.
const PATH_HOSTS = new Map<string, Platform>([
  ["jobs.ashbyhq.com", "ashby"],
  ["jobs.lever.co", "lever"],
  ["jobs.smartrecruiters.com", "smartrecruiters"],
  ["careers.smartrecruiters.com", "smartrecruiters"],
  ["jobs.jobvite.com", "jobvite"],
  ["ats.rippling.com", "rippling"],
  ["apply.workable.com", "workable"],
]);

// Boards named by the host's first label: `{id}.bamboohr.com`. iCIMS's id
// is its `jibeapply.com` slug, not an `icims.com` host.
const SUBDOMAIN_SUFFIXES: ReadonlyArray<readonly [string, Platform]> = [
  [".bamboohr.com", "bamboohr"],
  [".breezy.hr", "breezy"],
  [".applytojob.com", "jazzhr"],
  [".recruitee.com", "recruitee"],
  [".hrmdirect.com", "hrmdirect"],
  [".avature.net", "avature"],
  [".jibeapply.com", "icims"],
];

// A vendor's own labels under its board domain, never a company's board:
// `www.bamboohr.com`, the shared `app.eightfold.ai`.
const VENDOR_LABELS = new Set(["www", "app"]);

// Personio's reader reads the whole listing host, `.de` or `.com`.
const PERSONIO_HOST = /^[a-z0-9-]+\.jobs\.personio\.(de|com)$/;

// Amazon's one global board; `amazon.ts` reads it under the literal id
// "amazon".
const AMAZON_HOSTS = new Set(["amazon.jobs", "www.amazon.jobs"]);
const AMAZON_ID = "amazon";

// `{tenant}.wd{N}.myworkdayjobs.com`, the host `parseWorkdayId` in
// `src/ats/workday.ts` reads back out of `{wd}/{site}/{tenant}`.
const WORKDAY_HOST = /^([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com$/;

// `wd{N}.myworkdaysite.com/[{locale}/]recruiting/{tenant}/{site}`: the same
// tenant's site on a second vendor host. The reader reaches it through the
// myworkdayjobs host above, which answers the same CXS search (checked
// live 2026-09-27: one tenant's search answered 200 on both hosts).
const WORKDAY_SITE_HOST = /^(wd\d+)\.myworkdaysite\.com$/;

// A locale segment ("en-US") in front of a Workday site segment
// ("Cisco_Careers"). Real site names carry underscores or "Careers"; a
// locale is always two letters, a dash, two letters.
const WORKDAY_LOCALE = /^[a-z]{2}-[A-Z]{2}$/i;

function pathSegments(url: URL): string[] {
  return url.pathname.split("/").filter((segment) => segment !== "");
}

function withoutLocale(segments: string[]): string[] {
  const [first] = segments;
  return first !== undefined && WORKDAY_LOCALE.test(first) ? segments.slice(1) : segments;
}

function workdayBoard(
  wd: string,
  site: string | undefined,
  tenant: string | undefined,
): Board | null {
  if (site === undefined || tenant === undefined) return null;
  return { platform: "workday", id: `${wd}/${site}/${tenant.toLowerCase()}` };
}

// Greenhouse's embed forms (`/embed/job_app?for={id}`,
// `/embed/job_board?for={id}`) carry the board in the `for` parameter.
function greenhouseBoard(url: URL, segments: string[]): Board | null {
  const id = segments[0] === "embed" ? url.searchParams.get("for") : segments[0];
  return id === undefined || id === null || id === ""
    ? null
    : { platform: "greenhouse", id: id.toLowerCase() };
}

// Workable's `/j/{shortcode}` posting names no account.
function pathBoard(platform: Platform, segments: string[]): Board | null {
  const id = segments[0];
  if (id === undefined) return null;
  if (platform === "workable" && id === "j") return null;
  return { platform, id };
}

function subdomainBoard(host: string): Board | null {
  for (const [suffix, platform] of SUBDOMAIN_SUFFIXES) {
    if (!host.endsWith(suffix)) continue;
    const label = host.slice(0, -suffix.length);
    if (label === "" || label.includes(".") || VENDOR_LABELS.has(label)) return null;
    return { platform, id: label };
  }
  return null;
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

  if (GREENHOUSE_HOSTS.has(host)) return greenhouseBoard(parsed, segments);

  const pathPlatform = PATH_HOSTS.get(host);
  if (pathPlatform !== undefined) return pathBoard(pathPlatform, segments);

  if (host.endsWith(".eightfold.ai")) {
    const label = host.slice(0, -".eightfold.ai".length);
    return VENDOR_LABELS.has(label) ? null : { platform: "eightfold", id: host };
  }

  if (PERSONIO_HOST.test(host)) return { platform: "personio", id: host };

  if (AMAZON_HOSTS.has(host)) return { platform: "amazon", id: AMAZON_ID };

  const workday = WORKDAY_HOST.exec(host);
  if (workday !== null) {
    const [, tenant, wd = ""] = workday;
    return workdayBoard(wd, withoutLocale(segments)[0], tenant);
  }

  const workdaySite = WORKDAY_SITE_HOST.exec(host);
  if (workdaySite !== null) {
    const [, wd = ""] = workdaySite;
    const [recruiting, tenant, site] = withoutLocale(segments);
    return recruiting === "recruiting" ? workdayBoard(wd, site, tenant) : null;
  }

  return subdomainBoard(host);
}

// The board's public URL; used to write Common Crawl's candidates.
// Round-trips through `parseBoardUrl` for every platform.
export function boardUrl(board: Board): string {
  switch (board.platform) {
    case "greenhouse":
      return `https://job-boards.greenhouse.io/${board.id}`;
    case "ashby":
      return `https://jobs.ashbyhq.com/${board.id}`;
    case "lever":
      return `https://jobs.lever.co/${board.id}`;
    case "smartrecruiters":
      return `https://jobs.smartrecruiters.com/${board.id}`;
    case "jobvite":
      return `https://jobs.jobvite.com/${board.id}/jobs`;
    case "rippling":
      return `https://ats.rippling.com/${board.id}/jobs`;
    case "workable":
      return `https://apply.workable.com/${board.id}`;
    case "eightfold":
    case "personio":
      return `https://${board.id}`;
    case "amazon":
      return "https://www.amazon.jobs";
    case "bamboohr":
      return `https://${board.id}.bamboohr.com/careers`;
    case "breezy":
      return `https://${board.id}.breezy.hr`;
    case "jazzhr":
      return `https://${board.id}.applytojob.com/apply`;
    case "recruitee":
      return `https://${board.id}.recruitee.com`;
    case "hrmdirect":
      return `https://${board.id}.hrmdirect.com/employment/job-openings.php`;
    case "avature":
      return `https://${board.id}.avature.net/careers`;
    case "icims":
      return `https://${board.id}.jibeapply.com`;
    case "workday": {
      const [wd, site, tenant] = board.id.split("/");
      return `https://${tenant}.${wd}.myworkdayjobs.com/${site}`;
    }
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

// An Avature portal names its owner in the page's `og:site_name` meta tag:
// the tenant checked live on 2026-09-27 states `content="Bloomberg"` there,
// while its <title> reads "Bloomberg Careers" and the portal's own name meta
// reads "External Careers". The <title> format differs between tenants
// (probe.ts, top), so it is not read.
export function avatureSiteName(html: string): string | null {
  const match = /<meta\s+property="og:site_name"\s+content="([^"]*)"/i.exec(html);
  if (match === null) return null;
  const name = htmlToText(match[1] ?? "").trim();
  return name === "" ? null : name;
}

// The name a board's own page gives for the company that owns it:
// Greenhouse's board `name`, the Ashby and Lever page `<title>` (via
// `pageTitle`), Avature's `og:site_name`, null for every other platform or
// any `HttpError` but a 429. A 429 is thrown: the vendor declined to answer,
// which is not the page naming nobody (probe.ts's `probePlatform` says why).
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

    if (board.platform === "avature") {
      const html = await getText(`https://${board.id}.avature.net/careers/SearchJobs`, options);
      return avatureSiteName(html);
    }

    return null;
  } catch (error) {
    if (error instanceof HttpError && error.status !== 429) return null;
    throw error;
  }
}
