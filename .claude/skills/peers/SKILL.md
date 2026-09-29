---
name: peers
description: 'Peer expansion: finds companies like the ones James applied to, shows each with its evidence and board URL, and adds the ones he keeps as candidates the daily run resolves. Use for /peers, /peers <count>, /peers <count> <start>, "find peers of the companies I applied to", "expand the watch list from my applications", "do peers 10 starting with the 11th company", or any request to research companies similar to ones already applied to.'
argument-hint: "[count] [start]"
---

# peers

Seeds are the companies James applied to whose peers have not been
searched. For each, the `peer-researcher` agent
(`.claude/agents/peer-researcher.md`) finds peers with evidence;
James chooses which to keep; `npm run peers -- record` adds the kept ones as
candidates with `origin: "peers"` and marks every researched seed as
searched. The daily run resolves the candidates; this skill never writes a
company.

Everything here reads and writes the store through `scripts/peers.ts`, and
through nothing else. Run every command from the repository root.

**Nothing is recorded until James has chosen.** Step 5 is a stop: do not
run `record`, and do not write the record file, before he answers.

Every file this run writes, including any scratch file of your own, goes in
one directory of its own, made before anything else:

```sh
mktemp -d /tmp/peers-$(date +%Y%m%d-%H%M%S)-XXXX
```

It prints the directory; `<run>` below is that path, written out in full in
every command, since the shell keeps no variable between commands. Never
write a fixed `/tmp` name: another session running this skill at the same
time would overwrite it, and `record` would write that session's peers.

## 1. Read the seeds

```sh
npm run --silent peers -- seeds > <run>/seeds.json
```

A nonzero exit stops here: show James its stderr. The file holds:

```json
{
  "seeds": [{ "name": "...", "roles": ["..."] }],
  "known": ["..."]
}
```

`known` holds every company name and every candidate name still pending or
resolved to a company, thousands of them, so do not read the file whole. Print the rest:

```sh
node -e 'const file = require("<run>/seeds.json"); console.log(JSON.stringify(file.seeds, null, 2)); console.log(`known: ${file.known.length} names`)'
```

When `seeds` is empty, say so and stop. When the skill was given a count
(`/peers 2`), keep only the first that many seeds, in the file's order.
When it was also given a start (`/peers 10 11`, the 11th company), skip
the first `start - 1` seeds first, in the file's order, then keep the next
`count` many; `start` defaults to 1. Seeds outside the kept range wait for
another run. Tell James the range this run covers (e.g. "seeds 11-20 of
43") and how many remain before and after it.

## 2. Research, in parallel

Split the seeds into batches of 5, in order. Dispatch one `peer-researcher`
agent per batch, all in one message so they run in parallel. Each
dispatch's prompt is one JSON object:

```json
{
  "seeds": <this batch's seeds, unchanged>,
  "boards_file": "<absolute path to src/discovery/boards.ts in this repository>"
}
```

Give nothing else: not `known`, not other batches, nothing about James.

## 3. Collect

Each agent replies with one JSON object:
`{ "seeds": [{ "name", "peers": [{ "name", "url", "careers", "evidence" }] }], "unresearched": [{ "name", "reason" }] }`.
A peer with no `careers` field has `careers: null`.

- A reply that does not parse, or lacks either array: every seed in that
  batch is unresearched, reason "agent reply unreadable". Do not retry.
- A seed the batch was given that appears in neither array is
  unresearched, reason "agent did not report it".
- A seed name that was not in the batch is ignored.
- **Researched** is every seed in some reply's `seeds` array, whether or
  not it has peers, and in no reply's `unresearched` array. A seed listed
  in both is unresearched: it is not marked, and its peers are still shown.

## 4. Filter

Write every peer name, in seed order, to `<run>/found.json` as a JSON
array of strings, then print the ones already known:

```sh
node -e 'const key = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, ""); const known = new Set(require("<run>/seeds.json").known.map(key)); for (const name of require("<run>/found.json")) if (known.has(key(name))) console.log(name)'
```

Drop every peer that command prints. Then drop a peer whose name, compared
the same way (lowercased, everything but letters and digits removed),
matches a peer met earlier in seed order; the first stays. A near-match
this misses is caught by the run as `known` or `alias`.

Prefix each remaining peer's evidence with its seed:
`Peer of <seed name>. <evidence as the agent wrote it>`. The seed name is
the one in the seeds file, exactly.

Then look up the boards the researcher could not find. Write every
remaining peer whose `url` is null and whose `careers` is not, as
`[{ "name", "careers" }]`, to `<run>/lookup.json`, and run:

```sh
npm run --silent peers -- boards <run>/lookup.json
```

It reads each careers page as raw HTML and prints
`[{ "name", "url", "reason" }]`: `url` is a board the page links to that
names the company (or, on Workday and the other platforms that state no
name, the first one it links), and null when there is none. For each
non-null `url`, set that peer's `url` to it and replace `Board: not found`
in its evidence with `Board: linked from its careers page (<careers>)`.
This URL comes from the script, not from you. A `reason` means the page
did not load; the peer keeps its null URL. A nonzero exit: show James its
stderr and go on with every URL still null.

## 5. Show James, and stop

One table, numbered from 1:

| #   | Name | Peer of | Evidence | Board URL |
| --- | ---- | ------- | -------- | --------- |

Board URL is the URL, or `none (the run looks the name up)` when null.

Below it, two lists, each only when it is not empty:

- **Researched, no new peers:** seed names.
- **Not researched (offered again next time):** seed name and reason.

Then ask: **"Which do you keep? Numbers, `all`, `none`, or `stop`."**

Wait for the answer. What each one does:

| Answer                    | Candidates written | Seeds marked searched                     |
| ------------------------- | ------------------ | ----------------------------------------- |
| Numbers, e.g. `1, 3, 7-9` | those rows         | every researched seed                     |
| `all`                     | every row          | every researched seed                     |
| `none`                    | none               | every researched seed                     |
| `stop`                    | none               | none; nothing is written and the run ends |

A seed is marked searched whether or not James keeps any of its peers:
its peers were researched, and a repeat search would find the same ones.
An unresearched seed is never marked.

## 6. Record

Write `<run>/record.json`:

```json
{
  "searched": ["<every researched seed name>"],
  "candidates": [{ "name": "...", "url": "... or null", "evidence": "Peer of ... " }]
}
```

Then:

```sh
npm run --silent peers -- record <run>/record.json
```

Relay its output verbatim. What it can say:

- `peers: added N candidate(s), marked M seed(s)`: done. The candidates
  resolve on the next daily run.
- `peers: <file>: <reason>; nothing written`: the file failed validation.
  Fix the entry the reason names, show James the change, and run `record`
  again. What fixing means for two reasons:
  - `cannot read url`: set that candidate's `url` to null (the run looks
    the name up). Never write a URL yourself.
  - `searched names that are not current seeds`: take each named name out
    of `searched`. A seed already marked by an earlier `record` is one of
    them.
- `peers: url dropped, resolved by name: <line>`: the URL names no board
  the readers can read (a company's own careers site, say), so `record`
  kept the candidate without it; the run looks the name up. Nothing to fix.
- `peers: not marked: <line>`: a seed's company row was deleted after the
  seeds were checked. The candidates were still written. Tell James which
  seed, and do not retry.

Tell James the record file's path; it is the log of what this run added.
