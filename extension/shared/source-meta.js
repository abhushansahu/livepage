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
