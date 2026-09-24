// We Work Remotely's published jobs feed as a discovery source: every
// item's company name, no judgment. One request for the whole feed.
import { getText, htmlToText, type HttpOptions } from "../net/http.ts";
import type { Source } from "./source.ts";

const FEED_URL = "https://weworkremotely.com/remote-jobs.rss";

// A regex rather than an XML parser: one field, no dependency.
const ITEM = /<item>([\s\S]*?)<\/item>/g;
const TITLE = /<title>([\s\S]*?)<\/title>/;

// WWR writes an item's title as "Company: Role". A title with no ": " is
// skipped: nothing says where a name ends and a role begins.
const SEPARATOR = ": ";

export function parseWeWorkRemotelyFeed(xml: string): string[] {
  const names: string[] = [];
  for (const item of xml.matchAll(ITEM)) {
    const title = TITLE.exec(item[1] ?? "");
    if (title === null) continue;

    const raw = title[1] ?? "";
    const end = raw.indexOf(SEPARATOR);
    if (end === -1) continue;

    // `htmlToText` because a name whose own spelling carries an ampersand
    // arrives entity-encoded ("A. VanArsdel&amp; Co.").
    const name = htmlToText(raw.slice(0, end)).trim();
    if (name !== "") names.push(name);
  }
  return names;
}

async function companies(options?: HttpOptions): Promise<string[]> {
  return parseWeWorkRemotelyFeed(await getText(FEED_URL, options));
}

export const weWorkRemotelySource: Source = { name: "weworkremotely", companies };
