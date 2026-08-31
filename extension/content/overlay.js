import { COLORS, COLOR_IDS } from "../shared/colors.js";
import { formatRelative } from "../shared/time.js";
import { highlightRect } from "./highlights.js";

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
.banner, .feed-offer, .toolbar, .toast, .card { pointer-events: auto; }
.banner[hidden], .feed-offer[hidden], .toolbar[hidden], .toast[hidden] { display: none !important; }
.toolbar {
  position: fixed; z-index: 2147483646; display: flex; gap: 4px; align-items: center;
  padding: 6px; background: #fffcf7; border: 1px solid rgba(28,23,18,0.12);
  border-radius: 999px; box-shadow: 0 14px 40px rgba(28,23,18,0.16);
}
.swatch { width: 18px; height: 18px; border-radius: 50%; border: 1px solid rgba(28,23,18,0.18); cursor: pointer; background: var(--lp-mark); }
button.ghost { appearance: none; border: 0; background: transparent; color: #1c1712; padding: 6px 9px; font: inherit; cursor: pointer; border-radius: 999px; }
.banner, .toast, .feed-offer {
  position: fixed; z-index: 2147483646; background: #fffcf7; border: 1px solid rgba(28,23,18,0.1);
  border-radius: 14px; padding: 10px 12px; box-shadow: 0 10px 40px rgba(28,23,18,0.12);
}
.banner { top: 12px; left: 50%; transform: translateX(-50%); display: flex; gap: 10px; align-items: center; }
.toast { bottom: 20px; left: 50%; transform: translateX(-50%); background: #1c1712; color: #f6f1e8; border-radius: 999px; }
button.solid { appearance: none; border: 0; background: #3f6b52; color: #f6f1e8; padding: 6px 10px; font: inherit; cursor: pointer; border-radius: 999px; font-weight: 600; }
`;

function makeHost(kind) {
  const host = document.createElement("div");
  host.className = "lp-ignore";
  host.setAttribute("data-lp", kind);
  return host;
}

export class Overlay {
  constructor() {
    this.host = makeHost("root");
    this.shadow = this.host.attachShadow({ mode: "open" });
    this.floatHost = makeHost("float");
    this.floatShadow = this.floatHost.attachShadow({ mode: "open" });
    this.page = null;
    this.activeThreadId = null;
    this.locked = false;
    this.snapshotTexts = null;
    this.handlers = {};
    this.sendMode = "comment";
    this.threadModes = {};
    this.awaitingAgent = null;
    this.els = { toolbar: null, banner: null, toast: null, feedOffer: null, gutter: null };
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
        <div class="banner" hidden></div>
        <div class="toast" hidden></div>
        <div class="feed-offer" hidden></div>
      </div>
    `;
    this.els.toolbar = this.floatShadow.querySelector(".toolbar");
    this.els.banner = this.floatShadow.querySelector(".banner");
    this.els.toast = this.floatShadow.querySelector(".toast");
    this.els.feedOffer = this.floatShadow.querySelector(".feed-offer");
    this.attachHosts();
  }

  attachHosts() {
    const root = document.documentElement;
    if (!root) return;
    if (this.floatHost.parentNode !== root) root.appendChild(this.floatHost);
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
    document.documentElement.style.setProperty("--lp-gutter", `${GUTTER}px`);
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
      document.documentElement.appendChild(rail);
    }
    document.documentElement.appendChild(this.host);
    this.attachHosts();
    this.applyRail();
  }

  bind() {
    window.addEventListener("resize", () => this.layoutCards(), { passive: true });
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

  setPage(page) {
    this.page = page;
    if (this.awaitingAgent) {
      const thread = page?.threads?.find((t) => t.id === this.awaitingAgent.threadId);
      const status = thread?.awaitingAgent?.status;
      if (status !== "pending" && status !== "error") this.awaitingAgent = null;
    }
    this.renderCards();
    this.applyRail();
    if (this.activeThreadId) this.openThread(this.activeThreadId);
  }

  applyRail() {
    const show = (this.page?.highlights || []).length > 0;
    this.host.hidden = !show;
    document.documentElement.classList.toggle("lp-rail-on", show);
    if (show) {
      document.documentElement.style.setProperty("--lp-gutter", `${GUTTER}px`);
    } else {
      document.documentElement.style.removeProperty("--lp-gutter");
    }
  }

  setLock({ locked, reason, snapshotTexts }) {
    this.locked = locked;
    this.snapshotTexts = snapshotTexts || null;
    if (!this.els?.banner) return;
    if (!locked) {
      this.els.banner.hidden = true;
      return;
    }
    this.els.banner.hidden = false;
    this.els.banner.innerHTML = `
      <p><strong>Infinite page.</strong> ${reason || "This page keeps growing."} Highlighting is locked until you snapshot the current view.</p>
      <button class="solid" data-act="snapshot">Snapshot</button>
      <button class="ghost" data-act="dismiss">Not now</button>
    `;
    this.els.banner.querySelector("[data-act='snapshot']").onclick = () =>
      this.handlers.onSnapshot?.();
    this.els.banner.querySelector("[data-act='dismiss']").onclick = () => {
      this.els.banner.hidden = true;
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

  showToolbar(rect, { onHighlight, onComment, onSnapshot } = {}) {
    this.attachHosts();
    const bar = this.els?.toolbar;
    if (!bar) return;
    bar.hidden = false;
    bar.removeAttribute("hidden");
    if (onSnapshot && !onHighlight) {
      bar.innerHTML = `<button class="solid" data-act="snapshot">Snapshot to highlight</button>`;
    } else {
      bar.innerHTML =
        COLOR_IDS.map(
          (id) =>
            `<button class="swatch" title="${COLORS[id].name}" style="--lp-mark:${COLORS[id].fill}" data-color="${id}"></button>`
        ).join("") + `<button class="ghost" data-act="comment">Comment</button>`;
    }
    const top = rect.top - 44;
    const left = Math.min(rect.left, document.documentElement.clientWidth - 280);
    bar.style.top = `${Math.max(8, top)}px`;
    bar.style.left = `${Math.max(8, left)}px`;
    bar.onpointerdown = (event) => event.preventDefault();
    bar.onmousedown = (event) => event.preventDefault();
    bar.querySelector("[data-act='snapshot']")?.addEventListener("click", (event) => {
      event.preventDefault();
      this.hideToolbar();
      onSnapshot?.();
    });
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
    this.els.gutter.innerHTML = this.page.highlights
      .map((highlight) => this.cardHtml(highlight))
      .join("");
    this.els.gutter.querySelectorAll(".card").forEach((card) => this.bindCard(card));
    this.layoutCards();
    this.markActiveHighlights();
    this.applyRail();
    const open = this.els.gutter.querySelector(".card.is-open .messages");
    if (open) open.scrollTop = open.scrollHeight;
  }

  cardHtml(highlight) {
    const thread = this.threadFor(highlight.id);
    const open = Boolean(thread && thread.id === this.activeThreadId);
    const color = COLORS[highlight.color]?.fill || "#F6E27A";
    const preview = thread?.messages?.[0]?.content || "Add a comment";
    const count = thread?.messages?.length || 0;
    if (!open) {
      return `
        <article class="card" data-highlight="${highlight.id}" data-thread="${thread?.id || ""}" style="--lp-mark:${color}">
          <p class="meta-line">
            <span>${escapeHtml(thread?.branchLabel || "note")}</span>
            <span>${count ? `${count}` : ""}</span>
            <button type="button" class="hl-delete" data-act="delete-hl" title="Delete highlight">×</button>
          </p>
          <p class="quote">${escapeHtml(clip(highlight.text, 90))}</p>
          <p class="preview">${escapeHtml(clip(preview, 110))}</p>
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
              (id) =>
                `<button type="button" class="swatch ${highlight.color === id ? "is-on" : ""}" title="${COLORS[id].name}" style="--lp-mark:${COLORS[id].fill}" data-color="${id}"></button>`
            ).join("")}
          </div>
          <button type="button" class="ghost" data-act="move-hl">Replace span</button>
          <button type="button" class="hl-delete" data-act="delete-hl">Delete</button>
        </div>
        <p class="quote">${escapeHtml(clip(highlight.text, 180))}</p>
        ${
          branches.length > 1
            ? `<div class="branch-list">${branches
                .map(
                  (b) =>
                    `<button class="chip ${b.id === thread.id ? "is-on" : ""}" data-branch="${b.id}">${escapeHtml(
                      b.parentId ? `↳ ${b.branchLabel}` : b.branchLabel
                    )}</button>`
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
              ? `<div class="packet">
                  <p class="kicker">${escapeHtml(awaitingCopy(thread.awaitingAgent))}</p>
                  ${
                    thread.awaitingAgent.status === "error"
                      ? `<p class="error">${escapeHtml(thread.awaitingAgent.error || "Agent host did not reply.")}</p>
                  <textarea class="packet-md" readonly>${escapeHtml(thread.awaitingAgent.packet || "")}</textarea>
                  <button type="button" class="ghost" data-act="copy-packet">Copy packet</button>`
                      : `<p class="hint">LivePage is talking to ${escapeHtml(agentName(thread.awaitingAgent.agent))}${thread.awaitingAgent.model ? ` · ${escapeHtml(thread.awaitingAgent.model)}` : ""}. The reply will land in this thread.</p>`
                  }
                </div>`
              : ""
          }
          <textarea placeholder="${escapeHtml(this.composerPlaceholder(thread))}"></textarea>
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
            <p>${escapeHtml(m.content)}</p>
            <div class="msg-actions">
              <button type="button" class="fork" data-fork="${m.id}">Branch</button>
              <button type="button" class="delete" data-delete="${m.id}">Delete</button>
            </div>
            <form class="fork-form" hidden data-fork-form="${m.id}">
              <input type="text" name="label" value="${escapeHtml(suggested)}" placeholder="Branch name" maxlength="48" />
              <button type="submit">Start branch</button>
              <button type="button" data-act="cancel-fork">Cancel</button>
            </form>
          </article>
          ${
            forks.length
              ? `<div class="fork-off">
                  <span class="fork-kicker">branched</span>
                  ${forks
                    .map(
                      (b) =>
                        `<button type="button" class="chip" data-branch="${b.id}">${escapeHtml(b.branchLabel)}</button>`
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
    card.onclick = (event) => {
      if (event.target.closest("button, textarea, select, a, .composer, .fork-form, input")) return;
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
    card.querySelector("[data-act='move-hl']")?.addEventListener("click", (event) => {
      event.stopPropagation();
      this.handlers.onMoveHighlight?.(highlightId);
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
        const form = card.querySelector(`[data-fork-form="${CSS.escape(btn.dataset.fork)}"]`);
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
      textarea.addEventListener("keydown", (event) => {
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
      this.handlers.onNote?.(threadId, content);
      return;
    }
    const agent = mode === "claude-code" ? "claude-code" : "cursor";
    this.threadModes[threadId] = mode;
    this.sendMode = mode;
    this.awaitingAgent = { threadId, agent };
    this.handlers.onAgent?.(threadId, content, agent);
  }

  layoutCards() {
    if (!this.els?.gutter) return;
    const docHeight = Math.max(
      document.documentElement.scrollHeight,
      document.body?.scrollHeight || 0,
      window.innerHeight
    );
    document.documentElement.style.setProperty("--lp-doc-height", `${docHeight}px`);
    this.host.style.height = `${docHeight}px`;
    const cards = [...this.els.gutter.querySelectorAll(".card")];
    const items = cards
      .map((el) => {
        const rect = highlightRect(el.dataset.highlight);
        const preferred = rect ? rect.top + window.scrollY : 12;
        return { el, preferred, height: el.offsetHeight || 72 };
      })
      .sort((a, b) => a.preferred - b.preferred);
    let cursor = 12;
    for (const item of items) {
      const top = Math.max(item.preferred, cursor);
      item.el.style.top = `${top}px`;
      cursor = top + item.height + CARD_GAP;
    }
  }

  openThread(threadId) {
    const thread = this.page?.threads.find((t) => t.id === threadId);
    if (!thread) return;
    this.activeThreadId = threadId;
    this.renderCards();
    const card = this.els.gutter.querySelector(`.card[data-thread="${CSS.escape(threadId)}"]`);
    const textarea = card?.querySelector("textarea");
    if (textarea) {
      requestAnimationFrame(() => textarea.focus());
    }
    if (card) {
      const top = parseFloat(card.style.top || "0");
      const viewTop = window.scrollY;
      const viewBottom = viewTop + window.innerHeight;
      if (top < viewTop + 24 || top > viewBottom - 160) {
        window.scrollTo({ top: Math.max(0, top - 80), behavior: "smooth" });
      }
    }
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
  if (message.role === "agent") return `Agent · ${message.agent || "unknown"}`;
  if (message.role === "system") return "System";
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
  return `branch-${siblings.length}`;
}

function agentName(agent) {
  return agent === "claude-code" ? "Claude Code" : "Cursor Agent";
}

function awaitingCopy(awaiting) {
  if (awaiting?.status === "error") {
    return `${agentName(awaiting.agent)} did not reply. Keep npm run agent-host running so it can call your local agent / claude CLIs.`;
  }
  return `Asking ${agentName(awaiting?.agent)}…`;
}
