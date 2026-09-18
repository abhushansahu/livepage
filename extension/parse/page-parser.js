import { blockIdFromText } from "../shared/id.js";

const STRIP_SELECTORS = [
  "script",
  "style",
  "noscript",
  "svg",
  "canvas",
  "iframe",
  "nav",
  "footer",
  "header",
  "form",
  "aside",
  "[role='navigation']",
  "[role='banner']",
  "[role='contentinfo']",
  "[role='complementary']",
  "[aria-hidden='true']",
  // LivePage's own furniture. The gist card is real text sitting in the
  // article, so a parse that counted it would change the content hash the
  // moment it was drawn — and the hash is what says an article has already
  // been read. The page would then re-read itself forever, once per card.
  ".lp-ignore"
].join(",");

const CONTENT_SELECTORS = [
  "article",
  "main",
  "[role='main']",
  ".post-content",
  ".entry-content",
  ".article-body",
  "#content",
  ".markdown-body"
];

export function parseDocument(doc, url = "") {
  const source = doc.cloneNode(true);
  source.querySelectorAll(STRIP_SELECTORS).forEach((el) => el.remove());

  const root = pickContentRoot(source) || source.body || source.documentElement;
  const blocks = [];
  const headings = [];
  const seen = new Set();

  const walker = source.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      const tag = node.tagName.toLowerCase();
      if (!["p", "li", "h1", "h2", "h3", "h4", "blockquote", "pre", "td"].includes(tag)) {
        return NodeFilter.FILTER_SKIP;
      }
      const text = normalizeText(node.textContent);
      if (text.length < 24 && !/^h[1-4]$/.test(tag)) return NodeFilter.FILTER_SKIP;
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  let node = walker.nextNode();
  while (node) {
    const text = normalizeText(node.textContent);
    const id = blockIdFromText(text);
    if (!seen.has(id)) {
      seen.add(id);
      const tag = node.tagName.toLowerCase();
      blocks.push({
        id,
        tag,
        text,
        heading: /^h[1-4]$/.test(tag),
        links: linksIn(node, url)
      });
      if (/^h[1-4]$/.test(tag)) headings.push(text);
    }
    node = walker.nextNode();
  }

  const excerpt = blocks
    .filter((b) => !b.heading)
    .slice(0, 3)
    .map((b) => b.text)
    .join(" ")
    .slice(0, 420);

  const allText = blocks.map((b) => b.text).join(" ");
  const wordCount = allText ? allText.split(/\s+/).length : 0;

  return {
    url,
    title: (doc.querySelector("title")?.textContent || "").trim(),
    excerpt,
    headings,
    wordCount,
    contentHash: blockIdFromText(allText),
    blocks
  };
}

const MAX_LINKS_PER_BLOCK = 4;

/**
 * The links a paragraph carries, kept rather than flattened away.
 *
 * `textContent` is what every other field here is made of, and it destroys
 * every href on the page. That is fine for anchoring a highlight and wrong for
 * an agent: an article that says "the upstream fix" with a link to it becomes
 * an article that alludes to a source nobody can reach. The words survive and
 * the address does not, so the one question a reader actually asks — where
 * does this number come from — has no answer left in the packet.
 */
function linksIn(node, pageUrl) {
  const links = [];
  const seen = new Set();
  for (const anchor of node.querySelectorAll("a[href]")) {
    const href = absoluteUrl(anchor.getAttribute("href"), pageUrl);
    const text = normalizeText(anchor.textContent);
    if (!href || !text || seen.has(href)) continue;
    seen.add(href);
    links.push({ text, href });
    if (links.length >= MAX_LINKS_PER_BLOCK) break;
  }
  return links;
}

/**
 * A page-relative href as somewhere you could actually go, or "" if it is not
 * a place — `mailto:`, `javascript:` and a bare `#section` are not sources.
 */
export function absoluteUrl(href, base = "") {
  if (!href) return "";
  try {
    const url = base ? new URL(href, base) : new URL(href);
    return /^https?:$/.test(url.protocol) ? url.toString() : "";
  } catch {
    return "";
  }
}

/**
 * The element the article actually lives in, or the body when a page offers
 * nothing better.
 *
 * Exported because the content script has to find the same element in the
 * live document — the gist card belongs at the top of the article, and two
 * different ideas of where an article starts would put it somewhere else.
 */
export function pickContentRoot(doc) {
  for (const selector of CONTENT_SELECTORS) {
    const el = doc.querySelector(selector);
    if (el && normalizeText(el.textContent).length > 200) return el;
  }
  return doc.body;
}

export function normalizeText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

export function uniqueBlocks(blocks, alreadySentIds) {
  const sent = new Set(alreadySentIds || []);
  return (blocks || []).filter((block) => !sent.has(block.id));
}
