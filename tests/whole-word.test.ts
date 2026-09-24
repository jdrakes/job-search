import assert from "node:assert/strict";
import { test } from "node:test";

import { findWholeWord } from "../src/judge/whole-word.ts";

// The three terms below are language names whose edges are punctuation,
// which is the case `\b…\b` gets wrong. Every other term has word characters
// at both ends and is covered by the "go"/"ml" cases at the bottom.

function matches(text: string, term: string): boolean {
  return findWholeWord(text, term) !== null;
}

test("findWholeWord: '.net' matches a mention after a space, which \\b.net\\b could not", () => {
  assert.equal(matches("Five years of experience with .NET.", ".net"), true);
});

// A role asking for ASP.NET is asking for .NET.
test("findWholeWord: '.net' matches the tail of 'ASP.NET Core'", () => {
  assert.equal(matches("Strong ASP.NET Core background.", ".net"), true);
});

test("findWholeWord: '.net' does not match '.networking', which continues the word", () => {
  assert.equal(matches("You will own the .networking layer.", ".net"), false);
});

test("findWholeWord: '.net' does not match 'NetSuite', which carries no dot", () => {
  assert.equal(matches("Experience administering NetSuite.", ".net"), false);
});

test("findWholeWord: 'c#' matches a mention before a space, which \\bc#\\b could not", () => {
  assert.equal(matches("5+ years of C# in production.", "c#"), true);
});

test("findWholeWord: 'c#' matches in 'C#/.NET shop'", () => {
  assert.equal(matches("We are a C#/.NET shop.", "c#"), true);
});

test("findWholeWord: 'c#' does not match the anchor in 'docs/abc#overview'", () => {
  assert.equal(matches("Our style guide is at docs/abc#overview.", "c#"), false);
});

test("findWholeWord: 'c++' matches at the end of a clause, which \\bc\\+\\+\\b could not", () => {
  assert.equal(matches("Five years of production C++.", "c++"), true);
});

test("findWholeWord: 'c++' matches inside an alternatives list written with slashes", () => {
  assert.equal(matches("Python/C/C++/Rust all translate well.", "c++"), true);
});

// The version standard follows the "++" with a digit.
test("findWholeWord: 'c++' matches 'C++14/17 or later'", () => {
  assert.equal(matches("Deep experience with C++14/17 or later.", "c++"), true);
});

test("findWholeWord: 'go' still does not match inside 'going'", () => {
  assert.equal(matches("Things are going well here.", "go"), false);
});

test("findWholeWord: 'ml' still does not match inside 'html'", () => {
  assert.equal(matches("You will write html templates.", "ml"), false);
});

test("findWholeWord: 'r' matches the standalone letter and not every word carrying one", () => {
  assert.equal(matches("We model in R and Python.", "r"), true);
  assert.equal(matches("We prefer Python for modelling.", "r"), false);
});

test("findWholeWord: a multi-word term is bounded at its edges, not inside", () => {
  assert.equal(matches("You will own the back end services.", "back end"), true);
  assert.equal(matches("You will own the back ending services.", "back end"), false);
});

test("findWholeWord: an empty term matches nothing", () => {
  assert.equal(findWholeWord("anything at all", ""), null);
});

test("findWholeWord: the returned index is where the term starts", () => {
  assert.equal(findWholeWord("we use .NET here", ".net"), 7);
});

test("findWholeWord: matching is case-insensitive unless the caller asks otherwise", () => {
  assert.equal(findWholeWord("we ship go code", "Go", true), null);
  assert.equal(findWholeWord("we ship Go code", "Go", true), 8);
  assert.equal(findWholeWord("we ship go code", "Go"), 8);
});
