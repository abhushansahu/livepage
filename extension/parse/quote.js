import { normalizeText } from "./page-parser.js";

const SKIP = "script,style,noscript,textarea,input,lp-root,.lp-ignore";

export function quoteFromRange(range, root = document.body) {
  const exact = normalizeText(range.toString());
  if (!exact) return null;
  const before = textBefore(range, root, 48);
  const after = textAfter(range, root, 48);
  return {
    exact,
    prefix: before.slice(-32),
    suffix: after.slice(0, 32)
  };
}

export function findQuote(root, selector) {
  if (!selector?.exact) return null;
  const map = flattenText(root);
  if (!map.text.includes(selector.exact)) return null;

  const candidates = [];
  let from = 0;
  while (from <= map.text.length) {
    const index = map.text.indexOf(selector.exact, from);
    if (index === -1) break;
    candidates.push(index);
    from = index + 1;
  }
  if (!candidates.length) return null;

  let best = candidates[0];
  let bestScore = -1;
  for (const index of candidates) {
    const prefix = map.text.slice(Math.max(0, index - 32), index);
    const suffix = map.text.slice(
      index + selector.exact.length,
      index + selector.exact.length + 32
    );
    let score = 0;
    if (selector.prefix && prefix.endsWith(selector.prefix)) score += 2;
    else if (selector.prefix && prefix.includes(selector.prefix.slice(-12))) score += 1;
    if (selector.suffix && suffix.startsWith(selector.suffix)) score += 2;
    else if (selector.suffix && suffix.includes(selector.suffix.slice(0, 12))) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = index;
    }
  }
  return rangeFromOffsets(map, best, best + selector.exact.length);
}

export function wrapRange(range, highlight) {
  if (!range || range.collapsed) return [];
  const marks = [];
  const points = splitBoundaries(range);
  const walker = document.createTreeWalker(
    range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        if (!node.textContent) return NodeFilter.FILTER_REJECT;
        if (node.parentElement?.closest(SKIP)) return NodeFilter.FILTER_REJECT;
        if (node.parentElement?.closest("mark.lp-hl")) return NodeFilter.FILTER_REJECT;
        if (!rangeIntersectsNode(range, node)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );

  const nodes = [];
  let current = walker.nextNode();
  while (current) {
    nodes.push(current);
    current = walker.nextNode();
  }

  for (const textNode of nodes) {
    let start = 0;
    let end = textNode.textContent.length;
    if (textNode === points.start.node) start = points.start.offset;
    if (textNode === points.end.node) end = points.end.offset;
    if (start >= end) continue;
    const middle = splitTextRange(textNode, start, end);
    const mark = document.createElement("mark");
    mark.className = "lp-hl";
    mark.dataset.lpId = highlight.id;
    mark.dataset.lpColor = highlight.color;
    mark.dataset.lpThread = highlight.threadId || "";
    middle.parentNode.insertBefore(mark, middle);
    mark.appendChild(middle);
    marks.push(mark);
  }
  return marks;
}

export function unwrapHighlight(root, highlightId) {
  root.querySelectorAll(`mark.lp-hl[data-lp-id="${cssEscape(highlightId)}"]`).forEach((mark) => {
    const parent = mark.parentNode;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize();
  });
}

function flattenText(root) {
  const pieces = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.textContent) return NodeFilter.FILTER_REJECT;
      if (node.parentElement?.closest(SKIP)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  let node = walker.nextNode();
  let offset = 0;
  while (node) {
    const text = node.textContent.replace(/\s+/g, " ");
    pieces.push({ node, start: offset, end: offset + text.length, text });
    offset += text.length;
    node = walker.nextNode();
  }
  return { pieces, text: pieces.map((p) => p.text).join("") };
}

function rangeFromOffsets(map, start, end) {
  const range = document.createRange();
  const startPoint = pointFromOffset(map, start);
  const endPoint = pointFromOffset(map, end);
  if (!startPoint || !endPoint) return null;
  range.setStart(startPoint.node, startPoint.offset);
  range.setEnd(endPoint.node, endPoint.offset);
  return range;
}

function pointFromOffset(map, offset) {
  for (const piece of map.pieces) {
    if (offset <= piece.end) {
      const local = Math.max(0, offset - piece.start);
      return { node: piece.node, offset: Math.min(local, piece.node.textContent.length) };
    }
  }
  const last = map.pieces[map.pieces.length - 1];
  return last ? { node: last.node, offset: last.node.textContent.length } : null;
}

function textBefore(range, root, limit) {
  const pre = document.createRange();
  pre.selectNodeContents(root);
  pre.setEnd(range.startContainer, range.startOffset);
  return normalizeText(pre.toString()).slice(-limit);
}

function textAfter(range, root, limit) {
  const post = document.createRange();
  post.selectNodeContents(root);
  post.setStart(range.endContainer, range.endOffset);
  return normalizeText(post.toString()).slice(0, limit);
}

function splitBoundaries(range) {
  let startNode = range.startContainer;
  let startOffset = range.startOffset;
  let endNode = range.endContainer;
  let endOffset = range.endOffset;
  if (startNode.nodeType !== Node.TEXT_NODE) {
    const found = firstText(startNode);
    if (found) {
      startNode = found;
      startOffset = 0;
    }
  }
  if (endNode.nodeType !== Node.TEXT_NODE) {
    const found = lastText(endNode);
    if (found) {
      endNode = found;
      endOffset = found.textContent.length;
    }
  }
  return {
    start: { node: startNode, offset: startOffset },
    end: { node: endNode, offset: endOffset }
  };
}

function splitTextRange(textNode, start, end) {
  let node = textNode;
  if (end < node.textContent.length) node.splitText(end);
  if (start > 0) node = node.splitText(start);
  return node;
}

function rangeIntersectsNode(range, node) {
  const probe = document.createRange();
  probe.selectNodeContents(node);
  return (
    range.compareBoundaryPoints(Range.END_TO_START, probe) < 0 &&
    range.compareBoundaryPoints(Range.START_TO_END, probe) > 0
  );
}

function firstText(node) {
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  return walker.nextNode();
}

function lastText(node) {
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  let last = null;
  let current = walker.nextNode();
  while (current) {
    last = current;
    current = walker.nextNode();
  }
  return last;
}

function cssEscape(value) {
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(value);
  return String(value).replace(/"/g, '\\"');
}
