const mathSignals = [
  "\\",
  "=",
  "^",
  "_",
  "frac",
  "sqrt",
  "sum",
  "int",
  "lim",
  "sin",
  "cos",
  "tan",
  "ln",
  "log",
  "alpha",
  "beta",
  "gamma",
  "theta",
  "pi",
  "infty",
  "o("
];

function looksLikeMath(value: string) {
  const content = value.trim();
  if (content.length < 3) return false;
  return mathSignals.some((signal) => content.includes(signal));
}

function normalizeBareSquareMath(markdown: string) {
  let result = "";
  let index = 0;

  while (index < markdown.length) {
    const open = markdown.indexOf("[", index);
    if (open === -1) {
      result += markdown.slice(index);
      break;
    }

    result += markdown.slice(index, open);
    const previous = open > 0 ? markdown[open - 1] : "";
    const close = markdown.indexOf("]", open + 1);
    if (close === -1 || previous === "!" || previous === "\\") {
      result += markdown.slice(open, close === -1 ? undefined : close + 1);
      index = close === -1 ? markdown.length : close + 1;
      continue;
    }

    const next = close + 1 < markdown.length ? markdown[close + 1] : "";
    const content = markdown.slice(open + 1, close).trim();
    if (next === "(" || content.includes("[") || content.includes("]") || !looksLikeMath(content)) {
      result += markdown.slice(open, close + 1);
    } else {
      result += `\n\n$$\n${content}\n$$\n\n`;
    }
    index = close + 1;
  }

  return result;
}

export function normalizeMarkdownMath(markdown: string) {
  return normalizeBareSquareMath(markdown)
    .replace(/\\\[((?:.|\n)*?)\\\]/g, (_match, content: string) => `\n\n$$\n${content.trim()}\n$$\n\n`)
    .replace(/\\\(((?:.|\n)*?)\\\)/g, (_match, content: string) => `$${content.trim()}$`);
}
