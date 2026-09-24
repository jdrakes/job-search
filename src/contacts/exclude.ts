// What is never a contact. This runs before any body is read: an address
// or header alone is enough to drop an ATS receipt or a job alert, and
// cheaper than judging the message underneath it.
import { findWholeWord } from "../judge/whole-word.ts";
import type { CaptureThread } from "./capture.ts";

// A local part carrying any of these, as a whole word, is a sender that
// never replies and never is a recruiter.
const EXCLUDED_LOCAL_PARTS = [
  "no-reply",
  "noreply",
  "donotreply",
  "do-not-reply",
  "jobalerts-noreply",
  "notifications",
  "careers",
  "support",
] as const;

// Seeded from the 2026-09-23 mailbox probe: ATS and job-board domains, each
// one a real observed sender. `linkedin.com` is here too, because job alerts
// (`jobalerts-noreply@linkedin.com`) vastly outnumber the InMail addresses
// carved out below.
const EXCLUDED_DOMAINS = [
  "greenhouse-mail.io",
  "us.greenhouse-mail.io",
  "gem.com",
  "appreview.gem.com",
  "ashbyhq.com",
  "lever.co",
  "myworkday.com",
  "icims.com",
  "smartrecruiters.com",
  "ziprecruiter.com",
  "linkedin.com",
] as const;

// Real recruiters writing through LinkedIn InMail, on `linkedin.com`, which
// this list would otherwise exclude whole.
const SURVIVING_LINKEDIN_SENDERS = ["inmail-hit-reply@linkedin.com", "hit-reply@linkedin.com"];

function domainExcluded(domain: string): boolean {
  return EXCLUDED_DOMAINS.some(
    (excluded) => domain === excluded || domain.endsWith(`.${excluded}`),
  );
}

export function isExcludedSender(address: string): boolean {
  const lower = address.toLowerCase().trim();
  if (SURVIVING_LINKEDIN_SENDERS.includes(lower)) return false;

  const at = lower.lastIndexOf("@");
  if (at === -1) return false;
  const localPart = lower.slice(0, at);
  const domain = lower.slice(at + 1);

  if (EXCLUDED_LOCAL_PARTS.some((term) => findWholeWord(localPart, term) !== null)) return true;
  return domainExcluded(domain);
}

// The inclusion bar: a thread with no message James sent is a thread he
// never answered, not a relationship. `SENT` is the label the search
// response already carries per message, so this reads that rather than
// re-deriving it from the sender address alone.
export function hasReplyFromJames(thread: CaptureThread, account: string): boolean {
  const lowerAccount = account.toLowerCase().trim();
  return thread.messages.some(
    (message) =>
      (message.labels ?? []).includes("SENT") ||
      message.sender.toLowerCase().trim() === lowerAccount,
  );
}
