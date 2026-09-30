**Integration default:** push, PR, verify, merge

**Verify:** a change to a phase of the daily (`src/daily.ts` and what it
calls) is run once by hand against a real deployment, on the branch rebased
on current main, and its log read before the PR merges. The run writes to
the live store, so a branch behind main undoes what main has fixed. Tests
do not reach the live ATSs or the two stores; the run does.
