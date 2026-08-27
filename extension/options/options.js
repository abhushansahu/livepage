import { call } from "../shared/bridge.js";
import { EXPERIMENTS, resolveFlags } from "../shared/flags.js";
import { parseTagInput } from "../shared/tags.js";
import { bindVaultFolder, vaultStatus } from "../export/vault.js";

const form = document.getElementById("form");
const status = document.getElementById("status");
const rssList = document.getElementById("rss-list");

if (location.protocol !== "chrome-extension:" && !globalThis.__LP_BRIDGE) {
  const { handleMessage } = await import("../background/handlers.js");
  globalThis.__LP_BRIDGE = (type, payload) => handleMessage({ type, payload });
}

let settings = await call("GET_SETTINGS");
fillForm(settings);
await refreshRss();
await refreshVault();

form.elements.experimentVariant.addEventListener("change", () => {
  const variant = EXPERIMENTS["dashboard-density"].variants[form.elements.experimentVariant.value];
  const flags = variant?.flags || {};
  if (typeof flags.forYouFeed === "boolean") form.elements.flagForYou.checked = flags.forYouFeed;
  if (typeof flags.localTweets === "boolean") form.elements.flagLocalTweets.checked = flags.localTweets;
  if (flags.dashboardLayout) form.elements.dashboardLayout.value = flags.dashboardLayout;
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const patch = currentPatch();
  settings = await call("SAVE_SETTINGS", patch);
  if (globalThis.chrome?.runtime?.sendMessage) {
    chrome.runtime.sendMessage({ type: "RESCHEDULE_REMINDER" });
  }
  status.hidden = false;
});

document.getElementById("rss-add").onclick = async () => {
  const url = document.getElementById("rss-url").value.trim();
  if (!url) return;
  settings = (await call("ADD_RSS_FEED", {
    url,
    tags: parseTagInput(document.getElementById("rss-tags").value)
  })).settings;
  document.getElementById("rss-url").value = "";
  document.getElementById("rss-tags").value = "";
  await refreshRss();
  status.hidden = false;
  status.textContent = "Feed added.";
};

document.getElementById("bind-vault").onclick = async () => {
  const result = await bindVaultFolder();
  if (result.ok) {
    settings = await call("SAVE_SETTINGS", {
      vault: { bound: true, name: result.name, boundAt: result.boundAt }
    });
  }
  await refreshVault();
};

function currentPatch() {
  return {
    defaultColor: form.elements.defaultColor.value,
    agentDefault: form.elements.agentDefault.value,
    obsidianVault: form.elements.obsidianVault.value.trim(),
    obsidianFolder: form.elements.obsidianFolder.value.trim() || "livepage",
    remindersEnabled: form.elements.remindersEnabled.checked,
    reminderHour: Number(form.elements.reminderHour.value || 9),
    lockInfiniteScroll: form.elements.lockInfiniteScroll.checked,
    importSavesEnabled: form.elements.flagImportSaves.checked,
    localTweetsEnabled: form.elements.flagLocalTweets.checked,
    experiment: { id: "dashboard-density", variant: form.elements.experimentVariant.value },
    flags: {
      forYouFeed: form.elements.flagForYou.checked,
      readingList: form.elements.flagReading.checked,
      bookmarks: form.elements.flagBookmarks.checked,
      saves: form.elements.flagSaves.checked,
      rss: form.elements.flagRss.checked,
      review: form.elements.flagReview.checked,
      localTweets: form.elements.flagLocalTweets.checked,
      importSaves: form.elements.flagImportSaves.checked,
      dashboardLayout: form.elements.dashboardLayout.value
    }
  };
}

function fillForm(value) {
  const { flags, experiment } = resolveFlags(value);
  form.elements.defaultColor.value = value.defaultColor || "lemon";
  form.elements.agentDefault.value = value.agentDefault || "cursor";
  form.elements.obsidianVault.value = value.obsidianVault || "";
  form.elements.obsidianFolder.value = value.obsidianFolder || "livepage";
  form.elements.remindersEnabled.checked = value.remindersEnabled !== false;
  form.elements.reminderHour.value = value.reminderHour ?? 9;
  form.elements.lockInfiniteScroll.checked = value.lockInfiniteScroll !== false;
  form.elements.experimentVariant.value = experiment.variant;
  form.elements.dashboardLayout.value = flags.dashboardLayout;
  form.elements.flagForYou.checked = flags.forYouFeed !== false;
  form.elements.flagReading.checked = flags.readingList !== false;
  form.elements.flagBookmarks.checked = flags.bookmarks !== false;
  form.elements.flagSaves.checked = flags.saves !== false;
  form.elements.flagRss.checked = flags.rss !== false;
  form.elements.flagReview.checked = flags.review !== false;
  form.elements.flagLocalTweets.checked = Boolean(flags.localTweets);
  form.elements.flagImportSaves.checked = flags.importSaves !== false;
}

async function refreshRss() {
  settings = await call("GET_SETTINGS");
  const feeds = settings.rssFeeds || [];
  if (!feeds.length) {
    rssList.innerHTML = `<li class="empty">No feeds yet.</li>`;
    return;
  }
  rssList.innerHTML = feeds
    .map(
      (feed) => `<li>
        <div>
          <strong>${escapeHtml(feed.title || feed.url)}</strong>
          <span>${escapeHtml(feed.url)}</span>
          <span>${(feed.tags || []).map((tag) => `#${tag}`).join(" ")}</span>
        </div>
        <button type="button" data-remove="${feed.id}">Remove</button>
      </li>`
    )
    .join("");
  rssList.querySelectorAll("[data-remove]").forEach((btn) => {
    btn.onclick = async () => {
      settings = await call("REMOVE_RSS_FEED", { id: btn.dataset.remove });
      await refreshRss();
    };
  });
}

async function refreshVault() {
  const el = document.getElementById("vault-status");
  try {
    const statusInfo = await vaultStatus();
    el.textContent = statusInfo.bound
      ? `Bound to ${statusInfo.name}. Write from the dashboard, then git commit / push. The other machine git pulls the same vault.`
      : "Not bound. Pick the cloned vault folder (the git repo root). LivePage writes a livepage/ directory of markdown + catalog.json.";
    document.getElementById("bind-vault").textContent = statusInfo.bound
      ? `Rebound ${statusInfo.name}`
      : "Bind vault folder";
  } catch {
    el.textContent = "Folder bind is unavailable in this context. Markdown download still works.";
  }
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
