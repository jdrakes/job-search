import assert from "node:assert/strict";
import { test } from "node:test";

import type { CaptureThread } from "../src/contacts/capture.ts";
import { hasReplyFromJames, isExcludedSender } from "../src/contacts/exclude.ts";

const ACCOUNT = "operator@example.com";

test("isExcludedSender: drops a no-reply local part", () => {
  assert.equal(isExcludedSender("no-reply@somecompany.com"), true);
});

test("isExcludedSender: drops a noreply local part", () => {
  assert.equal(isExcludedSender("noreply@somecompany.com"), true);
});

test("isExcludedSender: drops a donotreply local part", () => {
  assert.equal(isExcludedSender("donotreply@somecompany.com"), true);
});

test("isExcludedSender: drops a do-not-reply local part", () => {
  assert.equal(isExcludedSender("do-not-reply@somecompany.com"), true);
});

test("isExcludedSender: drops a jobalerts-noreply local part", () => {
  assert.equal(isExcludedSender("jobalerts-noreply@somecompany.com"), true);
});

test("isExcludedSender: drops a notifications local part", () => {
  assert.equal(isExcludedSender("notifications@somecompany.com"), true);
});

test("isExcludedSender: drops a careers local part", () => {
  assert.equal(isExcludedSender("careers@somecompany.com"), true);
});

test("isExcludedSender: drops a support local part", () => {
  assert.equal(isExcludedSender("support@somecompany.com"), true);
});

test("isExcludedSender: a plain agency recruiter survives", () => {
  assert.equal(isExcludedSender("juno@arvelo.partners"), false);
});

test("isExcludedSender: drops greenhouse-mail.io", () => {
  assert.equal(isExcludedSender("someone@greenhouse-mail.io"), true);
});

test("isExcludedSender: drops the us.greenhouse-mail.io subdomain", () => {
  assert.equal(isExcludedSender("someone@us.greenhouse-mail.io"), true);
});

test("isExcludedSender: drops gem.com", () => {
  assert.equal(isExcludedSender("someone@gem.com"), true);
});

test("isExcludedSender: drops the appreview.gem.com subdomain", () => {
  assert.equal(isExcludedSender("someone@appreview.gem.com"), true);
});

test("isExcludedSender: drops ashbyhq.com", () => {
  assert.equal(isExcludedSender("someone@ashbyhq.com"), true);
});

test("isExcludedSender: drops lever.co", () => {
  assert.equal(isExcludedSender("someone@lever.co"), true);
});

test("isExcludedSender: drops myworkday.com", () => {
  assert.equal(isExcludedSender("someone@myworkday.com"), true);
});

test("isExcludedSender: drops icims.com", () => {
  assert.equal(isExcludedSender("someone@icims.com"), true);
});

test("isExcludedSender: drops smartrecruiters.com", () => {
  assert.equal(isExcludedSender("someone@smartrecruiters.com"), true);
});

test("isExcludedSender: drops ziprecruiter.com", () => {
  assert.equal(isExcludedSender("someone@ziprecruiter.com"), true);
});

test("isExcludedSender: drops a linkedin.com job alert", () => {
  assert.equal(isExcludedSender("jobalerts-noreply@linkedin.com"), true);
});

test("isExcludedSender: drops an unrelated linkedin.com sender too", () => {
  assert.equal(isExcludedSender("messages-noreply@linkedin.com"), true);
});

test("isExcludedSender: a subdomain of an excluded ATS domain is still excluded", () => {
  assert.equal(isExcludedSender("someone@boards.greenhouse-mail.io"), true);
});

test("isExcludedSender: keeps inmail-hit-reply@linkedin.com, a real recruiter writing through InMail", () => {
  assert.equal(isExcludedSender("inmail-hit-reply@linkedin.com"), false);
});

test("isExcludedSender: keeps hit-reply@linkedin.com, a real recruiter writing through InMail", () => {
  assert.equal(isExcludedSender("hit-reply@linkedin.com"), false);
});

test("isExcludedSender: the InMail carve-out survives mixed case and surrounding space", () => {
  assert.equal(isExcludedSender(" Inmail-Hit-Reply@LinkedIn.com "), false);
});

function thread(messages: CaptureThread["messages"]): CaptureThread {
  return { id: "thread-1", messages };
}

test("hasReplyFromJames: a thread with no sent message is rejected", () => {
  const oneWay = thread([
    { id: "m1", date: "2026-01-01", sender: "juno@arvelo.partners", labels: ["INBOX"] },
  ]);
  assert.equal(hasReplyFromJames(oneWay, ACCOUNT), false);
});

test("hasReplyFromJames: a thread where James replied by SENT label is kept", () => {
  const replied = thread([
    { id: "m1", date: "2026-01-01", sender: "juno@arvelo.partners", labels: ["INBOX"] },
    { id: "m2", date: "2026-01-02", sender: ACCOUNT, labels: ["SENT"] },
  ]);
  assert.equal(hasReplyFromJames(replied, ACCOUNT), true);
});

test("hasReplyFromJames: a thread where a message's sender is the account address is kept even without a SENT label", () => {
  const replied = thread([
    { id: "m1", date: "2026-01-01", sender: "juno@arvelo.partners", labels: ["INBOX"] },
    { id: "m2", date: "2026-01-02", sender: ACCOUNT },
  ]);
  assert.equal(hasReplyFromJames(replied, ACCOUNT), true);
});

test("hasReplyFromJames: matching the account address ignores case", () => {
  const replied = thread([
    { id: "m1", date: "2026-01-01", sender: "juno@arvelo.partners", labels: ["INBOX"] },
    { id: "m2", date: "2026-01-02", sender: "Operator@Example.com" },
  ]);
  assert.equal(hasReplyFromJames(replied, ACCOUNT), true);
});
