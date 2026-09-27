import type { HttpOptions } from "../net/http.ts";
import type { Board } from "../schema.ts";

export interface Source {
  readonly name: string;
  companies(options?: HttpOptions): Promise<string[]>;
}

// A source that names boards rather than companies: it does not know what a
// board's company is called, only that the board exists. `discover` reads a
// board's name itself, with `boardName` (`src/discovery/boards.ts`), once
// per board it has not seen before, rather than having the source guess at
// a name up front. `boards` reports a part it could not reach through `log`
// and returns the rest; it throws only when it has nothing to return.
export interface BoardSource {
  readonly name: string;
  boards(options?: HttpOptions, log?: (line: string) => void): Promise<Board[]>;
}

export type DiscoverySource = Source | BoardSource;
