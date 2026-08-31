import { classifyLibraryUrl, isRefreshSource } from "./sources.js";
import { harvestRedditDom } from "./reddit.js";
import { harvestYoutubeDom } from "./youtube.js";
import { harvestTwitterDom } from "./twitter.js";
import { uniqueItems } from "./normalize.js";

export {
  classifyLibraryUrl,
  isLibraryUrl,
  sourceForHost,
  isRefreshSource
} from "./sources.js";

export function harvestDocument(doc, pageUrl) {
  const source = classifyLibraryUrl(pageUrl);
  if (!source || !isRefreshSource(source.id)) return [];
  if (source.id === "twitter") return harvestTwitterDom(doc, pageUrl);
  if (source.id === "reddit") return harvestRedditDom(doc, pageUrl);
  if (source.id === "youtube") return harvestYoutubeDom(doc, pageUrl);
  return [];
}

export function mergeHarvests(...lists) {
  return uniqueItems(lists.flat());
}
