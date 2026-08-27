import assert from "node:assert/strict";
import test from "node:test";
import { canonicalizeUrl, hostnameOf, pageIdFromUrl } from "../extension/shared/url.js";
import { blockIdFromText } from "../extension/shared/id.js";
import { uniqueBlocks } from "../extension/parse/page-parser.js";
import { hostLooksInfinite, evaluateInfiniteScroll } from "../extension/parse/infinite-scroll.js";
import { buildAgentPacket, nextLedger } from "../extension/agent/packet.js";
import { pageToMarkdown, suggestedFilename } from "../extension/export/obsidian.js";

test("canonicalizeUrl strips tracking and www", () => {
  const raw = "https://www.Example.com/a/b/?utm_source=x&fbclid=1&q=2#top";
  assert.equal(canonicalizeUrl(raw), "https://example.com/a/b?q=2");
});

test("page ids are stable for a canonical url", () => {
  const a = pageIdFromUrl(canonicalizeUrl("https://site.test/post"));
  const b = pageIdFromUrl(canonicalizeUrl("https://www.site.test/post/"));
  assert.equal(a, b);
  assert.equal(hostnameOf("https://www.site.test/post"), "site.test");
});

test("block ids collapse whitespace so duplicates drop", () => {
  const a = blockIdFromText("Hello   world");
  const b = blockIdFromText("hello world");
  assert.equal(a, b);
  const blocks = [
    { id: a, text: "Hello world" },
    { id: "other", text: "fresh" }
  ];
  const unique = uniqueBlocks(blocks, [a]);
  assert.equal(unique.length, 1);
  assert.equal(unique[0].id, "other");
});

test("infinite hosts and feed roles are detected", () => {
  assert.equal(hostLooksInfinite("https://x.com/home"), true);
  assert.equal(hostLooksInfinite("https://example.com/essay"), false);
  const fakeDoc = { querySelector: (s) => (s.includes("feed") ? {} : null) };
  const result = evaluateInfiniteScroll("https://example.com/x", fakeDoc);
  assert.equal(result.infinite, true);
  assert.equal(result.reason, "dom-hint");
});

test("agent packet includes only new blocks and the strict ask", () => {
  const page = {
    id: "p_1",
    title: "Essay",
    canonicalUrl: "https://example.com/essay",
    url: "https://example.com/essay",
    why: "understand trails",
    parsed: {
      headings: ["One"],
      wordCount: 12,
      contentHash: "h",
      blocks: [
        { id: "b_old", tag: "p", text: "already sent" },
        { id: "b_new", tag: "p", text: "fresh evidence" }
      ]
    },
    highlights: [{ id: "hl1", color: "lemon", text: "decision site" }],
    threads: [
      {
        id: "th1",
        highlightId: "hl1",
        branchLabel: "main",
        messages: [{ role: "user", content: "prior note" }]
      }
    ]
  };
  const packet = buildAgentPacket({
    page,
    thread: page.threads[0],
    ask: "Does this span redefine reading?",
    ledger: { sentBlockIds: ["b_old"] },
    agent: "cursor"
  });
  assert.match(packet.markdown, /Does this span redefine reading\?/);
  assert.match(packet.markdown, /fresh evidence/);
  assert.doesNotMatch(packet.markdown, /already sent/);
  assert.match(packet.markdown, /Answer STRICTLY the user ask/);
  const ledger = nextLedger({ sentBlockIds: ["b_old"] }, packet, page.id);
  assert.ok(ledger.sentBlockIds.includes("b_new"));
});

test("obsidian dump keeps anchor, voice, branch, and state", () => {
  const page = {
    id: "p_1",
    title: "Essay",
    canonicalUrl: "https://example.com/essay",
    url: "https://example.com/essay",
    domain: "example.com",
    readState: "in_progress",
    bookmarked: true,
    tags: ["trails"],
    updatedAt: Date.parse("2026-08-27T00:00:00Z"),
    parsed: { excerpt: "clip", headings: ["Why the live page"] },
    highlights: [{ id: "hl1", color: "moss", text: "living animal" }],
    threads: [
      {
        id: "th1",
        highlightId: "hl1",
        parentId: null,
        branchLabel: "main",
        status: "open",
        messages: [{ role: "user", content: "I disagree" }]
      },
      {
        id: "th2",
        highlightId: "hl1",
        parentId: "th1",
        forkedFromMessageId: "m1",
        branchLabel: "other take",
        status: "parked",
        messages: [
          { role: "user", content: "I disagree" },
          { role: "agent", agent: "cursor", content: "Only answering the ask." }
        ]
      }
    ]
  };
  const md = pageToMarkdown(page);
  assert.match(md, /living animal/);
  assert.match(md, /I disagree/);
  assert.match(md, /other take/);
  assert.match(md, /Agent \(cursor\)/);
  assert.match(suggestedFilename(page), /example-com/);
});
