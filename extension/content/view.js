/**
 * The handful of geometry questions the margin has to ask of whatever is
 * scrolling underneath it.
 *
 * On an article that is the window; in the PDF viewer it is a div. Those are
 * the only two differences that matter, and they are collected here rather
 * than left as `window.scrollY` scattered through `Overlay` — because the
 * margin *is* the product, and a second copy of it for PDFs would mean every
 * future change gets made twice and the two drift.
 *
 * "Content coordinates" below always means: distance from the top of the
 * scrollable content, not from the top of the viewport.
 */

/** The margin over an ordinary web page, where the window is the scroller. */
export const documentView = {
  /** Where the overlay's hosts are appended. */
  mount: () => document.documentElement,

  /** A viewport rect's top, in content coordinates. */
  contentTop: (rect) => rect.top + window.scrollY,

  /** The top of what is currently visible, in content coordinates. */
  scrollTop: () => window.scrollY,

  viewportHeight: () => window.innerHeight,

  contentHeight: () =>
    Math.max(
      document.documentElement.scrollHeight,
      document.body?.scrollHeight || 0,
      window.innerHeight
    ),

  scrollToTop: (top) => window.scrollTo({ top: Math.max(0, top), behavior: "smooth" }),

  /**
   * Makes room for the margin, or gives it back.
   *
   * The rule lives in a style element rather than inline on <html> so a page's
   * own stylesheet cannot outrank it, and so removing the class is enough to
   * undo it.
   */
  setGutter(on, width) {
    const root = document.documentElement;
    if (!document.getElementById("lp-gutter-style")) {
      const rail = document.createElement("style");
      rail.id = "lp-gutter-style";
      rail.textContent = `
        html.lp-rail-on {
          position: relative;
          box-sizing: border-box;
          padding-right: var(--lp-gutter, 328px) !important;
          scroll-padding-right: var(--lp-gutter, 328px);
        }
      `;
      root.appendChild(rail);
    }
    root.classList.toggle("lp-rail-on", on);
    if (on) root.style.setProperty("--lp-gutter", `${width}px`);
    else root.style.removeProperty("--lp-gutter");
  },

  /** Re-layout triggers other than our own. */
  onRelayout(handler) {
    window.addEventListener("resize", handler, { passive: true });
    return () => window.removeEventListener("resize", handler);
  }
};

/**
 * The margin over a scrolling container — the PDF viewer's page stack.
 *
 * `container` is the element with `overflow: auto`. Absolutely positioned
 * children of a scroll container scroll with its content, so the gutter host
 * goes inside it and needs no scroll listener at all; the cards are placed
 * once, in content coordinates, and the browser moves them.
 */
export function containerView(container) {
  const originTop = () => container.getBoundingClientRect().top;
  return {
    mount: () => container,
    contentTop: (rect) => rect.top - originTop() + container.scrollTop,
    scrollTop: () => container.scrollTop,
    viewportHeight: () => container.clientHeight,
    contentHeight: () => Math.max(container.scrollHeight, container.clientHeight),
    scrollToTop: (top) => container.scrollTo({ top: Math.max(0, top), behavior: "smooth" }),
    setGutter(on, width) {
      // The padding is on the scroller, so the page stack re-centres in what
      // is left and the gutter sits in the space that opens up — the same
      // move `html.lp-rail-on` makes on an article.
      container.classList.toggle("lp-rail-on", on);
      if (on) container.style.setProperty("--lp-gutter", `${width}px`);
      else container.style.removeProperty("--lp-gutter");
    },
    onRelayout(handler) {
      window.addEventListener("resize", handler, { passive: true });
      return () => window.removeEventListener("resize", handler);
    }
  };
}
