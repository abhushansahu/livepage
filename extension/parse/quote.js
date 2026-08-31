import { normalizeText } from "./page-parser.js";

const SKIP = "script,style,noscript,textarea,input,lp-root,.lp-ignore";

export function quoteFromRange(range, root = document.body) {
  if (!range || range.collapsed) return null;
  const map = flattenText(root);
  const start = flatOffsetFromPoint(map, range.startContainer, range.startOffset, "start");
  const end = flatOffsetFromPoint(map, range.endContainer, range.endOffset, "end");
  let exact = "";
  if (start != null && end != null && end > start) {
    exact = map.text.slice(start, end).trim();
  }
  if (!exact) exact = normalizeText(range.toString());
  if (!exact) return null;
  const index = start != null && end > start ? start : map.text.indexOf(exact);
  const before =
    index >= 0 ? map.text.slice(Math.max(0, index - 48), index) : textBefore(range, root, 48);
  const after =
    index >= 0
      ? map.text.slice(index + exact.length, index + exact.length + 48)
      : textAfter(range, root, 48);
  return {
    exact,
    prefix: before.slice(-32),
    suffix: after.slice(0, 32)
  };
}

export function locateQuote(hay, selector) {
  const exact = normalizeText(selector?.exact || "");
  if (!exact || !hay) return null;
  const prefix = normalizeText(selector.prefix || "");
  const suffix = normalizeText(selector.suffix || "");
  const hits = [];
  let from = 0;
  while (from <= hay.length) {
    const index = hay.indexOf(exact, from);
    if (index === -1) break;
    hits.push(index);
    from = index + 1;
  }
  if (hits.length) return pickBest(hay, hits, exact.length, prefix, suffix);

  for (let trim = 1; trim <= Math.min(4, Math.floor(exact.length / 5)); trim += 1) {
    const inner = exact.slice(trim, exact.length - trim);
    if (inner.length < 8) break;
    const index = hay.indexOf(inner);
    if (index >= 0) {
      return pickBest(hay, [index], inner.length, prefix, suffix);
    }
  }

  if (prefix.length >= 8 && suffix.length >= 8) {
    const p = hay.indexOf(prefix);
    if (p >= 0) {
      const s = hay.indexOf(suffix, p + prefix.length);
      if (s > p) return { start: p + prefix.length, end: s };
    }
  }

  if (exact.length >= 12 && exact.length <= 240) {
    return fuzzyWindow(hay, exact, prefix, suffix);
  }
  return null;
}

export function findQuote(root, selector) {
  if (!selector?.exact) return null;
  const map = flattenText(root);
  const found = locateQuote(map.text, selector);
  if (!found) return null;
  return rangeFromOffsets(map, found.start, found.end);
}

export function wrapRange(range, highlight) {
  if (!range || range.collapsed) return [];
  const marks = [];
  const points = splitBoundaries(range);
  const ancestor =
    range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
  if (!ancestor) return [];
  const walker = document.createTreeWalker(ancestor, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.textContent) return NodeFilter.FILTER_REJECT;
      if (node.parentElement?.closest(SKIP)) return NodeFilter.FILTER_REJECT;
      if (node.parentElement?.closest("mark.lp-hl")) return NodeFilter.FILTER_REJECT;
      if (!rangeIntersectsNode(range, node)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });

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
  const spans = [];
  let rawCombined = "";
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.textContent) return NodeFilter.FILTER_REJECT;
      if (node.parentElement?.closest(SKIP)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  let node = walker.nextNode();
  while (node) {
    const raw = node.textContent;
    spans.push({ node, rawStart: rawCombined.length, rawEnd: rawCombined.length + raw.length });
    rawCombined += raw;
    node = walker.nextNode();
  }
  const { text, rawAtFlat } = collapseMap(rawCombined);
  return { spans, text, rawAtFlat };
}

export function collapseMap(raw) {
  const textChars = [];
  const rawAtFlat = [];
  let pendingSpace = false;
  let sawContent = false;
  for (let i = 0; i < raw.length; i += 1) {
    if (/\s/.test(raw[i])) {
      if (sawContent) pendingSpace = true;
      continue;
    }
    if (pendingSpace) {
      textChars.push(" ");
      rawAtFlat.push(i);
      pendingSpace = false;
    }
    textChars.push(raw[i]);
    rawAtFlat.push(i);
    sawContent = true;
  }
  return { text: textChars.join(""), rawAtFlat };
}

function flatOffsetFromPoint(map, container, offset, edge) {
  const point = resolveToText(container, offset, edge);
  if (!point) return edge === "end" ? map.text.length : 0;
  const span = map.spans.find((s) => s.node === point.node);
  if (!span) return null;
  const raw = span.rawStart + clamp(point.offset, 0, point.node.textContent.length);
  if (!map.rawAtFlat.length) return 0;
  if (edge === "end") {
    let last = 0;
    for (let i = 0; i < map.rawAtFlat.length; i += 1) {
      if (map.rawAtFlat[i] < raw) last = i + 1;
      else break;
    }
    return last;
  }
  for (let i = 0; i < map.rawAtFlat.length; i += 1) {
    if (map.rawAtFlat[i] >= raw) return i;
  }
  return map.text.length;
}

function rangeFromOffsets(map, start, end) {
  const range = document.createRange();
  const startPoint = pointFromFlat(map, start, "start");
  const endPoint = pointFromFlat(map, Math.max(start, end), "end");
  if (!startPoint || !endPoint) return null;
  try {
    range.setStart(startPoint.node, startPoint.offset);
    range.setEnd(endPoint.node, endPoint.offset);
  } catch {
    return null;
  }
  return range.collapsed ? null : range;
}

function pointFromFlat(map, flatIndex, edge) {
  if (!map.spans.length) return null;
  const idx = clamp(flatIndex, 0, Math.max(0, map.rawAtFlat.length - (edge === "end" ? 0 : 1)));
  const raw =
    edge === "end" && flatIndex >= map.rawAtFlat.length
      ? map.spans[map.spans.length - 1].rawEnd
      : map.rawAtFlat[Math.min(idx, map.rawAtFlat.length - 1)];
  const target = edge === "end" ? raw : raw;
  const span =
    map.spans.find((s) => target >= s.rawStart && target < s.rawEnd) ||
    (edge === "end" ? map.spans[map.spans.length - 1] : map.spans[0]);
  return { node: span.node, offset: clamp(target - span.rawStart, 0, span.node.textContent.length) };
}

function resolveToText(container, offset, edge) {
  if (!container) return null;
  if (container.nodeType === Node.TEXT_NODE) {
    return { node: container, offset };
  }
  const kids = container.childNodes;
  if (edge === "end") {
    if (offset <= 0) return firstTextPoint(container);
    const child = kids[Math.min(offset, kids.length) - 1];
    return lastTextPoint(child || container);
  }
  if (offset >= kids.length) return lastTextPoint(container);
  const child = kids[offset];
  return child ? firstTextPoint(child) : firstTextPoint(container);
}

function pickBest(hay, hits, length, prefix, suffix) {
  let best = hits[0];
  let bestScore = -1;
  for (const index of hits) {
    const pre = hay.slice(Math.max(0, index - 32), index);
    const suf = hay.slice(index + length, index + length + 32);
    let score = 0;
    if (prefix && pre.endsWith(prefix)) score += 3;
    else if (prefix && pre.includes(prefix.slice(-12))) score += 1;
    if (suffix && suf.startsWith(suffix)) score += 3;
    else if (suffix && suf.includes(suffix.slice(0, 12))) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = index;
    }
  }
  return { start: best, end: best + length };
}

function fuzzyWindow(hay, exact, prefix, suffix) {
  const maxDist = Math.max(2, Math.floor(exact.length * 0.1));
  let best = null;
  let bestScore = maxDist + 1;
  const step = exact.length > 80 ? 3 : 1;
  for (let i = 0; i <= hay.length - exact.length; i += step) {
    const slice = hay.slice(i, i + exact.length);
    const dist = levenshtein(slice, exact, maxDist);
    if (dist > maxDist) continue;
    let score = dist;
    if (prefix && hay.slice(Math.max(0, i - 32), i).endsWith(prefix)) score -= 0.5;
    if (suffix && hay.slice(i + exact.length, i + exact.length + 32).startsWith(suffix)) score -= 0.5;
    if (score < bestScore) {
      bestScore = score;
      best = { start: i, end: i + exact.length };
    }
  }
  return best;
}

function levenshtein(a, b, max) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > max) return max + 1;
  let prev = new Array(n + 1);
  let next = new Array(n + 1);
  for (let j = 0; j <= n; j += 1) prev[j] = j;
  for (let i = 1; i <= m; i += 1) {
    next[0] = i;
    let rowMin = next[0];
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      next[j] = Math.min(prev[j] + 1, next[j - 1] + 1, prev[j - 1] + cost);
      if (next[j] < rowMin) rowMin = next[j];
    }
    if (rowMin > max) return max + 1;
    [prev, next] = [next, prev];
  }
  return prev[n];
}

function splitBoundaries(range) {
  const start = resolveToText(range.startContainer, range.startOffset, "start") || {
    node: range.startContainer,
    offset: range.startOffset
  };
  const end = resolveToText(range.endContainer, range.endOffset, "end") || {
    node: range.endContainer,
    offset: range.endOffset
  };
  return { start, end };
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

function firstTextPoint(node) {
  if (!node) return null;
  if (node.nodeType === Node.TEXT_NODE) return { node, offset: 0 };
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  const found = walker.nextNode();
  return found ? { node: found, offset: 0 } : null;
}

function lastTextPoint(node) {
  if (!node) return null;
  if (node.nodeType === Node.TEXT_NODE) return { node, offset: node.textContent.length };
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  let last = null;
  let current = walker.nextNode();
  while (current) {
    last = current;
    current = walker.nextNode();
  }
  return last ? { node: last, offset: last.textContent.length } : null;
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

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function cssEscape(value) {
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(value);
  return String(value).replace(/"/g, '\\"');
}
