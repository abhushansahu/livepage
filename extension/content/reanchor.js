import { nextAttempt } from "./anchor-plan.js";

/**
 * Keeps trying to anchor highlights while a page finishes arriving.
 *
 * A highlight that does not anchor at document_idle has usually not been
 * deleted: the article body is still hydrating, or it lazy-loads on scroll.
 * Declaring those lost on the first look would condemn most highlights on a
 * modern site. So we look again a few times as the DOM settles, and stop.
 *
 * The observer does nothing but note that something changed — every re-read is
 * driven by the timer instead. That is what keeps this from doing work on
 * every mutation batch of a busy page, and what keeps it out of the way of the
 * infinite-scroll detector watching the same subtree.
 */
export function createReanchorLoop({ root, unresolvedCount, anchorNow, infinite = false } = {}) {
  let attempt = 0;
  let dirty = false;
  let timer = null;
  let observer = null;
  let running = false;

  function stop() {
    running = false;
    if (timer) clearTimeout(timer);
    timer = null;
    if (observer) observer.disconnect();
    observer = null;
  }

  function schedule() {
    if (!running) return;
    if (unresolvedCount() === 0) {
      stop();
      return;
    }
    const plan = nextAttempt({ attempt, dirty, infinite });
    if (plan.done) {
      stop();
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      if (!running) return;
      const skipping = plan.skip;
      attempt += 1;
      if (!skipping) {
        dirty = false;
        try {
          anchorNow();
        } catch (error) {
          console.warn("LivePage re-anchor failed", error);
        }
      }
      schedule();
    }, plan.delay);
  }

  return {
    start() {
      // Everything anchored on the first pass, which is the ordinary case.
      // Do not build an observer just to watch a page that has nothing left
      // to find.
      if (running || unresolvedCount() === 0) return;
      running = true;
      if (typeof MutationObserver !== "undefined") {
        observer = new MutationObserver(() => {
          dirty = true;
        });
        observer.observe(root || document.body, {
          childList: true,
          subtree: true,
          characterData: true
        });
      } else {
        dirty = true;
      }
      schedule();
    },
    /** Re-read now — the page changed under us in a way we already know about. */
    kick() {
      if (unresolvedCount() === 0) return;
      dirty = true;
      if (!running) {
        attempt = 0;
        this.start();
        return;
      }
      try {
        anchorNow();
      } catch (error) {
        console.warn("LivePage re-anchor failed", error);
      }
    },
    stop
  };
}

/**
 * Calls back when the page navigates without reloading.
 *
 * A content script runs in an isolated world, so patching history.pushState
 * here would never see the page's own calls. The Navigation API does fire for
 * them; where it is missing, watching the href is the honest fallback.
 */
export function watchUrl(onChange, { pollMs = 700, debounceMs = 250 } = {}) {
  let last = location.href;
  let timer = null;
  let poll = null;

  const fire = () => {
    if (location.href === last) return;
    last = location.href;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onChange(location.href);
    }, debounceMs);
  };

  const hasNavigation = typeof navigation !== "undefined" && navigation?.addEventListener;
  if (hasNavigation) navigation.addEventListener("navigatesuccess", fire);
  window.addEventListener("popstate", fire);
  window.addEventListener("hashchange", fire);
  if (!hasNavigation) poll = setInterval(fire, pollMs);

  return () => {
    if (timer) clearTimeout(timer);
    if (poll) clearInterval(poll);
    if (hasNavigation) navigation.removeEventListener("navigatesuccess", fire);
    window.removeEventListener("popstate", fire);
    window.removeEventListener("hashchange", fire);
  };
}
