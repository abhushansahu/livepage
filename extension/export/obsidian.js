import { contentTags } from "../shared/tags.js";

export function pageToMarkdown(page) {
  const tags = contentTags({ ...page, tags: ["livepage", ...(page.tags || [])] });
  const threadsByHighlight = new Map();
  for (const thread of page.threads || []) {
    const list = threadsByHighlight.get(thread.highlightId) || [];
    list.push(thread);
    threadsByHighlight.set(thread.highlightId, list);
  }

  const lines = [
    `---`,
    `title: ${yamlEscape(page.title || page.domain)}`,
    `url: ${page.canonicalUrl || page.url}`,
    `domain: ${page.domain || ""}`,
    `status: ${page.readState || "unread"}`,
    `source: ${page.importMeta?.source || "live"}`,
    `type: ${page.kind === "pdf" ? "pdf" : "article"}`,
    `progress: ${page.progress?.maxPercent || 0}`,
    `bookmarked: ${page.bookmarked ? "true" : "false"}`,
    `tags: [${tags.map(yamlEscape).join(", ")}]`,
    ...(page.docMeta?.pages ? [`pages: ${page.docMeta.pages}`] : []),
    `livepage_id: ${page.id}`,
    `updated: ${iso(page.updatedAt)}`,
    `---`,
    ``,
    `# ${page.title || page.domain}`,
    ``,
    `[Open source](${page.url})`,
    ``
  ];

  if (page.why) {
    lines.push(`## Why opened`, page.why, ``);
  }

  if (page.parsed?.headings?.length) {
    lines.push(`## Outline`, ...page.parsed.headings.map((h) => `- ${h}`), ``);
  }

  if (page.parsed?.excerpt) {
    lines.push(`## Parsed excerpt`, page.parsed.excerpt, ``);
  }

  lines.push(`## Highlights and conversations`);
  if (!(page.highlights || []).length) {
    lines.push(`_No highlights yet._`, ``);
  }

  for (const highlight of page.highlights || []) {
    // The page number is how you find a passage again in a 40-page paper, so
    // it belongs in the heading you scan, not in a field further down.
    const where = highlight.locator?.page ? ` · p. ${highlight.locator.page}` : "";
    lines.push(`### ${highlight.color}: "${clip(highlight.text, 140)}"${where}`);
    lines.push(`> ${highlight.text}`, ``);
    const threads = threadsByHighlight.get(highlight.id) || [];
    if (!threads.length) continue;
    for (const thread of threads) {
      const fork = thread.parentId
        ? ` (branch of ${thread.parentId}, from ${thread.forkedFromMessageId || "root"})`
        : "";
      lines.push(`#### ${thread.branchLabel || "main"} — ${thread.status}${fork}`);
      for (const message of thread.messages || []) {
        const who =
          message.role === "agent"
            ? `Agent (${message.agent || "unknown"})`
            : message.role === "system"
              ? "System"
              : "You";
        lines.push(`- **${who}:** ${message.content}`);
      }
      lines.push(``);
    }
  }

  return lines.join("\n").trim() + "\n";
}

export function obsidianNewUri({ vault, folder, filename, content }) {
  const path = [folder, filename].filter(Boolean).join("/");
  const params = new URLSearchParams();
  if (vault) params.set("vault", vault);
  params.set("file", path);
  params.set("content", content);
  return `obsidian://new?${params.toString()}`;
}

export function suggestedFilename(page) {
  const stamp = new Date(page.updatedAt || Date.now()).toISOString().slice(0, 10);
  const slug = slugify(page.title || fileStem(page.url) || page.domain || "page").slice(0, 60);
  // A file:// PDF has no hostname, so without a fallback every local document
  // would export as "…-web-….md" and they would sort into one indistinct pile.
  const host = slugify(page.domain || (isFileUrl(page.url) ? "local" : "web")).slice(0, 40);
  return `${stamp}-${host}-${slug}.md`;
}

function isFileUrl(url) {
  return /^file:/i.test(String(url || ""));
}

function fileStem(url) {
  const path = String(url || "").split("#")[0].split("?")[0];
  const file = path.split("/").filter(Boolean).pop() || "";
  try {
    return decodeURIComponent(file).replace(/\.[a-z0-9]{1,5}$/i, "");
  } catch {
    return file.replace(/\.[a-z0-9]{1,5}$/i, "");
  }
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "note";
}

function yamlEscape(value) {
  return `"${String(value || "").replace(/"/g, '\\"')}"`;
}

function iso(ts) {
  return ts ? new Date(ts).toISOString() : "";
}

function clip(text, n) {
  const s = String(text || "");
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
