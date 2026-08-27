const KNOWN_HOSTS = [
  "x.com",
  "twitter.com",
  "reddit.com",
  "old.reddit.com",
  "linkedin.com",
  "facebook.com",
  "instagram.com",
  "tiktok.com",
  "youtube.com",
  "news.ycombinator.com"
];

const HINT_SELECTORS = [
  "[role='feed']",
  "[data-testid='infinite-scroll']",
  ".infinite-scroll",
  ".infinite-scroller",
  "[data-infinite]",
  "infinite-scroll"
];

export function hostLooksInfinite(url) {
  let host = "";
  try {
    host = new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return false;
  }
  return KNOWN_HOSTS.some((known) => host === known || host.endsWith(`.${known}`));
}

export function domLooksInfinite(doc = document) {
  return HINT_SELECTORS.some((selector) => doc.querySelector(selector));
}

export function createInfiniteScrollDetector(options = {}) {
  const threshold = options.threshold ?? 0.4;
  const minGrowths = options.minGrowths ?? 2;
  let lastHeight = measureHeight();
  let growths = 0;
  let flagged = Boolean(options.initial);
  const listeners = new Set();

  function measureHeight() {
    const el = options.root || globalThis.document?.documentElement;
    return el ? el.scrollHeight : 0;
  }

  function check() {
    if (flagged) return flagged;
    const height = measureHeight();
    if (lastHeight > 400 && height > lastHeight * (1 + threshold)) {
      growths += 1;
      lastHeight = height;
      if (growths >= minGrowths) {
        flagged = true;
        listeners.forEach((fn) => fn(true));
      }
    } else if (height > lastHeight) {
      lastHeight = height;
    }
    return flagged;
  }

  function start() {
    if (typeof MutationObserver === "undefined") return () => {};
    const observer = new MutationObserver(() => {
      check();
    });
    observer.observe(options.root || document.body, {
      childList: true,
      subtree: true
    });
    const onScroll = () => check();
    (options.scrollTarget || window).addEventListener("scroll", onScroll, { passive: true });
    return () => {
      observer.disconnect();
      (options.scrollTarget || window).removeEventListener("scroll", onScroll);
    };
  }

  return {
    start,
    check,
    isFlagged: () => flagged,
    onFlag(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    }
  };
}

export function evaluateInfiniteScroll(url, doc, extras = {}) {
  if (hostLooksInfinite(url)) {
    return { infinite: true, reason: "This looks like a feed that keeps growing." };
  }
  if (domLooksInfinite(doc)) {
    return { infinite: true, reason: "This page is an infinite feed." };
  }
  if (extras.heuristic) {
    return { infinite: true, reason: "This page grew while you were reading." };
  }
  return { infinite: false, reason: null };
}
