import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_MARKS,
  markCeiling,
  anchorMarkup,
  articleIsWorthMarking,
  buildMarkupPacket,
  dropAlreadyKept,
  parseMarkupGist,
  parseMarkupReply
} from "../extension/agent/markup.js";
import { looksLikeStableDocument, evaluateInfiniteScroll } from "../extension/parse/infinite-scroll.js";
import { minimapTicks } from "../extension/content/minimap.js";
import {
  SITE_SURFACES,
  mutedHere,
  symbolsMutedHere,
  toggleSiteSurface,
  toggleSymbolsForSite
} from "../extension/shared/site-prefs.js";
import { shortcutAction, isTypingTarget } from "../extension/content/selection.js";
import { COLOR_IDS } from "../extension/shared/colors.js";

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
  assert.match(packet, /no quota/i);
  assert.match(packet, /\bzero\b/i);
  assert.match(packet, /padding/i);
  assert.match(packet, /verbatim|exactly/i);
  // A quota anywhere in the prompt is what produces padding; the only number
  // allowed is the runaway guard, and it must read as a guard.
  assert.match(packet, /Never mark more than \d+\. That is a guard against a runaway reply,\s*not a target/);
});

test("the prompt names under-marking as the likelier failure, not just padding", () => {
  const packet = buildMarkupPacket({ pageTitle: "T", url: "https://e.com", blocks });
  // The old prompt argued one side only, and a model reading it marked two
  // passages in an essay and called that restraint.
  assert.match(packet, /marked too little/i);
  assert.match(packet, /marking too little is the more common one/i);
  assert.match(packet, /every few\s*paragraphs/i);
  // Both failures have to stay on the page; dropping the padding warning is
  // how the ceiling starts getting filled.
  assert.match(packet, /buries the real marks/i);
});

test("the prompt asks for the whole palette without forcing it", () => {
  const packet = buildMarkupPacket({ pageTitle: "T", url: "https://e.com", blocks });
  // Every colour has to arrive with the meaning that separates it from the
  // others, or the model has nothing to choose on and defaults to the first.
  for (const id of COLOR_IDS) assert.match(packet, new RegExp(`\\b${id}\\b`));
  assert.match(packet, /entirely in one colour/i);
  assert.match(packet, /three or more/i);
  // A diversity rule that overrides the meaning is worse than no rule.
  assert.match(packet, /Do not force a colour onto a passage/i);
});

test("the ceiling grows with the article instead of starving a long one", () => {
  assert.ok(markCeiling(2000) > markCeiling(900));
  assert.ok(markCeiling(6000) > markCeiling(2000));
  // Still a ceiling, not a licence to mark a book: past a certain length the
  // reader is skimming a book anyway, and more ticks stop being navigation.
  assert.equal(markCeiling(400000), MAX_MARKS);
  assert.equal(markCeiling(15000), MAX_MARKS);
});

test("an ordinary article is not held to a handful of marks", () => {
  // The lengths most things anyone reads actually are. One per 700 words with
  // a floor of four capped every one of these at four, which is a claim and
  // nothing holding it up.
  assert.ok(markCeiling(900) >= 6);
  assert.ok(markCeiling(1500) >= 6);
  assert.ok(markCeiling(2500) >= 8, "a long-read essay needs more than a note does");
  assert.ok(markCeiling(0) >= 6, "an unmeasured article must not be the most starved of all");
});

test("a long article is told it may need more, a short one told not to reach", () => {
  const long = buildMarkupPacket({ blocks, wordCount: 9000 });
  assert.match(long, /9000 words/);
  assert.match(long, /stranded in the middle/);
  assert.match(long, new RegExp(`Never mark more than ${markCeiling(9000)}`));

  const short = buildMarkupPacket({ blocks, wordCount: 700 });
  assert.match(short, /still makes more than one move/);
  assert.doesNotMatch(short, /stranded in the middle/);
});

test("the reply is cut at the article's own ceiling, not a flat one", () => {
  const reply = Array.from(
    { length: 40 },
    (_, i) => `lemon | a distinct quoted passage number ${i} here | reason`
  ).join("\n");
  assert.equal(parseMarkupReply(reply, markCeiling(900)).length, markCeiling(900));
  assert.equal(parseMarkupReply(reply, markCeiling(15000)).length, markCeiling(15000));
  // A short article's ceiling has to actually bind, or the cut is not a cut.
  assert.ok(markCeiling(900) < markCeiling(15000));
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

test("a passage the article repeats is still a passage worth marking", () => {
  // Ambiguity is scored from the prefix and suffix around a quote, and a model
  // is never asked for either — so a repeated sentence scored loose and was
  // thrown away, despite being the one thing we can be sure of: found whole in
  // the article. It is common in practice; a refrain is usually the point.
  const repeated = [
    { id: "r1", tag: "p", text: "Adoption is not the same as usage, and the gap is the whole finding." },
    { id: "r2", tag: "p", text: "Every measure we tried agreed on that much." },
    { id: "r3", tag: "p", text: "Adoption is not the same as usage, and the gap is the whole finding." }
  ];
  const kept = anchorMarkup(
    [{ color: "lemon", quote: "Adoption is not the same as usage, and the gap is the whole finding.", why: "the refrain" }],
    repeated
  );
  assert.equal(kept.length, 1, "the first occurrence is taken rather than none");
  assert.match(kept[0].text, /^Adoption is not the same as usage/);
});

test("taking the first occurrence still cannot double-paint one span", () => {
  const repeated = [
    { id: "r1", tag: "p", text: "Adoption is not the same as usage, and the gap is the whole finding." },
    { id: "r2", tag: "p", text: "Adoption is not the same as usage, and the gap is the whole finding." }
  ];
  const kept = anchorMarkup(
    [
      { color: "lemon", quote: "Adoption is not the same as usage, and the gap is the whole finding.", why: "a" },
      { color: "sand", quote: "not the same as usage, and the gap", why: "b" }
    ],
    repeated
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

test("muting symbols is remembered for the whole site, not just the page", () => {
  let settings = { symbolsOffHosts: [] };
  const first = toggleSymbolsForSite(settings, "https://www.docs.example.com/a?x=1");
  settings = { symbolsOffHosts: first.symbolsOffHosts };

  assert.equal(first.muted, true);
  assert.equal(first.host, "docs.example.com", "www. must not split a site in two");
  assert.equal(symbolsMutedHere(settings, "https://docs.example.com/some/other/page"), true);
});

test("muting one site says nothing about any other", () => {
  const muted = toggleSymbolsForSite({ symbolsOffHosts: [] }, "https://noisy.example.com/a");
  const settings = { symbolsOffHosts: muted.symbolsOffHosts };
  assert.equal(symbolsMutedHere(settings, "https://elsewhere.com/a"), false);
  assert.equal(symbolsMutedHere(settings, "https://noisy.example.com/b"), true);
});

test("the same shortcut brings them back", () => {
  let settings = { symbolsOffHosts: [] };
  const off = toggleSymbolsForSite(settings, "https://example.com/a");
  settings = { symbolsOffHosts: off.symbolsOffHosts };
  const on = toggleSymbolsForSite(settings, "https://example.com/a");

  assert.equal(on.muted, false);
  assert.deepEqual(on.symbolsOffHosts, [], "turning it back on must not leave the host behind");
});

test("muting stays put across other sites being muted and unmuted", () => {
  let settings = { symbolsOffHosts: [] };
  for (const url of ["https://a.com/x", "https://b.com/y", "https://c.com/z"]) {
    settings = { symbolsOffHosts: toggleSymbolsForSite(settings, url).symbolsOffHosts };
  }
  settings = { symbolsOffHosts: toggleSymbolsForSite(settings, "https://b.com/y").symbolsOffHosts };
  assert.deepEqual(settings.symbolsOffHosts, ["a.com", "c.com"]);
});

test("a page with no host cannot be muted, and does not corrupt the list", () => {
  const settings = { symbolsOffHosts: ["a.com"] };
  const result = toggleSymbolsForSite(settings, "not-a-url");
  assert.equal(result.host, "");
  assert.deepEqual(result.symbolsOffHosts, ["a.com"]);
  assert.equal(symbolsMutedHere(settings, "not-a-url"), false);
});

test("no setting at all reads as nothing muted", () => {
  assert.equal(symbolsMutedHere({}, "https://example.com/a"), false);
  assert.equal(symbolsMutedHere(undefined, "https://example.com/a"), false);
});


// Every surface a reader can silence on one site works the same way, and the
// point of the table is that they cannot drift apart.
for (const surface of Object.keys(SITE_SURFACES)) {
  test(`${surface} can be off for one site and on everywhere else`, () => {
    const key = SITE_SURFACES[surface];
    const off = toggleSiteSurface({}, "https://www.docs.example.com/a?x=1", surface);
    assert.equal(off.muted, true);
    assert.equal(off.host, "docs.example.com", "www. must not split a site in two");
    assert.deepEqual(off.patch, { [key]: ["docs.example.com"] });

    const settings = off.patch;
    assert.equal(mutedHere(settings, "https://docs.example.com/another", surface), true);
    assert.equal(mutedHere(settings, "https://elsewhere.com/a", surface), false);

    const back = toggleSiteSurface(settings, "https://docs.example.com/a", surface);
    assert.equal(back.muted, false);
    assert.deepEqual(back.hosts, [], "turning it back on must not leave the host behind");
  });
}

test("silencing one surface on a site says nothing about the others there", () => {
  const settings = toggleSiteSurface({}, "https://noisy.example.com/a", "markup").patch;
  assert.equal(mutedHere(settings, "https://noisy.example.com/a", "markup"), true);
  assert.equal(mutedHere(settings, "https://noisy.example.com/a", "symbols"), false);
  assert.equal(mutedHere(settings, "https://noisy.example.com/a", "minimap"), false);
});

test("a surface nobody has heard of cannot write to settings", () => {
  const result = toggleSiteSurface({}, "https://example.com/a", "nonsense");
  assert.equal(result.host, "");
  assert.deepEqual(result.patch, {});
  assert.equal(mutedHere({ nonsenseOffHosts: ["example.com"] }, "https://example.com/a", "nonsense"), false);
});

test("a page with no host cannot mute a surface, and does not corrupt the list", () => {
  const settings = { markupOffHosts: ["a.com"] };
  const result = toggleSiteSurface(settings, "not-a-url", "markup");
  assert.equal(result.host, "");
  assert.deepEqual(result.hosts, ["a.com"]);
  assert.deepEqual(result.patch, {});
});

test("asking again does not re-suggest a passage you already kept", () => {
  const marks = [
    { text: "It is likely our results underestimate actual adoption.", color: "lemon" },
    { text: "Surveys may lead to underreporting of actual adoption.", color: "sky" }
  ];
  const kept = dropAlreadyKept(marks, [
    { text: "It is likely our results underestimate actual adoption." }
  ]);
  assert.equal(kept.length, 1);
  assert.match(kept[0].text, /^Surveys may lead/);
});

test("a mark inside a longer highlight of yours is already yours", () => {
  const kept = dropAlreadyKept(
    [{ text: "results underestimate actual adoption" }],
    [{ text: "It is likely our results underestimate actual adoption due to free tools." }]
  );
  assert.deepEqual(kept, []);
});

test("a highlight too short to be a quote cannot swallow the marks", () => {
  const marks = [{ text: "It is likely our results underestimate adoption." }];
  assert.equal(dropAlreadyKept(marks, [{ text: "the" }]).length, 1);
  assert.equal(dropAlreadyKept(marks, []).length, 1);
  assert.equal(dropAlreadyKept(marks, undefined).length, 1);
});

// On macOS, Option is the Alt key and composes a character with it, so the
// letter never arrives as itself. These are the events Chrome actually emits
// there; matching on `key` is why the shortcuts silently did nothing.
const macOption = (code, key) => ({ altKey: true, code, key });

test("Option+S reaches the toggle on a Mac, where the key is not an s at all", () => {
  assert.equal(shortcutAction(macOption("KeyS", "ß")), "symbols");
  assert.equal(shortcutAction(macOption("KeyJ", "∆")), "next-mark");
  assert.equal(shortcutAction(macOption("KeyK", "˚")), "prev-mark");
});

test("the same physical keys still work where Alt does not compose", () => {
  assert.equal(shortcutAction({ altKey: true, code: "KeyS", key: "s" }), "symbols");
  assert.equal(shortcutAction({ altKey: true, code: "KeyJ", key: "j" }), "next-mark");
});

test("a layout that puts another letter on that key is unaffected", () => {
  // Dvorak reports code KeyS for the physical key labelled o.
  assert.equal(shortcutAction({ altKey: true, code: "KeyS", key: "o" }), "symbols");
});

test("plain typing is never a shortcut", () => {
  assert.equal(shortcutAction({ altKey: false, code: "KeyS", key: "s" }), null);
  assert.equal(shortcutAction({ altKey: true, code: "KeyQ", key: "q" }), null);
});

test("other modifiers on the same key belong to the page or the browser", () => {
  assert.equal(shortcutAction({ altKey: true, metaKey: true, code: "KeyS" }), null);
  assert.equal(shortcutAction({ altKey: true, ctrlKey: true, code: "KeyS" }), null);
});

test("holding the key does not toggle over and over", () => {
  assert.equal(shortcutAction({ altKey: true, code: "KeyS", repeat: true }), null);
});

test("writing a comment wins over the shortcut", () => {
  assert.equal(shortcutAction(macOption("KeyS", "ß"), { typing: true }), null);
});

test("the margin composer counts as writing, through the shadow boundary", () => {
  const host = { name: "overlay-host" };
  const event = { altKey: true, code: "KeyS", target: host, composedPath: () => [host] };
  const ownsEvent = (e) => (e.composedPath?.() || []).includes(host);
  assert.equal(isTypingTarget(event, ownsEvent), true);
});

test("an ordinary paragraph is not a typing target", () => {
  const event = { target: { closest: () => null } };
  assert.equal(isTypingTarget(event, () => false), false);
});

test("marking up has its own key, and it is the physical one", () => {
  assert.equal(shortcutAction(macOption("KeyA", "å")), "markup");
  assert.equal(shortcutAction({ altKey: true, code: "KeyA", key: "a" }), "markup");
});

test("every shortcut is a distinct action, so none shadows another", () => {
  const codes = ["KeyA", "KeyS", "KeyJ", "KeyK"];
  const actions = codes.map((code) => shortcutAction({ altKey: true, code }));
  assert.equal(new Set(actions).size, codes.length);
  assert.ok(actions.every(Boolean));
});

test("holding Shift asks for a fresh read, not the one already paid for", () => {
  assert.equal(shortcutAction({ altKey: true, shiftKey: true, code: "KeyA" }), "markup-again");
  assert.equal(shortcutAction(macOption("KeyA", "å")), "markup");
  // A rerun is an agent call, so it must not be a key held down.
  assert.equal(shortcutAction({ altKey: true, shiftKey: true, code: "KeyA", repeat: true }), null);
  assert.equal(shortcutAction({ altKey: true, shiftKey: true, code: "KeyA" }, { typing: true }), null);
});

test("Shift on a key that does not claim it leaves that key alone", () => {
  assert.equal(shortcutAction({ altKey: true, shiftKey: true, code: "KeyJ" }), "next-mark");
  assert.equal(shortcutAction({ altKey: true, shiftKey: true, code: "KeyS" }), "symbols");
});

test("the prompt asks for the argument in plain words before it asks for marks", () => {
  const packet = buildMarkupPacket({ pageTitle: "T", url: "https://e.com", blocks, wordCount: 1200 });
  assert.match(packet, /## The gist, first/);
  assert.match(packet, /plain language/i);
  assert.match(packet, /does not have the background/i);
  // The gist is for the reader who has not read the piece, so it cannot be a
  // recap of the marks — they are the thing it has to make readable.
  assert.match(packet, /not a summary of the marks/i);
  assert.ok(packet.indexOf("## The gist, first") < packet.indexOf("## Colours"));
  assert.match(packet, /## Gist/);
  assert.match(packet, /## Marks/);
});

test("a two-section reply gives up its gist and its marks separately", () => {
  const reply = [
    "## Gist",
    "Surveys undercount how much AI businesses actually use, because a firm on a free tool does not think of itself as a customer.",
    "",
    "## Marks",
    "sand | surveys may lead to underreporting of actual adoption | the gap the paper is built on",
    "lemon | our results underestimate actual adoption | what they conclude from it"
  ].join("\n");

  assert.match(parseMarkupGist(reply), /^Surveys undercount/);
  const marks = parseMarkupReply(reply);
  assert.equal(marks.length, 2);
  assert.equal(marks[0].color, "sand");
  // The gist prose must never leak into the marks: it has no pipes and no
  // colour, so it falls out on its own, but a regression here paints prose on
  // the page as if the article had said it.
  assert.ok(marks.every((mark) => !/Surveys undercount/.test(mark.quote)));
});

test("a reply from before the gist existed is still all marks", () => {
  const reply = "lemon | our results underestimate actual adoption | the conclusion";
  assert.equal(parseMarkupGist(reply), "");
  assert.equal(parseMarkupReply(reply).length, 1);
});

test("an article with nothing to explain gets no card", () => {
  assert.equal(parseMarkupGist("## Gist\nNONE\n\n## Marks\nNONE"), "");
  assert.equal(parseMarkupGist("## Gist\n\n## Marks\nNONE"), "");
  assert.equal(parseMarkupGist(""), "");
  assert.deepEqual(parseMarkupReply("## Gist\nNONE\n\n## Marks\nNONE"), []);
});

test("an article worth explaining but not worth marking keeps its gist", () => {
  const reply = "## Gist\nOne careful argument, and no single sentence carries it.\n\n## Marks\nNONE";
  assert.match(parseMarkupGist(reply), /One careful argument/);
  assert.deepEqual(parseMarkupReply(reply), []);
});

test("a gist that is really the mark lines again is thrown away", () => {
  const reply = "## Gist\nlemon | some quote | some reason\n\n## Marks\nlemon | some quote | some reason";
  assert.equal(parseMarkupGist(reply), "");
});

test("markdown in the gist is flattened, because the card renders text", () => {
  const reply = "## Gist\n- **Surveys** undercount `adoption`.\n\n## Marks\nNONE";
  assert.equal(parseMarkupGist(reply), "Surveys undercount adoption.");
});

test("a runaway gist is cut at a sentence, not mid-word", () => {
  const sentence = "This is a sentence about adoption and what it rests on. ";
  const reply = `## Gist\n${sentence.repeat(40)}\n\n## Marks\nNONE`;
  const gist = parseMarkupGist(reply);
  assert.ok(gist.length <= 900);
  assert.ok(gist.endsWith("."));
  assert.ok(!/\bade?$|\bsente?$/.test(gist));
});
