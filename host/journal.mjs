import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * A line per ask, so a pass that produced nothing can be looked at afterwards.
 *
 * The host used to say three things at startup and nothing ever again. That is
 * fine until a markup pass comes back with no gist and no marks: the page draws
 * nothing, the corner says nothing useful, and there is no record anywhere of
 * what was asked or what came back. The only way to see it was to reproduce it
 * from the command line and hope it failed the same way twice.
 *
 * So each ask writes one line, and markup asks write what actually matters
 * about them — whether the reply carried the headings the parser needs, and
 * whether a gist survived. That is the difference between "the model did not
 * write one" and "the model wrote one and we dropped it", which are the two
 * halves nobody could tell apart from the page.
 *
 * It is a log, so it holds page titles and reply sizes. It does not hold the
 * reply: an article you read is not something to leave lying in a file, and
 * `--raw` on the dry run is there when the text itself is the question.
 */
/**
 * Read per call rather than once at import.
 *
 * Frozen at module load it cannot be pointed anywhere else afterwards, which
 * is wrong for an env var and, more practically, made it untestable: the test
 * file imports this at the top, so by the time a test sets the variable the
 * path it wanted was already decided.
 */
export function logPath() {
  return resolve(process.env.LIVEPAGE_AGENT_LOG || "host/agent-host.log");
}

/** Kept small — one call is one line, and the useful ones are the last few. */
export async function journal(entry) {
  if (process.env.LIVEPAGE_AGENT_LOG === "off") return;
  const line = `${new Date().toISOString()}  ${entry}\n`;
  try {
    await appendFile(logPath(), line);
  } catch {
    // A host that cannot write its log is still a host that can answer.
  }
  if (process.env.LIVEPAGE_AGENT_QUIET !== "1") process.stdout.write(line);
}

/**
 * What a markup reply looks like from the outside.
 *
 * Deliberately not a parse — this reports the shape the parser will be handed,
 * so the log still tells the truth on the day the parser is what is wrong.
 */
export function shapeOfMarkupReply(text) {
  const reply = String(text || "");
  const lines = reply.split(/\r?\n/);
  const heading = (word) =>
    lines.some((line) => new RegExp(`^\\s*(?:#{1,4}\\s*)?(?:\\*\\*|__)?\\s*${word}\\b`, "i").test(line));
  const markLines = lines.filter((line) => line.includes("|")).length;
  return [
    `chars=${reply.length}`,
    `gistHeading=${heading("gist") ? "yes" : "NO"}`,
    `marksHeading=${heading("marks?") ? "yes" : "NO"}`,
    `pipeLines=${markLines}`
  ].join(" ");
}

/** Whether this packet is a markup pass, so the line can say more about it. */
export function looksLikeMarkupPacket(packet) {
  return /^#\s*Mark up this article/m.test(String(packet || ""));
}
