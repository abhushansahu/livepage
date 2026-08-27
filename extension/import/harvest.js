import { classifyLibraryUrl } from "./sources.js";
import { harvestRedditDom } from "./reddit.js";
import { harvestYoutubeDom } from "./youtube.js";
import { harvestGenericList, harvestTwitterDom } from "./twitter.js";
import { uniqueItems } from "./normalize.js";

export { classifyLibraryUrl, isLibraryUrl, sourceForHost } from "./sources.js";

export function harvestDocument(doc, pageUrl) {
  const source = classifyLibraryUrl(pageUrl);
  if (!source) return [];
  if (source.id === "twitter") return harvestTwitterDom(doc, pageUrl);
  if (source.id === "reddit") return harvestRedditDom(doc, pageUrl);
  if (source.id === "youtube") return harvestYoutubeDom(doc, pageUrl);
  if (source.id === "pocket" || source.id === "hn") {
    return harvestGenericList(doc, pageUrl, source.id, source.kind);
  }
  return [];
}

export function mergeHarvests(...lists) {
  return uniqueItems(lists.flat());
}
