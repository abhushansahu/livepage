import { findQuote, wrapRange, unwrapHighlight, cssEscape } from "../parse/quote.js";

/**
 * Paints an agent's marks on the page, and lets you move between them.
 *
 * These are deliberately not your highlights. They are a suggestion from
 * something that read ahead of you, so they are drawn more quietly and are
 * thrown away wholesale without touching anything you wrote. One becomes
 * yours only when you keep it.
 */
const CLASS = "lp-mark-ai";

export function paintMarks(root, marks, { reveal = false } = {}) {
  const painted = [];
  for (const mark of marks || []) {
    unwrapMark(root, mark.id);
    const range = findQuote(root, {
      exact: mark.text,
      prefix: mark.prefix,
      suffix: mark.suffix
    });
    if (!range) continue;
    const spans = wrapRange(range, { id: mark.id, color: mark.color, threadId: "" });
    if (!spans.length) continue;
    for (const span of spans) {
      span.classList.add(CLASS);
      span.dataset.lpMark = mark.id;
      span.title = mark.why ? `${mark.why} — click to keep` : "Click to keep this highlight";
      if (reveal) {
        // Staggered in document order, so it reads as the page being marked
        // up rather than as one that already was. Only on the pass that
        // painted them — re-anchoring must not replay the whole thing.
        span.classList.add("is-fresh");
        span.style.setProperty("--lp-mark-delay", `${Math.min(painted.length, 11) * 90}ms`);
      }
    }
    painted.push(mark.id);
  }
  return painted;
}

export function unwrapMark(root, markId) {
  unwrapHighlight(root, markId);
}

export function clearMarks(root, marks) {
  for (const mark of marks || []) unwrapMark(root, mark.id);
}

export function markSpans(markId) {
  return [...document.querySelectorAll(`mark[data-lp-mark="${cssEscape(markId)}"]`)];
}

/**
 * The next mark below where you are reading, wrapping to the first.
 *
 * This is the point of the feature: the marks are only worth making if you
 * can move between them without hunting for the colour.
 */
export function nextMark(marks, direction = 1, fromY = window.scrollY) {
  const placed = (marks || [])
    .map((mark) => {
      const span = markSpans(mark.id)[0];
      if (!span) return null;
      return { mark, top: span.getBoundingClientRect().top + window.scrollY };
    })
    .filter(Boolean)
    .sort((a, b) => a.top - b.top);
  if (!placed.length) return null;

  // A little tolerance, so "next" from a mark you are sitting on moves on
  // rather than landing on the same one again.
  const edge = fromY + 8;
  if (direction > 0) return (placed.find((item) => item.top > edge) || placed[0]).mark;
  const before = placed.filter((item) => item.top < fromY - 8);
  return (before.length ? before[before.length - 1] : placed[placed.length - 1]).mark;
}

export function scrollToMark(markId) {
  const span = markSpans(markId)[0];
  if (!span) return false;
  window.scrollTo({ top: span.getBoundingClientRect().top + window.scrollY - 120, behavior: "smooth" });
  return true;
}
