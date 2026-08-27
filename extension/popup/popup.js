import { call } from "../shared/bridge.js";
import { formatRelative } from "../shared/time.js";

const list = document.getElementById("list");

document.getElementById("dashboard").onclick = () => {
  chrome.runtime.sendMessage({ type: "OPEN_DASHBOARD" });
  window.close();
};

document.getElementById("options").onclick = () => {
  chrome.runtime.openOptionsPage();
};

const unread = (await call("UNREAD_PAGES")) || [];
if (!unread.length) {
  list.innerHTML = `<p class="empty">Nothing waiting. When a page still needs a pass, it will appear here.</p>`;
} else {
  list.innerHTML = unread
    .slice(0, 6)
    .map(
      (page) =>
        `<button class="item" data-url="${page.url}"><strong>${escapeHtml(page.title)}</strong><br/><small>${escapeHtml(page.domain)} · ${page.progress?.maxPercent || 0}% · ${formatRelative(page.lastVisitedAt)}</small></button>`
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
