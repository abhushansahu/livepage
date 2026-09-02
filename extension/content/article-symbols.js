const ROOT_SELECTORS = [
  "article",
  "main",
  "[role='main']",
  ".post-content",
  ".entry-content",
  ".article-body",
  "#content",
  ".markdown-body"
];

const BLOCK_SELECTOR = "p, li, blockquote, td, h1, h2, h3, h4";
const SKIP_SELECTOR =
  "a, button, input, textarea, select, option, pre, script, style, noscript, svg, canvas, iframe, [contenteditable], .lp-ignore, mark.lp-hl, .lp-article-symbol";

/**
 * Words that can never carry a term on their own, and can never sit at the
 * edge of a phrase. Without this, "the model picker is a dead end" reads as a
 * definition of "the model".
 */
const STOP = new Set(
  `a an and are as at be been being but by can could did do does doing done for from had has have
   having he her here hers him his how i if in into is it its itself just me more most much my no
   nor not now of off on once only or other our ours out over own same she should so some such than
   that the their theirs them then there these they this those through to too under until up very
   was we were what when where which while who whom why will with would you your yours
   about after again against all also am any because before below between both during each else
   ever few further however less like made make many may might must never new next often once
   perhaps rather really said say see seen since still take than thing things think through thus
   time using want way well went yet always another around away back come coming even far get gets
   getting give given go going good great keep kept know known last later least let long look
   looking lot maybe mean means need needed needs part put right same seem seems set show shown
   sure tell than them themselves thought together took toward turn turned use used uses
   want wanted whether without work worked working
   above across along amid among around behind below beneath beside besides beyond despite
   inside near onto outside per plus regarding since throughout toward towards underneath
   unless unlike upon versus via within`
    .split(/\s+/)
    .filter(Boolean)
);

/**
 * Frequent English words that survive the stopword pass but are never jargon.
 * A single word only becomes a symbol if it is absent from both lists.
 */
const COMMON = new Set(
  `above across actual actually almost alone along already although among amount answer anyone
   anything appear applied apply approach available become becomes began begin behind believe
   below better beyond bring build building built call called calls case cases certain chance
   change changed changes choice choose clear clearly close common company complete consider
   contain continue could course create created current data decide decision decisions
   different difficult direct done double doubt during early easy effect either enough entire
   especially essential every everyone everything exact example examples except expect
   experience explain fact fail failed finally find finds first follow following force found
   full future general given group grow half hand happen hard help high hold hope house
   human idea ideas important include included including increase inside instead interest
   issue issues keep kind known large later learn learning least leave left level likely
   limit line little live local long longer look loss main major making manner matter member
   might mind minute model models moment money month more moving name nature near nearly
   need never note nothing number offer often open opinion option order others outside part
   particular pass past people perfect person piece place plan plans point points position
   possible power practice prefer present pretty previous private probably problem problems
   process product products program project provide provided public purpose quality question
   questions quick quickly quite reach read reading ready real reason reasons receive recent
   record reduce remain remember report request require required response result results
   return risk role room rule rules safe save saying school second section seeing sense
   series serious service several share short side simple simply single situation size small
   social solution someone something sometimes soon sort sound source space speak special
   specific spend stage stand start started state step steps stop story straight strong
   student study subject success support system systems table talk task tasks team tell term
   terms test tests thank third though three today total track trade trouble true trust try
   trying turning type types understand until update upon usually value various version view
   wait walk watch water week weeks whole wide window within wonder word words world write
   writing wrong year years
   agent aim answer approach build context cost decision detail effort evidence failure
   freedom gain goal history instruction job judge judgment prompt recovery response share
   thing tool unit`
    .split(/\s+/)
    .filter(Boolean)
);

const QUALIFIERS = new Set(
  `real true actual genuine simple single whole entire basic general overall so-called
   good great proper plain classic typical modern old first second third final
   one two three another every each any certain particular`
    .split(/\s+/)
    .filter(Boolean)
);

const MIN_PHRASE_HITS = 2;
const MIN_WORD_HITS = 4;
const PREFETCH_LIMIT = 4;
const glosses = new Map();
const failures = new Map();

/**
 * Finds the terms an article treats as jargon: acronyms it expands, phrases it
 * quotes or explicitly defines, and multi-word or uncommon terms it leans on
 * repeatedly. Article text supplies instant fallback context; the hover card
 * can replace it with a contextual AI explanation.
 */
export function extractArticleSymbols(blocks = [], limit = 32) {
  const body = (blocks || []).filter((block) => block?.text && !block.heading);
  const allText = (blocks || []).map((block) => block?.text || "").join(" ");
  if (!body.length) return [];

  const sentences = body.flatMap((block) => splitSentences(block.text));
  const candidates = new Map();

  const add = (raw, source) => {
    const term = trimTerm(raw);
    const key = normalizeTerm(term);
    if (!key || candidates.has(key) || !plausibleTerm(term)) return;
    candidates.set(key, { term, key, source });
  };

  for (const sentence of sentences) {
    for (const match of sentence.matchAll(ACRONYM)) add(match[2], "acronym");
    for (const match of sentence.matchAll(QUOTED)) add(match[1], "quoted");
    for (const match of sentence.matchAll(DEFINED)) add(match[1], "defined");
  }
  for (const phrase of repeatedPhrases(sentences)) add(phrase, "phrase");
  for (const word of repeatedWords(sentences, candidates)) add(word, "word");

  const symbols = [];
  for (const candidate of candidates.values()) {
    const support = supportFor(candidate, sentences);
    if (!support) continue;
    const count = countTerm(allText, candidate.term);
    if (count < minHits(support.kind, candidate.term)) continue;
    symbols.push({ ...candidate, ...support, count });
  }

  return symbols
    .sort((a, b) => rank(b) - rank(a) || b.count - a.count)
    .slice(0, limit)
    .map((symbol) => ({
      ...symbol,
      anchorBlockId: blockContaining(body, symbol.anchorText)?.id || null,
      anchorBlockText: blockContaining(body, symbol.anchorText)?.text || ""
    }));
}

export function enableArticleSymbols(doc, parsed, options = {}) {
  const symbols = extractArticleSymbols(parsed?.blocks || []);
  const root = symbols.length ? pickRoot(doc) : null;
  if (!root) return { count: 0, destroy() {} };

  const symbolByKey = new Map(symbols.map((symbol) => [symbol.key, symbol]));
  const anchorByKey = locateAnchors(root, symbols);
  const pattern = termPattern(symbols.map((symbol) => symbol.term).sort((a, b) => b.length - a.length));
  let count = 0;

  for (const node of textNodes(root, doc)) {
    const matches = [...node.data.matchAll(pattern)];
    if (!matches.length) continue;
    const fragment = doc.createDocumentFragment();
    let cursor = 0;
    for (const match of matches) {
      const start = match.index + (match[1] || "").length;
      if (start < cursor) continue;
      fragment.append(node.data.slice(cursor, start));
      const span = doc.createElement("span");
      const key = normalizeTerm(match[2]);
      span.className = "lp-article-symbol";
      span.dataset.lpSymbol = symbolByKey.has(key) ? key : normalizeTerm(singular(match[2]));
      span.textContent = match[2];
      if (anchorByKey.get(span.dataset.lpSymbol)?.contains(node)) span.dataset.lpAnchor = "true";
      fragment.append(span);
      cursor = start + match[2].length;
      count += 1;
    }
    fragment.append(node.data.slice(cursor));
    node.replaceWith(fragment);
  }

  const card = makeCard(doc);
  doc.documentElement.append(card);
  let hideTimer = null;
  let origin = null;
  let activeKey = "";

  const render = (symbol, span) => {
    const gloss = glosses.get(glossKey(options.url, symbol.key));
    card.querySelector(".lp-symbol-name").textContent = symbol.term;
    card.querySelector(".lp-symbol-kind").textContent = statusLabel(symbol, gloss);
    card.classList.toggle("lp-symbol-waiting", gloss?.status === "pending");
    card.querySelector(".lp-symbol-detail").textContent = gloss?.text || symbol.detail;
    card.querySelector(".lp-symbol-hint").textContent =
      span.dataset.lpAnchor === "true"
        ? `${symbol.count} mentions · you are at the source`
        : `${symbol.count} mentions · ⌘/Ctrl-click to jump, again to come back`;
    card.hidden = false;
    positionCard(card, span.getBoundingClientRect());
  };

  const show = (span) => {
    const symbol = symbolByKey.get(span.dataset.lpSymbol);
    if (!symbol) return;
    clearTimeout(hideTimer);
    activeKey = symbol.key;
    // The answer is worth waiting for even once the card is gone: it is cached
    // against the page, so the hover that follows is instant.
    const pending = loadGloss(symbol, parsed, options);
    render(symbol, span);
    pending?.then(() => {
      if (activeKey === symbol.key && span.isConnected) render(symbol, span);
    });
  };

  const scheduleHide = () => {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      card.hidden = true;
    }, 140);
  };

  const onPointerOver = (event) => {
    const span = event.target.closest?.(".lp-article-symbol");
    if (span) show(span);
  };
  const onPointerOut = (event) => {
    if (event.target.closest?.(".lp-article-symbol") && !card.contains(event.relatedTarget)) scheduleHide();
  };
  const onClick = (event) => {
    if (!event.metaKey && !event.ctrlKey) return;
    const span = event.target.closest?.(".lp-article-symbol");
    if (!span) return;
    const anchor = anchorByKey.get(span.dataset.lpSymbol);
    event.preventDefault();
    if (anchor && !anchor.contains(span)) {
      origin = span;
      jumpTo(anchor);
    } else if (origin?.isConnected) {
      jumpTo(origin);
      origin = null;
    }
  };
  // Holding the modifier lights every symbol at once, so they stay findable
  // without shouting over the author's own typography the rest of the time.
  const onKeyDown = (event) => {
    if (event.key === "Meta" || event.key === "Control") doc.documentElement.classList.add("lp-symbols-peek");
  };
  const onKeyUp = () => doc.documentElement.classList.remove("lp-symbols-peek");

  warmGlosses(options).then(() => prefetchGlosses(symbols, parsed, options));

  card.addEventListener("pointerenter", () => clearTimeout(hideTimer));
  card.addEventListener("pointerleave", scheduleHide);
  root.addEventListener("pointerover", onPointerOver);
  root.addEventListener("pointerout", onPointerOut);
  root.addEventListener("click", onClick, true);
  doc.addEventListener("keydown", onKeyDown);
  doc.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onKeyUp);

  return {
    count,
    symbols,
    destroy() {
      root.removeEventListener("pointerover", onPointerOver);
      root.removeEventListener("pointerout", onPointerOut);
      root.removeEventListener("click", onClick, true);
      doc.removeEventListener("keydown", onKeyDown);
      doc.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onKeyUp);
      doc.documentElement.classList.remove("lp-symbols-peek");
      card.remove();
      root.querySelectorAll(".lp-article-symbol").forEach((span) => span.replaceWith(span.textContent));
      root.normalize();
    }
  };
}

const ACRONYM = /\b([A-Z][A-Za-z]*(?:[\s-][A-Za-z][A-Za-z-]+){1,5})\s+\(([A-Z][A-Za-z0-9-]{1,9})\)/g;
const QUOTED = /[“"']([\p{L}][\p{L}\p{N}\s’'/-]{2,46})[”"']/gu;
const DEFINED =
  /\b((?:[\p{L}][\p{L}\p{N}’'/-]+)(?:\s+[\p{L}][\p{L}\p{N}’'/-]+){0,3})\s+(?:is|are|means|refers to|describes|stands for)\s+/giu;

const KIND_LABEL = {
  defined: "Defined in this article",
  acronym: "Stands for",
  context: "Context from this article"
};

/**
 * A term the article itself spells out already has a real explanation on the
 * page, so only the ones it leans on without ever explaining are worth an
 * agent turn.
 */
export function shouldExplainWithAi(symbol) {
  if (!symbol || symbol.kind !== "context") return false;
  const term = String(symbol.term || "").trim();
  if (term.length < 4) return false;
  const words = term.split(/\s+/);
  if (words.length > 4) return false;
  return !words.every((word) => {
    const lower = singular(word.toLowerCase());
    return COMMON.has(lower) || STOP.has(lower) || QUALIFIERS.has(lower);
  });
}

function statusLabel(symbol, gloss) {
  if (gloss?.text) return "Explanation";
  if (gloss?.status === "pending") return "Explaining…";
  if (gloss?.status === "error") return `${KIND_LABEL[symbol.kind]} · explanation unavailable`;
  return KIND_LABEL[symbol.kind];
}

function loadGloss(symbol, parsed, options) {
  if (typeof options.call !== "function" || !shouldExplainWithAi(symbol)) return null;
  // One dead agent host should cost a couple of slow hovers, not one per term.
  if ((failures.get(String(options.url)) || 0) >= 2) return null;
  const key = glossKey(options.url, symbol.key);
  const existing = glosses.get(key);
  if (existing?.promise) return existing.promise;
  if (existing?.text || existing?.status === "error") return null;

  const entry = { status: "pending", text: "" };
  const promise = options
    .call("EXPLAIN_SYMBOL", {
      term: symbol.term,
      termKey: symbol.key,
      pageTitle: options.pageTitle || "",
      url: options.url || "",
      anchorText: symbol.anchorText,
      nearbyBlocks: contextBlocks(parsed?.blocks || [], symbol.anchorBlockId)
    })
    .then((result) => {
      const text = String(result?.text || "").replace(/\s+/g, " ").trim();
      glosses.set(key, text ? { status: "done", text } : { status: "error", text: "" });
      return text;
    })
    .catch((error) => {
      console.warn("LivePage could not explain", symbol.term, error);
      failures.set(String(options.url), (failures.get(String(options.url)) || 0) + 1);
      glosses.set(key, { status: "error", text: "" });
      return "";
    });
  entry.promise = promise;
  glosses.set(key, entry);
  return promise;
}

/**
 * Explanations already paid for on an earlier visit come back before the first
 * hover, so a page you kept never asks for the same term twice.
 */
async function warmGlosses(options) {
  if (typeof options.call !== "function") return;
  try {
    const { entries } = (await options.call("GET_GLOSSARY", { url: options.url })) || {};
    for (const [termKey, text] of Object.entries(entries || {})) {
      if (text) glosses.set(glossKey(options.url, termKey), { status: "done", text });
    }
  } catch (error) {
    console.warn("LivePage glossary unavailable", error);
  }
}

/**
 * Pages you kept are read closely enough to be worth explaining ahead of the
 * hover; passing traffic only pays for the terms you actually stop on.
 */
async function prefetchGlosses(symbols, parsed, options) {
  if (!options.prefetch) return;
  const queue = symbols
    .filter((symbol) => shouldExplainWithAi(symbol))
    .filter((symbol) => !glosses.get(glossKey(options.url, symbol.key))?.text)
    .sort((a, b) => b.count - a.count)
    .slice(0, PREFETCH_LIMIT);
  for (const symbol of queue) {
    const text = await loadGloss(symbol, parsed, options);
    if (!text) return;
  }
}

function glossKey(url, termKey) {
  return `${String(url || location.href)}::${termKey}`;
}

function contextBlocks(blocks, anchorBlockId, windowSize = 2) {
  const body = blocks.filter((block) => block?.text && !block.heading);
  const index = body.findIndex((block) => block.id === anchorBlockId);
  if (index < 0) return body.slice(0, 3);
  return body.slice(Math.max(0, index - windowSize), index + windowSize + 1);
}

function rank(symbol) {
  if (symbol.kind === "acronym") return 3;
  if (symbol.kind === "defined") return 2;
  return 1;
}

/**
 * Supporting text always comes from a sentence in the article. A definition is
 * only accepted when the predicate actually says something, which is what keeps
 * headline copy like "the model picker is a dead end" out of the card.
 */
function supportFor(candidate, sentences) {
  const term = escapeRegExp(candidate.term);
  const expands = new RegExp(`\\b([A-Z][\\w-]*(?:[\\s-][\\w-]+){1,5})\\s+\\(${term}\\)`);
  // Anchored at the start of the sentence on purpose: the term has to be what
  // the sentence is about. Without that, "If the context is wrong, a tool is
  // confusing" reads as a definition of "context".
  const defines = new RegExp(
    `^(?:the|a|an|our|your|its|their|real|true)?\\s*${term}s?\\b\\s+(?:is|are|means|refers to|describes|stands for)\\s+([^.!?]{28,220})`,
    "i"
  );
  const appositive = new RegExp(`^(?:the|a|an)?\\s*${term}s?\\b\\s*(?:—|–|:)\\s*([^.!?]{28,220})`, "i");
  const mentions = new RegExp(`\\b${term}s?\\b`, "i");

  for (const sentence of sentences) {
    const expansion = sentence.match(expands);
    if (expansion) return { kind: "acronym", detail: cleanDetail(expansion[1]), anchorText: sentence };
  }
  for (const sentence of sentences) {
    const match = sentence.match(defines) || sentence.match(appositive);
    if (match && wordCount(match[1]) >= 6) {
      return { kind: "defined", detail: cleanDetail(match[1]), anchorText: sentence };
    }
  }
  const mention = sentences.find((sentence) => mentions.test(sentence) && wordCount(sentence) >= 10);
  return mention ? { kind: "context", detail: clip(cleanDetail(mention), 260), anchorText: mention } : null;
}

function repeatedPhrases(sentences) {
  const counts = new Map();
  for (const sentence of sentences) {
    const words = tokenize(sentence);
    for (let size = 3; size >= 2; size -= 1) {
      for (let i = 0; i + size <= words.length; i += 1) {
        const slice = words.slice(i, i + size).map((word) => word.toLowerCase());
        if (slice.some((word) => STOP.has(word) || QUALIFIERS.has(word) || word.length < 2)) continue;
        // A phrase built only from everyday words ("different models") is not
        // jargon, however often the article repeats it.
        if (slice.every((word) => COMMON.has(singular(word)))) continue;
        const term = words.slice(i, i + size).join(" ");
        const entry = counts.get(normalizeTerm(term)) || { term, count: 0 };
        entry.count += 1;
        counts.set(normalizeTerm(term), entry);
      }
    }
  }
  return [...counts.values()]
    .filter((entry) => entry.count >= MIN_PHRASE_HITS)
    .sort((a, b) => b.count - a.count)
    .map((entry) => entry.term);
}

/**
 * Single words earn a symbol only when they are uncommon and load-bearing, and
 * never when they are already part of a phrase that was picked up.
 */
function repeatedWords(sentences, candidates) {
  const inPhrase = new Set();
  for (const candidate of candidates.values()) {
    for (const word of candidate.key.split(" ")) inPhrase.add(word);
  }
  const counts = new Map();
  for (const sentence of sentences) {
    for (const raw of tokenize(sentence)) {
      const word = singular(raw.toLowerCase());
      if (word.length < 5 || STOP.has(word) || COMMON.has(word) || inPhrase.has(word)) continue;
      const entry = counts.get(word) || { term: singular(raw), count: 0 };
      entry.count += 1;
      counts.set(word, entry);
    }
  }
  return [...counts.values()]
    .filter((entry) => entry.count >= MIN_WORD_HITS)
    .sort((a, b) => b.count - a.count)
    .map((entry) => entry.term);
}

/**
 * A term the article actually explains only has to appear once. Terms resting
 * on nothing but a passing mention have to prove they carry the piece.
 */
function minHits(kind, term) {
  if (kind === "acronym") return 2;
  if (kind === "defined") return 1;
  return term.includes(" ") ? MIN_PHRASE_HITS : MIN_WORD_HITS;
}

/**
 * Definitional sentences hand back whatever led up to the verb, so drop the
 * qualifiers in front of the head phrase: "The model picker" becomes "model
 * picker", never the bare "the model".
 */
function trimTerm(value) {
  const words = cleanTerm(value).split(/\s+/).filter(Boolean);
  while (words.length > 1) {
    const first = words[0].toLowerCase();
    if (!STOP.has(first) && !QUALIFIERS.has(first)) break;
    words.shift();
  }
  return words.slice(-4).join(" ");
}

function plausibleTerm(value) {
  const term = cleanTerm(value);
  const words = term.split(/\s+/);
  if (term.length < 3 || term.length > 52 || words.length > 6) return false;
  if (STOP.has(words[0].toLowerCase()) || STOP.has(words[words.length - 1].toLowerCase())) return false;
  if (words.length === 1 && !/^[A-Z][A-Z0-9-]{1,9}$/.test(term)) {
    const word = singular(term.toLowerCase());
    if (word.length < 5 || COMMON.has(word) || QUALIFIERS.has(word)) return false;
  }
  return /[\p{L}]/u.test(term);
}

function tokenize(value) {
  return String(value || "").match(/[\p{L}\p{N}][\p{L}\p{N}’'-]*/gu) || [];
}

function splitSentences(value) {
  return String(value || "")
    .split(/(?<=[.!?])\s+(?=[\p{Lu}“"'])/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 12);
}

function singular(value) {
  const word = String(value || "");
  if (/(ss|us|is|as)$/i.test(word) || word.length <= 4) return word;
  if (/ies$/i.test(word)) return `${word.slice(0, -3)}y`;
  if (/es$/i.test(word) && /(ch|sh|x|z|s)es$/i.test(word)) return word.slice(0, -2);
  return /s$/i.test(word) ? word.slice(0, -1) : word;
}

function wordCount(value) {
  return tokenize(value).length;
}

function clip(value, max) {
  const text = String(value || "");
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function cleanTerm(value) {
  return String(value || "").replace(/^[\s"'“”]+|[\s"'“”,:;.]+$/g, "").trim();
}

function cleanDetail(value) {
  return String(value || "").replace(/\s+/g, " ").trim().replace(/[.;:,\s]+$/, "");
}

function normalizeTerm(value) {
  return cleanTerm(value).toLocaleLowerCase();
}

function countTerm(text, term) {
  return [...String(text || "").matchAll(termPattern([term]))].length;
}

function termPattern(terms) {
  const alternatives = terms.map((term) => `${escapeRegExp(term)}(?:s|es)?`).join("|");
  return new RegExp(`(^|[^\\p{L}\\p{N}_])(${alternatives})(?=$|[^\\p{L}\\p{N}_])`, "giu");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function blockContaining(blocks, text) {
  const needle = normalizeSpace(text);
  if (!needle) return null;
  return blocks.find((block) => normalizeSpace(block.text).includes(needle)) || null;
}

function pickRoot(doc) {
  for (const selector of ROOT_SELECTORS) {
    const root = doc.querySelector(selector);
    if (root && root.textContent.trim().length > 200) return root;
  }
  return null;
}

function locateAnchors(root, symbols) {
  const blocks = [...root.querySelectorAll(BLOCK_SELECTOR)];
  const anchors = new Map();
  for (const symbol of symbols) {
    const needle = normalizeSpace(symbol.anchorBlockText || symbol.anchorText);
    if (!needle) continue;
    const target = blocks.find((block) => normalizeSpace(block.textContent).includes(needle));
    if (target) anchors.set(symbol.key, target);
  }
  return anchors;
}

function textNodes(root, doc) {
  const nodes = [];
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.data.trim() || node.parentElement?.closest(SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  let node = walker.nextNode();
  while (node) {
    nodes.push(node);
    node = walker.nextNode();
  }
  return nodes;
}

function makeCard(doc) {
  const card = doc.createElement("aside");
  card.className = "lp-symbol-card lp-ignore";
  card.hidden = true;
  card.innerHTML =
    '<strong class="lp-symbol-name"></strong><em class="lp-symbol-kind"></em>' +
    '<span class="lp-symbol-detail"></span><small class="lp-symbol-hint"></small>';
  return card;
}

function positionCard(card, rect) {
  const margin = 12;
  const width = Math.min(360, window.innerWidth - margin * 2);
  card.style.width = `${width}px`;
  card.style.left = `${Math.min(window.innerWidth - width - margin, Math.max(margin, rect.left))}px`;
  const below = rect.bottom + 8;
  const fitsBelow = below + card.offsetHeight + margin <= window.innerHeight;
  card.style.top = `${fitsBelow ? below : Math.max(margin, rect.top - card.offsetHeight - 8)}px`;
}

function jumpTo(element) {
  element.scrollIntoView({ behavior: "smooth", block: "center" });
  element.classList.remove("lp-symbol-pulse");
  requestAnimationFrame(() => element.classList.add("lp-symbol-pulse"));
  setTimeout(() => element.classList.remove("lp-symbol-pulse"), 1200);
}

function normalizeSpace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}
