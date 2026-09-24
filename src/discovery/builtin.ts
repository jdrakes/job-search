// Built In's job board as a discovery source: every card's company name,
// no judgment. Modelled on weworkremotely.ts (regex over server-rendered
// HTML, no dependency), not remoteok.ts.
import { getText, htmlToText, type HttpOptions } from "../net/http.ts";
import type { Source } from "./source.ts";

// A cap against a listing with no stated end: a board that keeps offering
// another page would otherwise be read until it stopped. themuse.ts holds
// its own for the same reason.
const MAX_PAGES = 50;

// The flagship board alone. Eight city editions (austin, boston,
// chicago, colorado, la, nyc, seattle, sf) were read too until
// 2026-09-22; two live runs of this branch that day removed them:
//
//   - the nine hosts cost ~450 page requests a run, more than any other
//     source;
//   - the first run's new companies, grouped by source, put Built In last
//     with none at all: it found nothing the tool did not already know, the
//     city sites overlapping heavily with each other and with the flagship;
//   - the second run's builtin.com answered HTTP 429 after 4 retries,
//     which failed the whole source: discover reports a throwing
//     companies() as one error and loses the source's whole contribution
//     for that run. (`companies` below no longer throws once it has read
//     a name, so a 429 part-way through now costs only the pages after
//     it; the request cost is still the reason the eight hosts went.)
//
// One host keeps the source, which the design page protects ("sources are
// added whenever one is found and never removed for yielding little"),
// and drops the eight redundant hosts that cost the requests and drew the
// throttling. Still a list, not a bare constant, because a city edition
// that later earns its place goes back in here.
const HOSTS = ["builtin.com"] as const;

// A card's company sits in `data-id="company-title"><span>{name}</span>`,
// consistently classed on every page checked. A regex rather than an HTML
// parser: one field, no dependency.
const COMPANY_TITLE = /data-id="company-title"[^>]*>\s*<span[^>]*>([^<]+)<\/span>/g;

export function parseBuiltInJobs(html: string): string[] {
  const names: string[] = [];
  for (const match of html.matchAll(COMPANY_TITLE)) {
    const name = htmlToText(match[1] ?? "").trim();
    if (name !== "") names.push(name);
  }
  return names;
}

// A page that fails ends the host's walk and keeps the names already
// read, the same way an empty page ends it. Built In answered HTTP 429
// part-way through three of the four runs it has been read in (2026-09-22
// 14:28 and 20:32, 2026-09-23 06:30; only 23:26 finished), and because
// `discover` reports a throwing `companies()` as one error and keeps
// nothing, the 06:30 run collected 46 pages of names and discarded all of
// them, seeing 1,603 names where the run that finished saw 2,281.
//
// Stopping short costs almost nothing: MAX_PAGES is this file's own cap,
// not the end of Built In's listing, so a walk that ends at page 46 of 50
// is the same kind of thin slice the walk already takes deliberately
// (themuse.ts reads 50 of 20,649 pages a run). The host saying 429 is it
// naming where to stop, not a failure to report.
//
// A failure before any name is read still throws, so a source that is
// wholly down is still one loud error in the discover phase rather than a
// silent nothing.
async function companies(options?: HttpOptions): Promise<string[]> {
  const names: string[] = [];
  for (const host of HOSTS) {
    for (let page = 1; page <= MAX_PAGES; page++) {
      let html: string;
      try {
        html = await getText(`https://${host}/jobs?page=${page}`, options);
      } catch (error) {
        if (names.length === 0) throw error;
        break;
      }
      const found = parseBuiltInJobs(html);
      if (found.length === 0) break;
      names.push(...found);
    }
  }
  return names;
}

// Named for the website, not "builtin": 4,919 companies in the store
// carry source = 'builtin' from a bootstrap import on 2026-09-15, a week
// before this source existed, where the word meant "built in to the
// tool". Sharing the string would credit this source with 4,919
// companies it never found in the one query — companies grouped by
// source — that decides whether a source earns its keep. The historical
// rows keep their own meaning; companies.source has no CHECK, so nothing
// to migrate.
export const builtInSource: Source = { name: "builtin.com", companies };
