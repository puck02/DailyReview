import html
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path


math_signals = [
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
    "o(",
]


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def _katex_dist_dir() -> Path:
    return _repo_root() / "frontend" / "node_modules" / "katex" / "dist"


def _chrome_binary() -> str:
    candidates = [
        os.getenv("CHROME_BIN", ""),
        "google-chrome",
        "chromium",
        "chromium-browser",
    ]
    for candidate in candidates:
        if not candidate:
            continue
        resolved = shutil.which(candidate)
        if resolved:
            return resolved
    raise RuntimeError("未找到 Chrome，无法导出带公式排版的 PDF")


def _read_katex_asset(name: str) -> str:
    path = _katex_dist_dir() / name
    if not path.exists():
        raise RuntimeError(f"缺少 KaTeX 资源：{path}")
    return path.read_text(encoding="utf-8")


def _katex_css() -> str:
    css = _read_katex_asset("katex.min.css")
    fonts_dir = (_katex_dist_dir() / "fonts").resolve()

    def replace_font_url(match: re.Match[str]) -> str:
        font_path = fonts_dir / match.group(2)
        return f"url('{font_path.as_uri()}')"

    return re.sub(r"url\((['\"]?)fonts/([^)'\"\s]+)\1\)", replace_font_url, css)


def _looks_like_math(value: str) -> bool:
    content = value.strip()
    return len(content) >= 3 and any(signal in content for signal in math_signals)


def _normalize_bare_square_math(markdown: str) -> str:
    result = []
    index = 0
    while index < len(markdown):
        open_index = markdown.find("[", index)
        if open_index == -1:
            result.append(markdown[index:])
            break

        result.append(markdown[index:open_index])
        previous = markdown[open_index - 1] if open_index > 0 else ""
        close_index = markdown.find("]", open_index + 1)
        if close_index == -1 or previous in {"!", "\\"}:
            result.append(markdown[open_index:] if close_index == -1 else markdown[open_index : close_index + 1])
            index = len(markdown) if close_index == -1 else close_index + 1
            continue

        next_char = markdown[close_index + 1] if close_index + 1 < len(markdown) else ""
        content = markdown[open_index + 1 : close_index].strip()
        if next_char == "(" or "[" in content or "]" in content or not _looks_like_math(content):
            result.append(markdown[open_index : close_index + 1])
        else:
            result.append(f"\n\n$$\n{content}\n$$\n\n")
        index = close_index + 1

    return "".join(result)


def _normalize_latex_display_math(markdown: str) -> str:
    result = []
    index = 0
    while index < len(markdown):
        open_index = markdown.find(r"\[", index)
        if open_index == -1:
            result.append(markdown[index:])
            break

        result.append(markdown[index:open_index])
        close_index = markdown.find(r"\]", open_index + 2)
        next_open_index = markdown.find(r"\[", open_index + 2)
        if close_index == -1 or (next_open_index != -1 and next_open_index < close_index):
            content_end = markdown.find("\n\n", open_index + 2)
            if content_end == -1:
                content_end = len(markdown)
            if next_open_index != -1 and next_open_index < content_end:
                content_end = next_open_index
            content = markdown[open_index + 2 : content_end].strip().rstrip("\\").strip()
            if _looks_like_math(content):
                result.append(f"\n\n$$\n{content}\n$$\n\n")
            else:
                result.append(markdown[open_index:content_end])
            index = content_end
            continue

        content = markdown[open_index + 2 : close_index].strip()
        result.append(f"\n\n$$\n{content}\n$$\n\n")
        index = close_index + 2

    return "".join(result)


def _normalize_markdown_math(markdown: str) -> str:
    normalized = _normalize_latex_display_math(markdown)
    normalized = _normalize_bare_square_math(normalized)
    return re.sub(r"\\\(((?:.|\n)*?)\\\)", lambda match: f"${match.group(1).strip()}$", normalized)


def _inline_markdown(text: str) -> str:
    escaped = html.escape(text.strip())
    escaped = re.sub(r"`([^`]+)`", r"<code>\1</code>", escaped)
    escaped = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", escaped)
    return escaped


def _is_table_separator(line: str) -> bool:
    cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
    return bool(cells) and all(re.fullmatch(r":?-{3,}:?", cell or "") for cell in cells)


def _is_table_start(lines: list[str], index: int) -> bool:
    return index + 1 < len(lines) and "|" in lines[index] and _is_table_separator(lines[index + 1])


def _table_cells(line: str) -> list[str]:
    return [cell.strip() for cell in line.strip().strip("|").split("|")]


def _flush_paragraph(parts: list[str], blocks: list[str]) -> None:
    if not parts:
        return
    text = "\n".join(part.strip() for part in parts if part.strip())
    if text:
        blocks.append(f"<p>{_inline_markdown(text)}</p>")
    parts.clear()


def _flush_list(items: list[str], ordered: bool, blocks: list[str]) -> None:
    if not items:
        return
    tag = "ol" if ordered else "ul"
    body = "".join(f"<li>{_inline_markdown(item)}</li>" for item in items)
    blocks.append(f"<{tag}>{body}</{tag}>")
    items.clear()


def _append_table(rows: list[list[str]], blocks: list[str]) -> None:
    if not rows:
        return
    head = "".join(f"<th>{_inline_markdown(cell)}</th>" for cell in rows[0])
    body_rows = []
    for row in rows[1:]:
        body_rows.append("<tr>" + "".join(f"<td>{_inline_markdown(cell)}</td>" for cell in row) + "</tr>")
    blocks.append(f"<table><thead><tr>{head}</tr></thead><tbody>{''.join(body_rows)}</tbody></table>")


def _append_display_math(lines: list[str], blocks: list[str]) -> None:
    expression = "\n".join(line.strip() for line in lines if line.strip()).strip()
    if expression:
        blocks.append(f"<div class=\"math-display\">$$\n{html.escape(expression)}\n$$</div>")


def _markdown_body_html(markdown: str) -> str:
    blocks: list[str] = []
    paragraph_parts: list[str] = []
    list_items: list[str] = []
    list_ordered = False
    code_lines: list[str] = []
    in_code = False
    lines = _normalize_markdown_math(markdown).splitlines()
    index = 0

    while index < len(lines):
        line = lines[index].rstrip()
        stripped = line.strip()

        if stripped.startswith("```"):
            _flush_paragraph(paragraph_parts, blocks)
            _flush_list(list_items, list_ordered, blocks)
            if in_code:
                blocks.append(f"<pre><code>{html.escape(chr(10).join(code_lines))}</code></pre>")
                code_lines.clear()
            in_code = not in_code
            index += 1
            continue

        if in_code:
            code_lines.append(line)
            index += 1
            continue

        if stripped == "$$":
            _flush_paragraph(paragraph_parts, blocks)
            _flush_list(list_items, list_ordered, blocks)
            math_lines = []
            index += 1
            while index < len(lines) and lines[index].strip() != "$$":
                math_lines.append(lines[index])
                index += 1
            _append_display_math(math_lines, blocks)
            if index < len(lines):
                index += 1
            continue

        if _is_table_start(lines, index):
            _flush_paragraph(paragraph_parts, blocks)
            _flush_list(list_items, list_ordered, blocks)
            rows = [_table_cells(lines[index])]
            index += 2
            while index < len(lines) and "|" in lines[index] and lines[index].strip():
                rows.append(_table_cells(lines[index]))
                index += 1
            _append_table(rows, blocks)
            continue

        if not stripped:
            _flush_paragraph(paragraph_parts, blocks)
            _flush_list(list_items, list_ordered, blocks)
            index += 1
            continue

        if re.fullmatch(r"-{3,}", stripped):
            _flush_paragraph(paragraph_parts, blocks)
            _flush_list(list_items, list_ordered, blocks)
            blocks.append("<hr>")
            index += 1
            continue

        heading = re.match(r"^(#{1,6})\s+(.+)$", stripped)
        if heading:
            _flush_paragraph(paragraph_parts, blocks)
            _flush_list(list_items, list_ordered, blocks)
            level = min(len(heading.group(1)), 4)
            blocks.append(f"<h{level}>{_inline_markdown(heading.group(2))}</h{level}>")
            index += 1
            continue

        unordered_match = re.match(r"^[-*]\s+(.+)$", stripped)
        ordered_match = re.match(r"^\d+[.)]\s+(.+)$", stripped)
        if unordered_match or ordered_match:
            ordered = ordered_match is not None
            if list_items and list_ordered != ordered:
                _flush_list(list_items, list_ordered, blocks)
            _flush_paragraph(paragraph_parts, blocks)
            list_ordered = ordered
            list_items.append((ordered_match or unordered_match).group(1))
            index += 1
            continue

        quote_match = re.match(r"^>\s*(.+)$", stripped)
        if quote_match:
            _flush_paragraph(paragraph_parts, blocks)
            _flush_list(list_items, list_ordered, blocks)
            blocks.append(f"<blockquote>{_inline_markdown(quote_match.group(1))}</blockquote>")
            index += 1
            continue

        paragraph_parts.append(stripped)
        index += 1

    _flush_paragraph(paragraph_parts, blocks)
    _flush_list(list_items, list_ordered, blocks)
    if code_lines:
        blocks.append(f"<pre><code>{html.escape(chr(10).join(code_lines))}</code></pre>")

    return "\n".join(blocks) or "<p>无报告内容</p>"


def _markdown_to_print_html(markdown: str) -> str:
    katex_css = _katex_css()
    katex_js = _read_katex_asset("katex.min.js")
    auto_render_js = _read_katex_asset("contrib/auto-render.min.js")
    body = _markdown_body_html(markdown)
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>
{katex_css}
@page {{
  size: A4;
  margin: 12mm 13mm;
}}
* {{
  box-sizing: border-box;
}}
html {{
  background: #ffffff;
}}
body {{
  margin: 0;
  color: #1d1d1f;
  font-family: "WenQuanYi Micro Hei", "Noto Sans CJK SC", "Source Han Sans SC", "Microsoft YaHei", sans-serif;
  font-size: 12px;
  line-height: 1.48;
  -webkit-font-smoothing: antialiased;
  print-color-adjust: exact;
  -webkit-print-color-adjust: exact;
}}
.report-shell {{
  width: 100%;
}}
h1, h2, h3, h4 {{
  color: #111111;
  break-after: avoid;
  page-break-after: avoid;
}}
h1 {{
  margin: 0 0 10px;
  font-size: 21px;
  line-height: 1.25;
  font-weight: 750;
}}
h2 {{
  margin: 13px 0 6px;
  font-size: 15px;
  line-height: 1.32;
  font-weight: 720;
}}
h3, h4 {{
  margin: 10px 0 5px;
  font-size: 13px;
  line-height: 1.35;
  font-weight: 700;
}}
p {{
  margin: 0 0 6px;
}}
ul, ol {{
  margin: 3px 0 7px 18px;
  padding: 0;
}}
li {{
  margin: 1px 0;
  padding-left: 2px;
}}
blockquote {{
  margin: 7px 0;
  padding: 7px 10px;
  border-left: 3px solid #d7d7dc;
  border-radius: 6px;
  background: #f6f6f7;
  color: #424245;
}}
hr {{
  height: 1px;
  margin: 11px 0;
  border: 0;
  background: #e5e5e7;
}}
table {{
  width: 100%;
  margin: 7px 0 9px;
  border-collapse: collapse;
  font-size: 11px;
  break-inside: avoid;
}}
th, td {{
  padding: 5px 6px;
  border: 1px solid #dedee3;
  vertical-align: top;
}}
th {{
  background: #f4f4f5;
  font-weight: 700;
}}
code {{
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
  font-size: 0.92em;
  padding: 1px 3px;
  border-radius: 4px;
  background: #f1f1f3;
}}
pre {{
  margin: 7px 0 9px;
  padding: 8px 9px;
  overflow: hidden;
  border: 1px solid #e2e2e5;
  border-radius: 8px;
  background: #f6f6f7;
  white-space: pre-wrap;
  break-inside: avoid;
}}
pre code {{
  padding: 0;
  background: transparent;
  font-size: 10.5px;
  line-height: 1.42;
}}
.katex {{
  font-size: 1.05em;
}}
.math-display {{
  margin: 0.42em 0 0.5em;
  overflow: visible;
  text-align: center;
  page-break-inside: avoid;
  break-inside: avoid;
}}
.katex-display {{
  margin: 0;
  overflow: visible;
  page-break-inside: avoid;
  break-inside: avoid;
}}
.katex-display > .katex {{
  max-width: 100%;
  white-space: normal;
}}
.katex-html {{
  white-space: normal;
}}
</style>
</head>
<body>
<main class="report-shell">
{body}
</main>
<script>
{katex_js}
</script>
<script>
{auto_render_js}
</script>
<script>
renderMathInElement(document.body, {{
  delimiters: [
    {{left: "$$", right: "$$", display: true}},
    {{left: "\\\\[", right: "\\\\]", display: true}},
    {{left: "\\\\(", right: "\\\\)", display: false}},
    {{left: "$", right: "$", display: false}}
  ],
  ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code"],
  throwOnError: false,
  strict: "ignore"
}});
document.documentElement.dataset.katexReady = "true";
</script>
</body>
</html>"""


def markdown_to_pdf_bytes(markdown: str) -> bytes:
    chrome = _chrome_binary()
    with tempfile.TemporaryDirectory(prefix="dailyreview-pdf-") as temp_dir:
        temp_path = Path(temp_dir)
        html_path = temp_path / "report.html"
        pdf_path = temp_path / "report.pdf"
        html_path.write_text(_markdown_to_print_html(markdown), encoding="utf-8")
        command = [
            chrome,
            "--headless=new",
            "--disable-gpu",
            "--no-sandbox",
            "--disable-dev-shm-usage",
            "--allow-file-access-from-files",
            f"--user-data-dir={temp_path / 'chrome-profile'}",
            "--no-pdf-header-footer",
            f"--print-to-pdf={pdf_path}",
            html_path.as_uri(),
        ]
        result = subprocess.run(command, check=False, capture_output=True, text=True, timeout=45)
        if result.returncode != 0 or not pdf_path.exists():
            detail = (result.stderr or result.stdout).strip()
            raise RuntimeError(f"Chrome PDF 导出失败：{detail}")
        return pdf_path.read_bytes()
