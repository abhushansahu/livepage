import assert from "node:assert/strict";
import test from "node:test";
import { anchorConfidence, locateQuote, spanLooksRight } from "../extension/parse/quote.js";
import {
  MAX_ATTEMPTS,
  RETRY_SCHEDULE,
  nextAttempt
} from "../extension/content/anchor-plan.js";
import {
  anchorItems,
  blocksAround,
  mergeAnchorVerdict,
  seenInParse,
  stateForConfidence
} from "../extension/shared/anchors.js";
import { selectionIsSafe } from "../extension/content/highlights.js";
import { stackCards } from "../extension/content/overlay.js";

test("a clean hit reports the exact rung", () => {
  const found = locateQuote("alpha hello world omega", { exact: "hello world" });
  assert.equal(found.rung, 1);
  assert.equal(found.hits, 1);
  assert.equal(found.ambiguous, false);
  assert.equal(anchorConfidence(found, { exact: "hello world" }), "exact");
});

test("repeated boilerplate is reported as a coin toss, not a confident match", () => {
  const hay = "alpha hello world beta hello world gamma";
  const blind = locateQuote(hay, { exact: "hello world" });
  assert.equal(blind.hits, 2);
  assert.equal(blind.ambiguous, true);
  assert.equal(anchorConfidence(blind, { exact: "hello world" }), "loose");

  const guided = locateQuote(hay, { exact: "hello world", prefix: "beta ", suffix: " gamma" });
  assert.equal(guided.ambiguous, false);
  assert.equal(anchorConfidence(guided, { exact: "hello world" }), "exact");
});

test("trimming the ends still counts as a second-rung recovery", () => {
  const found = locateQuote("alpha hello world omega", { exact: "xhello worldy" });
  assert.equal(found.rung, 2);
});

test("a deleted paragraph does not swallow everything between its neighbours", () => {
  const prefix = "the paragraph before it";
  const suffix = "the paragraph after it";
  const filler = "unrelated words that arrived later ".repeat(150);
  const hay = `${prefix} ${filler} ${suffix}`;
  const found = locateQuote(hay, {
    exact: "a short sentence that has since been deleted",
    prefix,
    suffix
  });
  if (found) {
    assert.notEqual(found.rung, 3, "the bracket rung must not report a wildly oversized span");
    assert.ok(found.end - found.start < 400);
  }
});

test("the bracket rung still works when what is left is the right size", () => {
  const prefix = "the paragraph before";
  const suffix = "the paragraph after";
  const hay = `${prefix} a slightly reworded sentence here ${suffix}`;
  const found = locateQuote(hay, {
    exact: "a slightly different sentence here",
    prefix,
    suffix
  });
  assert.ok(found);
  assert.ok(found.end - found.start < 60);
});

test("span length guard accepts near misses and rejects runaways", () => {
  assert.equal(spanLooksRight(100, 100), true);
  assert.equal(spanLooksRight(60, 100), true);
  assert.equal(spanLooksRight(5000, 100), false);
  assert.equal(spanLooksRight(0, 100), false);
});

test("a fuzzy match carries its edit distance", () => {
  const exact = "the quick brown fox jumps over the lazy dog";
  const hay = `padding ${exact.replace("quick", "quicb")} padding`;
  const found = locateQuote(hay, { exact });
  assert.equal(found.rung, 4);
  assert.equal(typeof found.distance, "number");
  assert.equal(anchorConfidence(found, { exact }), "close");
});

test("confidence separates a near miss from a guess", () => {
  const exact = "x".repeat(100);
  assert.equal(anchorConfidence({ rung: 1, ambiguous: false }, { exact }), "exact");
  assert.equal(anchorConfidence({ rung: 1, ambiguous: true, score: 0 }, { exact }), "loose");
  assert.equal(anchorConfidence({ rung: 1, ambiguous: true, score: 3 }, { exact }), "exact");
  assert.equal(anchorConfidence({ rung: 3 }, { exact }), "loose");
  assert.equal(anchorConfidence({ rung: 4, distance: 1 }, { exact }), "close");
  assert.equal(anchorConfidence({ rung: 4, distance: 9 }, { exact }), "loose");
  assert.equal(anchorConfidence(null, { exact }), null);
});

test("confidence maps onto the state the record keeps", () => {
  assert.equal(stateForConfidence("exact"), "found");
  assert.equal(stateForConfidence("close"), "found");
  assert.equal(stateForConfidence("loose"), "moved");
  assert.equal(stateForConfidence(null), "missing");
});

test("an unchanged verdict asks for no write at all", () => {
  const previous = { state: "found", rung: 1, at: 100, missStreak: 0, url: "u" };
  const same = mergeAnchorVerdict(previous, { state: "found", rung: 1, url: "u" }, 500);
  assert.equal(same.changed, false);
  assert.equal(same.anchor.at, 100, "an unchanged verdict must not restamp the record");

  const moved = mergeAnchorVerdict(previous, { state: "moved", rung: 4, url: "u" }, 500);
  assert.equal(moved.changed, true);
  assert.equal(moved.anchor.state, "moved");
});

test("misses accumulate a streak and a single success clears it", () => {
  const first = mergeAnchorVerdict(null, { state: "missing", url: "u" }, 1);
  assert.equal(first.anchor.missStreak, 1);
  assert.equal(first.changed, true);

  const second = mergeAnchorVerdict(first.anchor, { state: "missing", url: "u" }, 2);
  assert.equal(second.anchor.missStreak, 2);

  const recovered = mergeAnchorVerdict(second.anchor, { state: "found", rung: 1, url: "u" }, 3);
  assert.equal(recovered.anchor.missStreak, 0);
  assert.equal(recovered.anchor.state, "found");
  assert.equal(recovered.changed, true);
});

test("retries follow the schedule, skip quiet rounds, and stop", () => {
  assert.deepEqual(nextAttempt({ attempt: 0, dirty: false }), {
    done: false,
    skip: false,
    delay: RETRY_SCHEDULE[0]
  });
  assert.equal(nextAttempt({ attempt: 1, dirty: false }).skip, true);
  assert.equal(nextAttempt({ attempt: 1, dirty: true }).skip, false);
  assert.equal(nextAttempt({ attempt: MAX_ATTEMPTS, dirty: true }).done, true);
  assert.equal(nextAttempt({ attempt: 2, dirty: true, infinite: true }).done, true);
});

const parsedPage = {
  parsed: {
    blocks: [
      { id: "b1", tag: "p", text: "the opening paragraph" },
      { id: "b2", tag: "p", text: "a decision site worth marking" },
      { id: "b3", tag: "p", text: "the closing paragraph" }
    ]
  }
};

test("saved blocks still remember a passage the live page dropped", () => {
  const around = blocksAround(parsedPage, "decision site", 1);
  assert.deepEqual(
    around.map((block) => block.id),
    ["b1", "b2", "b3"]
  );
  assert.equal(seenInParse(parsedPage, "decision site"), true);
  assert.equal(seenInParse(parsedPage, "never written anywhere"), false);
  assert.deepEqual(blocksAround(parsedPage, ""), []);
});

test("one bad load never condemns a highlight, two do", () => {
  const page = (anchor) => ({
    ...parsedPage,
    id: "p1",
    highlights: [{ id: "hl1", text: "a decision site worth marking", createdAt: 1, anchor }],
    threads: [{ id: "th1", highlightId: "hl1", messages: [] }]
  });

  assert.deepEqual(anchorItems([page({ state: "missing", missStreak: 1, at: 9 })]), []);

  const lost = anchorItems([page({ state: "missing", missStreak: 2, at: 9 })]);
  assert.equal(lost.length, 1);
  assert.equal(lost[0].state, "missing");
  assert.equal(lost[0].weak, false);
  assert.equal(lost[0].thread.id, "th1");

  assert.deepEqual(anchorItems([page({ state: "found", rung: 1, missStreak: 0 })]), []);

  const moved = anchorItems([page({ state: "moved", rung: 4, at: 9 })]);
  assert.equal(moved[0].state, "moved");
});

test("a highlight with no verdict only surfaces when the saved text lost it too", () => {
  const known = {
    ...parsedPage,
    highlights: [{ id: "hl1", text: "a decision site worth marking", createdAt: 1 }],
    threads: []
  };
  assert.deepEqual(anchorItems([known]), []);

  const unknown = {
    ...parsedPage,
    highlights: [{ id: "hl2", text: "text we have never parsed", createdAt: 4 }],
    threads: []
  };
  const items = anchorItems([unknown]);
  assert.equal(items.length, 1);
  assert.equal(items[0].weak, true);
  assert.equal(items[0].state, "unknown");
});

test("doubt is listed newest first", () => {
  const page = {
    ...parsedPage,
    highlights: [
      { id: "old", text: "gone a", createdAt: 1, anchor: { state: "missing", missStreak: 2, at: 10 } },
      { id: "new", text: "gone b", createdAt: 1, anchor: { state: "missing", missStreak: 2, at: 90 } }
    ],
    threads: []
  };
  assert.deepEqual(
    anchorItems([page]).map((item) => item.highlight.id),
    ["new", "old"]
  );
});

test("a re-attach target is checked against the saved text without blocking", () => {
  const blocks = parsedPage.parsed.blocks.map((block) => block.text);
  const selection = (text) => ({ isCollapsed: !text, toString: () => text });
  assert.equal(selectionIsSafe(selection("a decision site"), blocks), true);
  assert.equal(selectionIsSafe(selection("text from another page entirely"), blocks), false);
  assert.equal(selectionIsSafe(selection(""), blocks), false);
  assert.equal(selectionIsSafe(selection("anything at all"), undefined), true);
});

test("a card with nowhere to sit is left out of the margin stack entirely", () => {
  const items = [
    { el: "orphan", preferred: null, height: 80 },
    { el: "top", preferred: 100, height: 60 },
    { el: "near", preferred: 120, height: 40 }
  ];
  const placed = stackCards(items, 10);
  assert.deepEqual(
    placed.map((item) => item.el),
    ["top", "near"],
    "an unanchored card must not be positioned at all, let alone ahead of every real one"
  );
  assert.equal(placed[0].top, 100);
  // The second card wants 120 but the first already runs to 160, so it is
  // pushed clear of it rather than overlapping.
  assert.equal(placed[1].top, 170);
});

test("cards are stacked in page order, not the order they were stored", () => {
  const placed = stackCards(
    [
      { el: "b", preferred: 400, height: 20 },
      { el: "a", preferred: 40, height: 20 }
    ],
    10
  );
  assert.deepEqual(
    placed.map((item) => item.el),
    ["a", "b"]
  );
});
