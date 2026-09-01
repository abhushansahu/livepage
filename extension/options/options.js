import { call } from "../shared/bridge.js";
import { applyTheme } from "../shared/theme.js";
import { EXPERIMENTS, resolveFlags } from "../shared/flags.js";
import { isKept } from "../shared/lists.js";
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
applyTheme(settings.pageTheme);
fillForm(settings);

form.elements.pageTheme.addEventListener("change", () => {
  applyTheme(form.elements.pageTheme.value);
});
await refreshRss();
await refreshVault();
await refreshHost();

document.getElementById("host-ping").onclick = () => refreshHost();

await refreshForget();

document.getElementById("forget-browsed").onclick = async () => {
  const note = document.getElementById("forget-status");
  try {
    const result = await call("FORGET_BROWSED", {});
    note.textContent = result.removed
      ? `Forgot ${result.removed} browsed-only ${result.removed === 1 ? "page" : "pages"}. ${result.kept} kept.`
      : "Nothing to forget — every stored page was kept on purpose.";
  } catch (error) {
    note.textContent = String(error.message || error);
  }
};

async function refreshForget() {
  const note = document.getElementById("forget-status");
  const button = document.getElementById("forget-browsed");
  try {
    const pages = (await call("LIST_PAGES")) || [];
    const stale = pages.filter((page) => !isKept(page)).length;
    button.disabled = !stale;
    note.textContent = stale
      ? `${stale} of ${pages.length} stored pages show no sign you meant to keep them.`
      : `${pages.length} stored pages, all kept on purpose.`;
  } catch {
    note.textContent = "";
  }
}

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
  applyTheme(settings.pageTheme);
  if (globalThis.chrome?.runtime?.sendMessage) {
    chrome.runtime.sendMessage({ type: "RESCHEDULE_REMINDER" });
  }
  status.hidden = false;
});

document.getElementById("rss-add").onclick = async () => {
  const text = document.getElementById("rss-urls").value.trim();
  if (!text) return;
  try {
    const result = await call("ADD_RSS_FEEDS", {
      text,
      tags: parseTagInput(document.getElementById("rss-tags").value)
    });
    settings = result.settings;
    document.getElementById("rss-urls").value = "";
    document.getElementById("rss-tags").value = "";
    await refreshRss();
    status.hidden = false;
    const n = result?.feeds?.length || 0;
    status.textContent = n
      ? `Added ${n} feed${n === 1 ? "" : "s"}.`
      : "No new feeds.";
  } catch (error) {
    status.hidden = false;
    status.textContent = String(error.message || error);
  }
};

document.getElementById("bind-vault").onclick = async () => {
  try {
    const result = await bindVaultFolder();
    if (result.ok) {
      settings = await call("SAVE_SETTINGS", {
        vault: { bound: true, name: result.name, boundAt: result.boundAt }
      });
    }
    await refreshVault();
  } catch (error) {
    if (error?.name === "AbortError" || /abort/i.test(String(error.message || error))) return;
    document.getElementById("vault-status").textContent = String(error.message || error);
  }
};

function currentPatch() {
  return {
    defaultColor: form.elements.defaultColor.value,
    pageTheme: form.elements.pageTheme.value,
    highlightStrength: Number(form.elements.highlightStrength.value || 48),
    agentDefault: form.elements.agentDefault.value,
    cursorModel: form.elements.cursorModel.value,
    claudeCodeModel: form.elements.claudeCodeModel.value,
    cursorAgentPath: form.elements.cursorAgentPath.value.trim(),
    claudeCodePath: form.elements.claudeCodePath.value.trim(),
    agentHostUrl: form.elements.agentHostUrl.value.trim() || "http://127.0.0.1:17321",
    agentWorkspace: form.elements.agentWorkspace.value.trim(),
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
      articleSymbols: form.elements.flagArticleSymbols.checked,
      dashboardLayout: form.elements.dashboardLayout.value
    }
  };
}

function fillForm(value) {
  const { flags, experiment } = resolveFlags(value);
  form.elements.defaultColor.value = value.defaultColor || "lemon";
  form.elements.pageTheme.value = value.pageTheme || "coffee";
  form.elements.highlightStrength.value = value.highlightStrength ?? 48;
  form.elements.agentDefault.value = value.agentDefault || "cursor";
  form.elements.cursorModel.value = value.cursorModel || "composer-2.5";
  form.elements.claudeCodeModel.value = value.claudeCodeModel || "sonnet";
  form.elements.cursorAgentPath.value = value.cursorAgentPath || "";
  form.elements.claudeCodePath.value = value.claudeCodePath || "";
  form.elements.agentHostUrl.value = value.agentHostUrl || "http://127.0.0.1:17321";
  form.elements.agentWorkspace.value = value.agentWorkspace || "";
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
  form.elements.flagArticleSymbols.checked = Boolean(flags.articleSymbols);
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

async function refreshHost() {
  const el = document.getElementById("host-status");
  try {
    const result = await call("PING_AGENT_HOST");
    el.textContent = result?.ok
      ? `Host is up. Cursor CLI: ${result.cursorOk ? result.cursor : "not found"}. Claude Code: ${result.claudeOk ? result.claude : "not found"}.`
      : `Agent host is not running. In the LivePage repo: npm run agent-host`;
  } catch {
    el.textContent = "Agent host is not running. In the LivePage repo: npm run agent-host";
  }
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
