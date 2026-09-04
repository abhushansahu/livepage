import {
  cssEscape,
  findQuote,
  locateAllInDom,
  quoteFromRange,
  unwrapHighlight,
  wrapRange
} from "../parse/quote.js";
import { colorOf } from "../shared/colors.js";
import { stateForConfidence } from "../shared/anchors.js";

/**
 * Puts marks back on the page for every highlight whose quote can still be
 * found, and says what happened to the ones that could not.
 *
 * Returns a Map of highlight id to { state, rung, confidence }: "found" is on
 * the page, "moved" matched loosely enough that the reader should confirm it,
 * "missing" is not here at all. Nothing is dropped silently — a highlight is
 * where a conversation is anchored, so losing one without saying so loses the
 * thread with it.
 *
 * `verdicts` carries the previous pass's answers. A highlight that is already
 * marked and was already found is left completely alone: re-wrapping it would
 * destroy and rebuild its marks, dropping the active state and any selection
 * inside them, for no gain.
 */
export function anchorHighlights(root, highlights, { verdicts } = {}) {
  const list = highlights || [];
  const results = new Map();
  const pending = [];
  for (const highlight of list) {
    const settled = verdicts?.get(highlight.id);
    if (settled?.state === "found" && marksFor(highlight.id).length) {
      results.set(highlight.id, settled);
      continue;
    }
    pending.push(highlight);
  }
  if (!pending.length) return results;

  // One flatten for the whole pass. flattenText walks every text node, and the
  // retry loop runs this often enough that per-highlight flattening would cost
  // the document several times over on every attempt.
  const located = locateAllInDom(
    root,
    pending.map((highlight) => ({
      exact: highlight.text,
      prefix: highlight.prefix,
      suffix: highlight.suffix
    }))
  );

  pending.forEach((highlight, index) => {
    unwrapHighlight(root, highlight.id);
    const match = located.get(index);
    if (!match) {
      results.set(highlight.id, { state: "missing", rung: 0, confidence: null });
      return;
    }
    const marks = wrapRange(match.range, highlight);
    // A span already covered by another highlight's mark yields nothing to
    // wrap. That is unresolved, not found.
    if (!marks.length) {
      results.set(highlight.id, { state: "missing", rung: match.rung, confidence: null });
      return;
    }
    const state = stateForConfidence(match.confidence);
    describeMarks(highlight, marks, match.confidence);
    results.set(highlight.id, { state, rung: match.rung, confidence: match.confidence });
  });
  return results;
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
  const marks = wrapRange(located, highlight);
  describeMarks(highlight, marks);
  return marks;
}

export function applySelectionHighlight(selection, highlight, root = document.body) {
  if (!selection || selection.rangeCount === 0) return [];
  return applyRangeHighlight(selection.getRangeAt(0), highlight, root);
}

export function marksFor(highlightId) {
  return [...document.querySelectorAll(`mark.lp-hl[data-lp-id="${cssEscape(highlightId)}"]`)];
}

export function recolorMarks(highlightId, color) {
  marksFor(highlightId).forEach((mark) => {
    mark.dataset.lpColor = color;
    mark.title = colorHint(color);
  });
}

function describeMarks(highlight, marks = marksFor(highlight.id), confidence = "exact") {
  const unsure = confidence === "loose";
  for (const mark of marks) {
    mark.title = unsure
      ? `${colorHint(highlight.color)} — the page changed; check this is the right passage`
      : colorHint(highlight.color);
    mark.classList.toggle("is-unsure", unsure);
  }
}

function colorHint(color) {
  const meta = colorOf(color);
  return `${meta.name} — ${meta.purpose}`;
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
