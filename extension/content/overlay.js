import { COLORS, COLOR_IDS } from "../shared/colors.js";
import { formatRelative } from "../shared/time.js";
import { highlightRect } from "./highlights.js";

const STATUSES = ["open", "parked", "todo", "fog", "resolved"];

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
        <svg class="connectors"></svg>
        <div class="rail"><div class="rail-line"></div><div class="markers"></div></div>
        <div class="toolbar" hidden></div>
        <aside class="panel" hidden></aside>
        <div class="toast" hidden></div>
      </div>
    `;
    this.els = {
      banner: this.shadow.querySelector(".banner"),
      connectors: this.shadow.querySelector(".connectors"),
      markers: this.shadow.querySelector(".markers"),
      toolbar: this.shadow.querySelector(".toolbar"),
      panel: this.shadow.querySelector(".panel"),
      toast: this.shadow.querySelector(".toast")
    };
    this.bind();
    document.documentElement.appendChild(this.host);
  }

  bind() {
    window.addEventListener("scroll", () => this.syncGeometry(), { passive: true });
    window.addEventListener("resize", () => this.syncGeometry());
  }

  setPage(page) {
    this.page = page;
    this.syncGeometry();
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
    bar.innerHTML = COLOR_IDS.map(
      (id) =>
        `<button class="swatch" title="${COLORS[id].name}" style="--lp-mark:${COLORS[id].fill}" data-color="${id}"></button>`
    ).join("") + `<button class="ghost" data-act="comment">Comment</button>`;
    const top = rect.top - 44;
    const left = Math.min(rect.left, document.documentElement.clientWidth - 280);
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

  syncGeometry() {
    if (!this.page || !this.els?.markers) return;
    const markers = this.page.highlights
      .map((h) => ({ h, rect: highlightRect(h.id) }))
      .filter((x) => x.rect);
    this.els.markers.innerHTML = markers
      .map(({ h }) => {
        const thread = this.page.threads.find((t) => t.highlightId === h.id && !t.parentId)
          || this.page.threads.find((t) => t.highlightId === h.id);
        const preview = thread?.messages?.[0]?.content || h.text;
        const active = this.activeThreadId && thread?.id === this.activeThreadId ? "is-active" : "";
        return `<button class="marker ${active}" data-id="${h.id}" style="--lp-mark:${COLORS[h.color]?.fill || "#F6E27A"}"><span>${escapeHtml(clip(preview, 28))}</span></button>`;
      })
      .join("");
    this.els.markers.querySelectorAll(".marker").forEach((btn, i) => {
      const { rect, h } = markers[i];
      btn.style.top = `${rect.top + rect.height / 2}px`;
      btn.onclick = () => {
        const thread =
          this.page.threads.find((t) => t.highlightId === h.id && t.id === this.activeThreadId) ||
          this.page.threads.find((t) => t.highlightId === h.id);
        if (thread) this.openThread(thread.id);
        else this.handlers.onOpenHighlight?.(h.id);
      };
    });
    this.drawConnectors(markers);
  }

  drawConnectors(markers) {
    const svg = this.els.connectors;
    const w = window.innerWidth;
    const h = window.innerHeight;
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    svg.innerHTML = markers
      .map(({ rect }) => {
        const x1 = rect.right;
        const y1 = rect.top + (rect.bottom - rect.top) / 2;
        const x2 = w - 22;
        const y2 = y1;
        const mid = (x1 + x2) / 2;
        return `<path d="M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}" fill="none" stroke="rgba(63,107,82,0.35)" stroke-width="1.2"/>`;
      })
      .join("");
  }

  openThread(threadId) {
    this.activeThreadId = threadId;
    const thread = this.page?.threads.find((t) => t.id === threadId);
    if (!thread) return;
    const highlight = this.page.highlights.find((h) => h.id === thread.highlightId);
    const branches = this.page.threads.filter((t) => t.highlightId === thread.highlightId);
    this.els.panel.hidden = false;
    this.els.panel.innerHTML = `
      <button class="close" title="Close">×</button>
      <header>
        <p class="kicker">${escapeHtml(thread.branchLabel || "main")} · ${escapeHtml(thread.status)}</p>
        <p class="quote">${escapeHtml(clip(highlight?.text || "", 180))}</p>
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
      </header>
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
        <textarea placeholder="Ask, disagree, park a why…"></textarea>
        <div class="row">
          <select data-agent>
            <option value="cursor">Cursor Agent</option>
            <option value="claude-code">Claude Code</option>
          </select>
          <button class="ghost" data-act="save">Save note</button>
          <button class="solid" data-act="agent">Send to agent</button>
        </div>
        <div class="row">
          <button class="ghost" data-act="paste">Paste agent reply</button>
          <button class="ghost" data-act="obsidian">Dump to Obsidian</button>
        </div>
      </div>
    `;
    this.els.panel.querySelector(".close").onclick = () => this.closePanel();
    this.els.panel.querySelectorAll("[data-status]").forEach((btn) => {
      btn.onclick = () => this.handlers.onStatus?.(thread.id, btn.dataset.status);
    });
    this.els.panel.querySelectorAll("[data-branch]").forEach((btn) => {
      btn.onclick = () => this.openThread(btn.dataset.branch);
    });
    this.els.panel.querySelectorAll("[data-fork]").forEach((btn) => {
      btn.onclick = () => {
        const label = prompt("Branch name", "other take") || "branch";
        this.handlers.onFork?.(thread.id, btn.dataset.fork, label);
      };
    });
    const textarea = this.els.panel.querySelector("textarea");
    this.els.panel.querySelector("[data-act='save']").onclick = () => {
      const content = textarea.value.trim();
      if (!content) return;
      this.handlers.onNote?.(thread.id, content);
      textarea.value = "";
    };
    this.els.panel.querySelector("[data-act='agent']").onclick = () => {
      const ask = textarea.value.trim();
      if (!ask) {
        this.toast("Write the ask first. Agents only get that ask.");
        return;
      }
      const agent = this.els.panel.querySelector("[data-agent]").value;
      this.handlers.onAgent?.(thread.id, ask, agent);
      textarea.value = "";
    };
    this.els.panel.querySelector("[data-act='paste']").onclick = () => {
      const content = prompt("Paste the agent reply");
      if (!content) return;
      const agent = this.els.panel.querySelector("[data-agent]").value;
      this.handlers.onAgentReply?.(thread.id, content, agent);
    };
    this.els.panel.querySelector("[data-act='obsidian']").onclick = () =>
      this.handlers.onObsidian?.();
    this.syncGeometry();
    document.querySelectorAll("mark.lp-hl").forEach((m) => {
      m.classList.toggle("is-active", m.dataset.lpId === highlight?.id);
    });
  }

  closePanel() {
    this.activeThreadId = null;
    this.els.panel.hidden = true;
    document.querySelectorAll("mark.lp-hl.is-active").forEach((m) => m.classList.remove("is-active"));
    this.syncGeometry();
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
