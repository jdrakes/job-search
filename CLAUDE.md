**Integration default:** push, PR, verify, merge

**Verify:** a change to a phase of the daily (`src/daily.ts` and what it
calls) is run once by hand against a real deployment, on the branch, and
its log read before the PR merges. Tests do not reach the live ATSs or the
two stores; the run does.
