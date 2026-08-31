import assert from "node:assert/strict";
import test from "node:test";
import { canonicalizeUrl, hostnameOf, pageIdFromUrl } from "../extension/shared/url.js";
import { blockIdFromText } from "../extension/shared/id.js";
import { uniqueBlocks } from "../extension/parse/page-parser.js";
import { hostLooksInfinite, evaluateInfiniteScroll } from "../extension/parse/infinite-scroll.js";
import { toolbarAction } from "../extension/content/selection.js";
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
  assert.match(result.reason, /infinite feed/);
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

test("follow-up packets keep the thread and ask the agent to continue", () => {
  const thread = {
    id: "th1",
    highlightId: "hl1",
    branchLabel: "main",
    messages: [
      { role: "user", content: "What does this mean?" },
      { role: "agent", agent: "cursor", content: "It marks a decision." }
    ]
  };
  const packet = buildAgentPacket({
    page: {
      id: "p_1",
      title: "Essay",
      canonicalUrl: "https://example.com/essay",
      url: "https://example.com/essay",
      parsed: { headings: [], wordCount: 1, contentHash: "h", blocks: [] },
      highlights: [{ id: "hl1", color: "lemon", text: "decision site" }],
      threads: [thread]
    },
    thread,
    ask: "And why should I care?",
    ledger: { sentBlockIds: [] },
    agent: "cursor"
  });
  assert.match(packet.markdown, /continuing conversation/);
  assert.match(packet.markdown, /And why should I care\?/);
  assert.match(packet.markdown, /It marks a decision/);
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

test("scroll depth derives reading status", async () => {
  const { applyProgress, deriveReadState, isWaiting, progressLabel } = await import(
    "../extension/shared/progress.js"
  );
  assert.equal(deriveReadState(0), "unread");
  assert.equal(deriveReadState(42), "in_progress");
  assert.equal(deriveReadState(95), "read");
  const page = { readState: "unread", progress: { maxPercent: 0 } };
  applyProgress(page, 40, 800);
  assert.equal(page.readState, "in_progress");
  assert.equal(page.progress.maxPercent, 40);
  assert.equal(progressLabel(page), "40% through");
  assert.equal(isWaiting(page), true);
  page.readState = "parked";
  applyProgress(page, 99, 2000);
  assert.equal(page.readState, "parked");
  assert.equal(page.progress.maxPercent, 99);
});

test("review items flag threads whose last voice is the user", async () => {
  const { reviewItems } = await import("../extension/shared/progress.js");
  const pages = [
    {
      id: "p1",
      title: "Essay",
      threads: [
        {
          id: "t1",
          highlightId: "h1",
          messages: [
            { role: "user", content: "ask", createdAt: 2 },
            { role: "agent", content: "reply", createdAt: 3 }
          ]
        },
        {
          id: "t2",
          highlightId: "h2",
          messages: [{ role: "user", content: "still mine", createdAt: 4 }]
        }
      ],
      highlights: [{ id: "h2", text: "quote" }]
    }
  ];
  const items = reviewItems(pages);
  assert.equal(items.length, 2);
  assert.equal(items[0].awaiting, true);
  assert.equal(items[0].last.content, "still mine");
  assert.equal(items[1].awaiting, false);
});

test("selection toolbar stays up when the page collapses the live range", () => {
  assert.equal(
    toolbarAction({ liveHasRange: true, gestureSelected: true, savedRange: { collapsed: false } }),
    "show"
  );
  assert.equal(
    toolbarAction({ liveHasRange: false, gestureSelected: true, savedRange: { collapsed: false } }),
    "show"
  );
  assert.equal(
    toolbarAction({ liveHasRange: false, gestureSelected: false, savedRange: { collapsed: false } }),
    "hide"
  );
  assert.equal(
    toolbarAction({ liveHasRange: false, gestureSelected: true, savedRange: { collapsed: true } }),
    "hide"
  );
});
