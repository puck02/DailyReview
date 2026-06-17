type PdfLine = {
  text: string;
  fontSize: number;
  gapBefore: number;
};

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN_X = 48;
const MARGIN_TOP = 54;
const MARGIN_BOTTOM = 56;
const BODY_FONT_SIZE = 10.5;
const LINE_HEIGHT = 16;
const FONT_OBJECT_ID = 4;

function stripInlineMarkdown(text: string): string {
  return text
    .replace(/!\[([^\]]*)]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)]\(([^)]+)\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function plainMarkdownLines(markdown: string): string[] {
  const lines: string[] = [];
  let inFence = false;
  for (const rawLine of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const trimmed = rawLine.trim();
    if (/^```/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (!trimmed) {
      lines.push("");
      continue;
    }
    if (!inFence && /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(trimmed)) {
      continue;
    }

    let line = trimmed;
    line = line.replace(/^#{1,6}\s+/, "");
    line = line.replace(/^>\s?/, "引用：");
    line = line.replace(/^[-*+]\s+/, "• ");
    line = line.replace(/^\d+\.\s+/, (match) => match.trimEnd() + " ");
    if (line.includes("|")) {
      line = line
        .split("|")
        .map((part) => part.trim())
        .filter(Boolean)
        .join("  ");
    }
    lines.push(stripInlineMarkdown(line));
  }
  return lines;
}

function charUnits(char: string): number {
  if (/\s/.test(char)) return 0.35;
  if (/[\u0000-\u007f]/.test(char)) return 0.55;
  if (/[\uff00-\uffef]/.test(char)) return 1;
  if (/[\u4e00-\u9fff]/.test(char)) return 1;
  return 0.9;
}

function wrapText(text: string, maxUnits: number): string[] {
  if (!text) return [""];
  const lines: string[] = [];
  let current = "";
  let currentUnits = 0;
  for (const char of Array.from(text)) {
    const units = charUnits(char);
    if (current && currentUnits + units > maxUnits) {
      lines.push(current.trimEnd());
      current = "";
      currentUnits = 0;
    }
    current += char;
    currentUnits += units;
  }
  if (current.trim()) {
    lines.push(current.trimEnd());
  }
  return lines.length ? lines : [""];
}

function markdownToLayoutLines(markdown: string, title: string): PdfLine[] {
  const result: PdfLine[] = [
    { text: title, fontSize: 16, gapBefore: 0 },
    { text: "", fontSize: BODY_FONT_SIZE, gapBefore: 8 }
  ];
  const maxUnits = Math.floor((PAGE_WIDTH - MARGIN_X * 2) / BODY_FONT_SIZE);
  for (const line of plainMarkdownLines(markdown)) {
    if (!line) {
      result.push({ text: "", fontSize: BODY_FONT_SIZE, gapBefore: 4 });
      continue;
    }
    const isHeading = /^(学习日报|今天最大的收获|今天修正的误解|核心知识|一句话记忆|明日建议|误解|核心结论|易混点|高频考点)/.test(line);
    const fontSize = isHeading ? 13 : BODY_FONT_SIZE;
    const wrapped = wrapText(line, isHeading ? Math.floor(maxUnits * 0.85) : maxUnits);
    wrapped.forEach((wrappedLine, index) => {
      result.push({ text: wrappedLine, fontSize, gapBefore: isHeading && index === 0 ? 9 : 0 });
    });
  }
  return result;
}

function paginate(lines: PdfLine[]): PdfLine[][] {
  const pages: PdfLine[][] = [];
  let page: PdfLine[] = [];
  let y = PAGE_HEIGHT - MARGIN_TOP;
  for (const line of lines) {
    const lineHeight = line.text ? Math.max(LINE_HEIGHT, line.fontSize + 5) : 10;
    const needed = lineHeight + line.gapBefore;
    if (page.length && y - needed < MARGIN_BOTTOM) {
      pages.push(page);
      page = [];
      y = PAGE_HEIGHT - MARGIN_TOP;
    }
    page.push(line);
    y -= needed;
  }
  if (page.length) {
    pages.push(page);
  }
  return pages.length ? pages : [[{ text: "报告内容为空", fontSize: BODY_FONT_SIZE, gapBefore: 0 }]];
}

function utf16BeHex(text: string): string {
  let hex = "";
  for (let index = 0; index < text.length; index += 1) {
    hex += text.charCodeAt(index).toString(16).padStart(4, "0");
  }
  return hex;
}

function pdfString(text: string): string {
  return `<${utf16BeHex(text)}>`;
}

function pageContent(lines: PdfLine[], pageNumber: number, pageCount: number): string {
  const commands: string[] = [];
  let y = PAGE_HEIGHT - MARGIN_TOP;
  for (const line of lines) {
    y -= line.gapBefore;
    if (line.text) {
      commands.push("BT");
      commands.push(`/${"F1"} ${line.fontSize.toFixed(1)} Tf`);
      commands.push(`${MARGIN_X.toFixed(2)} ${y.toFixed(2)} Td`);
      commands.push(`${pdfString(line.text)} Tj`);
      commands.push("ET");
    }
    y -= line.text ? Math.max(LINE_HEIGHT, line.fontSize + 5) : 10;
  }
  commands.push("BT");
  commands.push("/F1 8.5 Tf");
  commands.push(`${(PAGE_WIDTH / 2 - 20).toFixed(2)} 28.00 Td`);
  commands.push(`${pdfString(`${pageNumber} / ${pageCount}`)} Tj`);
  commands.push("ET");
  return `${commands.join("\n")}\n`;
}

function streamObject(content: string): string {
  const length = new TextEncoder().encode(content).length;
  return `<< /Length ${length} >>\nstream\n${content}endstream`;
}

function buildPdf(objects: string[]): ArrayBuffer {
  const encoder = new TextEncoder();
  let pdf = "%PDF-1.7\n%\xE2\xE3\xCF\xD3\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(encoder.encode(pdf).length);
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = encoder.encode(pdf).length;
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (let index = 1; index < offsets.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  const bytes = encoder.encode(pdf);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

export function reportMarkdownToPdfBytes(markdown: string, title: string): ArrayBuffer {
  const pages = paginate(markdownToLayoutLines(markdown, title));
  const pageObjectStart = 7;
  const contentObjectStart = pageObjectStart + pages.length;
  const pageRefs = pages.map((_, index) => `${pageObjectStart + index} 0 R`).join(" ");
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageRefs}] /Count ${pages.length} >>`,
    "<< /Producer (DailyReview Worker PDF) >>",
    "<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [5 0 R] >>",
    "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> /FontDescriptor 6 0 R >>",
    "<< /Type /FontDescriptor /FontName /STSong-Light /Flags 4 /FontBBox [-25 -254 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -254 /CapHeight 880 /StemV 80 >>"
  ];

  pages.forEach((_, index) => {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH.toFixed(2)} ${PAGE_HEIGHT.toFixed(2)}] /Resources << /Font << /F1 ${FONT_OBJECT_ID} 0 R >> >> /Contents ${contentObjectStart + index} 0 R >>`
    );
  });
  pages.forEach((page, index) => {
    objects.push(streamObject(pageContent(page, index + 1, pages.length)));
  });
  return buildPdf(objects);
}
