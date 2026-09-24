/** The one rule the page's text filters behave by. */

/** Blank matches everything. */
export function contains(haystack: string | null, needle: string): boolean {
  if (needle.trim() === "") return true;
  return haystack !== null && haystack.toLowerCase().includes(needle.trim().toLowerCase());
}
