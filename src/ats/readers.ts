// Shared by the daily and the survey import; the one place all eighteen
// readers are wired. A platform missing here is a company that lists as
// zero results rather than an error.

import { amazonReader } from "./amazon.ts";
import type { Reader } from "./ats.ts";
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
import type { Platform } from "../schema.ts";

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
