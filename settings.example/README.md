# settings

The shape of the gitignored `settings/` directory. Copy it and edit the copy.

```
cp -R settings.example settings
```

`settings/` is ignored by git, and that is the point of it. What goes in here
is yours, it says something about your own job search, and it does not belong
in a repository anyone else can read.

## config.json

Read by `src/settings.ts`, which is the only place in the tree that opens it.
It is read on demand rather than once at startup. The daily run reads it once
for the source list, and `src/net/http.ts` reads it again for every request it
makes, so a run makes one read per HTTP request and an edit part way through a
run takes effect part way through that run.

| Field              | Absent means          | Type             |
| ------------------ | --------------------- | ---------------- |
| `userAgent`        | every request refuses | string           |
| `discoverySources` | every source runs     | array of strings |
| `extraSourcePath`  | no extra source       | string           |

A missing `config.json` is not an error. It is an operator who has configured
nothing yet, so every field is absent and the built-in behaviour applies. A
`config.json` that exists and is malformed throws and names the path, because
a typo that silently runs defaults is worse than a refusal. An unknown key is
ignored, so an older checkout still reads a file written for a newer one.

### userAgent

Required in practice. `src/net/http.ts` has no built-in default and throws on
the first request without this, because every request identifies you to a
third-party job board. Give a contact point a person can use.

It ships empty in the `config.json` beside this file, rather than as a
plausible-looking placeholder. An empty string refuses exactly as an absent
field does, so a directory copied and not yet edited stops at the first
request instead of announcing somebody else's address to nine job boards.

### discoverySources

Names of the discovery sources to run, in the order given. Absent runs all of
them. A name no source carries throws and lists the valid ones rather than
quietly running a shorter list than you asked for. Today they are `hn`,
`remoteok` and `weworkremotely`.

### extraSourcePath

A path, relative to the repository root, naming a module whose default export
is a factory. The factory takes the level words from your criteria and returns
a discovery source. That is how a source you would rather not publish runs
without living in the tree.

It is not in the `config.json` beside this file on purpose. A path that does
not resolve stops the run, so a placeholder here would break the config of
anyone who copied the directory and only edited `userAgent`. Add it when you
have a module for it to point at.

```json
{
  "userAgent": "job-search (+https://example.com/you)",
  "discoverySources": ["hn", "remoteok"],
  "extraSourcePath": "settings/sources/your-source.ts"
}
```

## What else belongs here

Anything about your own search that the repository must not carry. The
criteria file you pass to `npm run criteria:load`. A discovery source you keep
private. A wrapper script your scheduler calls, with your paths in it.

## Nothing backs this up

Being gitignored is the whole of this directory's protection, and it is also
the whole of its risk. Nothing versions it, nothing copies it off the machine,
and a fresh clone does not have it. If losing it would cost you anything, keep
it in a private repository of its own.

## employerDomain

The domain of your own employer, if you have one. Contacts uses it to tell a
colleague from a recruiter, by the counterpart's domain rather than by a
company name, because a name match needs a company list and still misses a
colleague writing from an address with no signature.

Left out, no contact is ever classified as an employer, which is the right
answer for anyone who has not said where they work.

```
"employerDomain": "example.com"
```

## domainAliases

Maps a domain label to the firm's real name, for the cases where the two
differ. Contacts reads a firm's name off its domain when no signature names
it, and a label is a spelling rather than a name: a hyphenated name loses its
hyphen, a label can carry a verb the name drops, and internal capitals cannot
be guessed from lowercase.

It is left out of the example on purpose. Which firms appear here is a fact
about who you have corresponded with, so it is yours to write and it belongs
in `settings/`, which is gitignored, rather than in the source.

```
"domainAliases": { "findfourthcoffee": "Fourth Coffee" }
```
