const mathSignals = [
  "\\",
  "=",
  "^",
  "_",
  ">",
  "<",
  "→",
  "←",
  "↔",
  "√",
  "≤",
  "≥",
  "≠",
  "∈",
  "∉",
  "⊂",
  "⊆",
  "∑",
  "∫",
  "∞",
  "±",
  "×",
  "÷",
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

function looksLikeInlineMath(value: string) {
  const content = value.trim();
  if (!looksLikeMath(content)) return false;
  if (/^(npm|pnpm|yarn|git|curl|node|npx|wrangler|docker|SELECT|INSERT|UPDATE|DELETE)\b/i.test(content)) {
    return false;
  }
  if (/\b(const|let|var|function|return|import|export|await|async|class|if|else)\b/.test(content)) {
    return false;
  }
  if (/[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*/.test(content)) return false;
  if (/https?:\/\//i.test(content)) return false;
  return true;
}

function matchingCloseIndex(value: string, openIndex: number): number {
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const open = value[openIndex];
  const close = pairs[open || ""];
  if (!close) return -1;
  let depth = 0;
  for (let index = openIndex; index < value.length; index += 1) {
    const char = value[index];
    if (char === open) depth += 1;
    if (char === close) depth -= 1;
    if (depth === 0) return index;
  }
  return -1;
}

function findTopLevelOperator(value: string, operator: string): number {
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "(" || char === "[" || char === "{") depth += 1;
    if (char === ")" || char === "]" || char === "}") depth = Math.max(0, depth - 1);
    if (char === operator && depth === 0) return index;
  }
  return -1;
}

function stripOuterDelimiters(value: string): string {
  let content = value.trim();
  let changed = true;
  while (changed && content.length > 1) {
    changed = false;
    const first = content[0];
    if ((first === "(" || first === "[" || first === "{") && matchingCloseIndex(content, 0) === content.length - 1) {
      content = content.slice(1, -1).trim();
      changed = true;
    }
  }
  return content;
}

function readRootOperand(value: string, start: number): { operand: string; end: number } | null {
  let index = start;
  while (value[index] === " ") index += 1;
  if (value[index] === "(") {
    const close = matchingCloseIndex(value, index);
    if (close > index) {
      return { operand: value.slice(index + 1, close), end: close + 1 };
    }
  }
  const token = value.slice(index).match(/^[A-Za-z](?:_\{[^{}]+\}|_[A-Za-z0-9]+)?(?:\^\{[^{}]+\}|\^[A-Za-z0-9]+)?/);
  if (!token) return null;
  return { operand: token[0], end: index + token[0].length };
}

function normalizeRoots(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char !== "∛" && char !== "√") {
      result += char;
      continue;
    }
    const operand = readRootOperand(value, index + 1);
    if (!operand) {
      result += char;
      continue;
    }
    const content = normalizeRoots(operand.operand.trim());
    result += char === "∛" ? `\\sqrt[3]{${content}}` : `\\sqrt{${content}}`;
    index = operand.end - 1;
  }
  return result;
}

function normalizeLimit(value: string): string {
  return value.replace(/\blim_\{([^{}]+)\}/g, (_match, content: string) => {
    const normalized = content
      .replace(/→/g, " \\to ")
      .replace(/->/g, " \\to ")
      .replace(/\s+/g, " ")
      .trim();
    return `\\lim_{${normalized}}`;
  });
}

function splitLimitPrefix(value: string): { prefix: string; rest: string } {
  const match = value.trim().match(/^(\\lim_\{[^{}]+\})\s+(.+)$/);
  if (!match) return { prefix: "", rest: value };
  return { prefix: match[1] || "", rest: match[2] || "" };
}

function normalizeFraction(value: string): string {
  const parts: string[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    const nextEquals = findTopLevelOperator(value.slice(cursor), "=");
    if (nextEquals === -1) {
      parts.push(value.slice(cursor));
      break;
    }
    parts.push(value.slice(cursor, cursor + nextEquals));
    cursor += nextEquals + 1;
  }
  if (parts.length > 1) {
    return parts.map((part) => normalizeFraction(part)).join(" = ");
  }

  const { prefix, rest } = splitLimitPrefix(value);
  const target = rest.trim();
  const slash = findTopLevelOperator(target, "/");
  if (slash === -1) return value.trim();
  const numerator = stripOuterDelimiters(target.slice(0, slash));
  const denominator = stripOuterDelimiters(target.slice(slash + 1));
  const fraction = `\\frac{${normalizeFraction(numerator)}}{${normalizeFraction(denominator)}}`;
  return prefix ? `${prefix} ${fraction}` : fraction;
}

function hasTopLevelSlash(value: string): boolean {
  const { rest } = splitLimitPrefix(normalizeLimit(value.trim()));
  return findTopLevelOperator(rest, "/") !== -1;
}

function shouldUseDisplayMath(value: string): boolean {
  const content = value.trim();
  return /\blim_\{/.test(content) || hasTopLevelSlash(content);
}

function normalizeAssistantMath(value: string): string {
  const normalized = normalizeLimit(normalizeRoots(value.trim()))
    .replace(/→/g, " \\to ")
    .replace(/->/g, " \\to ")
    .replace(/\s+/g, " ")
    .trim();
  return normalizeFraction(normalized);
}

function normalizeAssistantInlineMath(value: string): string {
  return normalizeLimit(normalizeRoots(value.trim()))
    .replace(/→/g, " \\to ")
    .replace(/->/g, " \\to ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeInlineMath(value: string) {
  return value.trim().replace(/\$/g, "\\$");
}

function normalizeInlineCodeMathLine(line: string) {
  return line.replace(/`([^`\n]+)`/g, (match, content: string) => {
    if (!looksLikeInlineMath(content)) return match;
    if (shouldUseDisplayMath(content)) {
      return `\n\n$$\n${normalizeAssistantMath(content)}\n$$\n\n`;
    }
    return `$${escapeInlineMath(normalizeAssistantInlineMath(content))}$`;
  });
}

function normalizeInlineCodeMath(markdown: string) {
  let inFence = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      return normalizeInlineCodeMathLine(line);
    })
    .join("\n");
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
  return normalizeBareSquareMath(normalizeInlineCodeMath(markdown))
    .replace(/\\\[((?:.|\n)*?)\\\]/g, (_match, content: string) => `\n\n$$\n${content.trim()}\n$$\n\n`)
    .replace(/\\\(((?:.|\n)*?)\\\)/g, (_match, content: string) => `$${content.trim()}$`);
}
