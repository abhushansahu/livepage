import assert from "node:assert/strict";
import test from "node:test";
import { collapseMap, cssEscape, locateQuote } from "../extension/parse/quote.js";
import { nearbyBlocks } from "../extension/agent/packet.js";

test("cssEscape keeps ids safe for attribute selectors", () => {
  const escaped = cssEscape('hl_"x"');
  assert.equal(escaped.includes('"') && !escaped.includes('\\"'), false);
  assert.match(escaped, /hl_/);
});

test("collapseMap folds extra whitespace onto a single space", () => {
  const { text } = collapseMap("the   quick\n\nbrown");
  assert.equal(text, "the quick brown");
});

test("locateQuote keeps the exact span when prefix/suffix disambiguate", () => {
  const hay = "alpha hello world beta hello world gamma";
  const found = locateQuote(hay, {
    exact: "hello world",
    prefix: "beta ",
    suffix: " gamma"
  });
  assert.equal(hay.slice(found.start, found.end), "hello world");
  assert.equal(found.start, hay.lastIndexOf("hello world"));
});

test("locateQuote recovers when a character was added on each end", () => {
  const hay = "alpha hello world omega";
  const found = locateQuote(hay, { exact: "xhello worldy" });
  assert.ok(found);
  assert.equal(hay.slice(found.start, found.end), "hello world");
});

test("nearby blocks stay attached even if the ledger already sent them", () => {
  const page = {
    parsed: {
      blocks: [
        { id: "b_old", tag: "p", text: "already sent decision site here" },
        { id: "b_new", tag: "p", text: "fresh evidence" }
      ]
    }
  };
  const nearby = nearbyBlocks(page, { text: "decision site" });
  assert.equal(nearby[0].id, "b_old");
});
