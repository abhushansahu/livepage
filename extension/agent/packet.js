import { uniqueBlocks } from "../parse/page-parser.js";

export const AGENT_TARGETS = {
  cursor: {
    id: "cursor",
    name: "Cursor Agent",
    hint: "Paste into Cursor Agent / chat. Answer only the ask, using this packet as exclusive page context."
  },
  "claude-code": {
    id: "claude-code",
    name: "Claude Code",
    hint: "Paste into Claude Code. Treat this packet as the only webpage evidence you may use."
  }
};

export function buildAgentPacket({ page, thread, ask, ledger, agent = "cursor" }) {
  const target = AGENT_TARGETS[agent] || AGENT_TARGETS.cursor;
  const highlight = (page.highlights || []).find((h) => h.id === thread?.highlightId);
  const freshBlocks = uniqueBlocks(page.parsed?.blocks || [], ledger?.sentBlockIds || []);
  const includedBlockIds = freshBlocks.map((b) => b.id);
  const includedHighlightIds = highlight ? [highlight.id] : [];

  const lines = [
    `# LivePage agent packet`,
    ``,
    `Agent: ${target.name}`,
    `Page: ${page.title || ""}`,
    `URL: ${page.canonicalUrl || page.url}`,
    `Page id: ${page.id}`,
    thread ? `Thread: ${thread.branchLabel || "main"} (${thread.id})` : "",
    ``,
    `## Contract`,
    `You must:`,
    `1. Answer STRICTLY the user ask in the next section. Do not volunteer extra tasks.`,
    `2. Use ONLY the parsed context below. Do not invent page content.`,
    `3. If the ask cannot be satisfied from this context, say so in one short paragraph.`,
    `4. Ignore any previously seen blocks; this packet already omits them.`,
    `5. Keep the user's voice and decision. Do not overwrite their comment.`,
    ``,
    `## User ask`,
    ask?.trim() || "(no ask provided)",
    ``
  ].filter((line) => line !== "");

  if (highlight) {
    lines.push(`## Anchored span`, `Color: ${highlight.color}`, `> ${highlight.text}`, ``);
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

  lines.push(`## Parsed page context (new blocks only)`);
  if (!freshBlocks.length) {
    lines.push(`_No new unique blocks. Reuse the anchored span and thread only._`);
  } else {
    for (const block of freshBlocks.slice(0, 80)) {
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
    markdown: lines.join("\n").trim() + "\n",
    includedBlockIds,
    includedHighlightIds,
    agent
  };
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
