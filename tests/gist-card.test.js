import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

/**
 * The gist card is the one piece of this that only exists in a document.
 *
 * Everything else about a markup pass — the prompt, the reply, the quote
 * check — is a string going in and a string coming out, and `node --test`
 * reaches all of it. Where the card lands does not survive that treatment:
 * it is a question about a live page, and the first version of the placement
 * rule passed every test that existed while putting the card above the
 * headline on any page built without <article> or <main>.
 *
 * So this file runs the shipped module against real documents. The cost is a
 * DOM implementation in devDependencies; the thing it buys is that "is the
 * card where it should be" is a question with an answer.
 */

const ARTICLE_HTML = new URL("../demo/article.html", import.meta.url);

/**
 * A document, with the globals a content script expects pointing at it.
 *
 * The module is re-imported per document rather than once per file, because
 * it holds the card it drew in module state — a second document would find
 * that state pointing into the first one, which is a situation no browser
 * ever produces and no test should pretend to.
 */
let documents = 0;
async function pageOf(html) {
  const dom = new JSDOM(html, { url: "https://demo.test/article" });
  for (const key of ["window", "document", "Node", "NodeFilter", "HTMLElement"]) {
    globalThis[key] = key === "window" ? dom.window : dom.window[key];
  }
  const stamp = `?doc=${(documents += 1)}`;
  return {
    document: dom.window.document,
    card: () => dom.window.document.querySelector("lp-gist"),
    ...(await import(`../extension/content/gist-card.js${stamp}`)),
    ...(await import(`../extension/parse/page-parser.js${stamp}`))
  };
}

/** The demo article, minus its boot script — we are testing the card, not the extension. */
function demoArticle() {
  return readFileSync(ARTICLE_HTML, "utf8").replace(/<script[\s\S]*?<\/script>/g, "");
}

const GIST =
  "Annotating a page after you have captured it loses what made the page work on you: where your eye went, and what sat next to what.";

describe("the gist card on the demo article", () => {
  test("lands below the headline and above the first paragraph", async () => {
    const page = await pageOf(demoArticle());
    const main = page.document.querySelector("main");
    const firstProse = [...main.querySelectorAll("p")].find((p) => p.textContent.trim().length >= 80);

    assert.equal(page.showGist(GIST, { markCount: 3 }), true);
    const card = page.card();

    assert.ok(card, "a card was drawn");
    assert.equal(card.parentElement, main);
    assert.equal(card.nextElementSibling, firstProse);
    // A gist above the headline reads as a banner belonging to the site
    // rather than as something said about this piece.
    const h1 = main.querySelector("h1");
    assert.ok(h1.compareDocumentPosition(card) & 4, "the card follows the headline");
    // The kicker is a paragraph too, and a short one. Being drawn to it would
    // put the card above the title by a different route.
    assert.notEqual(card.nextElementSibling?.className, "kicker");
  });

  test("carries the gist, the mark count, and the class that keeps anchoring off it", async () => {
    const page = await pageOf(demoArticle());
    page.showGist(GIST, { markCount: 3 });
    const card = page.card();

    assert.ok(card.shadowRoot, "the card is in a shadow root");
    assert.equal(card.shadowRoot.querySelector(".body").textContent, GIST);
    assert.match(card.shadowRoot.querySelector(".marks").textContent, /^3 passages marked below/);
    // quote.js skips .lp-ignore, so a highlight can never anchor into the card.
    assert.ok(card.classList.contains("lp-ignore"));
  });

  test("is invisible to the parser, so the article is never re-read forever", async () => {
    const page = await pageOf(demoArticle());
    const before = page.parseDocument(page.document, "https://demo.test/article");

    page.showGist(GIST, { markCount: 3 });
    const after = page.parseDocument(page.document, "https://demo.test/article");

    // The content hash is what says an article has already been read. If the
    // card counted as article text, drawing it would change the hash, the
    // cache would miss, and every visit would buy another agent call — which
    // the card itself would then invalidate again.
    assert.equal(after.contentHash, before.contentHash);
    assert.equal(after.wordCount, before.wordCount);
    assert.equal(after.blocks.length, before.blocks.length);
    assert.ok(!after.blocks.some((block) => block.text.includes("Annotating a page")));
  });

  test("drawn twice is still one card, and an empty gist takes it away", async () => {
    const page = await pageOf(demoArticle());
    const main = page.document.querySelector("main");
    const firstProse = [...main.querySelectorAll("p")].find((p) => p.textContent.trim().length >= 80);

    page.showGist(GIST, { markCount: 3 });
    page.showGist("A different gist entirely.", { markCount: 0 });

    // Every pass calls this, cached or fresh, so it has to be idempotent.
    assert.equal(page.document.querySelectorAll("lp-gist").length, 1);
    assert.equal(page.card().shadowRoot.querySelector(".body").textContent, "A different gist entirely.");
    assert.equal(page.card().shadowRoot.querySelector(".marks").hidden, true);

    assert.equal(page.showGist("", {}), false);
    assert.equal(page.document.querySelectorAll("lp-gist").length, 0);
    // And it leaves the page as it found it.
    assert.equal([...main.querySelectorAll("p")].find((p) => p.textContent.trim().length >= 80), firstProse);
  });
});

/**
 * The shapes real articles actually come in.
 *
 * Every one of these placed the card correctly except the bare-body case,
 * which is why the rule is now "stop climbing once something already precedes
 * this paragraph" rather than "climb to a child of the root".
 */
const PROSE = (n) =>
  `<p>${`Sentence number ${n} carrying enough words to count as a real paragraph rather than a caption or a byline. `.repeat(2)}</p>`;

const SHAPES = {
  "an article wrapped in nested divs": {
    body: `<header><p>site nav</p></header><article><h1>Title</h1><div class="byline"><p>By someone</p></div><div class="body"><div class="para">${PROSE(1)}</div><h2>Next</h2>${PROSE(2)}</div></article>`,
    // Out of both wrapper divs, but not past the byline.
    before: "div"
  },
  "a page with no article or main at all": {
    body: `<div id="wrap"><h1>Title</h1>${PROSE(1)}<h2>Next</h2>${PROSE(2)}</div>`,
    // The root is the body here, and the whole page is one wrapper. Climbing
    // out of it would put the card above the headline.
    before: "p"
  },
  "an article opening on a pull quote": {
    body: `<article><h1>Title</h1><blockquote><p>A standfirst quote that is long enough to be treated as real prose by the parser rather than skipped as a caption.</p></blockquote>${PROSE(1)}</article>`,
    before: "blockquote"
  },
  "an article opening on a figure caption": {
    body: `<article><h1>Title</h1><figure><p>Photo: someone</p></figure>${PROSE(1)}${PROSE(2)}</article>`,
    // The caption is too short to be the first real paragraph.
    before: "p"
  },
  "an article whose first prose is a list": {
    body: `<main><h1>Title</h1><ul><li>A list item that is long enough to count as real prose here rather than being skipped as navigation furniture.</li></ul>${PROSE(1)}</main>`,
    before: "ul"
  },
  "prose with no headings anywhere": {
    body: `<main>${PROSE(1)}${PROSE(2)}</main>`,
    before: "p"
  }
};

describe("the gist card across the shapes articles come in", () => {
  for (const [name, shape] of Object.entries(SHAPES)) {
    test(name, async () => {
      const page = await pageOf(`<!doctype html><html><head><title>T</title></head><body>${shape.body}</body></html>`);
      const before = page.parseDocument(page.document, "https://demo.test/article");

      assert.equal(page.showGist("The gist, in plain words.", { markCount: 2 }), true);
      const card = page.card();

      assert.ok(card, "a card was drawn");
      assert.equal(card.nextElementSibling?.tagName.toLowerCase(), shape.before);

      const h1 = page.document.querySelector("h1");
      if (h1) assert.ok(h1.compareDocumentPosition(card) & 4, "the card never sits above the headline");
      // A card dropped inside a quote or a list item is attributed to the
      // article by anyone reading it.
      assert.equal(card.closest("blockquote, figure, li"), null);
      assert.equal(
        page.parseDocument(page.document, "https://demo.test/article").contentHash,
        before.contentHash
      );
    });
  }

  test("drawing it again does not let it creep down the page", async () => {
    // The mount is recomputed on every pass, and the card is a previous
    // sibling of the paragraph by then. Counting itself would make the climb
    // stop one step earlier each time.
    const page = await pageOf(
      `<!doctype html><html><head><title>T</title></head><body><article><h1>Title</h1><div class="body"><div class="para">${PROSE(1)}</div></div></article></body></html>`
    );
    page.showGist("First.", {});
    const first = page.card().nextElementSibling;
    page.showGist("Second.", {});
    assert.equal(page.card().nextElementSibling, first);
    assert.equal(page.document.querySelectorAll("lp-gist").length, 1);
  });
});
