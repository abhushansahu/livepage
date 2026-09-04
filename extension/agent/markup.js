import { COLORS, COLOR_IDS } from "../shared/colors.js";
import { locateQuote, anchorConfidence } from "../parse/quote.js";
import { normalizeText } from "../parse/page-parser.js";

/**
 * Reading an article ahead of you and marking the few passages worth stopping
 * at, in the colours the product already uses to mean something.
 *
 * The point is to be able to skim: if everything is marked, nothing is. So
 * there is no target count anywhere in the prompt. Asking for a number is how
 * you get padding — a model told to find five will find five whether or not a
 * fifth exists. It is told the opposite: fewer is better, and none is a real
 * answer for an article that makes no point worth stopping at.
 */

/** Not a target. A guard against a runaway reply, set far above a sane one. */
export const MAX_MARKS = 12;

/** Below this there is nothing to skim, and the call is not worth making. */
export const MIN_WORDS = 320;

const MAX_QUOTE = 300;
const MIN_QUOTE = 16;

export function buildMarkupPacket({ pageTitle = "", url = "", blocks = [] } = {}) {
  const body = blocks
    .filter((block) => block?.text)
    .map((block) => (block.heading ? `## ${block.text}` : block.text))
    .join("\n\n");

  const palette = COLOR_IDS.map((id) => `- \`${id}\` — ${COLORS[id].name}: ${COLORS[id].purpose}`).join(
    "\n"
  );

  return [
    `# Mark up this article for a reader who has not read it`,
    ``,
    `You are marking passages a reader should stop at, so they can skim the`,
    `rest. Your marks are the difference between them reading this in two`,
    `minutes or twenty.`,
    ``,
    `## The rule that matters`,
    ``,
    `Mark a passage **only if losing it would lose something the article is`,
    `actually saying**. Not the topic sentence of every section. Not context.`,
    `Not a passage that is merely well written.`,
    ``,
    `There is no target number, and you are not being scored on finding one.`,
    `An article making two real points gets two marks. One that makes none —`,
    `an announcement, a listing, boilerplate — gets **zero**, and returning`,
    `nothing is the correct answer there. Padding to look thorough is the one`,
    `way to fail this: every extra mark makes the real ones harder to see.`,
    `Never mark more than ${MAX_MARKS}; if you are near that, you are padding.`,
    ``,
    `## Colours`,
    ``,
    `Pick the one that says what the passage *is*. Do not default to one.`,
    ``,
    palette,
    ``,
    `## Quoting`,
    ``,
    `Each quote must be copied **exactly** from the text below — same words,`,
    `same order, same spelling. Do not paraphrase, summarise, join sentences`,
    `that were apart, or fix anything. A quote that is not verbatim is thrown`,
    `away, so an approximate one is worse than none.`,
    ``,
    `Keep each to a sentence or two — the span a reader's eye lands on, not a`,
    `whole paragraph.`,
    ``,
    `## Reply format`,
    ``,
    `One mark per line, nothing else — no preamble, no numbering, no closing`,
    `remark. If nothing is worth marking, reply with exactly \`NONE\`.`,
    ``,
    `\`\`\``,
    `color | exact quote from the article | why this is worth stopping at`,
    `\`\`\``,
    ``,
    `The reason is for the reader, in under 12 words. Say what the passage`,
    `gives them, not that it is important.`,
    ``,
    `## Article`,
    ``,
    `Title: ${pageTitle || "(untitled)"}`,
    url ? `URL: ${url}` : "",
    ``,
    body
  ]
    .filter((line) => line !== null)
    .join("\n");
}

/**
 * Reads the model's reply into proposals. Anything malformed is dropped
 * rather than guessed at — a mark in the wrong place is worse than a missing
 * one, because the reader trusts it.
 */
export function parseMarkupReply(reply) {
  const text = String(reply || "").trim();
  if (!text || /^none\.?$/i.test(text)) return [];
  const marks = [];
  const seen = new Set();

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").trim();
    if (!line || line.startsWith("#") || line.startsWith("```")) continue;
    const parts = line.split("|").map((part) => part.trim());
    if (parts.length < 2) continue;

    const color = parts[0].replace(/^`|`$/g, "").toLowerCase();
    if (!COLOR_IDS.includes(color)) continue;

    const quote = normalizeText(stripQuotes(parts[1]));
    if (quote.length < MIN_QUOTE || quote.length > MAX_QUOTE) continue;

    const key = quote.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    marks.push({ color, quote, why: normalizeText(parts.slice(2).join(" | ")).slice(0, 120) });
    if (marks.length >= MAX_MARKS) break;
  }
  return marks;
}

/**
 * Keeps only the marks that are really in the article, and gives each the
 * prefix and suffix a highlight needs to anchor.
 *
 * This is the check that makes the feature trustworthy rather than decorative.
 * A model will quietly normalise a quote — smart quotes, a dropped comma, two
 * sentences welded together — and a highlight built from that would either
 * land somewhere wrong or vanish. Anything that does not match the article
 * cleanly is discarded here, before it can become a mark on the page.
 */
export function anchorMarkup(marks, blocks) {
  const hay = normalizeText((blocks || []).map((block) => block?.text || "").join("\n"));
  if (!hay) return [];
  const kept = [];
  const used = [];

  for (const mark of marks || []) {
    const found = locateQuote(hay, { exact: mark.quote });
    if (!found) continue;
    const confidence = anchorConfidence(found, { exact: mark.quote });
    // Only a clean match survives. A loose one is the model having rewritten
    // the sentence, not the page having changed underneath us.
    if (confidence !== "exact" && confidence !== "close") continue;
    if (used.some(([start, end]) => found.start < end && start < found.end)) continue;
    used.push([found.start, found.end]);

    kept.push({
      color: mark.color,
      why: mark.why,
      text: hay.slice(found.start, found.end),
      prefix: hay.slice(Math.max(0, found.start - 32), found.start),
      suffix: hay.slice(found.end, found.end + 32)
    });
  }
  return kept;
}

export function articleIsWorthMarking(parsed) {
  return (parsed?.wordCount || 0) >= MIN_WORDS && (parsed?.blocks || []).length >= 3;
}

function stripQuotes(value) {
  return String(value || "")
    .trim()
    .replace(/^[`"'“‘]+/, "")
    .replace(/[`"'”’]+$/, "")
    .trim();
}
