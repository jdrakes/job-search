// Whole-word term matching for the criteria lists ("go" must not fire on
// "going", "ml" not on "html").
//
// `\b` is only meaningful beside a word character, so `\b\.net\b` demands
// a word character before the dot (matches "ASP.NET Core", not "experience
// with .NET") and `\bc#\b` matches nothing. The boundary is read off the
// term's own first and last character instead: where the edge is
// punctuation, the punctuation is itself the boundary, and nothing is
// asserted about the neighbouring character, which would drop "C++14/17".

function escapeRegExp(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const WORD_CHARACTER = /[A-Za-z0-9_]/;

// Exported for the one caller that adds its own suffix guard to the pattern.
export function wholeWordPattern(term: string): string {
  const leading = WORD_CHARACTER.test(term.charAt(0)) ? "\\b" : "";
  const trailing = WORD_CHARACTER.test(term.charAt(term.length - 1)) ? "\\b" : "";
  return `${leading}${escapeRegExp(term)}${trailing}`;
}

// A multi-word term like "back end" is bounded at its edges. The escape
// keeps "c++" read as literal text.
export function findWholeWord(text: string, term: string, caseSensitive = false): number | null {
  if (term === "") return null;
  const match = new RegExp(wholeWordPattern(term), caseSensitive ? "" : "i").exec(text);
  return match ? match.index : null;
}
