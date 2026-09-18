/**
 * Keeping the agent's scaffolding out of the conversation.
 *
 * The packet already asks for the answer only, and mostly gets it. But a CLI
 * agent is a tool-using thing, and it narrates: "I'll read `packet.md` to find
 * the latest user question and answer it directly." That sentence is true and
 * completely uninteresting, and once it is in the thread it is in the vault,
 * in the export, and in the search index forever.
 *
 * The rule is deliberately two-part — an intent to act **and** a reference to
 * our own scaffolding — because either alone would eat real answers. "Reading
 * this closely, the author argues…" is an answer. "Let me read packet.md" is
 * not. The cost of being wrong is asymmetric: a leaked preamble is untidy, a
 * deleted first paragraph loses the point of the reply.
 */

/** Somebody announcing what they are about to do. */
const INTENT =
  /^(?:(?:sure|ok|okay|alright|right|got it|understood)[\s,.!:—-]+)*(?:i(?:['’]|\s+wi)?ll\b|i['’]m\b|i am\b|i will\b|i need to\b|i should\b|i have to\b|let me\b|let['’]s\b|first,?\s+i\b|now,?\s+i\b|going to\b|reading\b|opening\b|checking\b|looking at\b|scanning\b|fetching\b|starting by\b)/i;

/** …about our own plumbing rather than about the page. */
const SCAFFOLD =
  /\b(?:packet(?:\.md)?|the file|that file|the attached|the provided|tool call|read the (?:page|file|notes)|user['’]?s? (?:question|ask|request)|latest (?:question|ask|message|request)|answer (?:it|the question|this) directly|the (?:context|content) (?:above|below|provided))\b/i;

/** A line that is nothing but a tool trace. */
const TRACE = /^(?:<thinking>|Read |Grep |Glob |Bash |Search(?:ing)? |Tool: |Running )/i;

/**
 * The longest a preamble can be.
 *
 * Announcing what you are about to do is a short thing to say. Past this the
 * sentence is carrying real content, whatever it opens with — and a long first
 * paragraph is exactly what must never be deleted by accident.
 */
const PREAMBLE_MAX = 180;

export function cleanAgentReply(value) {
  let text = String(value || "").replace(/\r\n?/g, "\n");

  // Reasoning the model chose to show. Not an answer, and not ours to keep.
  text = text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "");

  // A whole reply wrapped in one fence is the model formatting its answer, not
  // showing code. Unwrap it, or the margin renders the entire thing as a
  // monospace block.
  text = unwrapWholeFence(text);

  const lines = text.split("\n");
  while (lines.length) {
    const line = lines[0].trim().replace(/`/g, "");
    if (!line) {
      lines.shift();
      continue;
    }
    if (TRACE.test(line)) {
      lines.shift();
      continue;
    }
    // The sentence before the line, always. Narration and answer often share
    // one line — "I'll read packet.md. This passage is setting up…" — and
    // dropping the line there would take the answer with it.
    const trimmed = dropLeadingSentence(lines[0]);
    if (trimmed !== null) {
      lines[0] = trimmed;
      continue;
    }
    if (isPreamble(line)) {
      lines.shift();
      continue;
    }
    break;
  }

  return (
    lines
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim() || "I couldn’t form a useful reply from this passage."
  );
}

function isPreamble(line) {
  return line.length <= PREAMBLE_MAX && INTENT.test(line) && SCAFFOLD.test(line);
}

/**
 * Removes a first sentence that is scaffolding, if the rest of the line is
 * real. Returns null when there is nothing to remove, so the caller can tell
 * "trimmed" from "nothing left".
 *
 * The space after the full stop is optional, and that is not pedantry. A CLI
 * agent streams its narration and its answer as one run of text, and they
 * arrive welded: "…to see what's being asked.The highlighted sentence is…".
 * With a required space the split failed, the whole thing became one long
 * line, and the line was then too long to look like a preamble — so the
 * narration went into the thread, the vault and the search index exactly as
 * this file exists to prevent.
 *
 * A bare full stop is not enough on its own, though: the narration we most
 * want to catch is the one that says `packet.md`, and a split allowed
 * anywhere would cut it at that dot and leave "md to find the latest user
 * question…" in the thread. So a missing space is only accepted before a
 * capital, which is a sentence starting rather than a filename continuing.
 */
function dropLeadingSentence(line) {
  const match = /^(.{10,}?[.!?])(?:\s+|(?=[A-Z]))(\S.*)$/.exec(line.trim().replace(/`/g, ""));
  if (!match) return null;
  const [, first, rest] = match;
  if (!isPreamble(first)) return null;
  return rest;
}

/**
 * A reply that is entirely one code fence, unwrapped — but only when the fence
 * has no language, or a prose one. ```python around the whole reply means the
 * answer really is a program.
 */
function unwrapWholeFence(text) {
  const match = /^\s*```(\w*)\n([\s\S]*?)\n?```\s*$/.exec(text);
  if (!match) return text;
  const language = match[1].toLowerCase();
  if (language && !["markdown", "md", "text", "txt", "plain"].includes(language)) return text;
  return match[2];
}
