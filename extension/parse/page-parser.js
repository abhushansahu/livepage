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
  "[aria-hidden='true']"
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

  const root = pickRoot(source) || source.body || source.documentElement;
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
        heading: /^h[1-4]$/.test(tag)
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

function pickRoot(doc) {
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
