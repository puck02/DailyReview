import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeMarkdownMath } from "/tmp/dailyreview-frontend-tests/frontend/src/markdown.js";

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

test("keeps slash separators in prose unchanged", () => {
  const markdown = [
    "登录/注册入口都在右上角。",
    "输入可以是中文 / English。",
    "这个开关表示开启/关闭。",
    "可选阅读/写作/翻译三类任务。",
    "这个实验不是 A/B 测试。",
    "`中文 / English`",
    "`登录/注册`",
    "`登录/注册 = 二选一`",
    "`中文 / English = 输入语言`",
    "`阅读/写作/翻译 = 任务类型`",
    "`A/B = 两种方案`"
  ].join("\n");

  const normalized = normalizeMarkdownMath(markdown);

  assert.equal(normalized, markdown);
  assert.doesNotMatch(normalized, /\\frac/);
  assert.doesNotMatch(normalized, /\$/);
});

test("normalizes TeX slash delimiters", () => {
  const markdown = "\\[ \\cos x=1-\\frac{x^2}{2}+o(x^2) \\] 和 \\( E=mc^2 \\)";

  const normalized = normalizeMarkdownMath(markdown);

  assert.ok(normalized.includes("$$\n\\cos x=1-\\frac{x^2}{2}+o(x^2)\n$$"));
  assert.ok(normalized.includes("$E=mc^2$"));
});

test("repairs escaped and mixed markdown math delimiters from model output", () => {
  const markdown = String.raw`f'(1) = \$\lim_{h \to 0}$ \frac{2f(h) - f(1)}{h}，且原式为 \( f(1+x) = 2f(x) \)。`;

  const normalized = normalizeMarkdownMath(markdown);

  assert.ok(normalized.includes("$f'(1) = \\lim_{h \\to 0} \\frac{2f(h) - f(1)}{h}$，"));
  assert.ok(normalized.includes("$f(1+x) = 2f(x)$"));
  assert.doesNotMatch(normalized, /\\\$/);
  assert.doesNotMatch(normalized, /\\\(/);
});

test("keeps later display formulas stable after an orphan display close", () => {
  const markdown = String.raw`x^2 \sin(1/x) & \text{当 } x \neq 0 \\ 0 & \text{当 } x = 0 \end{cases}$$ **可导性验证：** $$f'(0) = \lim_{h \to 0} \frac{h^2 \sin(1/h)}{h} = 0$$ 考虑极限： $$\lim_{x \to 0} f'(x) = \lim_{x \to 0} [2x \sin(1/x) - \cos(1/x)]$$`;

  const normalized = normalizeMarkdownMath(markdown);

  assert.ok(
    normalized.includes(
      String.raw`$$
\lim_{x \to 0} f'(x) = \lim_{x \to 0} [2x \sin(1/x) - \cos(1/x)]
$$`
    )
  );
  assert.doesNotMatch(normalized, /\$\$\n2x \\sin\(1\/x\) - \\cos\(1\/x\)\n\$\$/);
});

test("moves multiline display math content off the dollar fence lines", () => {
  const markdown = String.raw`考虑函数：
$$f(x) = \begin{cases}
x^2 \sin(1/x) & \text{当 } x \neq 0 \\
0 & \text{当 } x = 0
\end{cases}$$`;

  const normalized = normalizeMarkdownMath(markdown);

  assert.ok(normalized.includes(String.raw`$$
f(x) = \begin{cases}`));
  assert.ok(normalized.includes(String.raw`\end{cases}
$$`));
  assert.doesNotMatch(normalized, /\$\$f\(x\)/);
  assert.doesNotMatch(normalized, /\\end\{cases\}\$\$/);
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

test("normalizes bare differential and limit formulas in prose", () => {
  const markdown = [
    "不能把 ",
    "Δy/Δx 直接等同于 ",
    "dy/dx；更准确地说，",
    "dy/dx = lim_{Δx→0} Δy/Δx。"
  ].join("\n");

  const normalized = normalizeMarkdownMath(markdown);

  assert.ok(normalized.includes("$\\frac{\\Delta y}{\\Delta x}$ 直接等同于"));
  assert.ok(normalized.includes("$\\frac{dy}{dx}$；更准确地说，"));
  assert.ok(normalized.includes("$\\frac{dy}{dx}$ = $\\lim_{\\Delta x \\to 0}$ $\\frac{\\Delta y}{\\Delta x}$。"));
});

test("keeps brackets inside existing display math blocks stable", () => {
  const markdown = [
    "4. **应用洛必达法则**：",
    "   对分子分母分别求导：",
    "   $$",
    "   \\ln L = \\lim_{x \\to 0} \\frac{\\frac{d}{dx} \\left[ \\ln \\left( \\frac{e^x + e^{2x} + \\cdots + e^{nx}}{n} \\right) \\right]}{\\frac{d}{dx}(x)}",
    "   $$",
    "",
    "5. **计算导数**：",
    "   $$",
    "   \\frac{d}{dx} \\left[ \\ln(S(x)) \\right] = \\frac{1}{S(x)} \\cdot S'(x)",
    "   $$"
  ].join("\n");

  const normalized = normalizeMarkdownMath(markdown);

  assert.equal((normalized.match(/\$\$/g) || []).length, 4);
  assert.ok(normalized.includes("\\left[ \\ln \\left"));
  assert.ok(normalized.includes("\\left[ \\ln(S(x)) \\right]"));
});
