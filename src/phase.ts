// One phase of the daily run, timed: wall clock, and what it spent on HTTP
// and the store as the difference between two snapshots of those modules'
// tallies. Every HTTP request in a phase is that phase's kind of request,
// so the host lines are the per-board-type breakdown.
import { httpStats, type HttpStats, type RequestTally } from "./net/http.ts";
import { storeStats } from "./store/stats.ts";

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

function count(value: number): string {
  return value.toLocaleString("en-US");
}

function tallyLine(tally: RequestTally): string {
  return `${count(tally.requests)} requests ${seconds(tally.ms)}`;
}

function minus(after: RequestTally, before: RequestTally | undefined): RequestTally {
  return {
    requests: after.requests - (before?.requests ?? 0),
    ms: after.ms - (before?.ms ?? 0),
  };
}

function httpDelta(before: HttpStats, after: HttpStats): HttpStats {
  const hosts = new Map<string, RequestTally>();
  for (const [host, tally] of after.hosts) {
    const delta = minus(tally, before.hosts.get(host));
    if (delta.requests > 0) hosts.set(host, delta);
  }
  return { ...minus(after, before), hosts };
}

export async function phase<T>(
  name: string,
  run: () => Promise<T>,
  report: (line: string) => void,
): Promise<T> {
  const started = performance.now();
  const http = httpStats();
  const store = storeStats();
  try {
    return await run();
  } finally {
    const wall = performance.now() - started;
    const spent = httpDelta(http, httpStats());
    report(
      `phase ${name}: ${seconds(wall)} wall; http ${tallyLine(spent)}; store ${tallyLine(minus(storeStats(), store))}`,
    );
    const byCost = [...spent.hosts].sort(([, a], [, b]) => b.ms - a.ms);
    for (const [host, tally] of byCost) report(`  ${host}: ${tallyLine(tally)}`);
  }
}
