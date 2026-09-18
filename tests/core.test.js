import assert from "node:assert/strict";
import test from "node:test";
import { canonicalizeUrl, hostnameOf, pageIdFromUrl } from "../extension/shared/url.js";
import { blockIdFromText } from "../extension/shared/id.js";
import { absoluteUrl, uniqueBlocks } from "../extension/parse/page-parser.js";
import { hostLooksInfinite, evaluateInfiniteScroll } from "../extension/parse/infinite-scroll.js";
import { toolbarAction } from "../extension/content/selection.js";
import { asksForClarity, buildAgentPacket, linksFrom, nextLedger } from "../extension/agent/packet.js";
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

test("agent packet includes only new blocks, and sends the agent after sources", () => {
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
  // The contract used to end at "answer strictly using this packet", which
  // made "the page does not say" a complete answer. A reader who asks again
  // wants the source opened, not the gap restated.
  assert.match(packet.markdown, /go and get it/);
  assert.doesNotMatch(packet.markdown, /STRICTLY/);
  const ledger = nextLedger({ sentBlockIds: ["b_old"] }, packet, page.id);
  assert.ok(ledger.sentBlockIds.includes("b_new"));
});

test("a packet carries the links the page was standing on", () => {
  // `textContent` used to eat every href, so an article that cites an upstream
  // fix arrived as an article that gestured at one. The agent could not name
  // the source, let alone open it.
  const page = {
    id: "p1",
    url: "https://site.test/report",
    parsed: {
      blocks: [
        {
          id: "b_new",
          tag: "p",
          text: "The 100,000 figure comes from the upstream fix.",
          links: [{ text: "the upstream fix", href: "https://github.test/org/repo/pull/7" }]
        }
      ]
    },
    highlights: [],
    threads: []
  };
  const packet = buildAgentPacket({ page, thread: null, ask: "Where does that number come from?" });
  assert.match(packet.markdown, /## Where this page points/);
  assert.match(packet.markdown, /\[the upstream fix\]\(https:\/\/github\.test\/org\/repo\/pull\/7\)/);
});

test("a page with no links gets no empty section", () => {
  const page = {
    id: "p1",
    url: "https://site.test/report",
    parsed: { blocks: [{ id: "b1", tag: "p", text: "No links here at all.", links: [] }] },
    highlights: [],
    threads: []
  };
  const packet = buildAgentPacket({ page, thread: null, ask: "What is this?" });
  assert.doesNotMatch(packet.markdown, /Where this page points/);
});

test("only somewhere you could actually go counts as a link", () => {
  assert.equal(absoluteUrl("/fix/7", "https://site.test/report"), "https://site.test/fix/7");
  assert.equal(absoluteUrl("https://other.test/a"), "https://other.test/a");
  assert.equal(absoluteUrl("#section", "https://site.test/report"), "https://site.test/report#section");
  assert.equal(absoluteUrl("mailto:a@b.test", "https://site.test/report"), "");
  assert.equal(absoluteUrl("javascript:void(0)", "https://site.test/report"), "");
  assert.equal(absoluteUrl("", "https://site.test/report"), "");
});

test("packet links are deduped and capped", () => {
  const blocks = Array.from({ length: 20 }, (_, i) => ({
    links: [{ text: `link ${i}`, href: `https://site.test/${i}` }, { text: "same", href: "https://site.test/0" }]
  }));
  const links = linksFrom(blocks);
  assert.equal(links.length, 12);
  assert.equal(new Set(links.map((l) => l.href)).size, 12);
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

test("an ask shaped like a question is read as someone stuck", () => {
  assert.equal(asksForClarity("What does a control plane actually do?"), true);
  assert.equal(asksForClarity("why does that follow"), true);
  assert.equal(asksForClarity("eli5"), true);
  assert.equal(asksForClarity("I don't get this paragraph"), true);
  assert.equal(asksForClarity("Explain the second half"), true);
  // A brief is not a question, and answering it as though the reader were
  // lost is its own kind of condescension.
  assert.equal(asksForClarity("Draft a reply to this post"), false);
  assert.equal(asksForClarity("Pull the numbers into a table"), false);
  assert.equal(asksForClarity(""), false);
});

test("the colour already says they are lost, whatever they typed", () => {
  // sky means "unclear or needs context" everywhere else in the product, so
  // reaching for it is the reader saying so before they type a word.
  assert.equal(asksForClarity("go on", { color: "sky" }), true);
  assert.equal(asksForClarity("go on", { color: "lemon" }), false);
});

const clarityPage = {
  id: "p_c",
  title: "Control planes",
  url: "https://site.test/control-planes",
  canonicalUrl: "https://site.test/control-planes",
  parsed: {
    headings: [],
    wordCount: 40,
    blocks: [{ id: "b1", tag: "p", text: "The control plane watches the work as it unfolds." }]
  },
  highlights: [{ id: "hl1", color: "sky", text: "The control plane watches the work" }],
  threads: [{ id: "th1", highlightId: "hl1", branchLabel: "main", messages: [] }]
};

test("a question in the margin is answered for someone who got stuck", () => {
  const packet = buildAgentPacket({
    page: clarityPage,
    thread: clarityPage.threads[0],
    ask: "What is a control plane?"
  });
  // The failure this guards against is the one reply with no value in it:
  // the highlighted sentence, reworded and handed back.
  assert.match(packet.markdown, /never hand it back reworded/);
  assert.match(packet.markdown, /no background in this subject/);
  // And the failure the first version of this contract caused: a good opening
  // sentence, then a glossary of every noun in the passage, then a paragraph
  // on the practical upshot. A margin card is not a page.
  assert.match(packet.markdown, /at most three sentences/);
  assert.match(packet.markdown, /Never a list, a heading, a bolded label/);
  assert.match(packet.markdown, /not what each word in it means/);
});

test("a brief in the margin keeps the ordinary voice", () => {
  const packet = buildAgentPacket({
    page: { ...clarityPage, highlights: [{ id: "hl1", color: "lemon", text: "The control plane watches the work" }] },
    thread: clarityPage.threads[0],
    ask: "Summarise this into three bullets for the team."
  });
  assert.doesNotMatch(packet.markdown, /never hand it back reworded/);
  assert.match(packet.markdown, /natural, concise language/);
});

test("a follow-up question stays in the thread and stays patient", () => {
  const packet = buildAgentPacket({
    page: clarityPage,
    thread: {
      ...clarityPage.threads[0],
      messages: [
        { role: "user", content: "What is a control plane?" },
        { role: "agent", agent: "cursor", content: "It is the part that decides what runs." }
      ]
    },
    ask: "Why does it need to be separate?"
  });
  assert.match(packet.markdown, /Stay in the thread/);
  assert.match(packet.markdown, /never hand it back reworded/);
});
