import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_MARKS,
  markCeiling,
  anchorMarkup,
  articleIsWorthMarking,
  buildMarkupPacket,
  parseMarkupReply
} from "../extension/agent/markup.js";
import { looksLikeStableDocument, evaluateInfiniteScroll } from "../extension/parse/infinite-scroll.js";
import { minimapTicks } from "../extension/content/minimap.js";

const blocks = [
  { id: "b1", tag: "h2", text: "Methodology", heading: true },
  {
    id: "b2",
    tag: "p",
    text: "Previous work has relied almost entirely on surveys that ask businesses if they use AI, but surveys may lead to underreporting of actual adoption.",
    heading: false
  },
  {
    id: "b3",
    tag: "p",
    text: "It is likely our results underestimate actual adoption due to the prevalence of businesses using free tools.",
    heading: false
  }
];

test("the prompt refuses to name a target, and says none is a real answer", () => {
  const packet = buildMarkupPacket({ pageTitle: "T", url: "https://e.com", blocks });
  assert.match(packet, /no target number/i);
  assert.match(packet, /\bzero\b/i);
  assert.match(packet, /padding/i);
  assert.match(packet, /verbatim|exactly/i);
  // A quota anywhere in the prompt is what produces padding; the only number
  // allowed is the runaway guard, and it must read as a ceiling.
  assert.match(packet, /Never mark more than \d+; if you are near that, you are padding/);
});

test("the ceiling grows with the article instead of starving a long one", () => {
  assert.equal(markCeiling(900), 4);
  assert.equal(markCeiling(2000), 4);
  assert.ok(markCeiling(8000) > markCeiling(2000));
  assert.ok(markCeiling(15000) > markCeiling(8000));
  // Still a ceiling, not a licence to mark a book.
  assert.equal(markCeiling(400000), MAX_MARKS);
  assert.equal(markCeiling(0), 4);
});

test("a long article is told it may need more, a short one told not to reach", () => {
  const long = buildMarkupPacket({ blocks, wordCount: 9000 });
  assert.match(long, /9000 words/);
  assert.match(long, /stranded in the middle/);
  assert.match(long, new RegExp(`Never mark more than ${markCeiling(9000)}`));

  const short = buildMarkupPacket({ blocks, wordCount: 700 });
  assert.match(short, /Do not look for more than are there/);
  assert.doesNotMatch(short, /stranded in the middle/);
});

test("the reply is cut at the article's own ceiling, not a flat one", () => {
  const reply = Array.from(
    { length: 40 },
    (_, i) => `lemon | a distinct quoted passage number ${i} here | reason`
  ).join("\n");
  assert.equal(parseMarkupReply(reply, markCeiling(900)).length, 4);
  assert.equal(parseMarkupReply(reply, markCeiling(15000)).length, markCeiling(15000));
});

test("the prompt carries the colour vocabulary the product already uses", () => {
  const packet = buildMarkupPacket({ blocks });
  for (const [id, meaning] of [
    ["lemon", "Key idea"],
    ["moss", "Action"],
    ["sky", "Question"],
    ["rose", "Concern"],
    ["iris", "Insight"],
    ["sand", "Evidence"]
  ]) {
    assert.ok(packet.includes(id), `missing colour ${id}`);
    assert.ok(packet.includes(meaning), `missing meaning for ${id}`);
  }
});

test("headings and body both reach the model", () => {
  const packet = buildMarkupPacket({ blocks });
  assert.match(packet, /## Methodology/);
  assert.ok(packet.includes("underreporting of actual adoption"));
});

test("a well-formed reply parses into marks", () => {
  const marks = parseMarkupReply(
    [
      "lemon | surveys may lead to underreporting of actual adoption | surveys undercount what firms actually do",
      "sand | our results underestimate actual adoption | the authors' own stated limit"
    ].join("\n")
  );
  assert.equal(marks.length, 2);
  assert.equal(marks[0].color, "lemon");
  assert.equal(marks[1].color, "sand");
  assert.match(marks[0].why, /undercount/);
});

test("an empty article is allowed to come back with nothing", () => {
  assert.deepEqual(parseMarkupReply("NONE"), []);
  assert.deepEqual(parseMarkupReply("none."), []);
  assert.deepEqual(parseMarkupReply(""), []);
  assert.deepEqual(parseMarkupReply("   \n  "), []);
});

test("chatter, numbering and unknown colours are dropped rather than guessed at", () => {
  const marks = parseMarkupReply(
    [
      "Here are the passages I found:",
      "```",
      "1. lemon | surveys may lead to underreporting of actual adoption | undercounts",
      "- neon | a quote in a colour that does not exist | nope",
      "just a line with no pipe at all",
      "sky |  | empty quote",
      "```",
      "Hope that helps!"
    ].join("\n")
  );
  assert.equal(marks.length, 1);
  assert.equal(marks[0].color, "lemon");
});

test("the same passage twice counts once", () => {
  const marks = parseMarkupReply(
    [
      "lemon | surveys may lead to underreporting of actual adoption | a",
      "sand | Surveys may lead to underreporting of actual adoption | b"
    ].join("\n")
  );
  assert.equal(marks.length, 1);
});

test("a runaway reply is cut off at the guard", () => {
  const reply = Array.from(
    { length: 40 },
    (_, i) => `lemon | a distinct quoted passage number ${i} here | reason`
  ).join("\n");
  assert.equal(parseMarkupReply(reply).length, MAX_MARKS);
});

test("only quotes really in the article survive", () => {
  const marks = [
    { color: "lemon", quote: "surveys may lead to underreporting of actual adoption", why: "real" },
    { color: "rose", quote: "a sentence the model invented wholesale here", why: "fabricated" }
  ];
  const kept = anchorMarkup(marks, blocks);
  assert.equal(kept.length, 1, "a quote not in the text must never become a mark");
  assert.equal(kept[0].why, "real");
});

test("an anchored mark carries what a highlight needs to find its place", () => {
  const [mark] = anchorMarkup(
    [{ color: "lemon", quote: "surveys may lead to underreporting of actual adoption", why: "w" }],
    blocks
  );
  assert.ok(mark.text.length > 0);
  assert.ok(mark.prefix.length > 0, "prefix disambiguates a repeated passage");
  assert.ok(mark.suffix.length > 0);
  assert.equal(mark.color, "lemon");
});

test("a paraphrase is rejected even though a human would call it the same sentence", () => {
  const kept = anchorMarkup(
    [{ color: "lemon", quote: "Surveys can cause firms to under-report their real AI adoption", why: "w" }],
    blocks
  );
  assert.deepEqual(kept, []);
});

test("overlapping marks collapse so the page is not double-painted", () => {
  const kept = anchorMarkup(
    [
      { color: "lemon", quote: "surveys may lead to underreporting of actual adoption", why: "a" },
      { color: "sand", quote: "underreporting of actual adoption", why: "b" }
    ],
    blocks
  );
  assert.equal(kept.length, 1);
});

test("an article with no text anchors nothing", () => {
  assert.deepEqual(anchorMarkup([{ color: "lemon", quote: "anything at all here", why: "" }], []), []);
});

test("short pages are not worth the call", () => {
  assert.equal(articleIsWorthMarking({ wordCount: 40, blocks }), false);
  assert.equal(articleIsWorthMarking({ wordCount: 900, blocks: [] }), false);
  assert.equal(articleIsWorthMarking({ wordCount: 900, blocks }), true);
});

test("an X article is a document, while the timeline stays a feed", () => {
  const doc = { querySelector: () => null };
  assert.equal(looksLikeStableDocument("https://x.com/wordgrammer/article/2095263188153401712"), true);
  assert.equal(evaluateInfiniteScroll("https://x.com/wordgrammer/article/2095263188153401712", doc).infinite, false);
  assert.equal(evaluateInfiniteScroll("https://x.com/home", doc).infinite, true);
  // A single tweet grows replies underneath it, so the feed treatment is right.
  assert.equal(evaluateInfiniteScroll("https://x.com/someone/status/123", doc).infinite, true);
  assert.equal(evaluateInfiniteScroll("https://twitter.com/a/article/9", doc).infinite, false);
});

test("ticks land at the depth of the passage they point at", () => {
  const ticks = minimapTicks(
    [
      { id: "a", kind: "highlight", color: "lemon", top: 0 },
      { id: "b", kind: "mark", color: "sand", top: 500 },
      { id: "c", kind: "highlight", color: "rose", top: 1000 }
    ],
    1000
  );
  assert.deepEqual(
    ticks.map((t) => t.pct),
    [0, 50, 100]
  );
});

test("ticks are ordered down the page however they arrived", () => {
  const ticks = minimapTicks(
    [
      { id: "late", kind: "mark", color: "lemon", top: 900 },
      { id: "early", kind: "highlight", color: "sand", top: 100 }
    ],
    1000
  );
  assert.deepEqual(
    ticks.map((t) => t.id),
    ["early", "late"]
  );
});

test("a passage with no place on the page gets no tick", () => {
  const ticks = minimapTicks(
    [
      { id: "placed", kind: "highlight", color: "lemon", top: 200 },
      { id: "orphan", kind: "highlight", color: "lemon", top: null },
      { id: "missing", kind: "mark", color: "lemon" }
    ],
    1000
  );
  assert.deepEqual(
    ticks.map((t) => t.id),
    ["placed"],
    "an unplaced passage must not pile up at the top of the rail"
  );
});

test("a mark measured past the end of the document stays on the rail", () => {
  const [tick] = minimapTicks([{ id: "a", kind: "mark", color: "lemon", top: 5000 }], 1000);
  assert.equal(tick.pct, 100);
});

test("nothing to show means no rail at all", () => {
  assert.deepEqual(minimapTicks([], 1000), []);
  assert.deepEqual(minimapTicks([{ id: "a", kind: "mark", color: "lemon", top: 10 }], 0), []);
});

test("a tick remembers which kind it is, so the rail can tell them apart", () => {
  const ticks = minimapTicks(
    [
      { id: "mine", kind: "highlight", color: "rose", top: 10 },
      { id: "theirs", kind: "mark", color: "sand", top: 20, why: "the authors' own limit" }
    ],
    100
  );
  assert.equal(ticks[0].kind, "highlight");
  assert.equal(ticks[1].kind, "mark");
  assert.equal(ticks[1].why, "the authors' own limit");
});
