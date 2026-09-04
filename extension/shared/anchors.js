/**
 * What a highlight's anchor is doing, derived from records alone.
 *
 * A highlight is a text quote, and the page underneath it can be rewritten at
 * any time. When the quote no longer matches, the mark disappears — and takes
 * a margin thread with it. These helpers are how the rest of the app talks
 * about that without a live page: the content script writes a verdict, and the
 * dashboard reads it back long after the tab is gone.
 */

export function normalizeLoose(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * The stored blocks around a passage. mergeParsed unions blocks and never
 * deletes, so parsed.blocks is an archive of every version of the page we ever
 * saw — usually still holding a quote the live page has dropped.
 */
export function blocksAround(page, text, windowSize = 2) {
  const blocks = page?.parsed?.blocks || [];
  if (!blocks.length) return [];
  const needle = normalizeLoose(text);
  if (!needle) return [];
  const index = blocks.findIndex((block) =>
    normalizeLoose(block.text).includes(needle.slice(0, 80))
  );
  if (index < 0) return [];
  return blocks.slice(Math.max(0, index - windowSize), index + windowSize + 1);
}

export function seenInParse(page, text) {
  return blocksAround(page, text, 0).length > 0;
}

/**
 * A verdict is about this page instance, not the record: logged out, behind a
 * paywall, or mid-hydration all read as "missing" while the quote is fine. So
 * one bad load never condemns a highlight — the dashboard waits for a second.
 */
export const LOST_AFTER_MISSES = 2;

/**
 * Highlights whose anchor wants attention, newest doubt first.
 *
 * Two signals, answering different questions, deliberately kept apart:
 * a recorded verdict knows whether the live page had the quote last time we
 * looked, and the stored parse only knows whether we ever saw the text at all.
 * The second is weaker, and is labelled as such rather than blended in.
 */
export function anchorItems(pages) {
  const items = [];
  for (const page of pages || []) {
    const threads = page.threads || [];
    for (const highlight of page.highlights || []) {
      const item = anchorItem(page, highlight, threads);
      if (item) items.push(item);
    }
  }
  items.sort((a, b) => (b.since || 0) - (a.since || 0));
  return items;
}

function anchorItem(page, highlight, threads) {
  const thread = threadFor(threads, highlight.id);
  const anchor = highlight.anchor;
  const base = { page, highlight, thread };

  if (anchor?.state === "missing") {
    if ((anchor.missStreak || 0) < LOST_AFTER_MISSES) return null;
    return {
      ...base,
      state: "missing",
      label: "Lost its place",
      missStreak: anchor.missStreak || 0,
      since: anchor.at || highlight.createdAt || 0,
      weak: false
    };
  }

  if (anchor?.state === "moved") {
    return {
      ...base,
      state: "moved",
      label: "Moved — worth a look",
      missStreak: 0,
      since: anchor.at || highlight.createdAt || 0,
      weak: false
    };
  }

  // No verdict at all: either this highlight predates anchor tracking, or it
  // was made somewhere we never parsed. Only worth mentioning when the saved
  // text has no memory of it either.
  if (!anchor && !seenInParse(page, highlight.text)) {
    return {
      ...base,
      state: "unknown",
      label: "Never seen in the saved text",
      missStreak: 0,
      since: highlight.createdAt || 0,
      weak: true
    };
  }

  return null;
}

function threadFor(threads, highlightId) {
  const mine = threads.filter((thread) => thread.highlightId === highlightId);
  if (!mine.length) return null;
  return mine.find((thread) => !thread.parentId) || mine[0];
}

/**
 * Folds one verdict into what the record already believed.
 *
 * Returns changed:false when the answer is the same as last time, which is the
 * common case on every page load — the caller uses that to write nothing at
 * all rather than rewriting a page record for no reason.
 */
export function mergeAnchorVerdict(previous, verdict, now = Date.now()) {
  const state = verdict?.state || "missing";
  const rung = verdict?.rung || 0;
  const url = verdict?.url || previous?.url || "";

  if (state === "missing") {
    const missStreak = (previous?.missStreak || 0) + 1;
    // A streak only grows once per load, so a verdict we already recorded this
    // load is not evidence of a second failure.
    const changed = previous?.state !== "missing" || previous?.missStreak !== missStreak;
    return {
      changed,
      anchor: { state: "missing", rung: 0, at: now, missStreak, url }
    };
  }

  const changed =
    previous?.state !== state || previous?.rung !== rung || (previous?.missStreak || 0) !== 0;
  return {
    changed,
    anchor: { state, rung, at: changed ? now : previous?.at || now, missStreak: 0, url }
  };
}

/** The verdict a confidence rating implies. */
export function stateForConfidence(confidence) {
  if (!confidence) return "missing";
  return confidence === "loose" ? "moved" : "found";
}
