import assert from "node:assert/strict";
import { test } from "node:test";

import type { GmailMessage, GmailThread } from "../scripts/job-email/gmail.ts";
import { sortThread } from "../scripts/job-email/sort.ts";

// Every address and subject here is invented.
function message(sender: string, subject = "Hello", labels: string[] = []): GmailMessage {
  return { sender, subject, date: "2026-10-27T20:15:44Z", labels, text: "" };
}

function sorted(first: GmailMessage, extra: GmailMessage[] = []) {
  const thread: GmailThread = { id: "t1", messages: [first, ...extra] };
  return sortThread(thread, [first]);
}

test("row 1: a message James sent sends the thread to both, even from a status sender", () => {
  const sent = message("me@example.test", "Re: Hi", ["SENT"]);
  assert.equal(sorted(message("noreply@lever.co"), [sent]), "both");
});

test("row 2: the LinkedIn alert sender is suggestions", () => {
  assert.equal(sorted(message("jobalerts-noreply@linkedin.com")), "suggestions");
});

test("row 2: other LinkedIn mail is both", () => {
  assert.equal(sorted(message("messages-noreply@linkedin.com")), "both");
});

test("row 3: alert domains are suggestions", () => {
  assert.equal(sorted(message("a@jobalert.indeed.com")), "suggestions");
  assert.equal(sorted(message("a@match.indeed.com")), "suggestions");
  assert.equal(sorted(message("a@nurture.icims.com")), "suggestions");
});

test("row 3 precedes row 6: nurture.icims.com is suggestions, talent.icims.com is status", () => {
  assert.equal(sorted(message("a@nurture.icims.com")), "suggestions");
  assert.equal(sorted(message("a@talent.icims.com")), "status");
});

test("row 4: job boards are suggestions", () => {
  for (const domain of ["glassdoor.com", "wellfound.com", "builtin.com", "dice.com"]) {
    assert.equal(sorted(message(`a@${domain}`)), "suggestions", domain);
  }
  for (const domain of ["ziprecruiter.com", "jobgether.com", "talenthop.com"]) {
    assert.equal(sorted(message(`a@${domain}`)), "suggestions", domain);
  }
});

test("row 5: mixed senders are both", () => {
  for (const domain of ["indeed.com", "getclera.com", "workable.com", "workablemail.com"]) {
    assert.equal(sorted(message(`a@${domain}`)), "both", domain);
  }
});

test("row 5: a ladders or raydar label makes it both", () => {
  assert.equal(sorted(message("a@unknown.example", "Hi", ["Ladders"])), "both");
  assert.equal(sorted(message("a@unknown.example", "Receipt", ["theladders"])), "both");
  assert.equal(sorted(message("a@unknown.example", "Receipt", ["raydar"])), "both");
});

test("row 6: ATS vendors are status", () => {
  for (const domain of ["ashbyhq.com", "greenhouse.io", "lever.co", "myworkday.com"]) {
    assert.equal(sorted(message(`a@${domain}`)), "status", domain);
  }
  for (const domain of ["rippling.com", "gem.com", "smartrecruiters.com", "jobvite.com"]) {
    assert.equal(sorted(message(`a@${domain}`)), "status", domain);
  }
  for (const domain of ["bamboohr.com", "clinchtalent.com", "icims.com"]) {
    assert.equal(sorted(message(`a@${domain}`)), "status", domain);
  }
});

test("row 6: a subdomain matches, a lookalike does not", () => {
  assert.equal(sorted(message("a@us.greenhouse-mail.io")), "status");
  assert.equal(sorted(message("a@notlever.co")), "both");
});

test("row 7: promotions and forums labels are neither", () => {
  assert.equal(sorted(message("a@shop.example", "Sale", ["CATEGORY_PROMOTIONS"])), "neither");
  assert.equal(sorted(message("a@club.example", "Post", ["CATEGORY_FORUMS"])), "neither");
});

test("row 7: code, receipt, invoice and newsletter subjects are neither", () => {
  for (const subject of [
    "Your verification code",
    "Sign-in code for your account",
    "Your receipt from Shop",
    "Invoice 42",
    "Our Newsletter",
  ]) {
    assert.equal(sorted(message("a@shop.example", subject)), "neither", subject);
  }
});

test("row 7 comes after rows 2 to 6: a LinkedIn alert with a promotions label stays suggestions", () => {
  const alert = message("jobalerts-noreply@linkedin.com", "New roles", ["CATEGORY_PROMOTIONS"]);
  assert.equal(sorted(alert), "suggestions");
  assert.equal(sorted(message("a@greenhouse.io", "Receipt", ["CATEGORY_PROMOTIONS"])), "status");
});

test("row 8: an unknown person with a subject naming no role is both", () => {
  assert.equal(sorted(message("pat.rowan@acme-widgets.example", "Quick question")), "both");
});
