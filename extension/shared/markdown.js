/**
 * Rendering what an agent wrote so a person can read it.
 *
 * Agents answer in markdown with LaTeX in it, because that is how they were
 * trained to write about anything mathematical. Escaping that and showing it
 * raw puts `h_\theta(x) = \theta^\top x` in the margin, which is worse than
 * useless: the reader has to decode it, and the whole point of the margin is
 * that the thought is right there.
 *
 * So: a deliberately small subset of markdown, and LaTeX converted to real
 * characters. No library. KaTeX is a few hundred kilobytes to typeset the
 * handful of constructs that actually turn up in a conversation about a paper.
 * Greek letters, sub- and superscripts, fractions and the common operators
 * cover almost everything an agent writes, and what is left over degrades to
 * legible text rather than to noise.
 *
 * Everything here is pure and returns HTML that is already escaped. Nothing
 * the model wrote reaches the DOM unescaped — the only tags in the output are
 * the ones this file emits.
 */

const GREEK = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ",
  epsilon: "ϵ", varepsilon: "ε", zeta: "ζ", eta: "η",
  theta: "θ", vartheta: "ϑ", iota: "ι", kappa: "κ",
  lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π",
  rho: "ρ", sigma: "σ", varsigma: "ς", tau: "τ",
  upsilon: "υ", phi: "ϕ", varphi: "φ", chi: "χ",
  psi: "ψ", omega: "ω",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ",
  Xi: "Ξ", Pi: "Π", Sigma: "Σ", Upsilon: "Υ",
  Phi: "Φ", Psi: "Ψ", Omega: "Ω"
};

const SYMBOLS = {
  ...GREEK,
  times: "×", cdot: "·", div: "÷", pm: "±", mp: "∓",
  ast: "∗", star: "⋆", circ: "∘",
  approx: "≈", neq: "≠", ne: "≠", leq: "≤", le: "≤",
  geq: "≥", ge: "≥", ll: "≪", gg: "≫", equiv: "≡",
  propto: "∝", sim: "∼", simeq: "≃", cong: "≅",
  in: "∈", notin: "∉", ni: "∋", subset: "⊂",
  subseteq: "⊆", supset: "⊃", supseteq: "⊇", cup: "∪",
  cap: "∩", setminus: "∖", emptyset: "∅",
  forall: "∀", exists: "∃", neg: "¬", lnot: "¬",
  land: "∧", lor: "∨",
  to: "→", rightarrow: "→", Rightarrow: "⇒",
  leftarrow: "←", Leftarrow: "⇐", leftrightarrow: "↔",
  Leftrightarrow: "⇔", mapsto: "↦", implies: "⟹", iff: "⟺",
  sum: "∑", prod: "∏", int: "∫", oint: "∮",
  partial: "∂", nabla: "∇", infty: "∞",
  top: "⊤", bot: "⊥", perp: "⊥", angle: "∠",
  ldots: "…", cdots: "⋯", dots: "…", vdots: "⋮",
  prime: "′", ell: "ℓ", hbar: "ℏ",
  langle: "⟨", rangle: "⟩", lceil: "⌈", rceil: "⌉",
  lfloor: "⌊", rfloor: "⌋", vert: "|", Vert: "‖",
  argmax: "argmax", argmin: "argmin", max: "max", min: "min", log: "log",
  ln: "ln", exp: "exp", sin: "sin", cos: "cos", tan: "tan", det: "det",
  dim: "dim", ker: "ker", deg: "deg", gcd: "gcd", lim: "lim", sup: "sup",
  inf: "inf", Pr: "Pr", quad: " ", qquad: "  "
};

const BLACKBOARD = {
  R: "ℝ", N: "ℕ", Z: "ℤ", Q: "ℚ", C: "ℂ",
  E: "𝔼", P: "ℙ", H: "ℍ"
};

/** Diacritics, which combine with the character before them. */
const ACCENTS = {
  hat: "̂", bar: "̄", overline: "̄", tilde: "̃",
  dot: "̇", ddot: "̈", vec: "⃗", check: "̌", acute: "́"
};

/** Commands that swallow one group and mark it up rather than transform it. */
const WRAPPERS = {
  mathbf: (body) => `<b>${body}</b>`,
  boldsymbol: (body) => `<b>${body}</b>`,
  mathit: (body) => `<i>${body}</i>`,
  mathrm: (body) => `<span class="up">${body}</span>`,
  operatorname: (body) => `<span class="up">${body}</span>`,
  text: (body) => `<span class="up">${body}</span>`,
  textrm: (body) => `<span class="up">${body}</span>`,
  mathcal: (body) => body,
  mathsf: (body) => body,
  mathtt: (body) => `<code>${body}</code>`
};

const SPACING = new Set([",", ";", "!", ":", " ", "\n"]);
const LITERAL = new Set(["{", "}", "$", "%", "&", "#", "_", "\\"]);

/**
 * The marker for a piece of output that is already rendered.
 *
 * A NUL survives HTML escaping untouched and cannot appear in anything a model
 * writes, so no part of the text can be mistaken for one of these.
 */
const MARK = "\u0000";

/**
 * LaTeX to HTML, for the subset that actually shows up in a conversation.
 *
 * A hand-written parser rather than regular expressions, because the two
 * constructs that matter most — `^{...}` and `\frac{a}{b}` — nest, and their
 * contents need the same treatment as everything else.
 */
export function latexToHtml(source) {
  return convert(String(source || ""));
}

function convert(src) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const ch = src[i];

    if (ch === "\\") {
      const step = command(src, i);
      out += step.html;
      i = step.next;
      continue;
    }

    if (ch === "^" || ch === "_") {
      const arg = argument(src, i + 1);
      const tag = ch === "^" ? "sup" : "sub";
      out += `<${tag}>${convert(arg.body)}</${tag}>`;
      i = arg.next;
      continue;
    }

    if (ch === "{" || ch === "}") {
      // Grouping braces carry no meaning once their command has consumed them;
      // a stray one is the model's typo, not something to show.
      i += 1;
      continue;
    }

    out += escapeHtml(ch);
    i += 1;
  }
  return out;
}

function command(src, at) {
  const rest = src.slice(at + 1);
  const name = (/^[A-Za-z]+/.exec(rest) || [""])[0];

  if (!name) {
    const ch = src[at + 1] || "";
    if (SPACING.has(ch)) return { html: " ", next: at + 2 };
    if (LITERAL.has(ch)) return { html: escapeHtml(ch), next: at + 2 };
    return { html: "", next: at + 2 };
  }

  let cursor = at + 1 + name.length;

  if (name === "frac" || name === "dfrac" || name === "tfrac") {
    const top = argument(src, cursor);
    const bottom = argument(src, top.next);
    return { html: fraction(convert(top.body), convert(bottom.body)), next: bottom.next };
  }

  if (name === "sqrt") {
    const arg = argument(src, cursor);
    return { html: `√<span class="root">${convert(arg.body)}</span>`, next: arg.next };
  }

  if (name === "mathbb") {
    const arg = argument(src, cursor);
    const body = arg.body.trim();
    return { html: BLACKBOARD[body] || escapeHtml(body), next: arg.next };
  }

  if (WRAPPERS[name]) {
    const arg = argument(src, cursor);
    return { html: WRAPPERS[name](convert(arg.body)), next: arg.next };
  }

  if (ACCENTS[name]) {
    const arg = argument(src, cursor);
    // The combining mark goes after the character it sits on.
    return { html: convert(arg.body) + ACCENTS[name], next: arg.next };
  }

  // \left( and \right) only say how tall a bracket should be. The bracket
  // itself follows and speaks for itself.
  if (name === "left" || name === "right" || name === "big" || name === "Big") {
    return { html: "", next: cursor };
  }

  if (SYMBOLS[name] !== undefined) {
    // A space after a command name is LaTeX's way of ending it, not a space in
    // the output.
    if (src[cursor] === " ") cursor += 1;
    return { html: escapeHtml(SYMBOLS[name]), next: cursor };
  }

  // Something we do not know. The name itself is nearly always more readable
  // than a backslash and a word, and never less.
  return { html: escapeHtml(name), next: cursor };
}

/** The next thing a `^`, `_` or `\frac` applies to: a group, or one token. */
function argument(src, at) {
  let i = at;
  while (src[i] === " ") i += 1;
  if (src[i] === "{") {
    let depth = 1;
    let j = i + 1;
    while (j < src.length && depth > 0) {
      if (src[j] === "\\") j += 1;
      else if (src[j] === "{") depth += 1;
      else if (src[j] === "}") depth -= 1;
      j += 1;
    }
    return { body: src.slice(i + 1, j - (depth === 0 ? 1 : 0)), next: j };
  }
  if (src[i] === "\\") {
    const name = (/^[A-Za-z]+|^./.exec(src.slice(i + 1)) || [""])[0];
    let next = i + 1 + name.length;
    // A space after a command name ends the name; it is not a space in the
    // output. Without this, "\\theta^\\top x" reads as "θ⊤ x".
    if (/^[A-Za-z]/.test(name) && src[next] === " ") next += 1;
    return { body: src.slice(i, i + 1 + name.length), next };
  }
  return { body: src[i] || "", next: i + (src[i] ? 1 : 0) };
}

function fraction(top, bottom) {
  return `<span class="frac"><span class="num">${top}</span><span class="den">${bottom}</span></span>`;
}

/* ----------------------------------------------------------- markdown ---- */

const MENTION = /@\[([^\]]+)\]\(livepage:([^)]+)\)/g;

/**
 * A message, as HTML.
 *
 * `mention` renders a LivePage mention; without one they show as their label.
 * Everything else is escaped, then a small subset of markdown is applied on
 * top: fenced and inline code, bold, italic, headings, lists, blockquotes, and
 * maths between `\( \)`, `\[ \]`, `$ $` or `$$ $$`.
 */
export function renderMessage(content, { mention } = {}) {
  const stash = [];
  const keep = (html) => {
    stash.push(html);
    return `${MARK}${stash.length - 1}${MARK}`;
  };

  let text = String(content || "").replace(/\r\n?/g, "\n").split(MARK).join("");

  // Order matters. Code first, so a fenced block full of LaTeX or asterisks is
  // shown as written; maths next, so its underscores are never read as
  // emphasis.
  text = text.replace(/```([a-z0-9+#-]*)\n?([\s\S]*?)```/gi, (_m, _lang, body) =>
    keep(`<pre class="code"><code>${escapeHtml(body.replace(/\n$/, ""))}</code></pre>`)
  );
  text = text.replace(/`([^`\n]+)`/g, (_m, body) => keep(`<code>${escapeHtml(body)}</code>`));
  text = text.replace(/\\\[([\s\S]+?)\\\]/g, (_m, body) => keep(mathBlock(body)));
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (_m, body) => keep(mathBlock(body)));
  text = text.replace(/\\\(([\s\S]+?)\\\)/g, (_m, body) => keep(mathInline(body)));
  // Only `$...$` that looks like maths. "$5 and $7" is money, and turning that
  // into an equation is a worse mistake than leaving an equation as text.
  text = text.replace(/\$([^$\n]{1,120})\$/g, (whole, body) =>
    /[\\^_{}]/.test(body) ? keep(mathInline(body)) : whole
  );
  text = text.replace(MENTION, (_m, label, target) =>
    keep(mention ? mention(label, target) : escapeHtml(label))
  );

  const html = blocks(text);
  return html.replace(
    new RegExp(`${MARK}(\\d+)${MARK}`, "g"),
    (_m, index) => stash[Number(index)] ?? ""
  );
}

function mathInline(body) {
  return `<span class="math">${latexToHtml(body.trim())}</span>`;
}

function mathBlock(body) {
  return `<span class="math is-block">${latexToHtml(body.trim())}</span>`;
}

function blocks(text) {
  const out = [];
  const lines = text.split("\n");
  let list = null;
  let paragraph = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    out.push(`<p>${inline(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    out.push(
      `<${list.tag}>${list.items.map((item) => `<li>${inline(item)}</li>`).join("")}</${list.tag}>`
    );
    list = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      // Levels are flattened: a margin card is not a document, and an <h1> in
      // one would shout over the page it sits beside.
      out.push(`<p class="head">${inline(heading[2])}</p>`);
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushParagraph();
      const tag = bullet ? "ul" : "ol";
      if (!list || list.tag !== tag) {
        flushList();
        list = { tag, items: [] };
      }
      list.items.push((bullet || numbered)[1]);
      continue;
    }

    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      flushParagraph();
      flushList();
      out.push(`<blockquote>${inline(quote[1])}</blockquote>`);
      continue;
    }

    // An indented line under a bullet continues it rather than starting a
    // paragraph of its own.
    if (list && /^\s{2,}\S/.test(raw)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`;
      continue;
    }

    flushList();
    paragraph.push(line.trim());
  }
  flushParagraph();
  flushList();
  return out.join("");
}

function inline(text) {
  let html = escapeHtml(text);
  html = html.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  html = html.replace(/__([^_]+)__/g, "<b>$1</b>");
  html = html.replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,;:!?])/g, "$1<i>$2</i>");
  // Underscores only when whitespace-bounded: `some_variable_name` is far more
  // common in this context than emphasis written that way.
  html = html.replace(/(^|\s)_([^_\n]+)_(?=$|[\s.,;:!?])/g, "$1<i>$2</i>");
  return html;
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
