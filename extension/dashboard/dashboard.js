import { call } from "../shared/bridge.js";
import { formatRelative } from "../shared/time.js";
import { COLORS } from "../shared/colors.js";
import { downloadMarkdown } from "../export/download.js";

const state = {
  pages: [],
  filter: "waiting",
  query: "",
  activeId: null
};

const els = {
  grid: document.getElementById("grid"),
  push: document.getElementById("waiting-push"),
  counts: document.getElementById("counts"),
  search: document.getElementById("search"),
  drawer: document.getElementById("drawer")
};

document.querySelectorAll(".nav").forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll(".nav").forEach((b) => b.classList.toggle("is-on", b === btn));
    state.filter = btn.dataset.filter;
    render();
  };
});

els.search.addEventListener("input", () => {
  state.query = els.search.value;
  render();
});

document.getElementById("export-waiting").onclick = async () => {
  const waiting = state.pages.filter(isWaiting);
  for (const page of waiting.slice(0, 8)) {
    const dump = await call("EXPORT_OBSIDIAN", { id: page.id });
    downloadMarkdown(dump.filename, dump.markdown);
    window.open(dump.uri, "_blank");
  }
};

boot();

async function boot() {
  state.pages = (await call("LIST_PAGES")) || [];
  render();
}

function isWaiting(page) {
  return page.readState === "unread" || page.readState === "in_progress";
}

function visible() {
  const q = state.query.trim().toLowerCase();
  return state.pages.filter((page) => {
    if (state.filter === "waiting" && !isWaiting(page)) return false;
    if (state.filter === "bookmarked" && !page.bookmarked) return false;
    if (state.filter === "parsed" && !(page.parsed?.blocks || []).length) return false;
    if (!q) return true;
    const hay = [
      page.title,
      page.domain,
      page.why,
      page.parsed?.excerpt,
      ...(page.highlights || []).map((h) => h.text),
      ...(page.threads || []).flatMap((t) => t.messages.map((m) => m.content))
    ]
      .join("\n")
      .toLowerCase();
    return hay.includes(q);
  });
}

function render() {
  const pages = visible();
  const waiting = state.pages.filter(isWaiting);
  els.counts.textContent = `${waiting.length} waiting · ${state.pages.length} saved`;

  if (waiting.length && (state.filter === "waiting" || state.filter === "all")) {
    els.push.innerHTML = `
      <div class="push-card">
        <h2>These still have not been read through.</h2>
        <p>A nudge, not a scoreboard. Open one, park the why, or release it.</p>
        <div class="push-list">
          ${waiting
            .slice(0, 5)
            .map(
              (p) =>
                `<button data-open="${p.id}"><strong>${escapeHtml(p.title)}</strong><br/><span>${escapeHtml(p.domain)} · ${formatRelative(p.lastVisitedAt)}</span></button>`
            )
            .join("")}
        </div>
      </div>`;
    els.push.querySelectorAll("[data-open]").forEach((btn) => {
      btn.onclick = () => openDrawer(btn.dataset.open);
    });
  } else {
    els.push.innerHTML = "";
  }

  if (!pages.length) {
    els.grid.innerHTML = `<p class="empty">Nothing here yet. Visit a page and leave a highlight — it will land in this habitat.</p>`;
    return;
  }

  els.grid.innerHTML = pages
    .map(
      (page) => `
      <article class="card" data-id="${page.id}">
        <div class="domain">${escapeHtml(page.domain)}${page.bookmarked ? " · bookmark" : ""}</div>
        <h3>${escapeHtml(page.title || page.url)}</h3>
        <p class="excerpt">${escapeHtml(clip(page.parsed?.excerpt || page.why || "No parsed excerpt yet.", 140))}</p>
        <div class="meta">
          <span>${page.highlights?.length || 0} marks · ${page.threads?.length || 0} threads</span>
          <span>${escapeHtml(page.readState)} · ${formatRelative(page.updatedAt)}</span>
        </div>
      </article>`
    )
    .join("");
  els.grid.querySelectorAll(".card").forEach((card) => {
    card.onclick = () => openDrawer(card.dataset.id);
  });
}

async function openDrawer(id) {
  const page = await call("GET_PAGE", { id });
  state.activeId = id;
  els.drawer.hidden = false;
  const parsedBlocks = (page.parsed?.blocks || [])
    .slice(0, 12)
    .map((b) => `<p class="excerpt"><code>${escapeHtml(b.id)}</code> ${escapeHtml(clip(b.text, 180))}</p>`)
    .join("");
  const threads = (page.threads || [])
    .map((thread) => {
      const highlight = (page.highlights || []).find((h) => h.id === thread.highlightId);
      const color = COLORS[highlight?.color]?.fill || "#F6E27A";
      return `
        <section class="thread">
          <q style="border-left: 3px solid ${color}; padding-left: 8px">${escapeHtml(highlight?.text || "")}</q>
          <p>${escapeHtml(thread.branchLabel)} · ${escapeHtml(thread.status)}${thread.parentId ? " · forked" : ""}</p>
          ${(thread.messages || [])
            .map(
              (m) =>
                `<p><strong>${m.role === "agent" ? `Agent (${m.agent})` : "You"}:</strong> ${escapeHtml(m.content)}</p>`
            )
            .join("")}
        </section>`;
    })
    .join("");

  els.drawer.innerHTML = `
    <button class="ghost" id="close-drawer">Close</button>
    <p class="domain">${escapeHtml(page.domain)}</p>
    <h2>${escapeHtml(page.title)}</h2>
    <p><a href="${page.url}" target="_blank" rel="noreferrer">Open live page</a></p>
    ${page.why ? `<p class="why">${escapeHtml(page.why)}</p>` : ""}
    <div class="actions">
      ${["unread", "in_progress", "read", "parked", "released"]
        .map((s) => `<button class="ghost" data-state="${s}">${s}</button>`)
        .join("")}
      <button class="ghost" data-act="bookmark">${page.bookmarked ? "Unbookmark" : "Bookmark"}</button>
      <button class="solid" data-act="obsidian">Dump to Obsidian</button>
      <button class="ghost" data-act="reset">Reset agent context</button>
      <button class="ghost" data-act="delete">Remove</button>
    </div>
    <h3>Parsed</h3>
    ${parsedBlocks || "<p class='excerpt'>No unique blocks stored yet.</p>"}
    <h3>Conversations</h3>
    ${threads || "<p class='excerpt'>No threads yet.</p>"}
  `;
  els.drawer.querySelector("#close-drawer").onclick = () => {
    els.drawer.hidden = true;
  };
  els.drawer.querySelectorAll("[data-state]").forEach((btn) => {
    btn.onclick = async () => {
      await call("SET_READ_STATE", { id: page.id, readState: btn.dataset.state });
      await reload();
      openDrawer(page.id);
    };
  });
  els.drawer.querySelector("[data-act='bookmark']").onclick = async () => {
    await call("TOGGLE_BOOKMARK", { id: page.id });
    await reload();
    openDrawer(page.id);
  };
  els.drawer.querySelector("[data-act='obsidian']").onclick = async () => {
    const dump = await call("EXPORT_OBSIDIAN", { id: page.id });
    try {
      await navigator.clipboard.writeText(dump.markdown);
    } catch {
      /* ignore */
    }
    downloadMarkdown(dump.filename, dump.markdown);
    window.open(dump.uri, "_blank");
  };
  els.drawer.querySelector("[data-act='reset']").onclick = async () => {
    await call("RESET_LEDGER", { pageId: page.id });
  };
  els.drawer.querySelector("[data-act='delete']").onclick = async () => {
    await call("DELETE_PAGE", { id: page.id });
    els.drawer.hidden = true;
    await reload();
  };
}

async function reload() {
  state.pages = (await call("LIST_PAGES")) || [];
  render();
}

function clip(text, n) {
  const s = String(text || "");
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
