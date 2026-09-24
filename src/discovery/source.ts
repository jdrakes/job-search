import type { HttpOptions } from "../net/http.ts";

export interface Source {
  readonly name: string;
  companies(options?: HttpOptions): Promise<string[]>;
}
