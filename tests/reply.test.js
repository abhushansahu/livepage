import assert from "node:assert/strict";
import test from "node:test";
import { cleanAgentReply } from "../extension/agent/reply.js";

test("the preamble that started this is removed", () => {
  const reply = [
    "I'll read `packet.md` to find the latest user question and answer it directly.",
    "This passage is setting up the shift from linear models to non-linear ones."
  ].join("\n");
  assert.equal(cleanAgentReply(reply), "This passage is setting up the shift from linear models to non-linear ones.");
});

test("other ways of saying the same thing are also removed", () => {
  const openings = [
    "Let me read the packet first.",
    "I will check packet.md for the user's question.",
    "Sure! I'll look at the file and answer.",
    "Reading packet.md now.",
    "First, I'll read the provided context.",
    "Okay, let me read packet.md."
  ];
  for (const opening of openings) {
    assert.equal(cleanAgentReply(`${opening}\nThe real answer.`), "The real answer.", opening);
  }
});

test("an answer that merely sounds like a preamble is kept", () => {
  // Two conditions have to hold — an intent to act *and* a reference to our
  // own plumbing — because deleting a real first paragraph is much worse than
  // leaving a tidy-up line in.
  const keep = [
    "Reading this closely, the author argues the opposite.",
    "I'll explain why linear models fall short here.",
    "Let me put that another way: the parameters are what you learn.",
    "I am not sure this passage supports that claim."
  ];
  for (const line of keep) {
    assert.equal(cleanAgentReply(`${line}\nMore.`), `${line}\nMore.`, line);
  }
});

test("narration sharing a line with the answer loses only the narration", () => {
  const reply = "I'll read packet.md. This passage is about non-linear models.";
  assert.equal(cleanAgentReply(reply), "This passage is about non-linear models.");
});

test("a long first sentence is never taken for a preamble", () => {
  const long =
    "I'll read the file as a whole rather than in fragments, because the argument in this section depends on the paragraph before it and quoting either alone would misrepresent what the author is claiming here. Then the rest.";
  assert.equal(cleanAgentReply(long), long);
});

test("shown reasoning is not part of the answer", () => {
  assert.equal(
    cleanAgentReply("<thinking>The user wants X.</thinking>\nThe answer is X."),
    "The answer is X."
  );
});

test("tool traces are dropped", () => {
  assert.equal(cleanAgentReply("Read packet.md\nGrep theta\nThe answer."), "The answer.");
});

test("a reply wrapped entirely in one prose fence is unwrapped", () => {
  assert.equal(cleanAgentReply("```markdown\n**Bold** answer.\n```"), "**Bold** answer.");
  assert.equal(cleanAgentReply("```\nPlain answer.\n```"), "Plain answer.");
});

test("a reply that really is a program keeps its fence", () => {
  const code = "```python\nprint(1)\n```";
  assert.equal(cleanAgentReply(code), code);
});

test("a fence inside a longer reply is left alone", () => {
  const reply = "Here is the loop:\n\n```py\nfor i in x:\n    pass\n```\n\nThat is the shape of it.";
  assert.equal(cleanAgentReply(reply), reply);
});

test("runs of blank lines are collapsed", () => {
  assert.equal(cleanAgentReply("One.\n\n\n\nTwo."), "One.\n\nTwo.");
});

test("an empty reply says so rather than being blank", () => {
  assert.match(cleanAgentReply(""), /couldn’t form a useful reply/);
  assert.match(cleanAgentReply("Let me read packet.md."), /couldn’t form a useful reply/);
});
