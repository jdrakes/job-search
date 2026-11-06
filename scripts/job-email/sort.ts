// Decides which agent lists read a thread: job-alert and recruiter mail,
// application status mail, both, or neither. A thread the table does not
// recognise goes to both, so a person at a company with a subject naming no
// role (the mail that changes a status) is never lost. First matching row wins.
import type { GmailMessage, GmailThread } from "./gmail.ts";

export type Lists = "suggestions" | "status" | "both" | "neither";

const ALERT_SENDER = "jobalerts-noreply@linkedin.com";
const ALERT_DOMAINS = ["jobalert.indeed.com", "match.indeed.com", "nurture.icims.com"];
const BOARD_DOMAINS = [
  "glassdoor.com",
  "wellfound.com",
  "builtin.com",
  "dice.com",
  "ziprecruiter.com",
  "jobgether.com",
  "talenthop.com",
];
const MIXED_DOMAINS = [
  "linkedin.com",
  "indeed.com",
  "getclera.com",
  "workable.com",
  "workablemail.com",
];
const MIXED_LABELS = ["ladders", "theladders", "raydar"];
const STATUS_DOMAINS = [
  "ashbyhq.com",
  "greenhouse-mail.io",
  "greenhouse.io",
  "lever.co",
  "myworkday.com",
  "icims.com",
  "rippling.com",
  "gem.com",
  "smartrecruiters.com",
  "jobvite.com",
  "bamboohr.com",
  "clinchtalent.com",
];
const NOISE_LABELS = ["CATEGORY_PROMOTIONS", "CATEGORY_FORUMS"];
const NOISE_SUBJECT =
  /(verification|sign.?in|security|login) code|\breceipt\b|\binvoice\b|\bnewsletter\b/i;

function domainOf(sender: string): string {
  return sender.slice(sender.lastIndexOf("@") + 1);
}

// The domain itself or a subdomain of it; "notlever.co" is not "lever.co".
function inDomains(domain: string, domains: readonly string[]): boolean {
  return domains.some((listed) => domain === listed || domain.endsWith(`.${listed}`));
}

export function sortThread(thread: GmailThread, windowMessages: readonly GmailMessage[]): Lists {
  const first = windowMessages[0];
  if (first === undefined) return "both";
  const domain = domainOf(first.sender);
  const windowLabels = windowMessages.flatMap((message) => message.labels);

  if (thread.messages.some((message) => message.labels.includes("SENT"))) return "both";
  if (first.sender === ALERT_SENDER) return "suggestions";
  if (inDomains(domain, ALERT_DOMAINS)) return "suggestions";
  if (inDomains(domain, BOARD_DOMAINS)) return "suggestions";
  if (inDomains(domain, MIXED_DOMAINS) || windowLabels.some((l) => MIXED_LABELS.includes(l))) {
    return "both";
  }
  if (inDomains(domain, STATUS_DOMAINS)) return "status";
  if (
    windowLabels.some((label) => NOISE_LABELS.includes(label)) ||
    NOISE_SUBJECT.test(first.subject)
  ) {
    return "neither";
  }
  return "both";
}
