import { call } from "../shared/bridge.js";
import { applyTheme } from "../shared/theme.js";
import { formatRelative } from "../shared/time.js";
import { parseTagInput, suggestedTagsForHost } from "../shared/tags.js";
import { hostnameOf } from "../shared/url.js";

const list = document.getElementById("list");
const titleEl = document.getElementById("title");
const domainEl = document.getElementById("domain");
const readingBtn = document.getElementById("reading");
const starBtn = document.getElementById("star");
const tagsInput = document.getElementById("tags");
const status = document.getElementById("status");

document.getElementById("dashboard").onclick = () => {
  chrome.runtime.sendMessage({ type: "OPEN_DASHBOARD" });
  window.close();
};

document.getElementById("options").onclick = () => {
  chrome.runtime.openOptionsPage();
};

try {
  applyTheme((await call("GET_SETTINGS"))?.pageTheme);
} catch {
  /* first run, before any settings exist */
}

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const tabUrl = tab?.url || "";
const tabTitle = tab?.title || tabUrl;
const host = hostnameOf(tabUrl);
titleEl.textContent = tabTitle || "This page";
domainEl.textContent = host;

let page = null;
if (/^https?:/i.test(tabUrl)) {
  try {
    page = await call("GET_PAGE", { url: tabUrl });
  } catch {
    page = null;
  }
}
renderPage();

readingBtn.onclick = async () => {
  if (!/^https?:/i.test(tabUrl)) {
    flash("This page cannot be queued.");
    return;
  }
  try {
    page = await call("TOGGLE_READING_LIST", {
      url: tabUrl,
      title: tabTitle,
      tags: parseTagInput(tagsInput.value),
      on: page ? !page.inReadingList : true
    });
    renderPage();
    flash(page.inReadingList ? "On the reading list." : "Removed from reading list.");
  } catch (error) {
    flash(String(error.message || error));
  }
};

starBtn.onclick = async () => {
  if (!/^https?:/i.test(tabUrl)) return;
  try {
    if (!page?.id) {
      page = await call("ENSURE_PAGE", {
        url: tabUrl,
        title: tabTitle,
        tags: parseTagInput(tagsInput.value)
      });
    }
    page = await call("TOGGLE_BOOKMARK", { id: page.id });
    renderPage();
    flash(page.bookmarked ? "Bookmarked." : "Bookmark removed.");
  } catch (error) {
    flash(String(error.message || error));
  }
};

let tagTimer = 0;
tagsInput.addEventListener("change", saveTags);
tagsInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  saveTags();
});
tagsInput.addEventListener("input", () => {
  clearTimeout(tagTimer);
  tagTimer = setTimeout(saveTags, 700);
});

async function saveTags() {
  const tags = parseTagInput(tagsInput.value);
  if (!page?.id || !/^https?:/i.test(tabUrl)) return;
  try {
    page = await call("SET_TAGS", { id: page.id, tags });
  } catch {
    /* page may not exist yet */
  }
}

function renderPage() {
  const listed = Boolean(page?.inReadingList);
  const starred = Boolean(page?.bookmarked);
  readingBtn.textContent = listed ? "Remove from reading list" : "Add to reading list";
  readingBtn.classList.toggle("on", listed);
  starBtn.textContent = starred ? "★ Bookmarked" : "☆ Bookmark";
  starBtn.classList.toggle("on", starred);
  if (document.activeElement !== tagsInput) {
    const existing = page?.tags || [];
    const suggested = suggestedTagsForHost(host);
    tagsInput.value = existing.length ? existing.join(", ") : "";
    tagsInput.placeholder = suggested.length
      ? `${suggested[0]}, later`
      : "machine learning, later";
  }
}

function flash(text) {
  status.hidden = false;
  status.textContent = text;
}

const unread = (await call("UNREAD_PAGES")) || [];
if (!unread.length) {
  list.innerHTML = `<p class="empty">Nothing waiting. Queue a page onto the reading list when you mean to come back.</p>`;
} else {
  list.innerHTML = unread
    .slice(0, 6)
    .map(
      (item) =>
        `<button class="item" data-url="${item.url}"><strong>${escapeHtml(item.title)}</strong><br/><small>${escapeHtml(item.domain)} · ${item.progress?.maxPercent || 0}% · ${formatRelative(item.lastVisitedAt)}</small></button>`
    )
    .join("");
  list.querySelectorAll(".item").forEach((btn) => {
    btn.onclick = () => {
      chrome.tabs.create({ url: btn.dataset.url });
    };
  });
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
