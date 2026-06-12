import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeMarkdownMath } from "/tmp/dailyreview-frontend-tests/markdown.js";

test("normalizes bare square bracket formulas into display math", () => {
  const markdown = [
    "[ e^x = 1+x+\\frac{x^2}{2}+o(x^2) ]",
    "[ \\ln(1+x)=x-\\frac{x^2}{2}+o(x^2) ]"
  ].join(" ");

  const normalized = normalizeMarkdownMath(markdown);

  assert.ok(normalized.includes("$$\ne^x = 1+x+\\frac{x^2}{2}+o(x^2)\n$$"));
  assert.ok(normalized.includes("$$\n\\ln(1+x)=x-\\frac{x^2}{2}+o(x^2)\n$$"));
});

test("keeps normal markdown links and image labels unchanged", () => {
  const markdown = "参考 [资料](https://example.com)，以及 ![图像](image.png)。";

  assert.equal(normalizeMarkdownMath(markdown), markdown);
});

test("normalizes TeX slash delimiters", () => {
  const markdown = "\\[ \\cos x=1-\\frac{x^2}{2}+o(x^2) \\] 和 \\( E=mc^2 \\)";

  const normalized = normalizeMarkdownMath(markdown);

  assert.ok(normalized.includes("$$\n\\cos x=1-\\frac{x^2}{2}+o(x^2)\n$$"));
  assert.ok(normalized.includes("$E=mc^2$"));
});

test("normalizes inline code that is actually math", () => {
  const markdown = [
    "`y_n = e^{x_n} - e^{-x_n}`",
    "`x = ln((y + √(y^2 + 4)) / 2)`",
    "`npm run build`"
  ].join("\n");

  const normalized = normalizeMarkdownMath(markdown);

  assert.ok(normalized.includes("$y_n = e^{x_n} - e^{-x_n}$"));
  assert.ok(normalized.includes("$x = ln((y + √(y^2 + 4)) / 2)$"));
  assert.ok(normalized.includes("`npm run build`"));
});
