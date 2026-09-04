import assert from "node:assert/strict";
import test from "node:test";
import {
  blocksFromItems,
  documentMetrics,
  hasUsableText,
  linesFromItems,
  paragraphsFromLines,
  parsePdfDocument,
  titleFromUrl
} from "../extension/pdf/pdf-parse.js";
import {
  isViewerUrl,
  looksLikePdfUrl,
  requestedPage,
  sourceUrlFrom,
  viewerUrlFor
} from "../extension/pdf/route.js";
import { blockIdFromText } from "../extension/shared/id.js";
import { emptyPage, newHighlight } from "../extension/storage/store.js";
import { pageToMarkdown, suggestedFilename } from "../extension/export/obsidian.js";

/**
 * A text item as pdf.js hands one back. The transform is
 * [scaleX, skewY, skewX, scaleY, x, y] and PDF coordinates put the origin at
 * the bottom-left, so a line further down the page has a *smaller* y.
 */
function item(str, { y, x = 72, size = 10, width = null, eol = true } = {}) {
  return {
    str,
    dir: "ltr",
    width: width === null ? str.length * size * 0.5 : width,
    height: size,
    transform: [size, 0, 0, size, x, y],
    fontName: "g_d0_f1",
    hasEOL: eol
  };
}

/** A justified body line: starts at the left margin, reaches the right one. */
function full(str, y) {
  return item(str, { y, x: 72, width: 468 });
}

const VIEWER = "chrome-extension://abcdefghijklmnopabcdefghijklmnop/pdf/viewer.html";

test("runs on one baseline become one line, and a baseline change starts another", () => {
  const lines = linesFromItems([
    item("Attention is", { y: 700, x: 72, width: 60, eol: false }),
    item("all you need", { y: 700, x: 138, width: 60, eol: true }),
    item("The dominant sequence models", { y: 688, width: 140 })
  ]);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].text, "Attention is all you need");
  assert.equal(lines[1].text, "The dominant sequence models");
});

test("two runs with no gap between them are one word, not two", () => {
  // Kerning splits "transformer" mid-word in the content stream. A space here
  // would break every quote and every search containing the word.
  const lines = linesFromItems([
    item("transfor", { y: 700, x: 72, width: 40, eol: false }),
    item("mer", { y: 700, x: 112, width: 15, eol: true })
  ]);
  assert.deepEqual(lines.map((l) => l.text), ["transformer"]);
});

test("hasEOL ends the line even when the baseline has not moved", () => {
  const lines = linesFromItems([
    item("first", { y: 700, x: 72, width: 30, eol: true }),
    item("second", { y: 700, x: 72, width: 30, eol: true })
  ]);
  assert.equal(lines.length, 2);
});

test("an empty run carries its line break", () => {
  const lines = linesFromItems([
    item("first", { y: 700, x: 72, width: 30, eol: false }),
    { str: "", transform: [10, 0, 0, 10, 112, 700], width: 0, height: 10, hasEOL: true },
    item("second", { y: 700, x: 112, width: 30, eol: true })
  ]);
  assert.deepEqual(lines.map((l) => l.text), ["first", "second"]);
});

test("lines at normal leading join into one paragraph", () => {
  const lines = linesFromItems([full("The dominant sequence transduction models are based", 700), full("on complex recurrent or convolutional neural networks", 688)]);
  const paragraphs = paragraphsFromLines(lines, { bodySize: 10, bodyRight: 540 });
  assert.equal(paragraphs.length, 1);
  assert.match(paragraphs[0].text, /^The dominant .* neural networks$/);
});

test("a line that stops short of the right margin ends its paragraph", () => {
  // The case that matters in justified text, where the leading between
  // paragraphs and between lines is identical and the gap tells you nothing.
  const lines = linesFromItems([
    full("The dominant sequence transduction models are based", 700),
    item("on complex recurrent networks.", { y: 688, x: 72, width: 180 }),
    full("We propose a new simple network architecture entirely", 676)
  ]);
  const paragraphs = paragraphsFromLines(lines, { bodySize: 10, bodyRight: 540 });
  assert.equal(paragraphs.length, 2);
  assert.match(paragraphs[1].text, /^We propose/);
});

test("a wide vertical gap ends a paragraph", () => {
  const lines = linesFromItems([full("The dominant sequence transduction models are based", 700), full("We propose a new simple network architecture entirely", 660)]);
  assert.equal(paragraphsFromLines(lines, { bodySize: 10, bodyRight: 540 }).length, 2);
});

test("moving back up the page is another column, not the next line", () => {
  const lines = linesFromItems([
    item("bottom of the left column of this paper", { y: 100, x: 72, width: 200 }),
    item("top of the right column of this paper", { y: 700, x: 320, width: 200 })
  ]);
  assert.equal(paragraphsFromLines(lines, { bodySize: 10, bodyRight: 540 }).length, 2);
});

test("a first-line indent ends the previous paragraph", () => {
  const lines = linesFromItems([
    full("The dominant sequence transduction models are based", 700),
    item("We propose a new simple network architecture entirely", { y: 688, x: 92, width: 448 })
  ]);
  assert.equal(paragraphsFromLines(lines, { bodySize: 10, bodyRight: 540 }).length, 2);
});

test("a change of type size ends a paragraph", () => {
  const lines = linesFromItems([
    item("1  Introduction", { y: 700, x: 72, size: 16, width: 100 }),
    full("The dominant sequence transduction models are based", 686)
  ]);
  const paragraphs = paragraphsFromLines(lines, { bodySize: 10, bodyRight: 540 });
  assert.equal(paragraphs.length, 2);
  assert.equal(paragraphs[0].heading, true);
  assert.equal(paragraphs[1].heading, false);
});

test("a word the typesetter broke across lines is put back together", () => {
  const lines = linesFromItems([full("models draw global dependencies between informa-", 700), full("tion in the input and output sequences of the model", 688)]);
  const [paragraph] = paragraphsFromLines(lines, { bodySize: 10, bodyRight: 540 });
  assert.match(paragraph.text, /between information in the input/);
});

test("a hyphen before a capital is a real compound and stays", () => {
  const lines = linesFromItems([full("we compare against the widely used English-", 700), full("German translation benchmark from the workshop", 688)]);
  const [paragraph] = paragraphsFromLines(lines, { bodySize: 10, bodyRight: 540 });
  assert.match(paragraph.text, /English-German/);
});

test("a numbered section heading set at body size is still a heading", () => {
  const lines = linesFromItems([item("3.2 Attention", { y: 700, x: 72, width: 70 })]);
  const [paragraph] = paragraphsFromLines(lines, { bodySize: 10, bodyRight: 540 });
  assert.equal(paragraph.heading, true);
});

test("block ids are the ones the rest of the product already computes", () => {
  const blocks = blocksFromItems(
    [full("The dominant sequence transduction models are based on recurrence", 700)],
    { page: 3, bodySize: 10, bodyRight: 540 }
  );
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].id, blockIdFromText(blocks[0].text));
  assert.equal(blocks[0].page, 3);
  assert.equal(blocks[0].tag, "p");
});

test("short runs that are not headings are page furniture and are dropped", () => {
  const blocks = blocksFromItems(
    [item("7", { y: 60, x: 300, width: 6 }), full("The dominant sequence transduction models are based on recurrence", 700)],
    { page: 7, bodySize: 10, bodyRight: 540 }
  );
  assert.deepEqual(blocks.map((b) => b.text.slice(0, 12)), ["The dominant"]);
});

test("the median body size ignores a page of tiny type", () => {
  const pages = [
    { page: 1, lines: linesFromItems([full("a body paragraph of perfectly ordinary running text here", 700)]) },
    { page: 2, lines: linesFromItems([item("tiny footnote text", { y: 60, size: 6, width: 80 })]) }
  ];
  assert.equal(documentMetrics(pages).bodySize, 10);
});

test("a parsed PDF has exactly the shape a parsed article has", () => {
  const parsed = parsePdfDocument({
    title: "Attention Is All You Need",
    url: "https://arxiv.org/pdf/1706.03762.pdf",
    pages: [
      {
        page: 1,
        items: [
          item("1  Introduction", { y: 700, x: 72, size: 16, width: 100 }),
          full("Recurrent neural networks, long short-term memory and gated", 680),
          item("recurrent networks in particular have been firmly established.", { y: 668, x: 72, width: 200 })
        ]
      }
    ]
  });
  assert.deepEqual(
    Object.keys(parsed).sort(),
    ["blocks", "contentHash", "excerpt", "headings", "title", "url", "wordCount"].sort()
  );
  assert.deepEqual(parsed.headings, ["1 Introduction"]);
  assert.ok(parsed.wordCount > 10);
  assert.equal(parsed.contentHash, blockIdFromText(parsed.blocks.map((b) => b.text).join(" ")));
});

test("a running header repeated on every page appears once", () => {
  const header = "Preprint. Under review as a conference paper at ICLR 2024";
  const page = (n, body) => ({
    page: n,
    items: [item(header, { y: 740, x: 72, width: 300 }), full(body, 700)]
  });
  const parsed = parsePdfDocument({
    pages: [page(1, "The first page says one thing about the subject at hand"), page(2, "The second page says a different thing about the subject")]
  });
  assert.equal(parsed.blocks.filter((b) => b.text === header).length, 1);
});

test("a scanned PDF with no text layer is reported as unusable", () => {
  assert.equal(hasUsableText(parsePdfDocument({ pages: [{ page: 1, items: [] }] })), false);
  assert.equal(hasUsableText({ wordCount: 4000 }), true);
});

test("a PDF with no metadata title falls back to its filename", () => {
  assert.equal(titleFromUrl("https://arxiv.org/pdf/1706.03762v5.pdf"), "1706.03762v5");
  assert.equal(titleFromUrl("https://example.com/papers/On_Bullshit.pdf"), "On Bullshit");
  assert.equal(titleFromUrl("not a url"), "PDF");
});

test("looksLikePdfUrl accepts documents and refuses lookalikes", () => {
  const table = [
    ["https://arxiv.org/pdf/1706.03762.pdf", true],
    ["https://example.com/a.pdf?download=1", true],
    ["https://example.com/A.PDF", true],
    ["https://example.com/report.pdfa", false],
    ["https://example.com/pdf/reader", false],
    ["https://example.com/pdf", false],
    ["https://example.com/a.pdf.html", false],
    ["mailto:someone@example.com", false],
    ["not a url", false],
    ["", false]
  ];
  for (const [url, expected] of table) {
    assert.equal(looksLikePdfUrl(url), expected, url);
  }
});

test("a fragment does not stop a PDF looking like one", () => {
  assert.equal(looksLikePdfUrl("https://arxiv.org/pdf/1706.03762.pdf#page=4"), true);
});

test("the viewer URL round-trips to the source PDF unchanged", () => {
  const source = "https://arxiv.org/pdf/1706.03762.pdf?v=2#page=4";
  const viewer = viewerUrlFor(source, VIEWER);
  assert.equal(sourceUrlFrom(viewer), source);
  assert.equal(isViewerUrl(viewer), true);
});

test("a viewer URL from another install is still recognised", () => {
  // The extension id changes on every reinstall, so identity can never be the
  // origin — only the path and the file it carries.
  const other = viewerUrlFor("https://example.com/a.pdf", "chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz/pdf/viewer.html");
  assert.equal(sourceUrlFrom(other), "https://example.com/a.pdf");
});

test("an ordinary page is not a viewer URL", () => {
  assert.equal(sourceUrlFrom("https://example.com/pdf/viewer.html?file=x"), "");
  assert.equal(isViewerUrl("https://arxiv.org/pdf/1706.03762.pdf"), false);
});

test("a #page fragment is read as a requested page, and its absence as none", () => {
  assert.equal(requestedPage("https://arxiv.org/pdf/x.pdf#page=7"), 7);
  assert.equal(requestedPage("https://arxiv.org/pdf/x.pdf#zoom=200&page=3"), 3);
  assert.equal(requestedPage("https://arxiv.org/pdf/x.pdf"), 0);
  assert.equal(requestedPage("https://arxiv.org/pdf/x.pdf#page=0"), 0);
});

/* ------------------------------------------------- the record and the vault */

test("a highlight keeps the page it was made on, and refuses a nonsense one", () => {
  // newHighlight drops unknown fields on purpose, so `locator` has to be named
  // or ADD_HIGHLIGHT would silently discard the only thing that says which
  // text layer to search on the next restore.
  assert.deepEqual(newHighlight({ text: "x", locator: { page: 4 } }).locator, { page: 4 });
  assert.equal(newHighlight({ text: "x", locator: { page: 0 } }).locator, null);
  assert.equal(newHighlight({ text: "x", locator: { page: "four" } }).locator, null);
  assert.equal(newHighlight({ text: "x" }).locator, null);
});

test("a PDF's record says so, and carries its length", () => {
  const page = emptyPage("https://arxiv.org/pdf/1706.03762.pdf", {
    kind: "pdf",
    docMeta: { pages: 15, fingerprint: "abc" }
  });
  assert.equal(page.kind, "pdf");
  assert.deepEqual(page.docMeta, { pages: 15, fingerprint: "abc" });
  assert.equal(emptyPage("https://example.com/a").kind, "web");
});

test("an exported PDF note says which page each passage was on", () => {
  const markdown = pageToMarkdown({
    id: "p1",
    title: "Attention Is All You Need",
    url: "https://arxiv.org/pdf/1706.03762.pdf",
    domain: "arxiv.org",
    kind: "pdf",
    docMeta: { pages: 15 },
    updatedAt: 1,
    highlights: [{ id: "h1", color: "moss", text: "We propose the Transformer", locator: { page: 2 } }],
    threads: []
  });
  assert.match(markdown, /^type: pdf$/m);
  assert.match(markdown, /^pages: 15$/m);
  assert.match(markdown, /### moss: "We propose the Transformer" · p\. 2$/m);
});

test("an article's note is unchanged apart from gaining a type", () => {
  const page = {
    id: "p2",
    title: "On attention",
    url: "https://example.com/attention",
    domain: "example.com",
    updatedAt: 1,
    highlights: [{ id: "h1", color: "lemon", text: "a passage worth keeping" }],
    threads: []
  };
  const markdown = pageToMarkdown(page);
  assert.match(markdown, /^type: article$/m);
  assert.equal(/pages:/.test(markdown), false);
  assert.match(markdown, /### lemon: "a passage worth keeping"$/m);
});

test("a local PDF exports under a name you can tell apart", () => {
  // hostnameOf returns "" for file://, so without a fallback every local
  // document would land as "…-web-….md" in one indistinct pile.
  const name = suggestedFilename({
    url: "file:///Users/x/papers/On_Bullshit.pdf",
    domain: "",
    updatedAt: Date.parse("2026-01-02T00:00:00Z")
  });
  assert.equal(name, "2026-01-02-local-on-bullshit.md");
});
