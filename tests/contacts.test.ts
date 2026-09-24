import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import type { Contact } from "../src/schema.ts";
import { readCapture, type Capture } from "../src/contacts/capture.ts";
import { contactsOf } from "../src/contacts/contact.ts";

// The fixture is hand-written, not captured: every name, address and
// sentence in it is invented. Real correspondence never enters this repo.
function sampleCapture(): Capture {
  const parsed = readCapture(
    JSON.parse(readFileSync(new URL("./fixtures/capture-sample.json", import.meta.url), "utf8")),
  );
  assert.ok(!("error" in parsed), `fixture did not parse: ${JSON.stringify(parsed)}`);
  return parsed;
}

// Corwin's last message is 2026-01-01T09:00:00Z, which is 91 days before
// this, so the fixture's other rows sit either side of the boundary.
const NOW = new Date("2026-04-02T09:00:00Z");
const EIGHTY_NINE_DAYS_AFTER_CORWIN = new Date("2026-03-31T09:00:00Z");
const NINETY_ONE_DAYS_AFTER_CORWIN = new Date("2026-04-02T09:00:00Z");

function contactFor(contacts: readonly Contact[], email: string): Contact {
  const found = contacts.find((contact) => contact.email === email);
  assert.ok(found !== undefined, `no contact for ${email}`);
  return found;
}

test("contactsOf: a plain agency recruiter becomes a contact, named and companied from his domain", () => {
  const corwin = contactFor(
    contactsOf(sampleCapture(), NOW),
    "corwin.vantreight@kestrelmoor.partners",
  );
  assert.equal(corwin.name, "Corwin Vantreight");
  assert.equal(corwin.company, "Kestrelmoor");
  assert.equal(corwin.first_contact, "2025-11-18T14:02:00.000Z");
  assert.equal(corwin.last_contact, "2026-01-01T09:00:00.000Z");
  assert.equal(corwin.last_subject, "Another founding engineer brief");
});

test("contactsOf: a contact's threads record, one by one, whether James sent in that thread", () => {
  const corwin = contactFor(
    contactsOf(sampleCapture(), NOW),
    "corwin.vantreight@kestrelmoor.partners",
  );
  assert.equal(corwin.thread_count, 2);
  assert.deepEqual(corwin.threads, [
    {
      id: "t-kestrelmoor-1",
      subject: "Staff role at a payments company",
      date: "2025-11-20T09:30:00.000Z",
      sent: true,
    },
    {
      id: "t-kestrelmoor-2",
      subject: "Another founding engineer brief",
      date: "2026-01-01T09:00:00.000Z",
      sent: false,
    },
  ]);
  assert.deepEqual(corwin.signals, ["replied-in-thread", "repeat-correspondent"]);
});

test("contactsOf: a recruiter who replies into a thread an ATS opened is the contact", () => {
  const hollis = contactFor(contactsOf(sampleCapture(), NOW), "hollis@larkmead.partners");
  assert.equal(hollis.name, "Hollis Marchbank");
  assert.equal(hollis.company, "Larkmead Partners");
  assert.equal(hollis.thread_count, 1);
  assert.equal(hollis.last_subject, "Your application to Pellworth Systems");
  assert.equal(hollis.state, "active");
});

test("contactsOf: an ATS receipt never becomes a contact, even though James replied in the thread", () => {
  const contacts = contactsOf(sampleCapture(), NOW);
  assert.equal(
    contacts.some((contact) => contact.email === "confirmations@greenhouse-mail.io"),
    false,
  );
  // The whole thread yields nothing: reading past the ATS sender finds only
  // James, and James is not a counterpart.
  assert.equal(
    contacts.some((contact) => contact.last_subject === "We received your application"),
    false,
  );
});

test("contactsOf: a job alert never becomes a contact", () => {
  const contacts = contactsOf(sampleCapture(), NOW);
  assert.equal(
    contacts.some((contact) => contact.email === "jobalerts-noreply@linkedin.com"),
    false,
  );
});

test("contactsOf: a thread James never answered never becomes a contact", () => {
  const contacts = contactsOf(sampleCapture(), NOW);
  assert.equal(
    contacts.some((contact) => contact.email === "marcus.delacroix@verityhire.com"),
    false,
  );
});

test("contactsOf: a counterpart on the operator's own domain is employer, whatever the date says", () => {
  const dana = contactFor(
    contactsOf(sampleCapture(), NOW, "adatum.example"),
    "dana.okonkwo@adatum.example",
  );
  assert.equal(dana.state, "employer");
  assert.deepEqual(dana.signals, ["replied-in-thread", "employer-domain"]);
  // No sender_name on her messages: the name comes from the signature.
  assert.equal(dana.name, "Dana Okonkwo");
  // The signature overrides the domain, which would have read "Adatum".
  assert.equal(dana.company, "Adatum");
});

test("contactsOf: a person whose company changes stays one row, the old one kept in company_history", () => {
  const noor = contactFor(contactsOf(sampleCapture(), NOW), "noor.b.haddad@gmail.com");
  assert.equal(noor.thread_count, 2);
  assert.equal(noor.company, "Halverday Talent");
  assert.deepEqual(noor.company_history, [
    {
      company: "Thornquist Search",
      domain: "gmail.com",
      first_seen: "2025-06-10T15:00:00.000Z",
      last_seen: "2025-06-12T09:00:00.000Z",
    },
  ]);
});

test("contactsOf: a free-mail domain is never a company name", () => {
  const tova = contactFor(contactsOf(sampleCapture(), NOW), "tova.brightwell@gmail.com");
  assert.equal(tova.name, "Tova Brightwell");
  assert.equal(tova.company, null);
  assert.deepEqual(tova.company_history, []);
  assert.equal(tova.state, "target");
});

test("contactsOf: a last contact 89 days before now is active", () => {
  const corwin = contactFor(
    contactsOf(sampleCapture(), EIGHTY_NINE_DAYS_AFTER_CORWIN),
    "corwin.vantreight@kestrelmoor.partners",
  );
  assert.equal(corwin.state, "active");
});

test("contactsOf: a last contact 91 days before now is target", () => {
  const corwin = contactFor(
    contactsOf(sampleCapture(), NINETY_ONE_DAYS_AFTER_CORWIN),
    "corwin.vantreight@kestrelmoor.partners",
  );
  assert.equal(corwin.state, "target");
});

test("contactsOf: no row carries dropped_at, reason, note, contacted_at or alias_of", () => {
  const contacts = contactsOf(sampleCapture(), NOW);
  assert.equal(contacts.length, 5);
  for (const contact of contacts) {
    assert.equal(contact.dropped_at, null, `${contact.email} dropped_at`);
    assert.equal(contact.reason, null, `${contact.email} reason`);
    assert.equal(contact.note, null, `${contact.email} note`);
    assert.equal(contact.contacted_at, null, `${contact.email} contacted_at`);
    assert.equal(contact.alias_of, null, `${contact.email} alias_of`);
  }
});

test("contactsOf: a thread whose messages carry no readable date is skipped rather than throwing", () => {
  const capture: Capture = {
    captured_at: "2026-04-02T08:00:00Z",
    account: "operator@example.com",
    query: "one thread, one unreadable date",
    threads: [
      {
        id: "t-undated",
        subject: "Sent from a session that wrote a bad date",
        messages: [
          { id: "m-1", date: "sometime last spring", sender: "hana.lindqvist@verityhire.com" },
          {
            id: "m-2",
            date: "not a date either",
            sender: "operator@example.com",
            labels: ["SENT"],
          },
        ],
      },
    ],
  };
  assert.deepEqual(contactsOf(capture, NOW), []);
});

// The company derivation on its own. These captures are built in the test
// rather than added to the fixture, so each one holds exactly the thread the
// case is about. Every name, agency and address below is invented.
const ACCOUNT = "operator@example.com";

interface Exchange {
  readonly id: string;
  readonly sender: string;
  // Omitted where the case wants the name read off the signature instead.
  readonly name?: string;
  readonly body: string;
  readonly on: string;
  readonly answered: string;
}

// Her mail, then the operator's reply, which is the inclusion bar.
function captureOf(exchanges: readonly Exchange[]): Capture {
  return {
    captured_at: "2026-04-02T08:00:00Z",
    account: ACCOUNT,
    query: "hand-written, invented names and addresses",
    threads: exchanges.map((exchange) => ({
      id: exchange.id,
      subject: `A role, ${exchange.id}`,
      messages: [
        {
          id: `${exchange.id}-them`,
          date: exchange.on,
          sender: exchange.sender,
          ...(exchange.name === undefined ? {} : { sender_name: exchange.name }),
          to: [ACCOUNT],
          labels: ["INBOX"],
          subject: `A role, ${exchange.id}`,
          body: exchange.body,
        },
        {
          id: `${exchange.id}-james`,
          date: exchange.answered,
          sender: ACCOUNT,
          labels: ["SENT"],
          subject: `Re: A role, ${exchange.id}`,
          body: "Tell me more.\n",
        },
      ],
    })),
  };
}

function onlyContact(exchanges: readonly Exchange[]): Contact {
  const contacts = contactsOf(captureOf(exchanges), NOW);
  assert.equal(contacts.length, 1, `expected one contact, got ${contacts.length}`);
  return contacts[0];
}

// A one-thread contact who signed nothing, so the company can only come from
// the address she wrote from.
function unsignedFrom(sender: string): Contact {
  return onlyContact([
    {
      id: "t-unsigned",
      sender,
      name: "Delphine Crowther",
      body: "Hi there,\n\nAre you open to a conversation this week?\n",
      on: "2026-03-12T10:00:00Z",
      answered: "2026-03-13T08:00:00Z",
    },
  ]);
}

const SALTGROVE = "hendrick.mallory@saltgrove.partners";

test("contactsOf: an unsigned follow-up is missing information, not a move to a shorter name", () => {
  const ingrid = onlyContact([
    {
      id: "t-fennimore-1",
      sender: "ingrid.saltmarsh@fennimore.partners",
      name: "Ingrid Saltmarsh",
      body: "Hi there,\n\nA founding engineer brief for you.\n\nBest,\nIngrid Saltmarsh\nFennimore Partners\n",
      on: "2026-02-10T09:00:00Z",
      answered: "2026-02-11T09:00:00Z",
    },
    {
      id: "t-fennimore-2",
      sender: "ingrid.saltmarsh@fennimore.partners",
      name: "Ingrid Saltmarsh",
      body: "Any update?\n",
      on: "2026-03-10T09:00:00Z",
      answered: "2026-03-11T09:00:00Z",
    },
  ]);
  assert.equal(ingrid.company, "Fennimore Partners");
  assert.deepEqual(ingrid.company_history, []);
});

test("contactsOf: a free-mail contact keeps the company her signature gave when a later thread signs nothing", () => {
  const ottilie = onlyContact([
    {
      id: "t-cranmere-1",
      sender: "ottilie.verhoeven@gmail.com",
      name: "Ottilie Verhoeven",
      body: "Hi there,\n\nA client of mine needs a platform lead.\n\nBest,\nOttilie Verhoeven\nCranmere Talent\n",
      on: "2026-01-20T11:00:00Z",
      answered: "2026-01-21T11:00:00Z",
    },
    {
      id: "t-cranmere-2",
      sender: "ottilie.verhoeven@gmail.com",
      name: "Ottilie Verhoeven",
      body: "Still thinking about it?\n",
      on: "2026-02-25T11:00:00Z",
      answered: "2026-02-26T11:00:00Z",
    },
  ]);
  assert.equal(ottilie.company, "Cranmere Talent");
  assert.deepEqual(ottilie.company_history, []);
});

test("contactsOf: a signature naming a firm the address does not becomes history when a later thread signs nothing", () => {
  const hendrick = onlyContact([
    {
      id: "t-saltgrove-1",
      sender: SALTGROVE,
      name: "Hendrick Mallory",
      body: "Hi there,\n\nA staff role with a client of ours.\n\nBest,\nHendrick Mallory\nRavensgate Search\n",
      on: "2025-09-08T10:00:00Z",
      answered: "2025-09-09T11:30:00Z",
    },
    {
      id: "t-saltgrove-2",
      sender: SALTGROVE,
      name: "Hendrick Mallory",
      body: "Two more roles on now.\n",
      on: "2026-03-14T08:00:00Z",
      answered: "2026-03-15T09:00:00Z",
    },
  ]);
  assert.equal(hendrick.company, "Saltgrove");
  assert.deepEqual(hendrick.company_history, [
    {
      company: "Ravensgate Search",
      domain: "saltgrove.partners",
      first_seen: "2025-09-08T10:00:00.000Z",
      last_seen: "2025-09-09T11:30:00.000Z",
    },
  ]);
});

test("contactsOf: a .co.uk address gives the label before the suffix, not the suffix's own half", () => {
  assert.equal(unsignedFrom("delphine.crowther@brackenhall.co.uk").company, "Brackenhall");
});

test("contactsOf: a .com.au address gives the label before the suffix", () => {
  assert.equal(unsignedFrom("delphine.crowther@penhaligon.com.au").company, "Penhaligon");
});

test("contactsOf: a .org.uk address gives the label before the suffix", () => {
  assert.equal(unsignedFrom("delphine.crowther@thistledown.org.uk").company, "Thistledown");
});

test("contactsOf: a .co.nz address gives the label before the suffix", () => {
  assert.equal(unsignedFrom("delphine.crowther@harrowgate.co.nz").company, "Harrowgate");
});

test("contactsOf: a job title under the name is skipped and the agency below it is the company", () => {
  const jonquil = onlyContact([
    {
      id: "t-ashcombe-1",
      sender: "jonquil.trethewey@ashcombe.partners",
      body: "Hi there,\n\nI have a founding engineer search on.\n\nBest,\nJonquil Trethewey\nSenior Technical Recruiter\nAshcombe Partners\n",
      on: "2026-03-02T09:00:00Z",
      answered: "2026-03-03T09:00:00Z",
    },
  ]);
  assert.equal(jonquil.name, "Jonquil Trethewey");
  assert.equal(jonquil.company, "Ashcombe Partners");
});

test("contactsOf: a free-mail recruiter who signs off only later has no former employer", () => {
  const wilhelmina = onlyContact([
    {
      id: "t-unsigned-then-signed-1",
      sender: "wilhelmina.fosbery@gmail.com",
      name: "Wilhelmina Fosbery",
      body: "Hi there,\n\nAre you open to hearing about a platform role?\n",
      on: "2026-03-08T09:00:00Z",
      answered: "2026-03-09T09:00:00Z",
    },
    {
      id: "t-unsigned-then-signed-2",
      sender: "wilhelmina.fosbery@gmail.com",
      name: "Wilhelmina Fosbery",
      body: "Hi there,\n\nThe brief is attached.\n\nBest,\nWilhelmina Fosbery\nCorveth Search\n",
      on: "2026-03-20T09:00:00Z",
      answered: "2026-03-21T09:00:00Z",
    },
  ]);
  assert.equal(wilhelmina.company, "Corveth Search");
  assert.deepEqual(wilhelmina.company_history, []);
});

// Each shape below produced a wrong `company` on a real row in the live
// table before `namesNoCompany` rejected it. Every name and address here is
// invented; only the signature shapes are drawn from what real recruiters
// send.
function signedCapture(body: string): Capture {
  const parsed = readCapture({
    captured_at: "2026-04-02T09:00:00Z",
    account: "operator@example.com",
    query: "test",
    threads: [
      {
        id: "t1",
        subject: "A role",
        messages: [
          {
            id: "m1",
            date: "2026-03-30T09:00:00Z",
            sender: "wren.hollowby@brackenhall.partners",
            to: ["operator@example.com"],
            labels: ["INBOX"],
            subject: "A role",
            body,
          },
          {
            id: "m2",
            date: "2026-03-30T10:00:00Z",
            sender: "operator@example.com",
            to: ["wren.hollowby@brackenhall.partners"],
            labels: ["SENT"],
            subject: "Re: A role",
            body: "Thanks, will read.",
          },
        ],
      },
    ],
  });
  assert.ok(!("error" in parsed), `capture did not parse: ${JSON.stringify(parsed)}`);
  return parsed;
}

function companyFromSignature(body: string): string | null {
  const contacts = contactsOf(signedCapture(body), NOW);
  return contactFor(contacts, "wren.hollowby@brackenhall.partners").company;
}

test("signature: a pronoun declaration under the name is not the company", () => {
  assert.equal(
    companyFromSignature("Hi there,\n\nA role.\n\nBest,\nWren Hollowby\nshe/her\n"),
    "Brackenhall",
  );
  assert.equal(
    companyFromSignature("Hi there,\n\nA role.\n\nBest,\nWren Hollowby\n(they/them)\n"),
    "Brackenhall",
  );
});

test("signature: a link bar under the name is not the company", () => {
  assert.equal(
    companyFromSignature(
      "Hi there,\n\nA role.\n\nBest,\nWren Hollowby\nWebsite | Blog | 212.555.0147\n",
    ),
    "Brackenhall",
  );
});

test("signature: a horizontal rule is not the company", () => {
  assert.equal(
    companyFromSignature("Hi there,\n\nA role.\n\nBest,\nWren Hollowby\n____________________\n"),
    "Brackenhall",
  );
  assert.equal(
    companyFromSignature("Hi there,\n\nA role.\n\nBest,\nWren Hollowby\n--\n"),
    "Brackenhall",
  );
});

test("signature: the writer's own name repeated under itself is not the company", () => {
  assert.equal(
    companyFromSignature("Hi there,\n\nA role.\n\nBest,\nWren Hollowby\nWren Hollowby\n"),
    "Brackenhall",
  );
});

test("signature: one part of the writer's name alone is not the company", () => {
  assert.equal(
    companyFromSignature("Hi there,\n\nA role.\n\nBest,\nWren Hollowby\nWren\n"),
    "Brackenhall",
  );
});

test("signature: a real agency line under a rejected line is still found", () => {
  assert.equal(
    companyFromSignature(
      "Hi there,\n\nA role.\n\nBest,\nWren Hollowby\nshe/her\nThornquist Search\n",
    ),
    "Thornquist Search",
  );
});

test("signature: an agency whose name contains the writer's surname still stands", () => {
  assert.equal(
    companyFromSignature("Hi there,\n\nA role.\n\nBest,\nWren Hollowby\nHollowby Talent Group\n"),
    "Hollowby Talent Group",
  );
});

test("signature: the last sign-off wins, so a mid-message 'Thank you!' does not shift the block", () => {
  // The shape that made a real row's company read as the writer's own first
  // name: a valediction written before the real sign-off.
  assert.equal(
    companyFromSignature(
      "Hi there,\n\nPlease send some times.\n\nThank you!\n\nBest,\nWren\nRecruiting Operations Specialist\n",
    ),
    "Brackenhall",
  );
});

test("signature: the full name under a first-name sign-off is still the writer", () => {
  // "Best, / Brittan / -- / Brittan Locke / Director of People" read as a
  // company of "Brittan Locke" until the comparison used every word.
  assert.equal(
    companyFromSignature(
      "Hi there,\n\nA role.\n\nBest,\nWren\n--\nWren Hollowby\nDirector of People\n",
    ),
    "Brackenhall",
  );
});

test("signature: the display name is what a candidate is compared against", () => {
  // The capture carries no sender_name here, so the comparison falls back to
  // the signature's own name line and must still reject the repeat.
  assert.equal(
    companyFromSignature("Hi there,\n\nA role.\n\nRegards,\nWren Hollowby\nWren\n"),
    "Brackenhall",
  );
});

const TEST_ALIASES = {
  northgate: "Northgate Markets",
  findfourthcoffee: "Fourth Coffee",
  lamnapartners: "Lamna Partners",
  wingtiptoyz: "WingtipToyZ",
} as const;

function companyForDomain(domain: string): string | null {
  const parsed = readCapture({
    captured_at: "2026-04-02T09:00:00Z",
    account: "operator@example.com",
    query: "test",
    threads: [
      {
        id: "d1",
        subject: "A role",
        messages: [
          {
            id: "d1m1",
            date: "2026-03-30T09:00:00Z",
            sender: `wren.hollowby@${domain}`,
            to: ["operator@example.com"],
            labels: ["INBOX"],
            subject: "A role",
            body: "Hi there,\n\nA role.\n",
          },
          {
            id: "d1m2",
            date: "2026-03-30T10:00:00Z",
            sender: "operator@example.com",
            to: [`wren.hollowby@${domain}`],
            labels: ["SENT"],
            subject: "Re: A role",
            body: "Thanks.",
          },
        ],
      },
    ],
  });
  assert.ok(!("error" in parsed), `capture did not parse: ${JSON.stringify(parsed)}`);
  return contactFor(contactsOf(parsed, NOW, undefined, TEST_ALIASES), `wren.hollowby@${domain}`)
    .company;
}

test("company: a domain whose label is not the firm's name reads through the alias map", () => {
  // The label is a spelling, not a name: a hyphenated name, a label carrying
  // a verb the name drops, two words run together, and internal capitals the
  // capitalisation rule cannot guess.
  assert.equal(companyForDomain("northgate.com"), "Northgate Markets");
  assert.equal(companyForDomain("findfourthcoffee.com"), "Fourth Coffee");
  assert.equal(companyForDomain("lamnapartners.com"), "Lamna Partners");
  assert.equal(companyForDomain("wingtiptoyz.com"), "WingtipToyZ");
});

test("company: a domain not in the alias map still reads as its capitalised label", () => {
  assert.equal(companyForDomain("adatum.com"), "Adatum");
  assert.equal(companyForDomain("brackenhall.co.uk"), "Brackenhall");
});

test("company: a signature naming the firm still beats the alias map", () => {
  assert.equal(
    companyFromSignature("Hi there,\n\nA role.\n\nBest,\nWren Hollowby\nThornquist Search\n"),
    "Thornquist Search",
  );
});
