import { pickContentRoot } from "../parse/page-parser.js";

/**
 * The article's argument in plain words, at the top of the article.
 *
 * The marks tell you where to stop; they do not tell you what the piece is
 * about until you have visited enough of them, and visiting them means
 * scrolling the whole article — which is the thing a reader skimming was
 * trying to avoid. The gist is the other half of the same pass: one card,
 * before the first paragraph, written for someone who does not have the
 * background the article assumes.
 *
 * It costs no extra agent call. The pass that marks the article writes it in
 * the same reply, and it is cached with the marks against the same content
 * hash, so an article read once is explained once.
 *
 * The card lives in a shadow root for two reasons. The page cannot restyle
 * what it cannot reach, and — more importantly — `textContent` does not cross
 * a shadow boundary, so the card is invisible to the parser that computes the
 * content hash. A card counted as article text would change the hash the
 * moment it was drawn, and the page would read itself again on every visit.
 */
const HOST_TAG = "lp-gist";

const CSS = `
:host { all: initial; display: block; margin: 0 0 1.4em; }
.card {
  box-sizing: border-box;
  border: 1px solid rgba(28, 23, 18, 0.14);
  border-left: 3px solid #E8CF62;
  border-radius: 10px;
  background: #fffcf7;
  color: #1c1712;
  padding: 13px 15px 12px;
  font: 15px/1.55 ui-sans-serif, "Segoe UI", system-ui, sans-serif;
  box-shadow: 0 6px 18px rgba(28, 23, 18, 0.07);
}
.top { display: flex; align-items: center; gap: 8px; margin-bottom: 7px; }
.label {
  flex: 1;
  font-size: 10px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: #8a6d1f;
}
.fold, .close {
  border: 0;
  background: none;
  padding: 2px 5px;
  border-radius: 5px;
  cursor: pointer;
  color: #756b61;
  font: inherit;
  font-size: 12px;
  line-height: 1;
}
.fold:hover, .close:hover { background: rgba(28, 23, 18, 0.07); color: #1c1712; }
.body { margin: 0; color: #2b241d; }
.marks {
  margin-top: 9px;
  padding: 0;
  border: 0;
  background: none;
  cursor: pointer;
  font: inherit;
  font-size: 12.5px;
  color: #7a6a4e;
  text-align: left;
}
.marks:hover { color: #1c1712; text-decoration: underline; }
:host(.is-folded) .body, :host(.is-folded) .marks { display: none; }
:host(.is-folded) .card { padding-bottom: 10px; }
:host(.is-folded) .top { margin-bottom: 0; }

/* Drawn in rather than snapped in, for the same reason the marks are: a pass
   takes a while, and an answer that appears fully formed reads as one that was
   always there. */
:host(.is-fresh) .card { animation: lp-gist-in 420ms ease-out both; }
@keyframes lp-gist-in {
  from { opacity: 0; transform: translateY(-5px); }
  to { opacity: 1; transform: none; }
}
@media (prefers-reduced-motion: reduce) {
  :host(.is-fresh) .card { animation: none; }
}

:host-context(html.lp-theme-dark) .card {
  border-color: rgba(238, 230, 219, 0.18);
  border-left-color: #E8CF62;
  background: #211e1a;
  color: #ece5db;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.42);
}
:host-context(html.lp-theme-dark) .body { color: #d7cfc4; }
:host-context(html.lp-theme-dark) .label { color: #d3b45f; }
:host-context(html.lp-theme-dark) .fold, :host-context(html.lp-theme-dark) .close { color: #a3998e; }
:host-context(html.lp-theme-dark) .fold:hover, :host-context(html.lp-theme-dark) .close:hover {
  background: rgba(238, 230, 219, 0.1);
  color: #ece5db;
}
:host-context(html.lp-theme-dark) .marks { color: #b6a684; }
`;

let host = null;
let shadow = null;

/**
 * Puts the gist on the page, or takes it off when there is nothing to say.
 *
 * Called on every pass, cached or fresh, so it has to be idempotent: the same
 * gist arriving twice must not stack two cards, and a page whose gist went
 * away must lose the card it already has.
 */
export function showGist(text, { reveal = false, markCount = 0, onJumpToMark } = {}) {
  const gist = String(text || "").trim();
  if (!gist) {
    clearGist();
    return false;
  }

  const mount = gistMount();
  if (!mount) return false;

  if (!host) {
    host = document.createElement(HOST_TAG);
    host.className = "lp-ignore";
    shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>${CSS}</style>
      <div class="card">
        <div class="top">
          <span class="label">In plain words</span>
          <button type="button" class="fold" title="Fold this away">–</button>
          <button type="button" class="close" title="Dismiss until this article changes" aria-label="Dismiss">×</button>
        </div>
        <p class="body"></p>
        <button type="button" class="marks" hidden></button>
      </div>
    `;
    shadow.querySelector(".fold").onclick = () => {
      const folded = host.classList.toggle("is-folded");
      shadow.querySelector(".fold").textContent = folded ? "+" : "–";
    };
    shadow.querySelector(".close").onclick = () => clearGist();
  }

  // Re-inserted rather than left where it was: a client-rendered article can
  // replace the element the card was sitting in, and a card orphaned inside a
  // detached subtree is a card nobody sees.
  if (host.parentNode !== mount.parent || host.nextSibling !== mount.before) {
    mount.parent.insertBefore(host, mount.before);
  }

  shadow.querySelector(".body").textContent = gist;
  const jump = shadow.querySelector(".marks");
  jump.hidden = !markCount;
  if (markCount) {
    jump.textContent = `${markCount} passage${markCount === 1 ? "" : "s"} marked below · ⌥J to move between them`;
    jump.onclick = () => onJumpToMark?.();
  }

  host.classList.toggle("is-fresh", Boolean(reveal));
  return true;
}

/** Takes you back to the card, for when the pill is all you can see. */
export function scrollToGist() {
  if (!host?.isConnected) return false;
  host.classList.remove("is-folded");
  const fold = shadow?.querySelector(".fold");
  if (fold) fold.textContent = "\u2013";
  window.scrollTo({ top: host.getBoundingClientRect().top + window.scrollY - 90, behavior: "smooth" });
  return true;
}

export function clearGist() {
  host?.remove();
  host = null;
  shadow = null;
}

const FIRST_PROSE = "p, li, blockquote, pre";

/**
 * Where the top of the article is, in the live document.
 *
 * Not the top of the content element — that is usually the headline, the
 * byline and the hero image, and a gist above those reads as a page banner
 * rather than as something about this piece. It goes immediately before the
 * first real paragraph, which is where a publication would put its own
 * standfirst.
 */
function gistMount() {
  const root = pickContentRoot(document);
  if (!root) return null;
  for (const node of root.querySelectorAll(FIRST_PROSE)) {
    if (node.closest(".lp-ignore") || node.closest(HOST_TAG)) continue;
    if ((node.textContent || "").trim().length < 80) continue;
    // Out of whatever wrapper divs the paragraph is buried in, but never past
    // something that already comes before it.
    //
    // Climbing blindly to a child of the root was wrong on any page with no
    // <article> or <main>: the root is then the body, the whole page is one
    // wrapper div, and the card was hoisted out of it — landing above the
    // headline, which reads as a site banner rather than as something about
    // this piece. A previous sibling is the signal that there is content
    // ahead of this paragraph, so the climb stops there and the card goes in
    // beside it instead.
    let target = node;
    while (target.parentElement && target.parentElement !== root && !precededBy(target)) {
      target = target.parentElement;
    }
    if (!target.parentElement) continue;
    return { parent: target.parentElement, before: target };
  }
  return root.firstElementChild ? { parent: root, before: root.firstElementChild } : null;
}

/**
 * Whether anything of the page's own comes before this element.
 *
 * The card itself does not count, or the mount would walk a step less far
 * every time it was recomputed and the card would creep down the page.
 */
function precededBy(element) {
  let previous = element.previousElementSibling;
  while (previous && (previous.tagName.toLowerCase() === HOST_TAG || previous.classList?.contains("lp-ignore"))) {
    previous = previous.previousElementSibling;
  }
  return Boolean(previous);
}
