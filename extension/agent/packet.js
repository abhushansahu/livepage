import { uniqueBlocks } from "../parse/page-parser.js";

export const AGENT_TARGETS = {
  cursor: {
    id: "cursor",
    name: "Cursor Agent",
    hint: "You are Cursor Agent, answering inside LivePage about a live webpage."
  },
  "claude-code": {
    id: "claude-code",
    name: "Claude Code",
    hint: "You are Claude Code, answering inside LivePage about a live webpage."
  }
};

export const CURSOR_MODELS = [
  { id: "composer-2.5", label: "Composer 2.5" },
  { id: "auto", label: "Auto" },
  { id: "gpt-5.2", label: "GPT-5.2" },
  { id: "claude-4.6-opus", label: "Claude 4.6 Opus" },
  { id: "claude-4.6-sonnet", label: "Claude 4.6 Sonnet" }
];

export const CLAUDE_CODE_MODELS = [
  { id: "sonnet", label: "Sonnet (Claude Code default)" },
  { id: "opus", label: "Opus" },
  { id: "haiku", label: "Haiku" },
  { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" }
];

export function buildAgentPacket({ page, thread, ask, ledger, agent = "cursor", model = "" }) {
  const target = AGENT_TARGETS[agent] || AGENT_TARGETS.cursor;
  const priorTurns = (thread?.messages || []).some((m) => m.role === "agent");
  const highlight = (page.highlights || []).find((h) => h.id === thread?.highlightId);
  const nearby = nearbyBlocks(page, highlight);
  const nearbyIds = new Set(nearby.map((b) => b.id));
  const freshBlocks = uniqueBlocks(page.parsed?.blocks || [], ledger?.sentBlockIds || []).filter(
    (block) => !nearbyIds.has(block.id)
  );
  const includedBlockIds = [...nearbyIds, ...freshBlocks.map((b) => b.id)];
  const includedHighlightIds = highlight ? [highlight.id] : [];

  const lines = [
    `# LivePage`,
    ``,
    target.hint,
    ``,
    priorTurns
      ? `This packet is a continuing conversation about a webpage. Thread so far is the history. Answer the latest user ask in that context. Stay in the thread — do not restart. Do not edit files. Do not run tools. Do not invent quotes. Reply with the answer only.`
      : `This packet is the page. Answer STRICTLY the user ask using it. Do not edit files. Do not run tools. Do not invent quotes. If the packet is not enough, say what is missing in one short paragraph. Reply with the answer only — no recap of these instructions.`,
    ``,
    `Agent: ${target.name}`,
    model ? `Model: ${model}` : "",
    `Page: ${page.title || ""}`,
    `URL: ${page.canonicalUrl || page.url}`,
    `Page id: ${page.id}`,
    thread ? `Thread: ${thread.branchLabel || "main"} (${thread.id})` : "",
    ``,
    `## User ask`,
    ask?.trim() || "(no ask provided)",
    ``
  ].filter((line) => line !== "");

  if (highlight) {
    lines.push(
      `## Anchored highlight`,
      `This is the span the user marked on the page. Treat it as the primary evidence.`,
      `Color: ${highlight.color}`,
      `> ${highlight.text}`,
      highlight.prefix ? `Prefix: ${highlight.prefix}` : "",
      highlight.suffix ? `Suffix: ${highlight.suffix}` : "",
      ``
    );
  }

  if (thread?.messages?.length) {
    lines.push(`## Thread so far`);
    for (const message of thread.messages) {
      const who =
        message.role === "agent"
          ? `agent/${message.agent || "unknown"}`
          : message.role;
      lines.push(`- ${who}: ${message.content}`);
    }
    lines.push(``);
  }

  if (page.why) {
    lines.push(`## Why this page was opened`, page.why, ``);
  }

  if (nearby.length) {
    lines.push(`## Surrounding paragraphs`);
    for (const block of nearby) {
      lines.push(`### ${block.id} (${block.tag})`, block.text, ``);
    }
  }

  lines.push(`## Other unused page blocks`);
  if (!freshBlocks.length) {
    lines.push(`_None. Use the highlight and surrounding paragraphs._`);
  } else {
    for (const block of freshBlocks.slice(0, 40)) {
      lines.push(`### ${block.id} (${block.tag})`, block.text, ``);
    }
  }

  lines.push(
    `## Headings`,
    ...(page.parsed?.headings || []).map((h) => `- ${h}`),
    ``,
    `Word count (parsed): ${page.parsed?.wordCount || 0}`,
    `Content hash: ${page.parsed?.contentHash || ""}`
  );

  return {
    markdown: lines.filter((line) => line !== "").join("\n").trim() + "\n",
    includedBlockIds,
    includedHighlightIds,
    agent,
    model
  };
}

export function nearbyBlocks(page, highlight, windowSize = 2) {
  const blocks = page?.parsed?.blocks || [];
  if (!blocks.length) return [];
  const needle = normalizeLoose(highlight?.text || "");
  let index = needle
    ? blocks.findIndex((block) => normalizeLoose(block.text).includes(needle.slice(0, 80)))
    : -1;
  if (index < 0) return [];
  return blocks.slice(Math.max(0, index - windowSize), index + windowSize + 1);
}

function normalizeLoose(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

export function nextLedger(ledger, packet, pageId) {
  const sentBlockIds = new Set(ledger?.sentBlockIds || []);
  const sentHighlightIds = new Set(ledger?.sentHighlightIds || []);
  for (const id of packet.includedBlockIds || []) sentBlockIds.add(id);
  for (const id of packet.includedHighlightIds || []) sentHighlightIds.add(id);
  return {
    pageId,
    sentBlockIds: [...sentBlockIds],
    sentHighlightIds: [...sentHighlightIds],
    sentThreadIds: ledger?.sentThreadIds || [],
    lastSentAt: Date.now()
  };
}
