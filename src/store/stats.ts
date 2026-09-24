// What every store adapter has spent: statements sent and the time callers
// waited. Apart from any adapter because `src/phase.ts` reads one tally for
// the run. The type is `http.ts`'s so the run's two tallies read alike.
import type { RequestTally } from "../net/http.ts";

const tally = { requests: 0, ms: 0 };

export function storeStats(): RequestTally {
  return { ...tally };
}

// One call per statement that reached the wire, success or failure.
export function recordStoreRequests(requests: number, ms: number): void {
  tally.requests += requests;
  tally.ms += ms;
}
