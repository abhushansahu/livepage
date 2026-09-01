const SOURCE_COLORS = {
  twitter: "#0f1419",
  reddit: "#ff4500",
  youtube: "#ff0000",
  pocket: "#ef4056",
  hn: "#ff6600",
  rss: "#f26522",
  live: "#3f6b52"
};

export function sourceKey(page) {
  const source = page?.importMeta?.source;
  return SOURCE_COLORS[source] ? source : "live";
}

export function sourceColor(page) {
  return SOURCE_COLORS[sourceKey(page)];
}

export function sourceLabel(page) {
  const source = page?.importMeta?.source;
  if (source === "twitter") return "X";
  if (source === "reddit") return "Reddit";
  if (source === "youtube") return "YouTube";
  if (source === "pocket") return "Pocket";
  if (source === "hn") return "HN";
  if (source === "rss") return "RSS";
  return page?.domain || "LivePage";
}

export function sourceGlyph(page) {
  const source = page?.importMeta?.source;
  if (source === "twitter") return "𝕏";
  if (source === "reddit") return "r/";
  if (source === "youtube") return "▶";
  if (source === "pocket") return "P";
  if (source === "hn") return "Y";
  if (source === "rss") return "◌";
  return "¶";
}
