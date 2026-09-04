import { blockIdFromText } from "../shared/id.js";
import { normalizeText } from "../parse/page-parser.js";

/**
 * Turning a PDF's text layer into the same blocks an article gives us.
 *
 * `parseDocument` returns `{url, title, excerpt, headings, wordCount,
 * contentHash, blocks}` and half the product reads that shape — the agent
 * packet, the vault export, the anchor recovery, `mergeParsed`. So this
 * returns exactly that shape and nothing here needs to know a PDF was
 * involved. Blocks carry one extra field, `page`, which the exporter uses and
 * everything else ignores.
 *
 * A PDF has no paragraphs. It has glyphs at coordinates, and pdf.js hands them
 * back as runs with a transform each. Recovering paragraphs from that is
 * heuristic by nature, so the rules below are the conservative ones: when a
 * signal is ambiguous we keep text together, because an over-joined paragraph
 * still reads and still anchors, while an over-split one turns one quote into
 * three blocks that no highlight spans.
 */

/** Below this a run of text is furniture — a page number, a running header. */
const MIN_BLOCK = 24;

/** A heading is set larger than the body, by at least this much. */
const HEADING_RATIO = 1.16;
const BIG_HEADING_RATIO = 1.5;

/**
 * Groups a page's text items into lines.
 *
 * pdf.js emits items in content-stream order, which is reading order for
 * almost every real document. We never re-sort by coordinate: doing so would
 * interleave the columns of a two-column paper into nonsense. Instead a line
 * ends when the item before it said so (`hasEOL`) or when the baseline moves.
 */
export function linesFromItems(items = []) {
  const lines = [];
  let current = null;
  let breakBefore = false;

  for (const item of items) {
    if (!item) continue;
    const str = String(item.str ?? "");
    // A zero-width item still carries the line break that follows it.
    if (!str) {
      if (item.hasEOL) breakBefore = true;
      continue;
    }
    const transform = item.transform || [0, 0, 0, 0, 0, 0];
    const x = Number(transform[4]) || 0;
    const y = Number(transform[5]) || 0;
    const size = Math.abs(Number(transform[0]) || Number(item.height) || 10) || 10;
    const width = Number(item.width) || 0;

    const moved = current && Math.abs(current.y - y) > Math.max(1, current.size * 0.4);
    if (!current || breakBefore || moved) {
      current = { text: str, y, size, left: x, right: x + width };
      lines.push(current);
    } else {
      current.text += joiner(current, x) + str;
      current.size = Math.max(current.size, size);
      current.left = Math.min(current.left, x);
      current.right = Math.max(current.right, x + width);
    }
    breakBefore = Boolean(item.hasEOL);
  }

  return lines
    .map((line) => ({ ...line, text: normalizeText(line.text) }))
    .filter((line) => line.text);
}

/**
 * Whether two runs on the same baseline need a space between them.
 *
 * pdf.js splits a line wherever the content stream did, which is often
 * mid-word for kerned text. Inserting a space on every split would shatter
 * words; inserting none would weld the last word of one run to the first of
 * the next. The gap on the page is the only evidence, so use it.
 */
function joiner(line, nextX) {
  if (/\s$/.test(line.text)) return "";
  const gap = nextX - line.right;
  return gap > line.size * 0.22 ? " " : "";
}

/**
 * Joins a page's lines into paragraphs.
 *
 * `bodySize` and `bodyRight` are document-wide, not per-page: a section that
 * happens to be all headings would otherwise decide it was the body text, and
 * the last page of a paper is often half-empty and would read as one long
 * ragged paragraph.
 */
export function paragraphsFromLines(lines = [], { bodySize = 10, bodyRight = 0 } = {}) {
  const paragraphs = [];
  let current = null;

  for (const line of lines) {
    if (!current) {
      current = startParagraph(line);
      paragraphs.push(current);
      continue;
    }
    if (breaksParagraph(current, line, { bodyRight })) {
      current = startParagraph(line);
      paragraphs.push(current);
      continue;
    }
    current.text = join(current.text, line.text);
    current.size = Math.max(current.size, line.size);
    current.lines += 1;
    current.lastY = line.y;
    current.lastRight = line.right;
    current.left = Math.min(current.left, line.left);
  }

  return paragraphs.map((p) => ({
    text: p.text,
    size: p.size,
    lines: p.lines,
    heading: isHeading(p, bodySize)
  }));
}

function startParagraph(line) {
  return {
    text: line.text,
    size: line.size,
    lines: 1,
    left: line.left,
    lastY: line.y,
    lastRight: line.right
  };
}

function breaksParagraph(paragraph, line, { bodyRight }) {
  // A change of type size is a change of role — body to heading, heading to
  // body, body to footnote. Never run those together.
  if (ratio(paragraph.size, line.size) > 1.12) return true;

  // PDF coordinates put the origin at the bottom, so a following line has a
  // smaller y. A gap much larger than the leading is a new paragraph; a
  // negative gap means we moved back up the page, into another column.
  const gap = paragraph.lastY - line.y;
  if (gap < 0) return true;
  if (gap > paragraph.size * 1.8) return true;

  // A line that stops well short of the right margin ended its paragraph —
  // this is what actually separates paragraphs in justified text, where the
  // vertical gap between paragraphs and between lines is identical.
  if (bodyRight && paragraph.lastRight < bodyRight - paragraph.size * 2.2) return true;

  // A first-line indent, the other convention for the same thing.
  if (line.left > paragraph.left + paragraph.size * 0.8) return true;

  return false;
}

/**
 * Joins two lines of one paragraph.
 *
 * A line ending in a hyphen is a word the typesetter broke, so the two halves
 * are welded with no space either way — "informa- tion" matches no quote and
 * no search. Whether the hyphen itself survives is the only question, and the
 * capital is the evidence: "informa-/tion" is one word, "English-/German" is a
 * real compound that happened to land on the break.
 */
function join(before, after) {
  if (!/[‐-]$/.test(before)) return `${before} ${after}`;
  return /^[a-z]/.test(after) ? before.replace(/[‐-]$/, "") + after : before + after;
}

function isHeading(paragraph, bodySize) {
  if (paragraph.lines > 2) return false;
  if (paragraph.text.length > 120) return false;
  if (paragraph.size >= bodySize * HEADING_RATIO) return true;
  // Numbered section headings are often set at body size and only bolded,
  // which the text layer does not report. The shape of the line is the clue.
  return paragraph.lines === 1 && /^(?:\d+(?:\.\d+)*\.?)\s+\S/.test(paragraph.text) && paragraph.text.length < 80;
}

function tagFor(paragraph, bodySize) {
  if (!paragraph.heading) return "p";
  return paragraph.size >= bodySize * BIG_HEADING_RATIO ? "h2" : "h3";
}

/**
 * The size and right margin most of the document's text uses.
 *
 * The median, not the mean: one full-page table of tiny type would drag a mean
 * far enough that every body paragraph read as a heading.
 */
export function documentMetrics(pages = []) {
  const sizes = [];
  const rights = [];
  for (const page of pages) {
    for (const line of page.lines || []) {
      // Weight by line length so a page of one-word captions does not
      // outvote a page of prose.
      const weight = Math.max(1, Math.round(line.text.length / 20));
      for (let i = 0; i < weight; i += 1) sizes.push(line.size);
      rights.push(line.right);
    }
  }
  return {
    bodySize: median(sizes) || 10,
    // The 85th percentile, not the max: a stray wide element (a rule, a
    // full-bleed figure caption) sets a right margin no paragraph reaches,
    // and then every line looks short and every line becomes a paragraph.
    bodyRight: percentile(rights, 0.85) || 0
  };
}

/**
 * Blocks for one page, in the shape `parseDocument` produces.
 *
 * Exported on its own because the viewer parses lazily — the first pages when
 * the document opens, the rest as they render — and each batch has to arrive
 * as blocks that `mergeParsed` can union into what is already stored.
 */
export function blocksFromItems(items, { page = 1, bodySize = 10, bodyRight = 0 } = {}) {
  const lines = linesFromItems(items);
  return blocksFromParagraphs(paragraphsFromLines(lines, { bodySize, bodyRight }), { page, bodySize });
}

function blocksFromParagraphs(paragraphs, { page, bodySize }) {
  const blocks = [];
  for (const paragraph of paragraphs) {
    const text = normalizeText(paragraph.text);
    // Same rule the article parser uses: short runs that are not headings are
    // page furniture, and a document's worth of them buries the real text.
    if (!text || (text.length < MIN_BLOCK && !paragraph.heading)) continue;
    blocks.push({
      id: blockIdFromText(text),
      tag: tagFor(paragraph, bodySize),
      text,
      heading: paragraph.heading,
      page
    });
  }
  return blocks;
}

/**
 * A whole PDF, parsed.
 *
 * Takes text content that has already been extracted, so this stays pure and
 * testable — the viewer does the awaiting and hands the items over.
 * `pages` is `[{ page: 1, items: [...] }, ...]`.
 */
export function parsePdfDocument({ title = "", url = "", pages = [] } = {}) {
  // A page may arrive as raw items or as lines already grouped. The viewer
  // re-parses the whole document every time another batch of pages finishes
  // extracting, and re-grouping every earlier page's items each time would
  // make that quadratic on a long book.
  const perPage = pages.map((entry) => ({
    page: entry.page,
    lines: entry.lines || linesFromItems(entry.items)
  }));
  const metrics = documentMetrics(perPage);

  const blocks = [];
  const headings = [];
  const seen = new Set();

  for (const entry of perPage) {
    const paragraphs = paragraphsFromLines(entry.lines, metrics);
    for (const block of blocksFromParagraphs(paragraphs, {
      page: entry.page,
      bodySize: metrics.bodySize
    })) {
      // Running headers and footers repeat verbatim on every page. Deduping
      // by id drops them for free, which is the same thing the article parser
      // does with a repeated nav.
      if (seen.has(block.id)) continue;
      seen.add(block.id);
      blocks.push(block);
      if (block.heading) headings.push(block.text);
    }
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
    title: normalizeText(title),
    excerpt,
    headings,
    wordCount,
    contentHash: blockIdFromText(allText),
    blocks
  };
}

/**
 * A scanned PDF is a stack of photographs. There is no text layer to select,
 * quote or send to an agent, and saying so is better than presenting an empty
 * margin as though the reader had not tried.
 */
export function hasUsableText(parsed) {
  return (parsed?.wordCount || 0) >= 40;
}

/** A readable title for a PDF that carries no metadata title. */
export function titleFromUrl(url) {
  try {
    const path = new URL(url).pathname;
    const file = decodeURIComponent(path.split("/").filter(Boolean).pop() || "");
    const stem = file.replace(/\.pdf$/i, "").replace(/[_+]+/g, " ").trim();
    return stem || "PDF";
  } catch {
    return "PDF";
  }
}

function ratio(a, b) {
  const big = Math.max(a, b);
  const small = Math.min(a, b);
  return small > 0 ? big / small : 1;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}
