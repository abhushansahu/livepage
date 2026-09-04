import assert from "node:assert/strict";
import test from "node:test";
import {
  PER_PAGE_LIMIT,
  highlightMatches,
  pageMatchesQuery,
  snippetAround
} from "../extension/shared/search.js";
import { pageMatches } from "../extension/storage/store.js";

function page(overrides = {}) {
  return {
    id: "p1",
    title: "On attention",
    domain: "example.com",
    url: "https://example.com/attention",
    canonicalUrl: "https://example.com/attention",
    tags: [],
    updatedAt: 10,
    parsed: { excerpt: "", headings: [], blocks: [] },
    highlights: [],
    threads: [],
    ...overrides
  };
}

test("a plain highlight with no comment is still findable", () => {
  const found = highlightMatches(
    [
      page({
        highlights: [{ id: "hl1", text: "attention is the scarce resource", createdAt: 1 }],
        threads: [{ id: "th1", highlightId: "hl1", messages: [] }]
      })
    ],
    "scarce"
  );
  assert.equal(found.length, 1, "walking threads would drop the commonest kind of highlight");
  assert.equal(found[0].field, "highlight");
  assert.equal(found[0].last, null, "an uncommented highlight has no last message");
  assert.equal(found[0].thread.id, "th1");
});

test("matches are found in your words and in the agent's, and labelled", () => {
  const subject = page({
    highlights: [{ id: "hl1", text: "a quote with nothing special", createdAt: 1 }],
    threads: [
      {
        id: "th1",
        highlightId: "hl1",
        messages: [
          { id: "m1", role: "user", content: "this reminds me of scarcity", createdAt: 2 },
          { id: "m2", role: "agent", content: "the economics of abundance", createdAt: 3 }
        ]
      }
    ]
  });

  const mine = highlightMatches([subject], "scarcity");
  assert.equal(mine[0].field, "user");
  assert.equal(mine[0].message.id, "m1");

  const theirs = highlightMatches([subject], "abundance");
  assert.equal(theirs[0].field, "agent");
  assert.equal(theirs[0].message.id, "m2");
});

test("the passage you marked outranks something an agent said", () => {
  const found = highlightMatches(
    [
      page({
        id: "p1",
        highlights: [
          { id: "hl1", text: "an aside that mentions attention", createdAt: 1 },
          { id: "hl2", text: "an unrelated quote", createdAt: 1 }
        ],
        threads: [
          { id: "t1", highlightId: "hl1", messages: [] },
          {
            id: "t2",
            highlightId: "hl2",
            messages: [{ id: "m", role: "agent", content: "something about attention", createdAt: 5 }]
          }
        ]
      })
    ],
    "attention"
  );
  assert.deepEqual(
    found.map((item) => item.field),
    ["highlight", "agent"]
  );
});

test("your own words outrank the agent's for the same query", () => {
  const found = highlightMatches(
    [
      page({
        highlights: [
          { id: "a", text: "quote a", createdAt: 1 },
          { id: "b", text: "quote b", createdAt: 1 }
        ],
        threads: [
          { id: "t1", highlightId: "a", messages: [{ id: "m1", role: "agent", content: "on memory", createdAt: 4 }] },
          { id: "t2", highlightId: "b", messages: [{ id: "m2", role: "user", content: "on memory", createdAt: 3 }] }
        ]
      })
    ],
    "memory"
  );
  assert.deepEqual(
    found.map((item) => item.field),
    ["user", "agent"]
  );
});

test("one heavily annotated page cannot crowd out every other page", () => {
  const busy = page({
    id: "busy",
    highlights: Array.from({ length: 10 }, (_, i) => ({
      id: `h${i}`,
      text: `attention note number ${i}`,
      createdAt: i
    })),
    threads: []
  });
  const other = page({
    id: "other",
    highlights: [{ id: "x", text: "attention elsewhere", createdAt: 1 }],
    threads: []
  });

  const found = highlightMatches([busy, other], "attention");
  const fromBusy = found.filter((item) => item.page.id === "busy");
  assert.equal(fromBusy.length, PER_PAGE_LIMIT);
  assert.ok(
    found.some((item) => item.page.id === "other"),
    "the other page must survive the crowd"
  );
});

test("an empty query returns nothing rather than everything", () => {
  const subject = page({ highlights: [{ id: "h", text: "anything", createdAt: 1 }], threads: [] });
  assert.deepEqual(highlightMatches([subject], ""), []);
  assert.deepEqual(highlightMatches([subject], "   "), []);
});

test("matching ignores case", () => {
  const subject = page({
    highlights: [{ id: "h", text: "Attention Is All You Need", createdAt: 1 }],
    threads: []
  });
  assert.equal(highlightMatches([subject], "attention is all").length, 1);
});

test("a passage result carries everything a review item does", () => {
  const found = highlightMatches(
    [
      page({
        highlights: [{ id: "h", text: "a marked passage", createdAt: 1 }],
        threads: [
          { id: "t", highlightId: "h", messages: [{ id: "m", role: "user", content: "marked", createdAt: 2 }] }
        ]
      })
    ],
    "marked"
  );
  for (const key of ["page", "thread", "highlight", "last", "awaiting"]) {
    assert.ok(key in found[0], `passage results must stay compatible on ${key}`);
  }
  assert.equal(found[0].awaiting, true, "a user message left last is still waiting on a reply");
});

test("the snippet centres the match and reports where it landed", () => {
  const body = `${"padding ".repeat(40)}the decisive phrase${" trailing".repeat(40)}`;
  const snippet = snippetAround(body, "decisive phrase");
  assert.equal(snippet.text.slice(snippet.start, snippet.end), "decisive phrase");
  assert.ok(snippet.text.startsWith("…"));
  assert.ok(snippet.text.endsWith("…"));
  assert.ok(snippet.text.length < body.length);
});

test("a snippet that needs no trimming gets no ellipses", () => {
  const snippet = snippetAround("a short line", "short");
  assert.equal(snippet.text, "a short line");
  assert.equal(snippet.text.slice(snippet.start, snippet.end), "short");
});

test("the snippet survives a match at either edge", () => {
  const head = snippetAround("decisive opening words", "decisive");
  assert.equal(head.text.slice(head.start, head.end), "decisive");
  assert.equal(head.start, 0);

  const tail = snippetAround("words then decisive", "decisive");
  assert.equal(tail.text.slice(tail.start, tail.end), "decisive");
});

test("a snippet with no match falls back to the opening of the text", () => {
  const snippet = snippetAround("nothing relevant here", "absent");
  assert.equal(snippet.start, 0);
  assert.equal(snippet.end, 0);
  assert.ok(snippet.text.startsWith("nothing"));
});

test("the store and the shared matcher agree on every page", () => {
  const fixtures = [
    page({ title: "On attention" }),
    page({ tags: ["design"], title: "Untitled" }),
    page({ highlights: [{ id: "h", text: "a marked passage", createdAt: 1 }] }),
    page({
      threads: [{ id: "t", highlightId: "h", messages: [{ id: "m", role: "agent", content: "a reply", createdAt: 1 }] }]
    }),
    page({ parsed: { excerpt: "an excerpt", headings: ["a heading"], blocks: [] } })
  ];
  for (const subject of fixtures) {
    for (const query of ["attention", "design", "marked", "reply", "heading", "absent"]) {
      assert.equal(
        pageMatches(subject, query),
        pageMatchesQuery(subject, query),
        `divergence on "${query}"`
      );
    }
  }
});
