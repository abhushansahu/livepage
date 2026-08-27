import { pageToMarkdown, suggestedFilename } from "./obsidian.js";
import { allTagsFromPages, contentTags } from "../shared/tags.js";

export function vaultFolderName(settings = {}) {
  const raw = String(settings.obsidianFolder || "livepage")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return raw || "livepage";
}

export function buildVaultBundle(pages = [], settings = {}) {
  const folder = vaultFolderName(settings);
  const catalog = buildCatalog(pages, settings);
  const files = [
    { path: ["README.md"], content: vaultReadme(folder) },
    { path: ["config.json"], content: `${JSON.stringify(buildVaultConfig(settings), null, 2)}\n` },
    { path: ["catalog.json"], content: `${JSON.stringify(catalog, null, 2)}\n` },
    { path: ["index.md"], content: vaultIndexMarkdown(catalog) },
    { path: ["tags.md"], content: vaultTagsMarkdown(pages) }
  ];
  for (const page of pages) {
    files.push({
      path: ["pages", suggestedFilename(page)],
      content: pageToMarkdown(page)
    });
  }
  return { folder, catalog, files };
}

export function buildCatalog(pages = [], settings = {}) {
  return {
    format: "livepage-okf/v1",
    generatedAt: new Date().toISOString(),
    folder: vaultFolderName(settings),
    counts: {
      pages: pages.length,
      bookmarks: pages.filter((page) => page.bookmarked).length,
      rss: pages.filter((page) => page.importMeta?.source === "rss").length
    },
    pages: pages.map((page) => ({
      id: page.id,
      title: page.title || page.url,
      url: page.canonicalUrl || page.url,
      file: `pages/${suggestedFilename(page)}`,
      tags: contentTags(page),
      status: page.readState || "unread",
      bookmarked: Boolean(page.bookmarked),
      source: page.importMeta?.source || "live",
      progress: page.progress?.maxPercent || 0,
      updated: page.updatedAt ? new Date(page.updatedAt).toISOString() : ""
    }))
  };
}

export function buildVaultConfig(settings = {}) {
  return {
    format: "livepage-config/v1",
    rssFeeds: settings.rssFeeds || [],
    flags: settings.flags || {},
    experiment: settings.experiment || null,
    obsidianVault: settings.obsidianVault || "",
    obsidianFolder: settings.obsidianFolder || "livepage"
  };
}

export function vaultIndexMarkdown(catalog) {
  const byTag = new Map();
  for (const page of catalog.pages || []) {
    const tags = page.tags?.length ? page.tags : ["untagged"];
    for (const tag of tags) {
      const list = byTag.get(tag) || [];
      list.push(page);
      byTag.set(tag, list);
    }
  }
  const lines = [
    `# LivePage`,
    ``,
    `Open knowledge dump. Human-readable markdown, machine-readable \`catalog.json\`.`,
    `Bind this folder on any machine, then \`git pull\` / \`git push\` to stay in sync.`,
    ``,
    `- Pages: ${catalog.counts?.pages || 0}`,
    `- Bookmarks: ${catalog.counts?.bookmarks || 0}`,
    `- RSS: ${catalog.counts?.rss || 0}`,
    `- Generated: ${catalog.generatedAt || ""}`,
    ``,
    `## By tag`,
    ``
  ];
  for (const tag of [...byTag.keys()].sort()) {
    lines.push(`### #${tag}`, ``);
    for (const page of byTag.get(tag)) {
      lines.push(`- [${page.title}](${page.file}) — ${page.url}`);
    }
    lines.push(``);
  }
  return lines.join("\n").trim() + "\n";
}

export function vaultTagsMarkdown(pages = []) {
  const rows = allTagsFromPages(pages);
  const lines = [`# Tags`, ``];
  if (!rows.length) {
    lines.push(`_No tags yet._`, ``);
  }
  for (const row of rows) {
    lines.push(`- #${row.tag} (${row.count})`);
  }
  return lines.join("\n").trim() + "\n";
}

function vaultReadme(folder) {
  return `# ${folder}

This folder is the LivePage vault dump: plain markdown + JSON, not a proprietary database.

Suggested git setup:

1. This directory lives inside an Obsidian vault (or any folder of markdown).
2. That vault is a git repo, usually on GitHub.
3. LivePage writes here from Chrome. Git keeps two machines in sync.

\`\`\`
git add ${folder}
git commit -m "livepage compost"
git pull --rebase
git push
\`\`\`

Chrome cannot push for you. Obsidian Git, a terminal, or another machine all work — the files are the source of truth.

- \`pages/\` — one note per URL, YAML frontmatter, highlights, your comments, agent replies
- \`catalog.json\` — machine index (tags, urls, ids)
- \`index.md\` — map of content for humans and agents
- \`config.json\` — RSS feeds and flags snapshot from the extension
`;
}
