import type { HttpOptions } from "../net/http.ts";
import type { Board } from "../schema.ts";

export interface Source {
  readonly name: string;
  companies(options?: HttpOptions): Promise<string[]>;
}

// A source that names boards rather than companies: it does not know what a
// board's company is called, only that the board exists. `discover` asks
// `companyName` itself, once per board it has not seen before, rather than
// having the source guess at a name up front.
export interface BoardSource {
  readonly name: string;
  boards(options?: HttpOptions): Promise<Board[]>;
  companyName(board: Board, options?: HttpOptions): Promise<string | null>;
}

export type DiscoverySource = Source | BoardSource;
