import { handleMessage } from "./handlers.js";
import { getSettings, unreadPages, upsertImportedPages } from "../storage/store.js";
import { syncSaves } from "../import/sync.js";
import { syncRssFeeds } from "../import/rss.js";
import { resolveFlags } from "../shared/flags.js";
import { viewerUrlFor } from "../pdf/route.js";

const DASHBOARD_PATH = "dashboard/index.html";
const ALARM = "livepage-unread-reminder";
const SYNC_ALARM = "livepage-sync-saves";
const RSS_ALARM = "livepage-sync-rss";

chrome.runtime.onInstalled.addListener(async () => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "lp-highlight",
      title: "LivePage: highlight",
      contexts: ["selection"]
    });
    chrome.contextMenus.create({
      id: "lp-comment",
      title: "LivePage: comment",
      contexts: ["selection"]
    });
    chrome.contextMenus.create({
      id: "lp-reading-list",
      title: "LivePage: add to reading list",
      contexts: ["page", "link"]
    });
    chrome.contextMenus.create({
      id: "lp-dashboard",
      title: "Open LivePage dashboard",
      contexts: ["action", "page"]
    });
    chrome.contextMenus.create({
      id: "lp-add-feed",
      title: "LivePage: add RSS feed from this page",
      contexts: ["page"]
    });
    // Only on links, and only ones that end in .pdf. Chrome will not tell us a
    // URL's content type before it is fetched, so anything wider than this
    // would be offering to open documents that are not there.
    chrome.contextMenus.create({
      id: "lp-open-pdf",
      title: "Open this PDF in LivePage",
      contexts: ["link"],
      targetUrlPatterns: ["*://*/*.pdf", "*://*/*.PDF", "*://*/*.pdf?*", "*://*/*.PDF?*"]
    });
  });
  await refreshBadge();
  await scheduleReminder();
  await scheduleSync();
  await scheduleRss();
});

chrome.runtime.onStartup.addListener(async () => {
  await refreshBadge();
  await scheduleReminder();
  await scheduleSync();
  await scheduleRss();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "OPEN_DASHBOARD") {
    openDashboard();
    sendResponse({ ok: true, data: true });
    return true;
  }
  if (message?.type === "OPEN_PDF") {
    openPdf(message.payload?.url, sender?.tab).then(() => sendResponse({ ok: true, data: true }));
    return true;
  }
  if (message?.type === "RESCHEDULE_REMINDER") {
    scheduleReminder().then(() => sendResponse({ ok: true, data: true }));
    return true;
  }
  handleMessage(message)
    .then((data) => {
      sendResponse({ ok: true, data });
      if (shouldRefreshBadge(message.type)) refreshBadge();
      if (message.type === "SAVE_SETTINGS") announceSettings(data);
    })
    .catch((error) => {
      sendResponse({ ok: false, error: error.message || String(error) });
    });
  return true;
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "lp-open-pdf") {
    await openPdf(info.linkUrl, tab);
    return;
  }
  if (info.menuItemId === "lp-dashboard") {
    await openDashboard();
    return;
  }
  if (info.menuItemId === "lp-add-feed") {
    if (tab?.id) await sendToTab(tab.id, { broadcast: true, kind: "ADD_RSS_FEED" });
    return;
  }
  if (info.menuItemId === "lp-reading-list") {
    const url = info.linkUrl || tab?.url;
    const title = info.linkUrl ? "" : tab?.title;
    if (!url) return;
    await handleMessage({
      type: "QUEUE_READING_LIST",
      payload: { url, title, visited: !info.linkUrl }
    });
    if (tab?.id) {
      await sendToTab(tab.id, { broadcast: true, kind: "TOAST", text: "Added to reading list" });
    }
    await refreshBadge();
    return;
  }
  if (!tab?.id) return;
  const action = info.menuItemId === "lp-comment" ? "comment" : "highlight";
  await sendToTab(tab.id, { broadcast: true, kind: "CONTEXT_ACTION", action });
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === "open-dashboard") {
    await openDashboard();
    return;
  }
  if (command === "add-to-reading-list") {
    if (!tab?.url) return;
    await handleMessage({
      type: "QUEUE_READING_LIST",
      payload: { url: tab.url, title: tab.title }
    });
    if (tab.id) {
      await sendToTab(tab.id, {
        broadcast: true,
        kind: "TOAST",
        text: "Added to reading list"
      });
    }
    await refreshBadge();
    return;
  }
  if (!tab?.id) return;
  const action = command === "comment-selection" ? "comment" : "highlight";
  await sendToTab(tab.id, { broadcast: true, kind: "CONTEXT_ACTION", action });
});

/**
 * Opens a PDF in LivePage's reader, in a new tab beside the one it came from.
 *
 * Never a redirect: PDFs are printed, downloaded, filled in and embedded, and
 * taking every one of them over would break all of that to serve the one case
 * where the reader wanted to think on it.
 */
async function openPdf(url, tab) {
  if (!url) return;
  const viewer = viewerUrlFor(url);
  if (!viewer) return;
  await chrome.tabs.create({
    url: viewer,
    index: typeof tab?.index === "number" ? tab.index + 1 : undefined,
    windowId: tab?.windowId
  });
}

chrome.action.onClicked.addListener(() => {
  /* popup handles click */
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === SYNC_ALARM) {
    const settings = await getSettings();
    const { flags } = resolveFlags(settings);
    if (!flags.importSaves) return;
    await syncSaves({ openTabs: false, importItems: upsertImportedPages });
    await refreshBadge();
    return;
  }
  if (alarm.name === RSS_ALARM) {
    const settings = await getSettings();
    const { flags } = resolveFlags(settings);
    if (!flags.rss) return;
    await syncRssFeeds({ settings, importItems: upsertImportedPages });
    await refreshBadge();
    return;
  }
  if (alarm.name !== ALARM) return;
  const settings = await getSettings();
  if (!settings.remindersEnabled) return;
  const unread = await unreadPages();
  if (!unread.length) return;
  const titles = unread.slice(0, 3).map((p) => p.title || p.domain);
  const more = unread.length > 3 ? ` and ${unread.length - 3} more` : "";
  chrome.notifications.create(`lp-unread-${Date.now()}`, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title: "LivePage · still waiting",
    message: `${unread.length} page${unread.length === 1 ? "" : "s"} still want a first real pass: ${titles.join(" · ")}${more}`,
    priority: 1
  });
});

chrome.notifications.onClicked.addListener(() => {
  openDashboard();
});

/** Theme and reading preferences are one choice, so every open surface follows it at once. */
async function announceSettings(settings) {
  if (!settings) return;
  const message = { broadcast: true, kind: "SETTINGS_CHANGED", settings };
  try {
    await chrome.runtime.sendMessage(message);
  } catch {
    /* no extension page is listening */
  }
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.id) await sendToTab(tab.id, message);
  }
}

async function sendToTab(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch {
    /* content script missing on this tab (chrome://, not injected yet, etc.) */
  }
}

async function openDashboard() {
  const url = chrome.runtime.getURL(DASHBOARD_PATH);
  const tabs = await chrome.tabs.query({ url });
  if (tabs[0]) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    if (tabs[0].windowId) await chrome.windows.update(tabs[0].windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url });
}

async function refreshBadge() {
  const unread = await unreadPages();
  const count = unread.length;
  await chrome.action.setBadgeBackgroundColor({ color: "#3F6B52" });
  await chrome.action.setBadgeText({ text: count ? String(count) : "" });
}

async function scheduleReminder() {
  const settings = await getSettings();
  const hour = Number(settings.reminderHour ?? 9);
  const minute = Number(settings.reminderMinute ?? 0);
  const when = nextTime(hour, minute);
  await chrome.alarms.clear(ALARM);
  if (!settings.remindersEnabled) return;
  chrome.alarms.create(ALARM, { when, periodInMinutes: 24 * 60 });
}

async function scheduleSync() {
  await chrome.alarms.clear(SYNC_ALARM);
  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 180 });
}

async function scheduleRss() {
  await chrome.alarms.clear(RSS_ALARM);
  chrome.alarms.create(RSS_ALARM, { periodInMinutes: 180 });
}

function nextTime(hour, minute) {
  const date = new Date();
  date.setHours(hour, minute, 0, 0);
  if (date.getTime() <= Date.now()) date.setDate(date.getDate() + 1);
  return date.getTime();
}

function shouldRefreshBadge(type) {
  return [
    "VISIT_PAGE",
    "PATCH_PAGE",
    "SET_READ_STATE",
    "DELETE_PAGE",
    "ADD_HIGHLIGHT",
    "SAVE_PAGE",
    "REPORT_PROGRESS",
    "IMPORT_ITEMS",
    "SYNC_SAVES",
    "SYNC_RSS",
    "ADD_RSS_FEED",
    "ADD_RSS_FEEDS",
    "SET_TAGS",
    "TOGGLE_READING_LIST",
    "QUEUE_READING_LIST",
    "SNOOZE_PAGE"
  ].includes(type);
}

