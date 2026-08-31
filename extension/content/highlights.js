import { findQuote, quoteFromRange, unwrapHighlight, wrapRange } from "../parse/quote.js";

export function restoreHighlights(root, highlights) {
  const restored = [];
  for (const highlight of highlights || []) {
    unwrapHighlight(root, highlight.id);
    const range = findQuote(root, {
      exact: highlight.text,
      prefix: highlight.prefix,
      suffix: highlight.suffix
    });
    if (!range) continue;
    wrapRange(range, highlight);
    restored.push(highlight.id);
  }
  return restored;
}

export function applyRangeHighlight(range, highlight, root = document.body) {
  if (!range || range.collapsed) return [];
  const quote = quoteFromRange(range, root);
  if (!quote) return [];
  Object.assign(highlight, {
    text: quote.exact,
    prefix: quote.prefix,
    suffix: quote.suffix
  });
  unwrapHighlight(root, highlight.id);
  const located = findQuote(root, quote) || range;
  return wrapRange(located, highlight);
}

export function applySelectionHighlight(selection, highlight, root = document.body) {
  if (!selection || selection.rangeCount === 0) return [];
  return applyRangeHighlight(selection.getRangeAt(0), highlight, root);
}

export function marksFor(highlightId) {
  return [...document.querySelectorAll(`mark.lp-hl[data-lp-id="${CSS.escape(highlightId)}"]`)];
}

export function recolorMarks(highlightId, color) {
  marksFor(highlightId).forEach((mark) => {
    mark.dataset.lpColor = color;
  });
}

export function highlightRect(highlightId) {
  const marks = marksFor(highlightId);
  if (!marks.length) return null;
  const rects = marks.map((m) => m.getBoundingClientRect());
  return {
    top: Math.min(...rects.map((r) => r.top)),
    bottom: Math.max(...rects.map((r) => r.bottom)),
    left: Math.min(...rects.map((r) => r.left)),
    right: Math.max(...rects.map((r) => r.right)),
    height: Math.max(...rects.map((r) => r.bottom)) - Math.min(...rects.map((r) => r.top))
  };
}

export function selectionIsSafe(selection, snapshotBlockTexts) {
  if (!selection || selection.isCollapsed) return false;
  const text = selection.toString().trim();
  if (text.length < 2) return false;
  if (!snapshotBlockTexts) return true;
  const hay = snapshotBlockTexts.join("\n");
  return hay.includes(text.slice(0, Math.min(80, text.length)));
}
