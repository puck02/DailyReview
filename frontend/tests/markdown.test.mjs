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
  assert.ok(normalized.includes("$x = ln((y + \\sqrt{y^2 + 4}) / 2)$"));
  assert.ok(normalized.includes("`npm run build`"));
});

test("normalizes assistant-style roots in inline code math", () => {
  const markdown = [
    "`u = ∛x`",
    "`∛(x^2) = ∛((u^3)^2) = ∛(u^6) = u^2`",
    "`x = ln((y + √(y^2 + 4)) / 2)`"
  ].join("\n");

  const normalized = normalizeMarkdownMath(markdown);

  assert.ok(normalized.includes("$u = \\sqrt[3]{x}$"));
  assert.ok(
    normalized.includes(
      "$\\sqrt[3]{x^2} = \\sqrt[3]{(u^3)^2} = \\sqrt[3]{u^6} = u^2$"
    )
  );
  assert.ok(normalized.includes("$x = ln((y + \\sqrt{y^2 + 4}) / 2)$"));
});

test("normalizes assistant-style limit fractions and roots in code math", () => {
  const markdown = [
    "`lim_{x→1} (∛(x^2) - 2∛x + 1) / (x-1)^2`",
    "`lim_{u→1} (u-1)^2 / [(u-1)^2(u^2+u+1)^2]`",
    "`1 / (1+1+1)^2 = 1/9`"
  ].join("\n");

  const normalized = normalizeMarkdownMath(markdown);

  assert.ok(
    normalized.includes("$$\n\\lim_{x \\to 1} \\frac{\\sqrt[3]{x^2} - 2\\sqrt[3]{x} + 1}{(x-1)^2}\n$$")
  );
  assert.ok(
    normalized.includes("$$\n\\lim_{u \\to 1} \\frac{(u-1)^2}{(u-1)^2(u^2+u+1)^2}\n$$")
  );
  assert.ok(normalized.includes("$$\n\\frac{1}{(1+1+1)^2} = \\frac{1}{9}\n$$"));
});
