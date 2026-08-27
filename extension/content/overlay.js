import { COLORS, COLOR_IDS } from "../shared/colors.js";
import { formatRelative } from "../shared/time.js";
import { highlightRect } from "./highlights.js";

const STATUSES = ["open", "parked", "todo", "fog", "resolved"];
const GUTTER = 328;
const CARD_GAP = 10;

export class Overlay {
  constructor() {
    this.host = document.createElement("lp-root");
    this.host.className = "lp-ignore";
    this.host.setAttribute("data-lp", "root");
    this.shadow = this.host.attachShadow({ mode: "open" });
    this.page = null;
    this.activeThreadId = null;
    this.locked = false;
    this.snapshotTexts = null;
    this.handlers = {};
    this.ready = this.render();
  }

  async render() {
    let css = "";
    try {
      const cssUrl = chrome.runtime?.getURL
        ? chrome.runtime.getURL("content/overlay.css")
        : new URL("./overlay.css", import.meta.url).href;
      css = await fetch(cssUrl).then((r) => r.text());
    } catch {
      css = "";
    }
    this.shadow.innerHTML = `
      <style>${css}</style>
      <div class="lp-root">
        <div class="banner" hidden></div>
        <div class="gutter"></div>
        <div class="toolbar" hidden></div>
        <div class="toast" hidden></div>
      </div>
    `;
    this.els = {
      banner: this.shadow.querySelector(".banner"),
      gutter: this.shadow.querySelector(".gutter"),
      toolbar: this.shadow.querySelector(".toolbar"),
      toast: this.shadow.querySelector(".toast")
    };
    this.bind();
    document.documentElement.style.setProperty("--lp-gutter", `${GUTTER}px`);
    document.documentElement.classList.add("lp-rail-on");
    if (!document.getElementById("lp-gutter-style")) {
      const style = document.createElement("style");
      style.id = "lp-gutter-style";
      style.textContent = `
        html.lp-rail-on {
          position: relative;
          box-sizing: border-box;
          padding-right: var(--lp-gutter, 328px) !important;
          scroll-padding-right: var(--lp-gutter, 328px);
        }
      `;
      document.documentElement.appendChild(style);
    }
    document.documentElement.appendChild(this.host);
  }

  bind() {
    window.addEventListener("resize", () => this.layoutCards(), { passive: true });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") this.closePanel();
    });
    document.addEventListener("mousedown", (event) => {
      if (!this.activeThreadId) return;
      if (event.target.closest?.("mark.lp-hl")) return;
      if (event.composedPath().includes(this.host)) return;
      this.closePanel();
    });
  }

  setPage(page) {
    this.page = page;
    this.renderCards();
    if (this.activeThreadId) this.openThread(this.activeThreadId);
  }

  setLock({ locked, reason, snapshotTexts }) {
    this.locked = locked;
    this.snapshotTexts = snapshotTexts || null;
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

  showToolbar(rect, { onHighlight, onComment }) {
    const bar = this.els.toolbar;
    bar.hidden = false;
    bar.innerHTML =
      COLOR_IDS.map(
        (id) =>
          `<button class="swatch" title="${COLORS[id].name}" style="--lp-mark:${COLORS[id].fill}" data-color="${id}"></button>`
      ).join("") + `<button class="ghost" data-act="comment">Comment</button>`;
    const top = rect.top - 44;
    const left = Math.min(rect.left, document.documentElement.clientWidth - GUTTER - 280);
    bar.style.top = `${Math.max(8, top)}px`;
    bar.style.left = `${Math.max(8, left)}px`;
    bar.onmousedown = (event) => event.preventDefault();
    bar.querySelectorAll(".swatch").forEach((btn) => {
      btn.onclick = (event) => {
        event.preventDefault();
        onHighlight(btn.dataset.color);
        this.hideToolbar();
      };
    });
    bar.querySelector("[data-act='comment']").onclick = (event) => {
      event.preventDefault();
      onComment();
      this.hideToolbar();
    };
  }

  hideToolbar() {
    this.els.toolbar.hidden = true;
  }

  toast(text) {
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
          <p class="meta-line"><span>${escapeHtml(thread?.branchLabel || "note")}</span><span>${count ? `${count}` : ""}</span></p>
          <p class="quote">${escapeHtml(clip(highlight.text, 90))}</p>
          <p class="preview">${escapeHtml(clip(preview, 110))}</p>
        </article>`;
    }
    const branches = this.page.threads.filter((t) => t.highlightId === highlight.id);
    return `
      <article class="card is-open" data-highlight="${highlight.id}" data-thread="${thread.id}" style="--lp-mark:${color}">
        <button class="close" title="Collapse">×</button>
        <p class="kicker">${escapeHtml(thread.branchLabel || "main")} · ${escapeHtml(thread.status)}</p>
        <p class="quote">${escapeHtml(clip(highlight.text, 180))}</p>
        <div class="statuses">
          ${STATUSES.map(
            (s) =>
              `<button class="chip ${s === thread.status ? "is-on" : ""}" data-status="${s}">${s}</button>`
          ).join("")}
        </div>
        ${
          branches.length > 1
            ? `<div class="branch-list">${branches
                .map(
                  (b) =>
                    `<button class="chip ${b.id === thread.id ? "is-on" : ""}" data-branch="${b.id}">${escapeHtml(b.branchLabel)}</button>`
                )
                .join("")}</div>`
            : ""
        }
        <div class="messages">
          ${(thread.messages || [])
            .map(
              (m) => `
            <article class="msg ${m.role === "agent" ? "agent" : ""}" data-msg="${m.id}">
              <div class="meta"><span>${escapeHtml(labelOf(m))}</span><span>${formatRelative(m.createdAt)}</span></div>
              <p>${escapeHtml(m.content)}</p>
              <button class="fork" data-fork="${m.id}">Fork from here</button>
            </article>`
            )
            .join("")}
        </div>
        <div class="composer">
          <textarea placeholder="Write in the margin…"></textarea>
          <div class="row">
            <select data-agent>
              <option value="cursor">Cursor Agent</option>
              <option value="claude-code">Claude Code</option>
            </select>
            <button class="ghost" data-act="save">Save</button>
            <button class="solid" data-act="agent">Send to agent</button>
          </div>
          <div class="row">
            <button class="ghost" data-act="paste">Paste agent reply</button>
            <button class="ghost" data-act="obsidian">Dump to Obsidian</button>
          </div>
        </div>
      </article>`;
  }

  bindCard(card) {
    const highlightId = card.dataset.highlight;
    const threadId = card.dataset.thread;
    card.onclick = (event) => {
      if (event.target.closest("button, textarea, select, a")) return;
      if (threadId) this.openThread(threadId);
      else this.handlers.onOpenHighlight?.(highlightId);
    };
    const close = card.querySelector(".close");
    if (close) close.onclick = (event) => {
      event.stopPropagation();
      this.closePanel();
    };
    card.querySelectorAll("[data-status]").forEach((btn) => {
      btn.onclick = (event) => {
        event.stopPropagation();
        this.handlers.onStatus?.(threadId, btn.dataset.status);
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
        const label = prompt("Branch name", "other take") || "branch";
        this.handlers.onFork?.(threadId, btn.dataset.fork, label);
      };
    });
    const textarea = card.querySelector("textarea");
    const save = card.querySelector("[data-act='save']");
    if (save) {
      save.onclick = (event) => {
        event.stopPropagation();
        const content = textarea.value.trim();
        if (!content) return;
        this.handlers.onNote?.(threadId, content);
        textarea.value = "";
      };
    }
    const agentBtn = card.querySelector("[data-act='agent']");
    if (agentBtn) {
      agentBtn.onclick = (event) => {
        event.stopPropagation();
        const ask = textarea.value.trim();
        if (!ask) {
          this.toast("Write the ask first. Agents only get that ask.");
          return;
        }
        const agent = card.querySelector("[data-agent]").value;
        this.handlers.onAgent?.(threadId, ask, agent);
        textarea.value = "";
      };
    }
    const paste = card.querySelector("[data-act='paste']");
    if (paste) {
      paste.onclick = (event) => {
        event.stopPropagation();
        const content = prompt("Paste the agent reply");
        if (!content) return;
        const agent = card.querySelector("[data-agent]").value;
        this.handlers.onAgentReply?.(threadId, content, agent);
      };
    }
    const obsidian = card.querySelector("[data-act='obsidian']");
    if (obsidian) {
      obsidian.onclick = (event) => {
        event.stopPropagation();
        this.handlers.onObsidian?.();
      };
    }
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
