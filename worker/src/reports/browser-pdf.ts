import puppeteer from "@cloudflare/puppeteer";
import katex from "katex";

import { normalizeMarkdownMath } from "../../../shared/src/markdown";
import type { Env } from "../env";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function markdownToPrintHtml(markdown: string, title: string): string {
  const safeTitle = escapeHtml(title);
  const bodyHtml = markdownToHtml(normalizeMarkdownMath(markdown));
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${safeTitle}</title>
    <style>
      :root { color-scheme: light; }
      html, body { margin: 0; padding: 0; background: #fff; color: #111; }
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif; }
      .page { padding: 18mm 16mm 20mm; }
      .markdown-preview { max-width: none; width: 100%; color: #111; background: #fff; }
      .markdown-preview h1 { margin: 0 0 10mm; font-size: 22pt; line-height: 1.18; }
      .markdown-preview h2 { margin: 7mm 0 3mm; padding-bottom: 2mm; font-size: 13.5pt; break-after: avoid; }
      .markdown-preview h3 { margin: 5mm 0 2mm; font-size: 11.5pt; break-after: avoid; }
      .markdown-preview p, .markdown-preview li { color: #222; font-size: 10.2pt; line-height: 1.48; }
      .markdown-preview ul, .markdown-preview ol { padding-left: 16pt; }
      .markdown-preview h2, .markdown-preview h3, .markdown-preview table, .markdown-preview pre, .markdown-preview blockquote { break-inside: avoid; page-break-inside: avoid; }
      .markdown-preview .markdown-code, .markdown-preview .markdown-inline-code { color: #111; background: #f6f6f6; border-color: #ddd; }
      .markdown-preview .katex { font-size: 1.02em; line-height: 1.35; }
      .markdown-preview .katex-display { max-width: 100%; overflow: visible; white-space: normal; margin: 4px 0; padding: 4px 0; }
      .markdown-preview .katex-display > .katex { display: inline-block; min-width: max-content; }
      .markdown-preview .markdown-math-block { margin: 3mm 0; overflow: visible; }
      .markdown-preview .markdown-math-inline { display: inline; }
    </style>
  </head>
  <body>
    <div class="page">
      <article id="content" class="markdown-preview">
        <h1>${safeTitle}</h1>
        ${bodyHtml}
      </article>
    </div>
  </body>
</html>`;
}

function renderMath(tex: string, displayMode: boolean): string {
  return katex.renderToString(tex.trim(), {
    displayMode,
    output: "htmlAndMathml",
    throwOnError: false,
    strict: "ignore"
  });
}

function replaceInlineMath(text: string): string {
  let result = "";
  let cursor = 0;
  while (cursor < text.length) {
    const open = text.indexOf("$", cursor);
    if (open === -1) {
      result += escapeHtml(text.slice(cursor));
      break;
    }
    if (text[open - 1] === "\\" || text[open + 1] === "$") {
      result += escapeHtml(text.slice(cursor, open + 1));
      cursor = open + 1;
      continue;
    }
    const close = text.indexOf("$", open + 1);
    if (close === -1) {
      result += escapeHtml(text.slice(cursor));
      break;
    }
    result += escapeHtml(text.slice(cursor, open));
    result += `<span class="markdown-math-inline">${renderMath(text.slice(open + 1, close), false)}</span>`;
    cursor = close + 1;
  }
  return result;
}

function inlineMarkdownToHtml(text: string): string {
  return replaceInlineMath(text)
    .replace(/`([^`]+)`/g, "<code class=\"markdown-inline-code\">$1</code>")
    .replace(/\[([^\]]+)]\(([^)]+)\)/g, "<a href=\"$2\" rel=\"noreferrer\">$1</a>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

function markdownToHtml(markdown: string): string {
  const blocks: string[] = [];
  let listItems: string[] = [];
  let paragraph: string[] = [];
  let codeLines: string[] = [];
  let mathLines: string[] = [];
  let inCode = false;
  let inMath = false;
  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push(`<p>${inlineMarkdownToHtml(paragraph.join(" "))}</p>`);
      paragraph = [];
    }
  };
  const flushCode = () => {
    if (codeLines.length) {
      blocks.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
      codeLines = [];
    }
  };
  const flushMath = () => {
    if (mathLines.length) {
      blocks.push(`<div class="markdown-math-block">${renderMath(mathLines.join("\n"), true)}</div>`);
      mathLines = [];
    }
  };
  const flushList = () => {
    if (listItems.length) {
      blocks.push(`<ul>${listItems.map((item) => `<li>${inlineMarkdownToHtml(item)}</li>`).join("")}</ul>`);
      listItems = [];
    }
  };
  for (const rawLine of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const line = rawLine.trim();
    if (line === "$$") {
      if (inMath) {
        flushMath();
      } else {
        flushParagraph();
        flushList();
        flushCode();
      }
      inMath = !inMath;
      continue;
    }
    const singleLineMath = /^\$\$(.+)\$\$$/.exec(line);
    if (singleLineMath && !inCode && !inMath) {
      flushParagraph();
      flushList();
      flushCode();
      blocks.push(`<div class="markdown-math-block">${renderMath(singleLineMath[1] || "", true)}</div>`);
      continue;
    }
    if (/^```/.test(line)) {
      if (inCode) {
        flushCode();
      } else {
        flushParagraph();
        flushList();
        flushMath();
      }
      inCode = !inCode;
      continue;
    }
    if (inMath) {
      mathLines.push(rawLine);
      continue;
    }
    if (inCode) {
      codeLines.push(rawLine);
      continue;
    }
    if (!line) {
      flushParagraph();
      flushList();
      flushCode();
      flushMath();
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1]?.length || 1;
      blocks.push(`<h${level}>${inlineMarkdownToHtml(heading[2] || "")}</h${level}>`);
      continue;
    }
    const listItem = /^[-*]\s+(.+)$/.exec(line);
    if (listItem) {
      flushParagraph();
      listItems.push(listItem[1] || "");
      continue;
    }
    if (/^>\s?/.test(line)) {
      flushParagraph();
      flushList();
      blocks.push(`<blockquote><p>${inlineMarkdownToHtml(line.replace(/^>\s?/, ""))}</p></blockquote>`);
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  flushParagraph();
  flushList();
  flushCode();
  flushMath();
  return blocks.join("\n");
}

export async function renderBrowserPdf(env: Env, markdown: string, title: string): Promise<ArrayBuffer | null> {
  if (!env.BROWSER) return null;
  const browser = await puppeteer.launch(env.BROWSER, { keep_alive: 600000 });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1240, height: 1754, deviceScaleFactor: 1 });
    await page.setContent(markdownToPrintHtml(markdown, title), { waitUntil: "networkidle0" });
    await page.evaluate(() => {
      const pageGlobal = globalThis as typeof globalThis & {
        document?: { fonts?: { ready?: Promise<unknown> } };
      };
      return pageGlobal.document?.fonts?.ready ?? Promise.resolve();
    });
    const pdf = await page.pdf({ format: "A4", printBackground: true });
    const bytes = new Uint8Array(pdf);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  } finally {
    await browser.close();
  }
}
