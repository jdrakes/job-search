// Node's fetch raises `TypeError: fetch failed` and puts the reason
// (ECONNRESET, a DNS failure) in `cause`, so `message` alone says only
// that something went wrong.
export function describeError(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    const code = (current as { code?: unknown }).code;
    parts.push(typeof code === "string" ? `${current.message} (${code})` : current.message);
    current = current.cause;
  }
  if (parts.length === 0) return String(error);
  return parts.join(" <- ");
}
