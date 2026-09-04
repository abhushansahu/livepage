import { COLORS, COLOR_IDS } from "../shared/colors.js";
import { formatRelative } from "../shared/time.js";
import { highlightRect } from "./highlights.js";
import { cssEscape } from "../parse/quote.js";
import { icon } from "../shared/icons.js";
import { normalizeTheme } from "../shared/theme.js";
import { blocksAround } from "../shared/anchors.js";
import { documentView } from "./view.js";
import { renderMessage } from "../shared/markdown.js";

const GUTTER = 328;
const CARD_GAP = 10;

const FALLBACK_CSS = `
:host { all: initial; display: block; pointer-events: none; z-index: 2147483000; }
:host([data-lp="root"]) {
  position: absolute; top: 0; right: 0;
  width: var(--lp-gutter, 328px); min-height: 100%; height: var(--lp-doc-height, 100%);
}
:host([data-lp="float"]) {
  position: fixed; inset: 0; width: 100%; height: 100%; overflow: visible;
  z-index: 2147483640; pointer-events: none;
}
.lp-root, .lp-float { font-family: ui-sans-serif, "Segoe UI", system-ui, sans-serif; color: #1c1712; font-size: 13px; }
.feed-offer, .toolbar, .toast, .card, .orphan-dock { pointer-events: auto; }
.feed-offer[hidden], .toolbar[hidden], .toast[hidden] { display: none !important; }
.toolbar {
  position: fixed; z-index: 2147483646; display: flex; gap: 4px; align-items: center;
  padding: 6px; background: #fffcf7; border: 1px solid rgba(28,23,18,0.12);
  border-radius: 999px; box-shadow: 0 14px 40px rgba(28,23,18,0.16);
}
.swatch { width: 18px; height: 18px; border-radius: 50%; border: 1px solid rgba(28,23,18,0.18); cursor: pointer; background: var(--lp-mark); }
button.ghost { appearance: none; border: 0; background: transparent; color: #1c1712; padding: 6px 9px; font: inherit; cursor: pointer; border-radius: 999px; }
.toast, .feed-offer {
  position: fixed; z-index: 2147483646; background: #fffcf7; border: 1px solid rgba(28,23,18,0.1);
  border-radius: 14px; padding: 10px 12px; box-shadow: 0 10px 40px rgba(28,23,18,0.12);
}
.toast { bottom: 20px; left: 50%; transform: translateX(-50%); background: #1c1712; color: #f6f1e8; border-radius: 999px; }
button.solid { appearance: none; border: 0; background: #3f6b52; color: #f6f1e8; padding: 6px 10px; font: inherit; cursor: pointer; border-radius: 999px; font-weight: 600; }
/* The dock is fixed because .gutter positions its cards absolutely; an
   in-flow block would sit underneath them. If the stylesheet fetch loses its
   race these rules are the difference between a readable dock and every
   orphan stacked on one point. */
.orphan-dock {
  position: fixed; right: 16px; bottom: 16px;
  width: min(300px, calc(var(--lp-gutter, 328px) - 28px));
  max-height: 60vh; overflow: auto; z-index: 2147483644;
  background: #fffcf7; border: 1px solid rgba(28,23,18,0.12);
  border-radius: 14px; padding: 8px 10px; box-shadow: 0 10px 40px rgba(28,23,18,0.12);
}
.orphan-dock.is-expanded { max-height: 78vh; }
.orphan-dock[hidden], .dock-body[hidden] { display: none !important; }
.orphan-dock .card { position: static; margin: 6px 0; }
.dock-head { display: flex; gap: 6px; align-items: center; width: 100%; appearance: none; border: 0; background: transparent; font: inherit; color: inherit; cursor: pointer; padding: 2px; text-align: left; }
.dock-title { flex: 1; font-weight: 600; }
.markup-status {
  position: fixed; left: 16px; bottom: 16px; z-index: 2147483646;
  display: flex; gap: 8px; align-items: center; pointer-events: auto;
  padding: 7px 12px; border-radius: 999px; font-size: 12px;
  background: #fffcf7; color: #1c1712;
  border: 1px solid rgba(28,23,18,0.12); box-shadow: 0 10px 30px rgba(28,23,18,0.12);
}
.markup-status[hidden] { display: none !important; }
.markup-status .pulse {
  width: 7px; height: 7px; border-radius: 50%; background: #3f6b52; flex: none;
}
.markup-status.is-working .pulse { animation: lp-markup-pulse 1.3s ease-in-out infinite; }
.markup-status.is-idle .pulse { background: transparent; box-shadow: inset 0 0 0 1.5px #3f6b52; }
.markup-status.is-empty .pulse { background: transparent; box-shadow: inset 0 0 0 1.5px rgba(28,23,18,0.4); }
.markup-status.is-error .pulse { background: #8a3a32; }
.markup-status.is-collapsed .label { display: none; }
.markup-status.is-collapsed { padding: 7px; }
.markup-status.is-collapsed:hover .label { display: inline; }
.markup-status.is-collapsed:hover { padding: 7px 12px; }
@keyframes lp-markup-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
/* Enough of the rendered-message rules to stay readable if overlay.css loses
   its fetch race — without these a reply is one unbroken run of text. */
.msg .body > * { margin: 0 0 6px; }
.msg .body p { white-space: pre-wrap; }
.msg .body p.head { font-weight: 650; white-space: normal; }
.msg .body ul, .msg .body ol { padding-left: 18px; }
.msg .body code, .msg .body pre.code { font-family: ui-monospace, Menlo, monospace; font-size: 0.92em; }
.msg .body pre.code { padding: 8px 10px; border-radius: 8px; overflow-x: auto; background: rgba(28,23,18,0.08); }
.msg .body .math { font-family: Palatino, Georgia, serif; font-style: italic; white-space: nowrap; }
.msg .body .math.is-block { display: block; text-align: center; margin: 8px 0; white-space: normal; }
.msg .body .math .up { font-style: normal; }
.msg .body .math sub, .msg .body .math sup { font-size: 0.72em; line-height: 0; }
.msg .body .frac { display: inline-flex; flex-direction: column; vertical-align: -0.45em; text-align: center; font-size: 0.92em; margin: 0 0.12em; }
.msg .body .frac .num { border-bottom: 1px solid currentColor; padding: 0 0.25em; }
.msg .body .frac .den { padding: 0 0.25em; }
.msg .body .root { border-top: 1px solid currentColor; padding: 0 0.15em; }
`;

function makeHost(kind) {
  const host = document.createElement("div");
  host.className = "lp-ignore";
  host.setAttribute("data-lp", kind);
  return host;
}

export class Overlay {
  /**
   * `view` answers the geometry questions — what is scrolling, how tall the
   * content is, where the margin's room comes from. It defaults to the window,
   * which is every case but the PDF viewer.
   */
  constructor({ view = documentView } = {}) {
    this.view = view;
    this.host = makeHost("root");
    this.shadow = this.host.attachShadow({ mode: "open" });
    this.floatHost = makeHost("float");
    this.floatShadow = this.floatHost.attachShadow({ mode: "open" });
    this.page = null;
    this.activeThreadId = null;
    this.handlers = {};
    this.sendMode = "comment";
    this.threadModes = {};
    this.awaitingAgent = null;
    this.theme = "coffee";
    this.highlightStrength = 48;
    this.mention = null;
    this.mentionRequest = "";
    this.anchors = new Map();
    this.reattaching = null;
    this.dockOpen = false;
    this.els = { toolbar: null, toast: null, feedOffer: null, markupStatus: null, gutter: null };
    this.mountFloat();
    this.bind();
    this.ready = this.render();
  }

  mountFloat() {
    this.floatHost.style.cssText =
      "all:initial;position:fixed;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none;z-index:2147483646;";
    this.floatShadow.innerHTML = `
      <style>${FALLBACK_CSS}</style>
      <div class="lp-float">
        <div class="toolbar" hidden></div>
        <div class="toast" hidden></div>
        <div class="feed-offer" hidden></div>
        <div class="markup-status" hidden role="status" aria-live="polite"></div>
      </div>
    `;
    this.els.toolbar = this.floatShadow.querySelector(".toolbar");
    this.els.toast = this.floatShadow.querySelector(".toast");
    this.els.feedOffer = this.floatShadow.querySelector(".feed-offer");
    this.els.markupStatus = this.floatShadow.querySelector(".markup-status");
    this.attachHosts();
  }

  attachHosts() {
    // The toolbar, toasts and the status dot are all fixed to the viewport, so
    // they hang off the document however the page is scrolling. The gutter is
    // the one that has to live inside the scroller, or its cards would sit
    // still while the passages they point at moved.
    const top = document.documentElement;
    if (top && this.floatHost.parentNode !== top) top.appendChild(this.floatHost);
    const root = this.view.mount();
    if (!root) return;
    if (this.els?.gutter && this.host.parentNode !== root) root.appendChild(this.host);
  }

  async render() {
    let css = "";
    try {
      const cssUrl = chrome.runtime?.getURL
        ? chrome.runtime.getURL("content/overlay.css")
        : new URL("./overlay.css", import.meta.url).href;
      css = await Promise.race([
        fetch(cssUrl).then((r) => r.text()),
        new Promise((resolve) => setTimeout(() => resolve(""), 800))
      ]);
    } catch {
      css = "";
    }
    const style = `<style>${FALLBACK_CSS}\n${css}</style>`;
    this.shadow.innerHTML = `
      ${style}
      <div class="lp-root">
        <div class="gutter"></div>
      </div>
    `;
    this.els.gutter = this.shadow.querySelector(".gutter");
    if (css && this.floatShadow.querySelector("style")) {
      this.floatShadow.querySelector("style").textContent = `${FALLBACK_CSS}\n${css}`;
    }
    this.view.mount()?.appendChild(this.host);
    this.attachHosts();
    this.applyTheme();
    this.applyRail();
  }

  bind() {
    this.view.onRelayout(() => this.layoutCards());
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      const menu = this.els?.gutter?.querySelector(".send-menu:not([hidden])");
      if (menu) {
        menu.hidden = true;
        return;
      }
      if (this.awaitingAgent) {
        this.awaitingAgent = null;
        this.renderCards();
        return;
      }
      this.closePanel();
    });
    document.addEventListener("mousedown", (event) => {
      if (!this.activeThreadId) return;
      if (event.target.closest?.("mark.lp-hl")) return;
      if (this.ownsEvent(event)) return;
      this.closePanel();
    });
  }

  ownsEvent(event) {
    const path = event.composedPath?.() || [];
    return path.includes(this.host) || path.includes(this.floatHost);
  }

  /**
   * Whether a node belongs to the overlay rather than the page.
   *
   * `host.contains(node)` cannot answer this: our UI lives in a shadow root,
   * and `contains` stops at the boundary. So a selection made inside a margin
   * card looked to the page like a selection of the page, and could be turned
   * into a highlight of our own chrome. `getRootNode` crosses it.
   */
  ownsNode(node) {
    if (!node) return false;
    const root = node.getRootNode?.();
    if (root === this.shadow || root === this.floatShadow) return true;
    return this.host.contains(node) || this.floatHost.contains(node);
  }

  /** Whether there is live selected text inside this element. */
  hasSelectionIn(el) {
    const selection = this.shadow?.getSelection?.() || document.getSelection();
    if (!selection || selection.isCollapsed || !selection.toString().trim()) return false;
    return el.contains(selection.anchorNode) || el.contains(selection.focusNode);
  }

  setPage(page) {
    this.page = page;
    if (this.awaitingAgent) {
      const thread = page?.threads?.find((t) => t.id === this.awaitingAgent.threadId);
      const status = thread?.awaitingAgent?.status;
      if (status !== "pending" && status !== "error") this.awaitingAgent = null;
    }
    this.renderCards();
    this.applyRail();
  }

  setPreferences(settings = {}) {
    this.theme = normalizeTheme(settings.pageTheme);
    this.highlightStrength = Math.max(24, Math.min(68, Number(settings.highlightStrength) || 48));
    this.applyTheme();
  }

  applyTheme() {
    this.host.dataset.theme = this.theme;
    this.floatHost.dataset.theme = this.theme;
    document.documentElement.classList.toggle("lp-theme-dark", this.theme === "dark");
    document.documentElement.style.setProperty("--lp-highlight-strength", `${this.highlightStrength}%`);
  }

  /** What the live page did with each highlight's quote, by highlight id. */
  setAnchors(anchors) {
    this.anchors = anchors || new Map();
    this.renderCards();
  }

  setReattaching(highlightId) {
    this.reattaching = highlightId || null;
    if (highlightId) this.expandDock();
    this.renderCards();
  }

  anchorOf(highlightId) {
    return this.anchors.get(highlightId) || null;
  }

  isOrphan(highlightId) {
    return this.anchorOf(highlightId)?.state === "missing";
  }

  /**
   * Lets go of the page entirely. A single-page app swaps articles under us,
   * and renderCards cannot clear itself — it returns early without a page.
   */
  clear() {
    this.page = null;
    this.anchors = new Map();
    this.reattaching = null;
    this.activeThreadId = null;
    this.dockOpen = false;
    if (this.els?.gutter) this.els.gutter.innerHTML = "";
    this.applyRail();
  }

  applyRail() {
    const show = (this.page?.highlights || []).length > 0;
    this.host.hidden = !show;
    this.view.setGutter(show, GUTTER);
  }

  /**
   * Chrome has handed this tab to its own PDF viewer, where none of LivePage
   * exists. Say so once, offer the reader that does, and go away when waved
   * off — the same manners as the RSS offer, and the same element.
   */
  offerPdf({ onOpen, onDismiss } = {}) {
    const el = this.els.feedOffer;
    if (!el) return;
    el.hidden = false;
    el.innerHTML = `
      <p><strong>This is a PDF.</strong> Open it in LivePage to highlight and think in the margin.</p>
      <button class="solid" data-act="open">Open in LivePage</button>
      <button class="ghost" data-act="dismiss">Not now</button>
    `;
    el.querySelector("[data-act='open']").onclick = () => {
      el.hidden = true;
      onOpen?.();
    };
    el.querySelector("[data-act='dismiss']").onclick = () => {
      el.hidden = true;
      onDismiss?.();
    };
  }

  offerFeed(feed, { onAdd, onDismiss } = {}) {
    const el = this.els.feedOffer;
    if (!el) return;
    if (!feed) {
      el.hidden = true;
      el.innerHTML = "";
      return;
    }
    el.hidden = false;
    el.innerHTML = `
      <p><strong>RSS on this page.</strong> ${escapeHtml(feed.title || feed.url)}</p>
      <input type="text" data-act="tags" placeholder="tags: design, weekly" />
      <button class="solid" data-act="add">Add feed</button>
      <button class="ghost" data-act="dismiss">Not now</button>
    `;
    el.querySelector("[data-act='add']").onclick = () => {
      const tags = el.querySelector("[data-act='tags']")?.value || "";
      onAdd?.(tags);
    };
    el.querySelector("[data-act='dismiss']").onclick = () => {
      el.hidden = true;
      onDismiss?.();
    };
  }

  /**
   * What has happened to this article, and what would happen if you asked.
   *
   * The states have to be told apart, because "not looked at yet", "looking",
   * "looked and found nothing" and "could not look" are four different things
   * and all of them used to render as an empty corner. The message shows
   * itself and then shrinks to a dot rather than disappearing, so the answer
   * is still there when you glance back.
   */
  markupStatus(state, { count = 0, detail = "" } = {}) {
    this.attachHosts();
    const el = this.els?.markupStatus;
    if (!el) return;
    clearTimeout(this._markupHide);
    this.markupState = state;

    if (!state) {
      el.hidden = true;
      return;
    }

    const copy = {
      idle: { text: "\u2325A to mark this up", hint: "Nothing marked here yet" },
      working: { text: "Reading this page\u2026", hint: "An agent is reading this page" },
      done: {
        text: `${count} passage${count === 1 ? "" : "s"} marked \u00b7 \u2325J to move between them`,
        hint: `${count} passage${count === 1 ? "" : "s"} marked`
      },
      empty: { text: "Nothing here worth marking", hint: "Read, and nothing was worth marking" },
      error: { text: detail || "Could not reach the agent", hint: detail || "Could not reach the agent" }
    }[state];
    if (!copy) return;

    el.hidden = false;
    el.className = `markup-status is-${state}`;
    el.title = copy.hint;
    el.innerHTML = `<span class="pulse"></span><span class="label">${escapeHtml(copy.text)}</span>`;
    el.onclick = () => this.handlers.onMarkupAction?.(this.markupState);

    // Working has no end of its own; the others say their piece and shrink.
    if (state === "working") return;
    this._markupHide = setTimeout(
      () => el.classList.add("is-collapsed"),
      state === "done" ? 5200 : 3400
    );
  }

  showToolbar(rect, { onHighlight, onComment } = {}) {
    this.attachHosts();
    const bar = this.els?.toolbar;
    if (!bar) return;
    bar.hidden = false;
    bar.removeAttribute("hidden");
    bar.innerHTML =
      COLOR_IDS.map(
        (id) => {
          const hint = colorHint(id);
          return `<button class="swatch" title="${escapeHtml(hint)}" aria-label="${escapeHtml(hint)}" style="--lp-mark:${COLORS[id].fill}" data-color="${id}"></button>`;
        }
      ).join("") + `<button class="ghost" data-act="comment">Comment</button>`;
    this.positionToolbar(rect);
    bar.querySelectorAll(".swatch").forEach((btn) => {
      btn.onclick = (event) => {
        event.preventDefault();
        onHighlight?.(btn.dataset.color);
        this.hideToolbar();
      };
    });
    bar.querySelector("[data-act='comment']")?.addEventListener("click", (event) => {
      event.preventDefault();
      onComment?.();
      this.hideToolbar();
    });
  }

  /** Places the floating bar above a selection, kept on screen. */
  positionToolbar(rect) {
    const bar = this.els?.toolbar;
    if (!bar || !rect) return;
    bar.hidden = false;
    bar.removeAttribute("hidden");
    const top = rect.top - 44;
    const left = Math.min(rect.left, document.documentElement.clientWidth - 280);
    bar.style.top = `${Math.max(8, top)}px`;
    bar.style.left = `${Math.max(8, left)}px`;
    // Keep the page's selection alive while the bar is clicked.
    bar.onpointerdown = (event) => event.preventDefault();
    bar.onmousedown = (event) => event.preventDefault();
  }

  hideToolbar() {
    if (this.els?.toolbar) this.els.toolbar.hidden = true;
  }

  toast(text) {
    if (!this.els?.toast) return;
    this.els.toast.hidden = false;
    this.els.toast.textContent = text;
    clearTimeout(this._toast);
    this._toast = setTimeout(() => {
      this.els.toast.hidden = true;
    }, 2400);
  }

  renderCards() {
    if (!this.page || !this.els?.gutter) return;
    this.mention = null;
    const previous = this.els.gutter.querySelector(".card.is-open .messages");
    const scrollState = previous
      ? {
          top: previous.scrollTop,
          height: previous.scrollHeight,
          atBottom: previous.scrollHeight - previous.scrollTop - previous.clientHeight < 32
        }
      : null;
    const draft = this._skipDraftOnce
      ? ""
      : this.els.gutter.querySelector(".card.is-open .composer textarea:not(.packet-md)")?.value || "";
    this._skipDraftOnce = false;
    const placed = [];
    const orphans = [];
    for (const highlight of this.page.highlights) {
      (this.isOrphan(highlight.id) ? orphans : placed).push(highlight);
    }
    // The dock has to be part of this same string: renderCards replaces the
    // gutter wholesale, so anything appended separately is thrown away on the
    // next mutation.
    this.els.gutter.innerHTML =
      placed.map((highlight) => this.cardHtml(highlight)).join("") + this.dockHtml(orphans);
    this.els.gutter.querySelectorAll(".card").forEach((card) => this.bindCard(card));
    this.bindDock();
    this.layoutCards();
    this.markActiveHighlights();
    this.applyRail();
    const open = this.els.gutter.querySelector(".card.is-open .messages");
    const composer = this.els.gutter.querySelector(".card.is-open .composer textarea:not(.packet-md)");
    if (composer && draft) composer.value = draft;
    if (open && scrollState) {
      open.scrollTop = scrollState.atBottom
        ? open.scrollHeight
        : scrollState.top;
    }
  }

  /**
   * The passages this page no longer has a place for.
   *
   * They keep their whole conversation — a highlight is only ever the anchor
   * for one — so nothing is lost while the page and the quote disagree.
   */
  dockHtml(orphans) {
    if (!orphans.length) return "";
    const open = this.dockOpen || Boolean(this.reattaching);
    const count = orphans.length;
    return `
      <section class="orphan-dock${open ? " is-expanded" : ""}">
        <button type="button" class="dock-head" data-act="toggle-orphans" aria-expanded="${open}">
          <span class="dock-ico">${icon("search", { size: 13 })}</span>
          <span class="dock-title">${count} highlight${count === 1 ? "" : "s"} lost ${count === 1 ? "its" : "their"} place</span>
          <span class="dock-caret">${open ? "\u25be" : "\u25b8"}</span>
        </button>
        <div class="dock-body"${open ? "" : " hidden"}>
          <p class="dock-hint">The page changed under these. Select the passage each one belongs to now, then re-attach.</p>
          ${orphans.map((highlight) => this.cardHtml(highlight)).join("")}
        </div>
      </section>`;
  }

  /**
   * A loose match is a guess. Ask before the stored quote is ever rewritten
   * from it — otherwise the anchor is re-derived from the same stale text on
   * every load and drifts until it snaps.
   */
  confirmRowHtml() {
    return `
      <div class="confirm-row">
        <span class="confirm-ask">The page changed. Is this the right passage?</span>
        <button type="button" class="solid" data-act="confirm-anchor">That\u2019s it</button>
        <button type="button" class="ghost" data-act="move-hl">No \u2014 re-attach</button>
      </div>`;
  }

  /**
   * What the saved copy of this page remembers around the passage. Collapsed,
   * so it costs nothing until asked for — and its absence is itself telling.
   */
  wasHereHtml(highlight) {
    const blocks = blocksAround(this.page, highlight.text, 1);
    if (!blocks.length) {
      return `<p class="was-context is-empty">We have no saved copy of this passage.</p>`;
    }
    const body = blocks
      .map((block) => {
        const text = clip(block.text, 220);
        return `<span class="was-block">${escapeHtml(text)}</span>`;
      })
      .join(" ");
    return `
      <details class="was-here">
        <summary>Where it used to sit</summary>
        <p class="was-context">${body}</p>
      </details>`;
  }

  bindDock() {
    const head = this.els.gutter.querySelector("[data-act='toggle-orphans']");
    if (!head) return;
    head.addEventListener("click", () => {
      this.dockOpen = !this.dockOpen;
      this.renderCards();
    });
  }

  /**
   * Asks whether this selection is the passage, rather than moving a highlight
   * the moment something is selected. Rendered through the existing toolbar so
   * it inherits the fallback styling and needs no new fixed element.
   */
  showReattachChip(rect, { quote, known = true, onAttach, onCancel } = {}) {
    this.attachHosts();
    const el = this.els?.toolbar;
    if (!el) return;
    el.hidden = false;
    el.removeAttribute("hidden");
    el.innerHTML = `
      <span class="chip-ask">Re-attach \u201c${escapeHtml(clip(quote || "", 30))}\u201d here?</span>
      ${known ? "" : `<span class="chip-note">not in the saved copy</span>`}
      <button class="solid" data-act="attach">Attach</button>
      <button type="button" class="ghost" data-act="cancel">Cancel</button>
    `;
    el.querySelector("[data-act='attach']").onclick = () => onAttach?.();
    el.querySelector("[data-act='cancel']").onclick = () => onCancel?.();
    this.positionToolbar(rect);
  }

  cardHtml(highlight) {
    const thread = this.threadFor(highlight.id);
    const open = Boolean(thread && thread.id === this.activeThreadId);
    const color = COLORS[highlight.color]?.fill || "#F6E27A";
    const preview = thread?.messages?.[0]?.content || "Add a comment";
    const count = thread?.messages?.length || 0;
    const orphan = this.isOrphan(highlight.id);
    const arming = this.reattaching === highlight.id;
    if (orphan) {
      const context = this.wasHereHtml(highlight);
      return `
        <article class="card is-orphan${arming ? " is-arming" : ""}" data-highlight="${highlight.id}" data-thread="${thread?.id || ""}" style="--lp-mark:${color}">
          <p class="meta-line">
            <span class="thread-label">${icon(thread?.parentId ? "branch" : "comment", { size: 12 })}${escapeHtml(threadLabel(thread))}</span>
            <span class="orphan-badge">not on this page</span>
            <button type="button" class="hl-delete" data-act="delete-hl" title="Delete highlight">×</button>
          </p>
          <p class="quote">${escapeHtml(clip(highlight.text, 140))}</p>
          ${context}
          ${count ? `<p class="preview">${escapeHtml(clip(preview, 110))}</p>` : ""}
          <div class="orphan-acts">
            <button type="button" class="solid" data-act="move-hl">${arming ? "Selecting…" : "Re-attach here"}</button>
            ${arming ? `<button type="button" class="ghost" data-act="cancel-reattach">Cancel</button>` : ""}
          </div>
        </article>`;
    }
    if (!open) {
      const unsure = this.anchorOf(highlight.id)?.state === "moved";
      return `
        <article class="card${unsure ? " is-unsure" : ""}" data-highlight="${highlight.id}" data-thread="${thread?.id || ""}" style="--lp-mark:${color}">
          <p class="meta-line">
            <span class="thread-label">${icon(thread?.parentId ? "branch" : "comment", { size: 12 })}${escapeHtml(threadLabel(thread))}</span>
            <span>${count ? `${count} ${count === 1 ? "message" : "messages"}` : ""}</span>
            <button type="button" class="hl-delete" data-act="delete-hl" title="Delete highlight">×</button>
          </p>
          <p class="quote">${escapeHtml(clip(highlight.text, 90))}</p>
          ${unsure ? this.confirmRowHtml() : `<p class="preview">${escapeHtml(clip(preview, 110))}</p>`}
        </article>`;
    }
    const branches = this.page.threads.filter((t) => t.highlightId === highlight.id);
    const mode = this.effectiveSendMode(thread);
    return `
      <article class="card is-open" data-highlight="${highlight.id}" data-thread="${thread.id}" style="--lp-mark:${color}">
        <button class="close" title="Collapse">×</button>
        <div class="hl-toolbar">
          <div class="swatches">
            ${COLOR_IDS.map(
              (id) => {
                const hint = colorHint(id);
                return `<button type="button" class="swatch ${highlight.color === id ? "is-on" : ""}" title="${escapeHtml(hint)}" aria-label="${escapeHtml(hint)}" style="--lp-mark:${COLORS[id].fill}" data-color="${id}"></button>`;
              }
            ).join("")}
          </div>
          <span class="color-meaning">${escapeHtml(COLORS[highlight.color]?.name || "Highlight")}</span>
          <button type="button" class="ghost" data-act="move-hl">Replace span</button>
          <button type="button" class="hl-delete" data-act="delete-hl">Delete</button>
        </div>
        <p class="quote">${escapeHtml(clip(highlight.text, 180))}</p>
        ${
          branches.length > 1
            ? `<div class="branch-list">${branches
                .map(
                  (b) =>
                    `<button class="chip ${b.id === thread.id ? "is-on" : ""}" data-branch="${b.id}">${icon(
                      b.parentId ? "branch" : "comment",
                      { size: 12 }
                    )}${escapeHtml(threadLabel(b))}</button>`
                )
                .join("")}</div>`
            : ""
        }
        <div class="messages">
          ${this.messagesHtml(highlight, thread)}
        </div>
        <div class="composer">
          ${
            thread.awaitingAgent
              ? `<div class="packet ${thread.awaitingAgent.status === "pending" ? "is-working" : ""}" role="status" aria-live="polite">
                  <p class="kicker">${escapeHtml(awaitingCopy(thread.awaitingAgent))}</p>
                  ${
                    thread.awaitingAgent.status === "error"
                      ? `<p class="error">The reply could not arrive. Check that the local agent helper is running, then try again.</p>
                  <details><summary>Technical details</summary>
                    <p class="error-detail">${escapeHtml(thread.awaitingAgent.error || "No response from the local agent.")}</p>
                    <textarea class="packet-md" readonly>${escapeHtml(thread.awaitingAgent.packet || "")}</textarea>
                    <button type="button" class="ghost" data-act="copy-packet">Copy request details</button>
                  </details>`
                      : `<p class="hint"><span class="working-dots"><i></i><i></i><i></i></span>${escapeHtml(agentName(thread.awaitingAgent.agent))} is reading this passage and writing a reply. You can keep reading.</p>`
                  }
                </div>`
              : ""
          }
          <textarea placeholder="${escapeHtml(this.composerPlaceholder(thread))}"></textarea>
          <div class="mention-menu" hidden></div>
          <div class="send">
            <button type="button" class="solid send-main" data-act="send">${escapeHtml(this.sendLabel(thread))}</button>
            <button type="button" class="solid send-caret" data-act="menu" aria-label="Send options">▾</button>
            <div class="send-menu" hidden>
              <button type="button" data-mode="comment" class="${mode === "comment" && !thread.awaitingAgent ? "is-on" : ""}">Comment</button>
              <button type="button" data-mode="cursor" class="${mode === "cursor" || thread.awaitingAgent?.agent === "cursor" ? "is-on" : ""}">Ask Cursor</button>
              <button type="button" data-mode="claude-code" class="${mode === "claude-code" || thread.awaitingAgent?.agent === "claude-code" ? "is-on" : ""}">Ask Claude Code</button>
            </div>
          </div>
        </div>
      </article>`;
  }

  messagesHtml(highlight, thread) {
    const siblings = (this.page?.threads || []).filter((t) => t.highlightId === highlight.id);
    const suggested = nextForkLabel(this.page, thread);
    return (thread.messages || [])
      .map((m) => {
        const forks = siblings.filter((b) => b.id !== thread.id && b.forkedFromMessageId === m.id);
        return `
          <article class="msg ${m.role === "agent" ? "is-agent" : "is-you"}" data-msg="${m.id}">
            <div class="meta"><span>${escapeHtml(labelOf(m))}</span><span>${formatRelative(m.createdAt)}</span></div>
            <div class="body">${messageHtml(m.content)}</div>
            <div class="msg-actions">
              <button type="button" class="fork" data-fork="${m.id}">${icon("branch", { size: 12 })} Explore another angle</button>
              <button type="button" class="delete" data-delete="${m.id}">Delete</button>
            </div>
            <form class="fork-form" hidden data-fork-form="${m.id}">
              <input type="text" name="label" value="${escapeHtml(suggested)}" placeholder="Name this angle" maxlength="48" />
              <button type="submit">Start angle</button>
              <button type="button" data-act="cancel-fork">Cancel</button>
            </form>
          </article>
          ${
            forks.length
              ? `<div class="fork-off">
                  <span class="fork-kicker">${icon("branch", { size: 11 })} Other angles</span>
                  ${forks
                    .map(
                      (b) =>
                        `<button type="button" class="chip" data-branch="${b.id}">${escapeHtml(threadLabel(b))}</button>`
                    )
                    .join("")}
                </div>`
              : ""
          }`;
      })
      .join("");
  }

  bindCard(card) {
    const highlightId = card.dataset.highlight;
    const threadId = card.dataset.thread;
    // A drag that selects text inside a card also fires a click on it, and
    // opening the thread re-renders the gutter — which throws the selection
    // away and scrolls the conversation to the bottom before you can copy a
    // word of it. Two guards, because they catch different gestures: the
    // distance covers dragging, and the live selection covers double-click.
    let pressedAt = null;
    card.addEventListener("pointerdown", (event) => {
      pressedAt = { x: event.clientX, y: event.clientY };
    });
    card.onclick = (event) => {
      if (event.target.closest("button, textarea, select, a, .composer, .fork-form, input")) return;
      const moved =
        pressedAt &&
        Math.hypot(event.clientX - pressedAt.x, event.clientY - pressedAt.y) > 4;
      pressedAt = null;
      if (moved || this.hasSelectionIn(card)) return;
      if (threadId) this.openThread(threadId);
      else this.handlers.onOpenHighlight?.(highlightId);
    };
    const close = card.querySelector(".close");
    if (close) close.onclick = (event) => {
      event.stopPropagation();
      this.closePanel();
    };
    card.querySelectorAll("[data-color]").forEach((btn) => {
      btn.onclick = (event) => {
        event.stopPropagation();
        this.handlers.onRecolorHighlight?.(highlightId, btn.dataset.color);
      };
    });
    card.querySelectorAll("[data-mention]").forEach((btn) => {
      btn.onclick = (event) => {
        event.stopPropagation();
        const [pageId, mentionThreadId] = decodeMention(btn.dataset.mention);
        this.handlers.onOpenMention?.(pageId, mentionThreadId);
      };
    });
    card.querySelectorAll("[data-act='move-hl']").forEach((btn) => {
      btn.addEventListener("click", (event) => {
        event.stopPropagation();
        this.handlers.onMoveHighlight?.(highlightId);
      });
    });
    card.querySelector("[data-act='confirm-anchor']")?.addEventListener("click", (event) => {
      event.stopPropagation();
      this.handlers.onConfirmAnchor?.(highlightId);
    });
    card.querySelector("[data-act='cancel-reattach']")?.addEventListener("click", (event) => {
      event.stopPropagation();
      this.handlers.onCancelReattach?.();
    });
    card.querySelectorAll("[data-act='delete-hl']").forEach((btn) => {
      btn.onclick = (event) => {
        event.stopPropagation();
        this.handlers.onDeleteHighlight?.(highlightId);
      };
    });
    card.querySelectorAll("[data-branch]").forEach((btn) => {
      btn.onclick = (event) => {
        event.stopPropagation();
        this.openThread(btn.dataset.branch);
      };
    });
    card.querySelectorAll("[data-fork]").forEach((btn) => {
      btn.onclick = (event) => {
        event.stopPropagation();
        card.querySelectorAll(".fork-form").forEach((form) => {
          form.hidden = form.dataset.forkForm !== btn.dataset.fork;
        });
        const form = card.querySelector(`[data-fork-form="${cssEscape(btn.dataset.fork)}"]`);
        const input = form?.querySelector("input");
        if (input) {
          input.focus();
          input.select();
        }
      };
    });
    card.querySelectorAll(".fork-form").forEach((form) => {
      form.onsubmit = (event) => {
        event.preventDefault();
        event.stopPropagation();
        const label = form.querySelector("input")?.value.trim() || "branch";
        this.handlers.onFork?.(threadId, form.dataset.forkForm, label);
      };
    });
    card.querySelectorAll("[data-act='cancel-fork']").forEach((btn) => {
      btn.onclick = (event) => {
        event.stopPropagation();
        btn.closest(".fork-form").hidden = true;
      };
    });
    card.querySelectorAll("[data-delete]").forEach((btn) => {
      btn.onclick = (event) => {
        event.stopPropagation();
        this.handlers.onDeleteMessage?.(threadId, btn.dataset.delete);
      };
    });
    const textarea = card.querySelector("textarea:not(.packet-md)");
    const menu = card.querySelector(".send-menu");
    const sendBtn = card.querySelector("[data-act='send']");
    const caret = card.querySelector("[data-act='menu']");
    const copyPacket = card.querySelector("[data-act='copy-packet']");
    const packetField = card.querySelector(".packet-md");
    const thread = this.page?.threads.find((t) => t.id === threadId);
    if (copyPacket && packetField) {
      copyPacket.onclick = async (event) => {
        event.stopPropagation();
        try {
          await navigator.clipboard.writeText(packetField.value);
          this.toast("Packet copied. Paste it into the agent, then paste the reply here.");
        } catch {
          packetField.focus();
          packetField.select();
          this.toast("Select the packet and copy it.");
        }
      };
    }
    if (caret && menu) {
      caret.onclick = (event) => {
        event.stopPropagation();
        menu.hidden = !menu.hidden;
      };
    }
    card.querySelectorAll("[data-mode]").forEach((btn) => {
      btn.onclick = (event) => {
        event.stopPropagation();
        this.sendMode = btn.dataset.mode;
        if (threadId) this.threadModes[threadId] = this.sendMode;
        if (menu) menu.hidden = true;
        if (sendBtn) sendBtn.textContent = this.sendLabel(thread);
        if (textarea) textarea.placeholder = this.composerPlaceholder(thread);
      };
    });
    const send = () => {
      if (menu) menu.hidden = true;
      const content = textarea?.value.trim();
      if (!content) return;
      this.dispatchSend(threadId, content);
      textarea.value = "";
    };
    if (sendBtn) {
      sendBtn.onclick = (event) => {
        event.stopPropagation();
        send();
      };
    }
    if (textarea) {
      textarea.addEventListener("input", () => this.updateMentions(card, textarea));
      textarea.addEventListener("blur", () => this.closeMentions());
      textarea.addEventListener("keydown", (event) => {
        if (this.mentionsOpen(textarea)) {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            this.moveMention(event.key === "ArrowDown" ? 1 : -1);
            return;
          }
          if (event.key === "Enter" || event.key === "Tab") {
            event.preventDefault();
            this.chooseMention(this.mention.index);
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            this.closeMentions();
            return;
          }
        }
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          send();
        }
      });
    }
  }

  effectiveSendMode(thread) {
    if (thread?.id && this.threadModes[thread.id]) return this.threadModes[thread.id];
    const agent = lastConversationAgent(thread);
    if (agent) return agent;
    return this.sendMode || "comment";
  }

  sendLabel(thread) {
    if (thread?.awaitingAgent?.status === "pending") return "Waiting…";
    if (thread?.awaitingAgent?.status === "error") return "Save agent reply";
    const mode = this.effectiveSendMode(thread);
    if (mode === "cursor") return "Ask Cursor";
    if (mode === "claude-code") return "Ask Claude Code";
    return "Comment";
  }

  composerPlaceholder(thread) {
    const awaiting = thread?.awaitingAgent;
    if (awaiting?.status === "pending") {
      return `Waiting for ${agentName(awaiting.agent)}…`;
    }
    if (awaiting?.status === "error") {
      const name = agentName(awaiting.agent);
      return `Paste ${name}’s reply only if the host failed…`;
    }
    const mode = this.effectiveSendMode(thread);
    if (mode === "cursor") return "Reply to Cursor…";
    if (mode === "claude-code") return "Reply to Claude Code…";
    return "Write a comment…";
  }

  dispatchSend(threadId, content) {
    const thread = this.page?.threads.find((t) => t.id === threadId);
    const awaiting = thread?.awaitingAgent;
    if (awaiting?.status === "pending") return;
    const mode = this.effectiveSendMode(thread);
    if (awaiting?.status === "error" && mode !== "comment") {
      const agent = awaiting.agent || "cursor";
      this.awaitingAgent = null;
      this.handlers.onAgentReply?.(threadId, content, agent);
      return;
    }
    if (mode === "comment") {
      this.addOptimisticMessage(thread, content);
      Promise.resolve(this.handlers.onNote?.(threadId, content)).catch(() => {
        this.toast("That comment could not be saved. Please try again.");
        this.handlers.onRefresh?.();
      });
      return;
    }
    const agent = mode === "claude-code" ? "claude-code" : "cursor";
    this.threadModes[threadId] = mode;
    this.sendMode = mode;
    this.awaitingAgent = { threadId, agent };
    this.addOptimisticMessage(thread, content);
    thread.awaitingAgent = {
      agent,
      askedAt: Date.now(),
      status: "pending",
      optimistic: true
    };
    this.renderCards();
    Promise.resolve(this.handlers.onAgent?.(threadId, content, agent)).catch(() => {
      this.handlers.onRefresh?.();
    });
  }

  addOptimisticMessage(thread, content) {
    thread.messages = thread.messages || [];
    thread.messages.push({
      id: `pending-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      role: "user",
      content,
      createdAt: Date.now(),
      optimistic: true
    });
    this._skipDraftOnce = true;
    this.renderCards();
  }

  async updateMentions(card, textarea) {
    const menu = card.querySelector(".mention-menu");
    if (!menu) return;
    const caret = textarea.selectionStart;
    const match = textarea.value.slice(0, caret).match(/(?:^|\s)@([\w .'-]{0,40})$/);
    if (!match) {
      this.closeMentions();
      return;
    }
    const query = match[1].trim();
    const request = `${query}:${Date.now()}`;
    this.mentionRequest = request;
    const items = (await this.handlers.onSearchMentions?.(query)) || [];
    if (this.mentionRequest !== request) return;
    this.mention = {
      menu,
      textarea,
      items,
      index: 0,
      start: caret - match[1].length - 1
    };
    menu.onmousedown = (event) => event.preventDefault();
    this.paintMentions();
  }

  paintMentions() {
    const state = this.mention;
    if (!state) return;
    const { menu, items, index } = state;
    menu.innerHTML = items.length
      ? items
          .map(
            (item, i) =>
              `<button type="button" class="${i === index ? "is-active" : ""}" data-mention-index="${i}">
                <span class="mention-dot" style="--lp-mark:${COLORS[item.color]?.fill || "transparent"}"></span>
                <span class="mention-text">
                  <strong>${escapeHtml(clip(item.passage, 46))}</strong>
                  <small>${escapeHtml(mentionContext(item))}</small>
                </span>
              </button>`
          )
          .join("")
      : `<p>No conversation matches that yet</p>`;
    menu.hidden = false;
    menu.querySelectorAll("[data-mention-index]").forEach((btn) => {
      btn.onclick = (event) => {
        event.stopPropagation();
        this.chooseMention(Number(btn.dataset.mentionIndex));
      };
    });
  }

  moveMention(step) {
    const state = this.mention;
    if (!state?.items.length) return;
    state.index = (state.index + step + state.items.length) % state.items.length;
    this.paintMentions();
    state.menu.querySelector(".is-active")?.scrollIntoView({ block: "nearest" });
  }

  chooseMention(index) {
    const state = this.mention;
    const item = state?.items?.[index];
    if (!item) return;
    const label = clip(item.passage, 34).replace(/[[\]()]/g, "");
    const token = `@[${label}](livepage:${encodeMention(item.pageId, item.threadId)}) `;
    state.textarea.setRangeText(token, state.start, state.textarea.selectionStart, "end");
    this.closeMentions();
    state.textarea.focus();
  }

  closeMentions() {
    if (this.mention?.menu) this.mention.menu.hidden = true;
    this.mention = null;
  }

  mentionsOpen(textarea) {
    return Boolean(this.mention && this.mention.textarea === textarea && !this.mention.menu.hidden);
  }

  layoutCards() {
    if (!this.els?.gutter) return;
    const docHeight = this.view.contentHeight();
    document.documentElement.style.setProperty("--lp-doc-height", `${docHeight}px`);
    this.host.style.height = `${docHeight}px`;
    // Only cards that sit directly in the gutter are positioned; the orphan
    // dock keeps its own, and a highlight with no marks has nothing to align
    // to, so it must stay out of the stack rather than piling up at the top of
    // the document ahead of every real card.
    const cards = [...this.els.gutter.querySelectorAll(".gutter > .card")];
    const items = cards.map((el) => {
      const rect = highlightRect(el.dataset.highlight);
      return {
        el,
        preferred: rect ? this.view.contentTop(rect) : null,
        height: el.offsetHeight || 72
      };
    });
    for (const item of items) {
      if (item.preferred === null) item.el.style.removeProperty("top");
    }
    for (const placed of stackCards(items, CARD_GAP)) {
      placed.el.style.top = `${placed.top}px`;
    }
  }

  openThread(threadId) {
    const thread = this.page?.threads.find((t) => t.id === threadId);
    if (!thread) return;
    this.activeThreadId = threadId;
    this.renderCards();
    const card = this.els.gutter.querySelector(`.card[data-thread="${cssEscape(threadId)}"]`);
    const messages = card?.querySelector(".messages");
    if (messages) messages.scrollTop = messages.scrollHeight;
    const textarea = card?.querySelector("textarea");
    if (textarea) {
      requestAnimationFrame(() => textarea.focus());
    }
    if (!card) return;
    // A card in the dock is not anywhere on the page. Opening it must reveal
    // the card, not drag the reader to the top of the document.
    if (card.closest(".orphan-dock")) {
      this.expandDock();
      card.scrollIntoView({ block: "nearest" });
      return;
    }
    if (!card.style.top) return;
    const top = parseFloat(card.style.top);
    const viewTop = this.view.scrollTop();
    const viewBottom = viewTop + this.view.viewportHeight();
    if (top < viewTop + 24 || top > viewBottom - 160) {
      this.view.scrollToTop(top - 80);
    }
  }

  expandDock() {
    const body = this.els?.gutter?.querySelector(".dock-body");
    const head = this.els?.gutter?.querySelector(".dock-head");
    if (body) body.hidden = false;
    if (head) head.setAttribute("aria-expanded", "true");
    this.dockOpen = true;
  }

  closePanel() {
    this.activeThreadId = null;
    this.renderCards();
  }

  threadFor(highlightId) {
    const threads = (this.page?.threads || []).filter((t) => t.highlightId === highlightId);
    if (!threads.length) return null;
    const active = threads.find((t) => t.id === this.activeThreadId);
    if (active) return active;
    return threads.find((t) => !t.parentId) || threads[0];
  }

  markActiveHighlights() {
    const thread = this.page?.threads.find((t) => t.id === this.activeThreadId);
    document.querySelectorAll("mark.lp-hl").forEach((mark) => {
      mark.classList.toggle("is-active", Boolean(thread && mark.dataset.lpId === thread.highlightId));
    });
  }
}

/**
 * Stacks the cards that have a place on the page, newest position wins ties.
 *
 * Cards with no anchor are absent from the result entirely rather than falling
 * back to the top of the document, where they would sort ahead of every real
 * card and push the whole margin down.
 */
export function stackCards(items, gap) {
  const placed = (items || [])
    .filter((item) => typeof item.preferred === "number")
    .sort((a, b) => a.preferred - b.preferred);
  let cursor = 12;
  return placed.map((item) => {
    const top = Math.max(item.preferred, cursor);
    cursor = top + (item.height || 72) + gap;
    return { ...item, top };
  });
}

function clip(text, n) {
  const s = String(text || "").replace(/\s+/g, " ");
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function labelOf(message) {
  if (message.role === "agent") return agentName(message.agent);
  if (message.role === "system") return "LivePage";
  return "You";
}

function lastConversationAgent(thread) {
  const messages = thread?.messages || [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "agent") {
      return messages[i].agent === "claude-code" ? "claude-code" : "cursor";
    }
  }
  return null;
}

function nextForkLabel(page, source) {
  const siblings = (page?.threads || []).filter(
    (t) => t.highlightId === source.highlightId && (t.parentId === source.id || t.id === source.id)
  );
  return `Angle ${siblings.length + 1}`;
}

function agentName(agent) {
  return agent === "claude-code" ? "Claude" : "Cursor";
}

function awaitingCopy(awaiting) {
  if (awaiting?.status === "error") {
    return `${agentName(awaiting.agent)} could not reply`;
  }
  return `${agentName(awaiting?.agent)} is thinking`;
}

function threadLabel(thread) {
  if (!thread) return "Comment";
  if (!thread.parentId || thread.branchLabel === "main") return "Original conversation";
  if (/^branch-\d+$/i.test(thread.branchLabel || "")) {
    const number = Number(thread.branchLabel.split("-")[1]) + 1;
    return `Angle ${number}`;
  }
  return thread.branchLabel || "Another angle";
}

function colorHint(id) {
  const color = COLORS[id] || COLORS.lemon;
  return `${color.name} — ${color.purpose}`;
}

function encodeMention(pageId, threadId) {
  return `${encodeURIComponent(pageId || "")}/${encodeURIComponent(threadId || "")}`;
}

function decodeMention(value) {
  const [pageId = "", threadId = ""] = String(value || "").split("/");
  return [decodeURIComponent(pageId), decodeURIComponent(threadId)];
}

/**
 * An agent answers in markdown with LaTeX in it. Showing that raw put
 * `h_\theta(x) = \theta^\top x` in the margin and left the reader to decode
 * it, which defeats the point of the thought being right there.
 */
function messageHtml(content) {
  return renderMessage(content, {
    mention: (label, target) =>
      `<button type="button" class="mention" data-mention="${escapeHtml(
        target
      )}" title="Open this conversation">${icon("at", { size: 12 })}${escapeHtml(label)}</button>`
  });
}

function mentionContext(item) {
  const where = item.samePage ? "This page" : clip(item.pageTitle, 32);
  const count = `${item.messageCount} ${item.messageCount === 1 ? "message" : "messages"}`;
  return `${threadLabel(item)} · ${count} · ${where}`;
}
