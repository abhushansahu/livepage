/**
 * When to try anchoring again, and what to remember about the answer.
 *
 * Pure on purpose: the retry loop it drives owns a MutationObserver and timers
 * that no test in this repo can run, so every decision it makes lives here
 * instead.
 */

/**
 * A highlight that did not anchor at document_idle has usually not been
 * deleted — the article body is still hydrating, or is lazy-loaded below the
 * fold. These delays cover the slow-render case without following a page
 * around forever.
 */
export const RETRY_SCHEDULE = [400, 1200, 3000, 6000, 12000];
export const MAX_ATTEMPTS = RETRY_SCHEDULE.length;

/** A feed rewrites its DOM continuously; watching one is a battery bug. */
export const INFINITE_MAX_ATTEMPTS = 2;

export function nextAttempt({ attempt = 0, dirty = false, infinite = false } = {}) {
  const cap = infinite ? INFINITE_MAX_ATTEMPTS : MAX_ATTEMPTS;
  if (attempt >= cap) return { done: true, skip: false, delay: 0 };
  // The first retry always runs: the page may have settled without mutating in
  // a way we saw. After that, nothing changed means nothing to re-read.
  const skip = attempt > 0 && !dirty;
  return { done: false, skip, delay: RETRY_SCHEDULE[attempt] };
}
