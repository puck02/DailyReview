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
  if (hasTextualSlashSeparator(content)) return false;
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
  return value.replace(/(^|[^A-Za-z\\])\\?lim_\{([^{}]+)\}/g, (_match, prefix: string, content: string) => {
    const normalized = content
      .replace(/→/g, " \\to ")
      .replace(/->/g, " \\to ")
      .replace(/\s+/g, " ")
      .trim();
    return `${prefix}\\lim_{${normalized}}`;
  });
}

function normalizePlainMathTokens(value: string): string {
  return value.replace(/Δ/g, "\\Delta ");
}

function stripMathPunctuation(value: string): { content: string; suffix: string } {
  const match = value.match(/^(.+?)([.,;:，。；：、]+)?$/);
  return {
    content: (match?.[1] || value).trim(),
    suffix: match?.[2] || ""
  };
}

function splitLimitPrefix(value: string): { prefix: string; rest: string } {
  const match = value.trim().match(/^(\\lim_\{[^{}]+\})\s+(.+)$/);
  if (!match) return { prefix: "", rest: value };
  return { prefix: match[1] || "", rest: match[2] || "" };
}

function hasCjkText(value: string): boolean {
  return /[\u3400-\u9fff]/.test(value);
}

function hasMathSyntax(value: string): boolean {
  return /[\\^_=<>→←↔√≤≥≠∈∉⊂⊆∑∫∞±×÷Δ]/.test(value) || /\b(lim|sin|cos|tan|ln|log|sqrt|frac|sum|int|alpha|beta|gamma|theta|pi|infty|o\()\b/.test(value);
}

function hasFormulaSyntax(value: string): boolean {
  return /[\\^_<>→←↔√≤≥≠∈∉⊂⊆∑∫∞±×÷Δ]/.test(value) || /\b(lim|sqrt|frac|sum|int|ln|log|alpha|beta|gamma|theta|pi|infty|o\()\b/.test(value);
}

function hasTextualSlashSeparator(value: string): boolean {
  const content = stripMathPunctuation(value.trim()).content;
  if (!content.includes("/")) return false;
  if (hasCjkText(content)) return true;
  if (hasFormulaSyntax(content)) return false;
  return /\b[A-Za-z]{1,4}\s*\/\s*[A-Za-z]{1,8}\b/.test(content);
}

function isPlainSingleLetter(value: string): boolean {
  return /^[A-Za-z]$/.test(stripMathPunctuation(value.trim()).content);
}

function isNumericExpression(value: string): boolean {
  return /^[0-9][0-9\s+\-*/().\[\]{}^]*$/.test(value.trim());
}

function isFractionOperand(value: string): boolean {
  const content = stripOuterDelimiters(stripMathPunctuation(value.trim()).content);
  if (!content || hasCjkText(content)) return false;
  if (isNumericExpression(content)) return true;
  if (/^d[A-Za-z]$/.test(content)) return true;
  if (/^\\?Delta\s*[A-Za-z]+$/.test(content) || /^Δ[A-Za-z]+$/.test(content)) return true;
  if (/^[A-Za-z](?:_\{[^{}]+\}|_[A-Za-z0-9]+)?(?:\^\{[^{}]+\}|\^[A-Za-z0-9]+)?$/.test(content)) return true;
  return hasMathSyntax(content) && !/^[A-Za-z]{2,}$/.test(content);
}

function isFractionExpression(value: string): boolean {
  const { rest } = splitLimitPrefix(normalizeLimit(value.trim()));
  const target = rest.trim();
  const slash = findTopLevelOperator(target, "/");
  if (slash === -1) return false;
  const numerator = target.slice(0, slash);
  const denominator = stripMathPunctuation(target.slice(slash + 1).trim()).content;
  if (isPlainSingleLetter(numerator) && isPlainSingleLetter(denominator) && !hasMathSyntax(target)) return false;
  return isFractionOperand(numerator) && isFractionOperand(denominator);
}

function normalizeFraction(value: string): string {
  const { content, suffix } = stripMathPunctuation(value.trim());
  const parts: string[] = [];
  let cursor = 0;
  while (cursor < content.length) {
    const nextEquals = findTopLevelOperator(content.slice(cursor), "=");
    if (nextEquals === -1) {
      parts.push(content.slice(cursor));
      break;
    }
    parts.push(content.slice(cursor, cursor + nextEquals));
    cursor += nextEquals + 1;
  }
  if (parts.length > 1) {
    return `${parts.map((part) => normalizeFraction(part)).join(" = ")}${suffix}`;
  }

  const { prefix, rest } = splitLimitPrefix(content);
  const target = rest.trim();
  const slash = findTopLevelOperator(target, "/");
  if (slash === -1 || !isFractionExpression(target)) return `${content}${suffix}`;
  const numerator = stripOuterDelimiters(target.slice(0, slash));
  const denominator = stripOuterDelimiters(stripMathPunctuation(target.slice(slash + 1).trim()).content);
  const fraction = `\\frac{${normalizeFraction(numerator)}}{${normalizeFraction(denominator)}}`;
  return `${prefix ? `${prefix} ${fraction}` : fraction}${suffix}`;
}

function shouldUseDisplayMath(value: string): boolean {
  const content = value.trim();
  return /\blim_\{/.test(content) || isFractionExpression(content);
}

function normalizeAssistantMath(value: string): string {
  const normalized = normalizePlainMathTokens(normalizeLimit(normalizeRoots(value.trim())))
    .replace(/→/g, " \\to ")
    .replace(/->/g, " \\to ")
    .replace(/\s+/g, " ")
    .trim();
  return normalizeFraction(normalized);
}

function normalizeAssistantInlineMath(value: string): string {
  return normalizePlainMathTokens(normalizeLimit(normalizeRoots(value.trim())))
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

function normalizeBareSquareMathSegment(markdown: string) {
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

function fencedCodeEnd(markdown: string, start: number): number {
  const lineEnd = markdown.indexOf("\n", start);
  const marker = markdown.slice(start, lineEnd === -1 ? undefined : lineEnd).trimStart().startsWith("~~~") ? "~~~" : "```";
  let cursor = lineEnd === -1 ? markdown.length : lineEnd + 1;
  while (cursor < markdown.length) {
    const nextLineEnd = markdown.indexOf("\n", cursor);
    const line = markdown.slice(cursor, nextLineEnd === -1 ? undefined : nextLineEnd);
    if (line.trimStart().startsWith(marker)) {
      return nextLineEnd === -1 ? markdown.length : nextLineEnd + 1;
    }
    cursor = nextLineEnd === -1 ? markdown.length : nextLineEnd + 1;
  }
  return markdown.length;
}

function mathEnd(markdown: string, start: number, delimiter: "$" | "$$"): number {
  const close = markdown.indexOf(delimiter, start + delimiter.length);
  return close === -1 ? markdown.length : close + delimiter.length;
}

function inlineCodeEnd(markdown: string, start: number): number {
  const close = markdown.indexOf("`", start + 1);
  return close === -1 ? markdown.length : close + 1;
}

function transformOutsideInlineCode(line: string, transform: (segment: string) => string): string {
  let result = "";
  let cursor = 0;
  while (cursor < line.length) {
    const open = line.indexOf("`", cursor);
    if (open === -1) {
      result += transform(line.slice(cursor));
      break;
    }
    result += transform(line.slice(cursor, open));
    const close = line.indexOf("`", open + 1);
    if (close === -1) {
      result += line.slice(open);
      break;
    }
    result += line.slice(open, close + 1);
    cursor = close + 1;
  }
  return result;
}

function findSingleDollar(value: string, start: number): number {
  for (let index = start; index < value.length; index += 1) {
    if (value[index] !== "$") continue;
    if (value[index + 1] === "$" || value[index - 1] === "$" || value[index - 1] === "\\") continue;
    return index;
  }
  return -1;
}

function normalizeEscapedMarkdownMathLine(line: string): string {
  return transformOutsideInlineCode(line, (segment) => {
    let result = "";
    let cursor = 0;
    while (cursor < segment.length) {
      const open = segment.indexOf("\\$", cursor);
      if (open === -1) {
        result += segment.slice(cursor);
        break;
      }
      const close = findSingleDollar(segment, open + 2);
      if (close === -1) {
        result += segment.slice(cursor);
        break;
      }
      const content = segment.slice(open + 2, close);
      if (!looksLikeMath(content)) {
        result += segment.slice(cursor, open + 2);
        cursor = open + 2;
        continue;
      }
      result += `${segment.slice(cursor, open)}$${content.trim()}$`;
      cursor = close + 1;
    }
    return result;
  });
}

function normalizeEscapedMarkdownMath(markdown: string): string {
  let inFence = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      return normalizeEscapedMarkdownMathLine(line);
    })
    .join("\n");
}

function normalizeTexMathDelimiters(markdown: string): string {
  let result = "";
  let index = 0;
  while (index < markdown.length) {
    const lineStart = index === 0 || markdown[index - 1] === "\n";
    const rest = markdown.slice(index);
    if (lineStart && /^\s*(```|~~~)/.test(rest)) {
      const end = fencedCodeEnd(markdown, index);
      result += markdown.slice(index, end);
      index = end;
      continue;
    }
    if (markdown.startsWith("$$", index)) {
      const end = mathEnd(markdown, index, "$$");
      result += markdown.slice(index, end);
      index = end;
      continue;
    }
    if (markdown[index] === "$") {
      const end = mathEnd(markdown, index, "$");
      result += markdown.slice(index, end);
      index = end;
      continue;
    }
    if (markdown[index] === "`") {
      const end = inlineCodeEnd(markdown, index);
      result += markdown.slice(index, end);
      index = end;
      continue;
    }
    if (markdown.startsWith("\\[", index)) {
      const close = markdown.indexOf("\\]", index + 2);
      if (close !== -1) {
        result += `\n\n$$\n${markdown.slice(index + 2, close).trim()}\n$$\n\n`;
        index = close + 2;
        continue;
      }
    }
    if (markdown.startsWith("\\(", index)) {
      const close = markdown.indexOf("\\)", index + 2);
      if (close !== -1) {
        result += `$${markdown.slice(index + 2, close).trim()}$`;
        index = close + 2;
        continue;
      }
    }
    result += markdown[index];
    index += 1;
  }
  return result;
}

function mathPrefixStart(value: string, open: number): number {
  let start = open;
  while (start > 0 && /[A-Za-z0-9\s\\()[\]{}_^+\-*/'=.]/.test(value[start - 1] || "")) {
    start -= 1;
  }
  let prefix = value.slice(start, open);
  const marker = prefix.match(/^(\s*(?:[-*+]\s+|\d+[.)]\s+))(.+)$/);
  if (marker && looksLikeInlineMath(marker[2] || "")) {
    start += (marker[1] || "").length;
    prefix = marker[2] || "";
  }
  if (!prefix.trim() || !looksLikeInlineMath(prefix)) return open;
  return start;
}

function readNakedLatexContinuation(value: string, start: number): { content: string; end: number } | null {
  let index = start;
  while (value[index] === " ") index += 1;
  if (!/^\\(?:frac|lim|sqrt|sum|int|sin|cos|tan|ln|log)\b/.test(value.slice(index))) {
    return null;
  }
  let end = index;
  let depth = 0;
  while (end < value.length) {
    const char = value[end] || "";
    if (char === "{" || char === "[" || char === "(") depth += 1;
    if (char === "}" || char === "]" || char === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && /[\n，。；：、]/.test(char)) break;
    if (depth === 0 && end > index && hasCjkText(char)) break;
    end += 1;
  }
  const content = value.slice(index, end).trim();
  return content && hasFormulaSyntax(content) ? { content, end } : null;
}

function repairMixedMarkdownMathLine(line: string): string {
  return transformOutsideInlineCode(line, (segment) => {
    let result = "";
    let cursor = 0;
    while (cursor < segment.length) {
      const open = findSingleDollar(segment, cursor);
      if (open === -1) {
        result += segment.slice(cursor);
        break;
      }
      const close = findSingleDollar(segment, open + 1);
      if (close === -1) {
        result += segment.slice(cursor);
        break;
      }
      const content = segment.slice(open + 1, close).trim();
      const continuation = readNakedLatexContinuation(segment, close + 1);
      if (!continuation || !hasFormulaSyntax(content)) {
        result += segment.slice(cursor, close + 1);
        cursor = close + 1;
        continue;
      }
      const prefixStart = mathPrefixStart(segment, open);
      const prefix = segment.slice(prefixStart, open);
      const leading = prefix.match(/^\s*/)?.[0] || "";
      const formulaPrefix = prefix.trim();
      const formula = [formulaPrefix, content, continuation.content].filter(Boolean).join(" ");
      result += `${segment.slice(cursor, prefixStart)}${leading}$${normalizeAssistantInlineMath(formula)}$`;
      cursor = continuation.end;
    }
    return result;
  });
}

function repairMixedMarkdownMath(markdown: string): string {
  let inFence = false;
  let inDisplayMath = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (line.trim() === "$$") {
        inDisplayMath = !inDisplayMath;
        return line;
      }
      if (inFence || inDisplayMath) return line;
      return repairMixedMarkdownMathLine(line);
    })
    .join("\n");
}

function normalizeBareSquareMath(markdown: string) {
  let result = "";
  let buffer = "";
  let index = 0;

  function flushBuffer() {
    if (!buffer) return;
    result += normalizeBareSquareMathSegment(buffer);
    buffer = "";
  }

  while (index < markdown.length) {
    const lineStart = index === 0 || markdown[index - 1] === "\n";
    const rest = markdown.slice(index);
    if (lineStart && /^\s*(```|~~~)/.test(rest)) {
      flushBuffer();
      const end = fencedCodeEnd(markdown, index);
      result += markdown.slice(index, end);
      index = end;
      continue;
    }
    if (markdown.startsWith("$$", index)) {
      flushBuffer();
      const end = mathEnd(markdown, index, "$$");
      result += markdown.slice(index, end);
      index = end;
      continue;
    }
    if (markdown[index] === "$") {
      flushBuffer();
      const end = mathEnd(markdown, index, "$");
      result += markdown.slice(index, end);
      index = end;
      continue;
    }
    if (markdown[index] === "`") {
      flushBuffer();
      const end = inlineCodeEnd(markdown, index);
      result += markdown.slice(index, end);
      index = end;
      continue;
    }
    buffer += markdown[index];
    index += 1;
  }

  flushBuffer();
  return result;
}

function normalizeBareMathLine(line: string): string {
  if (line.includes("$")) return line;
  const variableOperand = String.raw`[A-Za-z](?:(?:_\{[^{}]+\}|_[A-Za-z0-9]+)(?:\^\{[^{}]+\}|\^[A-Za-z0-9]+)?|(?:\^\{[^{}]+\}|\^[A-Za-z0-9]+))`;
  const fractionOperand = String.raw`(?:d[A-Za-z]|Δ[A-Za-z]+|${variableOperand})`;
  return line.replace(
    new RegExp(`(lim_\\{[^{}]+\\}|(?:${fractionOperand}\\s*\\/\\s*${fractionOperand}))([.,;:，。；：、]?)`, "g"),
    (match, formula: string, suffix: string) => {
      const normalized = escapeInlineMath(normalizeAssistantMath(formula));
      return `$${normalized}$${suffix || ""}`;
    }
  );
}

function normalizeBareMath(markdown: string) {
  let inFence = false;
  let inDisplayMath = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (line.trim() === "$$") {
        inDisplayMath = !inDisplayMath;
        return line;
      }
      if (inFence || inDisplayMath) return line;
      if (line.includes("`") || line.includes("$")) return line;
      return normalizeBareMathLine(line);
    })
    .join("\n");
}

export function normalizeMarkdownMath(markdown: string) {
  const prepared = repairMixedMarkdownMath(normalizeTexMathDelimiters(normalizeEscapedMarkdownMath(markdown)));
  return normalizeBareMath(normalizeBareSquareMath(normalizeInlineCodeMath(prepared)));
}
