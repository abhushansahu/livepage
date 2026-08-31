import { uniqueItems } from "./normalize.js";

export function extractAssignedJson(html, name) {
  const htmlText = String(html || "");
  const needle = `${name} = `;
  const start = htmlText.indexOf(needle);
  if (start < 0) return null;
  const from = start + needle.length;
  const brace = htmlText.indexOf("{", from);
  if (brace < 0) return null;
  let depth = 0;
  for (let i = brace; i < htmlText.length; i += 1) {
    const ch = htmlText[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(htmlText.slice(brace, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export function collectByKey(node, key, out = []) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const item of node) collectByKey(item, key, out);
    return out;
  }
  if (Object.prototype.hasOwnProperty.call(node, key)) out.push(node[key]);
  for (const value of Object.values(node)) collectByKey(value, key, out);
  return out;
}

function textOf(runsOrSimple) {
  if (!runsOrSimple) return "";
  if (typeof runsOrSimple === "string") return runsOrSimple;
  if (runsOrSimple.simpleText) return runsOrSimple.simpleText;
  if (Array.isArray(runsOrSimple.runs)) {
    return runsOrSimple.runs.map((r) => r.text || "").join("");
  }
  return "";
}

export function itemsFromYtInitialData(data, listUrl = "https://www.youtube.com/playlist?list=WL") {
  const renderers = collectByKey(data, "playlistVideoRenderer");
  const items = [];
  for (const video of renderers) {
    const videoId = video?.videoId;
    if (!videoId) continue;
    const title = textOf(video.title) || `YouTube ${videoId}`;
    const author = textOf(video.shortBylineText) || textOf(video.ownerText);
    items.push({
      url: `https://www.youtube.com/watch?v=${videoId}`,
      title,
      excerpt: title,
      author,
      source: "youtube",
      kind: "watch_later",
      externalId: videoId,
      listUrl
    });
  }
  return uniqueItems(items);
}

export function itemsFromYoutubeHtml(html, listUrl) {
  const data = extractAssignedJson(html, "ytInitialData");
  return itemsFromYtInitialData(data, listUrl);
}

export function harvestYoutubeDom(doc, pageUrl) {
  const items = [];
  const rows = doc.querySelectorAll(
    "ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer"
  );
  for (const row of rows) {
    const link = row.querySelector("a#video-title, a#video-title-link, a[href*='watch?v=']");
    if (!link?.href) continue;
    let url = link.href;
    try {
      const parsed = new URL(url, pageUrl);
      const id = parsed.searchParams.get("v");
      if (id) url = `https://www.youtube.com/watch?v=${id}`;
    } catch {
      /* keep */
    }
    const title = (link.textContent || link.getAttribute("title") || "").trim();
    const author = (row.querySelector("ytd-channel-name, .ytd-channel-name")?.textContent || "").trim();
    items.push({
      url,
      title: title || url,
      excerpt: title,
      author,
      source: "youtube",
      kind: "watch_later",
      listUrl: pageUrl
    });
  }
  return uniqueItems(items);
}
