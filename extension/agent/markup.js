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

/**
 * A ceiling, never a target — and it moves with the article.
 *
 * A 12,000-word essay carries more argument than a 900-word note, so holding
 * both to one number either starves the long piece or invites padding in the
 * short one. This scales with length and still sits well above what a good
 * reply needs, so it binds only on a runaway.
 *
 * It used to sit at one mark per 700 words with a floor of four, which meant
 * every article under about 2,800 words — most of what anyone reads — was
 * held to four marks whatever it argued. Four is not enough to carry an
 * argument: a reader gets the claim and none of what it stands on.
 *
 * One per 250 with a floor of six is roughly a mark every couple of
 * paragraphs, which is what the prompt now asks for. The number has to sit
 * above a good reply rather than on top of it — a ceiling that trims what an
 * honest read produced is a quota wearing a different hat, and the reader
 * never learns which marks it took.
 */
export function markCeiling(wordCount = 0) {
  return Math.max(6, Math.min(MAX_MARKS, Math.ceil((wordCount || 0) / 250)));
}

/** The most any reply may contain, whatever the article. */
export const MAX_MARKS = 32;

/** Below this there is nothing to skim, and the call is not worth making. */
export const MIN_WORDS = 320;

const MAX_QUOTE = 300;
const MIN_QUOTE = 16;

export function buildMarkupPacket({ pageTitle = "", url = "", blocks = [], wordCount = 0 } = {}) {
  const ceiling = markCeiling(wordCount);
  const long = wordCount >= 2500;
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
    `The test is what someone gets from your marks alone. They should come`,
    `away holding the argument — what it claims, what those claims rest on,`,
    `and where it turns. If they would finish with a headline and none of the`,
    `reasoning under it, you marked too little.`,
    ``,
    `Both directions fail, and marking too little is the more common one.`,
    `Padding with passages that carry nothing buries the real marks. But an`,
    `article makes its case over several moves, and marking one of them hands`,
    `a reader a gap they have no way of knowing is there. A piece that is`,
    `arguing something usually gives you a passage worth stopping at every few`,
    `paragraphs; if you have marked a whole article in two or three places,`,
    `read it again, because you are summarising rather than marking.`,
    ``,
    `There is still no quota, and you are not scored on reaching one. An`,
    `article that makes no point worth stopping at — an announcement, a`,
    `listing, boilerplate — gets **zero**, and returning nothing is the`,
    `correct answer there.`,
    ``,
    wordCount
      ? `This piece runs about ${wordCount} words. ${
          long
            ? `A piece this long usually carries several distinct points, and a reader skimming it needs enough marks to follow the argument from one end to the other — a long piece marked in three places leaves them stranded in the middle. Mark each point that carries it, including the evidence a point stands on where losing that evidence would leave the claim unsupported.`
            : `A piece this short still makes more than one move — the claim, and whatever it rests on — so look for those rather than settling on the first sentence that sounds like a thesis.`
        }`
      : null,
    `Never mark more than ${ceiling}. That is a guard against a runaway reply,`,
    `not a target and not a shape to aim at.`,
    ``,
    `## Colours`,
    ``,
    `Six colours, and each is a different reason to stop. Choosing well is`,
    `half of what a mark is worth: the colour tells a reader what kind of`,
    `attention a passage wants before they have read a word of it.`,
    ``,
    palette,
    ``,
    `Ask what the passage *is*, not what it is about. The thing the piece is`,
    `claiming is a key idea; the study, number or quotation holding that claim`,
    `up is evidence; something a reader could go and do is an action; a risk`,
    `or objection the author raises is a concern; a connection that travels`,
    `somewhere beyond this article is an insight; something left unexplained`,
    `is a question.`,
    ``,
    `An article marked entirely in one colour has thrown away most of what`,
    `the marks could have said, and it is usually a sign of labelling rather`,
    `than reading — a claim and the evidence under it are not the same kind`,
    `of passage. Anything with an argument in it normally earns three or more`,
    `of these. Do not force a colour onto a passage to spread them, and do`,
    `not fall back on the first in the list.`,
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
export function parseMarkupReply(reply, ceiling = MAX_MARKS) {
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
    if (marks.length >= Math.min(ceiling, MAX_MARKS)) break;
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
    //
    // The exception is a passage that occurs more than once. Ambiguity is
    // scored from the prefix and suffix around a quote, and a model is never
    // asked for either — so a sentence the article happens to repeat scored
    // as loose and was thrown away, despite being the one thing we can be
    // certain of: text found whole in the article. The first occurrence is
    // taken, and the overlap check below stops two marks landing on one span.
    const verbatim = found.rung === 1;
    if (!verbatim && confidence !== "exact" && confidence !== "close") continue;
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

/**
 * Drops the marks you have already kept as your own highlights.
 *
 * This only bites on a second pass, and it is the reason a second pass is
 * safe to offer. The agent reads the article, not your page, so asking again
 * will happily suggest the sentence you kept the first time — and a
 * suggestion to keep what you already own is noise drawn on top of your own
 * colour. Containment either way, because a mark is rarely the exact span you
 * dragged over.
 */
export function dropAlreadyKept(marks, highlights) {
  const kept = (highlights || [])
    .map((highlight) => normalizeText(highlight?.text || "").toLowerCase())
    .filter((text) => text.length >= MIN_QUOTE);
  if (!kept.length) return marks || [];
  return (marks || []).filter((mark) => {
    const text = normalizeText(mark?.text || "").toLowerCase();
    if (!text) return false;
    return !kept.some((own) => own.includes(text) || text.includes(own));
  });
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
