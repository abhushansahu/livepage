import assert from "node:assert/strict";
import test from "node:test";
import { latexToHtml, renderMessage } from "../extension/shared/markdown.js";

test("greek, superscripts and subscripts become readable", () => {
  assert.equal(latexToHtml("h_\\theta(x) = \\theta^\\top x"), "h<sub>θ</sub>(x) = θ<sup>⊤</sup>x");
  assert.equal(latexToHtml("\\phi(x)"), "ϕ(x)");
  assert.equal(latexToHtml("x^2 + y^2"), "x<sup>2</sup> + y<sup>2</sup>");
});

test("a braced group is one super- or subscript, not just its first character", () => {
  assert.equal(latexToHtml("x^{(i)}"), "x<sup>(i)</sup>");
  assert.equal(latexToHtml("\\sum_{i=1}^{n}"), "∑<sub>i=1</sub><sup>n</sup>");
});

test("nested structure is converted all the way down", () => {
  assert.equal(latexToHtml("x^{\\theta_1}"), "x<sup>θ<sub>1</sub></sup>");
});

test("escaped braces are literal braces", () => {
  assert.equal(latexToHtml("\\{(x^{(i)}, y^{(i)})\\}"), "{(x<sup>(i)</sup>, y<sup>(i)</sup>)}");
});

test("fractions and roots keep their two halves apart", () => {
  assert.equal(
    latexToHtml("\\frac{1}{2}"),
    '<span class="frac"><span class="num">1</span><span class="den">2</span></span>'
  );
  assert.match(latexToHtml("\\sqrt{n}"), /^√<span class="root">n<\/span>$/);
});

test("blackboard letters and accents", () => {
  assert.equal(latexToHtml("\\mathbb{R}^d"), "ℝ<sup>d</sup>");
  assert.equal(latexToHtml("\\hat{y}"), "ŷ");
});

test("\\left and \\right leave the bracket they were sizing", () => {
  assert.equal(latexToHtml("\\left( x \\right)"), "( x )");
});

test("an unknown command degrades to its own name, never to a backslash", () => {
  assert.equal(latexToHtml("\\wibble x"), "wibble x");
});

test("nothing the model wrote can reach the DOM as a tag", () => {
  assert.equal(latexToHtml("<script>alert(1)</script>"), "&lt;script&gt;alert(1)&lt;/script&gt;");
  assert.match(renderMessage("<img src=x onerror=alert(1)>"), /&lt;img/);
  assert.equal(/<img/.test(renderMessage("<img src=x>")), false);
});

test("bold, italic and inline code survive; the markers do not", () => {
  assert.equal(renderMessage("a **bold** word"), "<p>a <b>bold</b> word</p>");
  assert.equal(renderMessage("a *slanted* word"), "<p>a <i>slanted</i> word</p>");
  assert.equal(renderMessage("call `fn(x)` here"), "<p>call <code>fn(x)</code> here</p>");
});

test("an underscore inside an identifier is not emphasis", () => {
  // `some_variable_name` is far more common in this context than emphasis
  // written with underscores, and mangling it loses the name.
  assert.equal(renderMessage("use some_variable_name here"), "<p>use some_variable_name here</p>");
});

test("code fences are shown as written, markup and all", () => {
  const html = renderMessage("```py\nx = a**b\n```");
  assert.match(html, /<pre class="code"><code>x = a\*\*b<\/code><\/pre>/);
});

test("maths inside code is left alone", () => {
  assert.match(renderMessage("`\\theta^\\top`"), /<code>\\theta\^\\top<\/code>/);
});

test("bullets become a list, and a blank line ends it", () => {
  const html = renderMessage("- one\n- two\n\nafter");
  assert.equal(html, "<ul><li>one</li><li>two</li></ul><p>after</p>");
});

test("numbered items become an ordered list", () => {
  assert.equal(renderMessage("1. first\n2. second"), "<ol><li>first</li><li>second</li></ol>");
});

test("a heading is flattened rather than shouting over the page", () => {
  assert.equal(renderMessage("## Why this matters"), '<p class="head">Why this matters</p>');
});

test("money is not mistaken for maths", () => {
  assert.equal(renderMessage("it cost $5 and then $7"), "<p>it cost $5 and then $7</p>");
});

test("dollar maths with real notation is still rendered", () => {
  assert.match(renderMessage("where $x^2$ grows"), /<span class="math">x<sup>2<\/sup><\/span>/);
});

test("display maths gets its own block", () => {
  assert.match(renderMessage("so:\n\n\\[ \\theta^\\top x \\]"), /class="math is-block"/);
});

test("a mention renders through the caller, or as its label", () => {
  assert.equal(renderMessage("see @[that thread](livepage:p1/t1)"), "<p>see that thread</p>");
  assert.equal(
    renderMessage("see @[that thread](livepage:p1/t1)", {
      mention: (label, target) => `<button data-mention="${target}">${label}</button>`
    }),
    '<p>see <button data-mention="p1/t1">that thread</button></p>'
  );
});

test("the reply that started this renders end to end", () => {
  const reply = [
    "This passage is setting up the shift from **linear** models to **non-linear** ones.",
    "",
    "- **Linear regression:** \\(h_\\theta(x) = \\theta^\\top x\\)",
    "- **With a feature map:** \\(h_\\theta(x) = \\theta^\\top \\phi(x)\\)",
    "",
    "Choose \\(\\theta\\) using training examples \\(\\{(x^{(i)}, y^{(i)})\\}\\)."
  ].join("\n");
  const html = renderMessage(reply);

  assert.match(html, /<b>linear<\/b>/);
  assert.match(html, /<ul><li>/);
  assert.match(html, /h<sub>θ<\/sub>\(x\) = θ<sup>⊤<\/sup>x/);
  assert.match(html, /θ<sup>⊤<\/sup>ϕ\(x\)/);
  assert.match(html, /\{\(x<sup>\(i\)<\/sup>, y<sup>\(i\)<\/sup>\)\}/);
  // Nothing raw left over.
  assert.equal(/\\theta|\\phi|\\top|\\\(|\\\[/.test(html), false);
});

test("plain prose comes through untouched", () => {
  assert.equal(renderMessage("Just a sentence."), "<p>Just a sentence.</p>");
  assert.equal(renderMessage(""), "");
});
