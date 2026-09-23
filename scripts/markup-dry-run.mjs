#!/usr/bin/env node
/**
 * Runs a markup pass outside the browser and shows every step of it.
 *
 * A pass that comes back with no gist looks identical, from the page, to a
 * feature that was never built: nothing is drawn, and nothing says why. There
 * are four places it can go — the article was not parsed the way you think,
 * the model did not write a gist, the reply was written in a shape the parser
 * does not read, or the card had nowhere to mount — and from a browser
 * console you cannot tell which.
 *
 * So this runs the same code the extension runs, on the same agent host, and
 * prints what each stage actually produced.
 *
 *   node scripts/markup-dry-run.mjs https://example.com/an-article
 *   node scripts/markup-dry-run.mjs demo/article.html
 *   node scripts/markup-dry-run.mjs --reply saved-reply.txt   # no agent call
 *
 * Options:
 *   --agent cursor|claude-code   which agent to ask (default: cursor)
 *   --model <id>                 model override
 *   --reply <file>               parse a reply you already have, and stop
 *   --raw                        print the reply exactly as it arrived
 */
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { parseDocument } from "../extension/parse/page-parser.js";
import {
  anchorMarkup,
  articleIsWorthMarking,
  buildMarkupPacket,
  markCeiling,
  parseMarkupGist,
  parseMarkupReply
} from "../extension/agent/markup.js";
import { cleanAgentReply } from "../extension/agent/reply.js";
import { pairAgentHost, pingAgentHost, runAgentAsk } from "../extension/agent/host-client.js";

const argv = process.argv.slice(2);
const flag = (name, fallback = "") => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? argv[at + 1] || "" : fallback;
};
const has = (name) => argv.includes(`--${name}`);
const target = argv.find((arg) => !arg.startsWith("--") && argv[argv.indexOf(arg) - 1]?.startsWith("--") !== true);

const bold = (s) => `[1m${s}[0m`;
const dim = (s) => `[2m${s}[0m`;
const good = (s) => `[32m${s}[0m`;
const bad = (s) => `[31m${s}[0m`;
const step = (n, title) => console.log(`\n${bold(`${n}. ${title}`)}`);

async function main() {
  const replyFile = flag("reply");

  let parsed = null;
  let reply = "";

  if (replyFile) {
    reply = readFileSync(replyFile, "utf8");
    console.log(dim(`Parsing ${replyFile}; no page and no agent call.`));
  } else {
    if (!target) {
      console.error("Give me a URL, an HTML file, or --reply <file>.");
      process.exit(2);
    }
    parsed = await parsePage(target);
    reply = await askAgent(parsed);
  }

  if (parsed) reportParse(parsed);
  reportReply(reply, parsed);
}

/** Stage one: what the parser thinks this page is. */
async function parsePage(where) {
  const isUrl = /^https?:\/\//i.test(where);
  const html = isUrl
    ? await fetch(where, { headers: { "User-Agent": "Mozilla/5.0 LivePage dry run" } }).then((r) => r.text())
    : readFileSync(where, "utf8");
  const dom = new JSDOM(html.replace(/<script[\s\S]*?<\/script>/g, ""), {
    url: isUrl ? where : "https://local.test/article"
  });
  for (const key of ["window", "document", "Node", "NodeFilter", "HTMLElement"]) {
    globalThis[key] = key === "window" ? dom.window : dom.window[key];
  }
  const parsed = parseDocument(dom.window.document, isUrl ? where : "https://local.test/article");
  parsed.__document = dom.window.document;
  parsed.__url = isUrl ? where : where;
  return parsed;
}

function reportParse(parsed) {
  step(1, "What the parser sees");
  const worth = articleIsWorthMarking(parsed);
  console.log(`   title       ${parsed.title || dim("(none)")}`);
  console.log(`   words       ${parsed.wordCount}`);
  console.log(`   blocks      ${parsed.blocks.length}`);
  console.log(`   ceiling     ${markCeiling(parsed.wordCount)} marks`);
  console.log(`   hash        ${parsed.contentHash}`);
  console.log(`   markable    ${worth ? good("yes") : bad("no — the pass would stop here")}`);
  if (!worth) {
    console.log(dim("   (needs 320+ words and 3+ blocks; a page below that is never read)"));
  }

  // Where the card would go, asked of the same document the parse came from.
  step(2, "Where the card would mount");
  try {
    const root = pickRootFor(parsed.__document);
    console.log(`   content root  <${root.tagName.toLowerCase()}${root.id ? "#" + root.id : ""}>`);
    const firstProse = [...root.querySelectorAll("p, li, blockquote, pre")].find(
      (node) => (node.textContent || "").trim().length >= 80 && !node.closest(".lp-ignore")
    );
    console.log(
      firstProse
        ? `   mounts before <${firstProse.tagName.toLowerCase()}> ${dim(`"${firstProse.textContent.trim().slice(0, 60)}…"`)}`
        : bad("   no paragraph over 80 characters — the card has nowhere to go")
    );
  } catch (error) {
    console.log(bad(`   could not resolve a mount: ${error.message}`));
  }
}

function pickRootFor(doc) {
  for (const selector of [
    "article", "main", "[role='main']", ".post-content", ".entry-content", ".article-body", "#content", ".markdown-body"
  ]) {
    const el = doc.querySelector(selector);
    if (el && (el.textContent || "").replace(/\s+/g, " ").trim().length > 200) return el;
  }
  return doc.body;
}

/** Stage three: what the agent actually said. */
async function askAgent(parsed) {
  step(3, "Asking the agent");
  const settings = { agentHostUrl: "http://127.0.0.1:17321" };
  const paired = await pairAgentHost(settings);
  if (!paired.ok) {
    console.error(bad("   could not pair with the agent host — is `npm run agent-host` running?"));
    process.exit(1);
  }
  settings.agentHostToken = paired.token;
  const health = await pingAgentHost(settings);
  const agent = flag("agent", "cursor");
  console.log(`   host ok, agent ${agent}${flag("model") ? `, model ${flag("model")}` : ""}`);
  if (health.cursorOk === false && agent === "cursor") {
    console.log(bad("   the host cannot find the cursor binary"));
  }

  const packet = buildMarkupPacket({
    pageTitle: parsed.title,
    url: parsed.__url,
    blocks: parsed.blocks,
    wordCount: parsed.wordCount
  });
  console.log(dim(`   packet is ${packet.length} characters`));
  const started = Date.now();
  const result = await runAgentAsk({ settings, agent, model: flag("model"), packet });
  console.log(`   replied in ${Math.round((Date.now() - started) / 1000)}s`);
  return result.text;
}

/** Stages four and five: what survived the reader, and what survived the check. */
function reportReply(raw, parsed) {
  const cleaned = cleanAgentReply(raw);

  step(4, "The reply");
  if (has("raw")) {
    console.log(dim("--- exactly as it arrived ---"));
    console.log(raw);
    console.log(dim("--- end ---"));
  }
  if (cleaned !== raw.trim()) {
    console.log(dim(`   a preamble was stripped (${raw.trim().length} → ${cleaned.length} characters)`));
  }
  const headings = cleaned.split(/\r?\n/).filter((line) => /^\s*(?:#{1,4}\s*)?(?:\*\*|__)?\s*(gist|marks?)\b/i.test(line));
  console.log(
    headings.length
      ? `   headings found: ${headings.map((h) => JSON.stringify(h.trim())).join(", ")}`
      : bad("   no Gist or Marks heading anywhere in the reply")
  );

  step(5, "The gist");
  const gist = parseMarkupGist(cleaned);
  if (gist) {
    console.log(good(`   ${gist.length} characters — the card would draw`));
    console.log(`\n   ${gist.replace(/(.{88}\s)/g, "$1\n   ")}\n`);
  } else {
    console.log(bad("   empty — no card would be drawn"));
    console.log(dim("   the reply said NONE, had no readable Gist section, or it looked like mark lines"));
    console.log(dim("   re-run with --raw to see what the model actually sent"));
  }

  step(6, "The marks");
  const proposed = parseMarkupReply(cleaned, markCeiling(parsed?.wordCount || 0));
  console.log(`   ${proposed.length} proposed`);
  if (parsed) {
    const kept = anchorMarkup(proposed, parsed.blocks);
    console.log(
      `   ${kept.length} survived the quote check` +
        (kept.length < proposed.length ? bad(`  (${proposed.length - kept.length} were not verbatim)`) : "")
    );
    for (const mark of kept) console.log(dim(`     ${mark.color.padEnd(6)} ${mark.text.slice(0, 70)}…`));
  }

  console.log(
    `\n${bold("Verdict:")} ${
      gist ? good("a gist came back — if no card shows, the fault is in the page, not the pass") : bad("no gist came back — the model or the parse is where this is failing")
    }\n`
  );
}

main().catch((error) => {
  console.error(bad(`\nFailed: ${error.message}`));
  process.exit(1);
});
