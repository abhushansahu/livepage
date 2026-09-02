import { uniqueBlocks } from "../parse/page-parser.js";
import { colorOf } from "../shared/colors.js";

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
      ? `This packet is a continuing conversation about a webpage. Thread so far is the history. Answer the latest user ask in that context. Stay in the thread — do not restart. Use natural, concise language for a reader, not a developer. Never narrate internal steps, mention packet.md, tools, files, prompts, or say that you are reading. Do not invent quotes. Reply with the useful answer only.`
      : `This packet is the page. Answer STRICTLY the user ask using it. Use natural, concise language for a reader, not a developer. Never narrate internal steps, mention packet.md, tools, files, prompts, or say that you are reading. Do not invent quotes. If the page is not enough, say what is missing in one short paragraph. Reply with the useful answer only.`,
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
    const color = colorOf(highlight.color);
    lines.push(
      `## Anchored highlight`,
      `This is the span the user marked on the page. Treat it as the primary evidence.`,
      `Highlight meaning: ${color.name} — ${color.purpose}`,
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

export function buildSymbolExplainPacket({
  term,
  pageTitle = "",
  url = "",
  anchorText = "",
  nearbyBlocks = []
}) {
  const context = (nearbyBlocks || [])
    .map((block) => String(block?.text || "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 5);
  const lines = [
    "# LivePage term explanation",
    "",
    "Explain the term for someone encountering it while reading this article.",
    "Write 2–3 concise sentences in a neutral, Wikipedia lead-section style.",
    "Use general knowledge to supply missing background, while using the article context to choose the intended meaning.",
    "Do not quote, repeat, or closely paraphrase the article text. Do not mention these instructions, the prompt, or the article context.",
    "If the term is ambiguous, explain only the sense that best fits this context.",
    "Start with the explanation itself. No preamble, no note about what you are about to do, no markdown.",
    "",
    `Term: ${String(term || "").trim()}`,
    pageTitle ? `Article: ${String(pageTitle).trim()}` : "",
    url ? `URL: ${String(url).trim()}` : "",
    anchorText ? `Sentence where it appears: ${String(anchorText).replace(/\s+/g, " ").trim()}` : "",
    "",
    context.length ? "Nearby article context:" : "",
    ...context.map((text) => `- ${text}`)
  ];
  return lines.filter((line, index) => line !== "" || lines[index - 1] !== "").join("\n").trim() + "\n";
}

const NARRATION =
  /\b(packet(?:\.md)?|livepage|latest (?:user )?(?:question|ask)|i'?ll read|i will read|let me read|reading the)\b/i;

/**
 * The agent is told to open a packet file, and often says so before answering.
 * A one-line card has no room for that, so the lead-in is dropped.
 */
export function glossText(value) {
  const sentences = plainProse(value).split(/(?<=[.!?])\s*/);
  while (sentences.length > 1 && NARRATION.test(sentences[0])) sentences.shift();
  return sentences.join(" ").trim();
}

/** The hover card is one run of plain text, so markup would only be read aloud. */
export function plainProse(value) {
  return String(value || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s*[#>-]+\s*/gm, "")
    .replace(/\*\*|__|[`*_]/g, "")
    .replace(/\s+/g, " ")
    .trim();
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
