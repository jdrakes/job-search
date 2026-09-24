// Shared by the daily and the survey import; the one place all eighteen
// readers are wired. A platform missing here is a company that lists as
// zero results rather than an error.

import { amazonReader } from "./amazon.ts";
import type { DetailRead, Listing, Reader } from "./ats.ts";
import { ashbyReader } from "./ashby.ts";
import { avatureReader } from "./avature.ts";
import { bambooHrReader } from "./bamboohr.ts";
import { breezyReader } from "./breezy.ts";
import { eightfoldReader } from "./eightfold.ts";
import { greenhouseReader } from "./greenhouse.ts";
import { hrmdirectReader } from "./hrmdirect.ts";
import { icimsReader } from "./icims.ts";
import { jazzhrReader } from "./jazzhr.ts";
import { jobviteReader } from "./jobvite.ts";
import { leverReader } from "./lever.ts";
import { personioReader } from "./personio.ts";
import { recruiteeReader } from "./recruitee.ts";
import { ripplingReader } from "./rippling.ts";
import { smartrecruitersReader } from "./smartrecruiters.ts";
import { workableReader } from "./workable.ts";
import { workdayReader } from "./workday.ts";
import type { Board, Platform } from "../schema.ts";

export const READERS: Record<Platform, Reader> = {
  greenhouse: greenhouseReader,
  ashby: ashbyReader,
  lever: leverReader,
  smartrecruiters: smartrecruitersReader,
  workday: workdayReader,
  eightfold: eightfoldReader,
  amazon: amazonReader,
  workable: workableReader,
  rippling: ripplingReader,
  jobvite: jobviteReader,
  bamboohr: bambooHrReader,
  avature: avatureReader,
  breezy: breezyReader,
  jazzhr: jazzhrReader,
  recruitee: recruiteeReader,
  personio: personioReader,
  hrmdirect: hrmdirectReader,
  icims: icimsReader,
};

// A body left null is what sends the judge to `body` for the page; a band
// or workplace the listing carried would be the listing's, not the page's.
function withoutDetail(listing: Listing): Listing {
  return { ...listing, body: null, compLow: null, compHigh: null, workplace: null };
}

function withDetailRead(reader: Reader, reads: readonly DetailRead[]): Reader {
  const readFor = (board: Board) => reads.find((read) => read.board === board.id) ?? null;
  return {
    ...reader,
    async list(board, options) {
      const listings = await reader.list(board, options);
      return readFor(board) === null ? listings : listings.map(withoutDetail);
    },
    async body(board, id, options) {
      const read = readFor(board);
      if (read !== null) return read.body(id, options);
      return reader.body === undefined ? null : reader.body(board, id, options);
    },
  };
}

// A platform no read names keeps its reader as it is, so a one-phase reader
// gains no `body` and is judged exactly as before.
export function withDetailReads(
  readers: Record<Platform, Reader>,
  reads: readonly DetailRead[],
): Record<Platform, Reader> {
  const entries = Object.entries(readers).map(([platform, reader]) => {
    const own = reads.filter((read) => read.platform === platform);
    return [platform, own.length === 0 ? reader : withDetailRead(reader, own)] as const;
  });
  return Object.fromEntries(entries) as Record<Platform, Reader>;
}
