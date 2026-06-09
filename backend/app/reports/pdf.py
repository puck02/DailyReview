import html
import re
from io import BytesIO
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    ListFlowable,
    ListItem,
    Paragraph,
    Preformatted,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)


font_candidates = [
    ("DailyReviewSans", "/usr/share/fonts/wqy-microhei/wqy-microhei.ttc"),
    ("DailyReviewSans", "/usr/share/fonts/dejavu/DejaVuSans.ttf"),
]
mono_font_candidates = [
    ("DailyReviewMono", "/usr/share/fonts/liberation-mono/LiberationMono-Regular.ttf"),
    ("DailyReviewMono", "/usr/share/fonts/dejavu/DejaVuSans.ttf"),
]


def _register_font(candidates: list[tuple[str, str]]) -> str:
    for font_name, font_path in candidates:
        if Path(font_path).exists():
            registered = pdfmetrics.getRegisteredFontNames()
            if font_name not in registered:
                pdfmetrics.registerFont(TTFont(font_name, font_path))
            return font_name
    return "Helvetica"


def _styles() -> dict[str, ParagraphStyle]:
    body_font = _register_font(font_candidates)
    mono_font = _register_font(mono_font_candidates)
    base = getSampleStyleSheet()
    return {
        "title": ParagraphStyle(
            "DailyReviewTitle",
            parent=base["Title"],
            fontName=body_font,
            fontSize=18,
            leading=24,
            spaceAfter=8,
            textColor=colors.HexColor("#111111"),
        ),
        "heading": ParagraphStyle(
            "DailyReviewHeading",
            parent=base["Heading2"],
            fontName=body_font,
            fontSize=13,
            leading=18,
            spaceBefore=8,
            spaceAfter=5,
            textColor=colors.HexColor("#111111"),
        ),
        "body": ParagraphStyle(
            "DailyReviewBody",
            parent=base["BodyText"],
            fontName=body_font,
            fontSize=10.5,
            leading=16,
            spaceAfter=5,
            alignment=TA_LEFT,
            textColor=colors.HexColor("#222222"),
        ),
        "code": ParagraphStyle(
            "DailyReviewCode",
            parent=base["Code"],
            fontName=mono_font,
            fontSize=8.8,
            leading=12,
            leftIndent=6,
            rightIndent=6,
            spaceBefore=4,
            spaceAfter=6,
            backColor=colors.HexColor("#f5f5f5"),
            textColor=colors.HexColor("#222222"),
        ),
        "table": ParagraphStyle(
            "DailyReviewTable",
            parent=base["BodyText"],
            fontName=body_font,
            fontSize=8.8,
            leading=12,
            textColor=colors.HexColor("#222222"),
        ),
    }


def _inline_markdown(text: str) -> str:
    escaped = html.escape(_replace_inline_latex_math(text.strip()))
    escaped = re.sub(r"`([^`]+)`", r"<font name='DailyReviewMono'>\1</font>", escaped)
    escaped = re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", escaped)
    escaped = re.sub(r"\*([^*]+)\*", r"<i>\1</i>", escaped)
    return escaped


superscript_map = str.maketrans(
    {
        "0": "⁰",
        "1": "¹",
        "2": "²",
        "3": "³",
        "4": "⁴",
        "5": "⁵",
        "6": "⁶",
        "7": "⁷",
        "8": "⁸",
        "9": "⁹",
        "+": "⁺",
        "-": "⁻",
        "(": "⁽",
        ")": "⁾",
    }
)
subscript_map = str.maketrans(
    {
        "0": "₀",
        "1": "₁",
        "2": "₂",
        "3": "₃",
        "4": "₄",
        "5": "₅",
        "6": "₆",
        "7": "₇",
        "8": "₈",
        "9": "₉",
        "+": "₊",
        "-": "₋",
        "=": "₌",
        "(": "₍",
        ")": "₎",
        "n": "ₙ",
        "x": "ₓ",
        "k": "ₖ",
    }
)
latex_symbol_map = {
    r"\alpha": "α",
    r"\beta": "β",
    r"\gamma": "γ",
    r"\delta": "δ",
    r"\theta": "θ",
    r"\lambda": "λ",
    r"\mu": "μ",
    r"\pi": "π",
    r"\sigma": "σ",
    r"\omega": "ω",
    r"\sum": "Σ",
    r"\cdots": "...",
    r"\ldots": "…",
    r"\leq": "≤",
    r"\geq": "≥",
    r"\neq": "≠",
    r"\times": "×",
    r"\div": "÷",
    r"\pm": "±",
    r"\to": "→",
    r"\infty": "∞",
    r"\ln": "ln",
    r"\sin": "sin",
    r"\cos": "cos",
    r"\tan": "tan",
    r"\left": "",
    r"\right": "",
}


def _replace_latex_sums(expression: str) -> str:
    expression = re.sub(
        r"\\sum_\{([^{}]+)\}\^\{([^{}]+)\}",
        lambda match: f"Σ({match.group(1).replace('-', '−')}→{match.group(2).replace('-', '−')})",
        expression,
    )
    return re.sub(
        r"\\sum_\{([^{}]+)\}\^([A-Za-z0-9+\-]+)",
        lambda match: f"Σ({match.group(1).replace('-', '−')}→{match.group(2).replace('-', '−')})",
        expression,
    )


def _replace_latex_roots(expression: str) -> str:
    return re.sub(r"\\sqrt\s*\{([^{}]+)\}", lambda match: f"√({match.group(1)})", expression)


def _replace_latex_fractions(expression: str) -> str:
    pattern = re.compile(r"\\d?frac\s*\{([^{}]+)\}\s*\{([^{}]+)\}")
    while True:
        replaced = pattern.sub(lambda match: f"{match.group(1)}/{match.group(2)}", expression)
        if replaced == expression:
            return re.sub(r"\\d?frac\s*([A-Za-z0-9])\s*([A-Za-z0-9])", r"\1/\2", replaced)
        expression = replaced


def _script_text(value: str, translation: dict[int, str]) -> str:
    if translation is superscript_map:
        if value in {"1", "2", "3"}:
            return value.translate(translation)
        return f"^({value.replace('-', '−')})" if len(value) > 1 else f"^{value}"
    if translation is subscript_map and not value.isdigit():
        return f"_({value.replace('-', '−')})" if len(value) > 1 else f"_{value}"
    converted = value.translate(translation)
    return converted if converted != value else f"^{value}"


def _replace_latex_scripts(expression: str) -> str:
    def replace_grouped(match: re.Match[str]) -> str:
        translation = superscript_map if match.group(1) == "^" else subscript_map
        return _script_text(match.group(2), translation)

    def replace_single(match: re.Match[str]) -> str:
        translation = superscript_map if match.group(1) == "^" else subscript_map
        return _script_text(match.group(2), translation)

    expression = re.sub(r"([_^])\{([^{}]+)\}", replace_grouped, expression)
    return re.sub(r"([_^])\\?([A-Za-z0-9+\-()])", replace_single, expression)


def _latex_math_to_text(expression: str) -> str:
    text = expression.strip().strip("$").strip()
    text = _replace_latex_sums(text)
    text = _replace_latex_roots(text)
    text = _replace_latex_fractions(text)
    for command, replacement in latex_symbol_map.items():
        text = text.replace(command, replacement)
    text = _replace_latex_scripts(text)
    text = text.replace(r"\,", " ").replace(r"\;", " ").replace(r"\!", "")
    text = text.replace("\\", "")
    text = text.replace("-", "−")
    text = text.replace("sim", "∼")
    return re.sub(r"\s+", " ", text).strip()


def _replace_inline_latex_math(text: str) -> str:
    return re.sub(r"\\\((.+?)\\\)", lambda match: _latex_math_to_text(match.group(1)), text)


def _math_block_from_lines(lines: list[str], index: int) -> tuple[str, int, str] | None:
    stripped = lines[index].strip()
    if stripped.startswith(r"\["):
        start_delimiter = r"\["
        end_delimiter = r"\]"
    elif stripped.startswith("$$"):
        start_delimiter = "$$"
        end_delimiter = "$$"
    elif stripped.startswith("[") and stripped.endswith("]") and ("\\" in stripped or "^" in stripped):
        return stripped[1:-1].strip(), index + 1, ""
    else:
        return None

    parts = [stripped[len(start_delimiter) :]]
    next_index = index + 1
    while parts:
        end_position = parts[-1].find(end_delimiter)
        if end_position >= 0:
            remainder = parts[-1][end_position + len(end_delimiter) :].strip()
            parts[-1] = parts[-1][:end_position]
            return " ".join(part.strip() for part in parts).strip(), next_index, remainder
        if next_index >= len(lines):
            return " ".join(part.strip() for part in parts).rstrip("\\").strip(), next_index, ""
        parts.append(lines[next_index].strip())
        next_index += 1

    return None


def _inline_math_blocks(text: str) -> list[str]:
    blocks: list[str] = []
    patterns = [
        re.compile(r"\\\[(.+?)\\\]"),
        re.compile(r"\$\$(.+?)\$\$"),
        re.compile(r"(?<!\S)\[(.+?\\.+?)\](?!\S)"),
    ]
    for pattern in patterns:
        blocks.extend(match.group(1).strip() for match in pattern.finditer(text))
    return blocks


def _append_math_blocks(blocks: list[str], story: list, styles: dict[str, ParagraphStyle]) -> None:
    for expression in blocks:
        rendered = _latex_math_to_text(expression)
        if rendered:
            story.append(Paragraph(html.escape(rendered), styles["body"]))


def _is_table_separator(line: str) -> bool:
    cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
    return bool(cells) and all(re.fullmatch(r":?-{3,}:?", cell or "") for cell in cells)


def _is_table_start(lines: list[str], index: int) -> bool:
    return index + 1 < len(lines) and "|" in lines[index] and _is_table_separator(lines[index + 1])


def _table_cells(line: str) -> list[str]:
    return [cell.strip() for cell in line.strip().strip("|").split("|")]


def _flush_paragraph(parts: list[str], story: list, styles: dict[str, ParagraphStyle]) -> None:
    if not parts:
        return
    text = " ".join(part.strip() for part in parts if part.strip())
    if text:
        story.append(Paragraph(_inline_markdown(text), styles["body"]))
    parts.clear()


def _flush_list(items: list[str], story: list, styles: dict[str, ParagraphStyle]) -> None:
    if not items:
        return
    story.append(
        ListFlowable(
            [ListItem(Paragraph(_inline_markdown(item), styles["body"]), leftIndent=8) for item in items],
            bulletType="bullet",
            leftIndent=14,
            bulletFontName=styles["body"].fontName,
            bulletFontSize=7,
        )
    )
    items.clear()


def _append_table(rows: list[list[str]], story: list, styles: dict[str, ParagraphStyle]) -> None:
    if not rows:
        return
    width = 174 * mm
    column_width = width / max(len(rows[0]), 1)
    data = [[Paragraph(_inline_markdown(cell), styles["table"]) for cell in row] for row in rows]
    table = Table(data, colWidths=[column_width] * len(rows[0]), hAlign="LEFT", repeatRows=1)
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f2f2f2")),
                ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#d9d9d9")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 5),
                ("RIGHTPADDING", (0, 0), (-1, -1), 5),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ]
        )
    )
    story.append(table)
    story.append(Spacer(1, 5))


def markdown_to_pdf_bytes(markdown: str) -> bytes:
    styles = _styles()
    story: list = []
    paragraph_parts: list[str] = []
    list_items: list[str] = []
    code_lines: list[str] = []
    in_code = False
    lines = markdown.splitlines()
    index = 0

    while index < len(lines):
        raw_line = lines[index]
        line = raw_line.rstrip()

        if line.strip().startswith("```"):
            _flush_paragraph(paragraph_parts, story, styles)
            _flush_list(list_items, story, styles)
            if in_code:
                story.append(Preformatted("\n".join(code_lines), styles["code"], maxLineLength=88))
                code_lines.clear()
            in_code = not in_code
            index += 1
            continue

        if in_code:
            code_lines.append(line)
            index += 1
            continue

        inline_math_blocks = _inline_math_blocks(line)
        if inline_math_blocks:
            _flush_paragraph(paragraph_parts, story, styles)
            _flush_list(list_items, story, styles)
            _append_math_blocks(inline_math_blocks, story, styles)
            index += 1
            continue

        math_block = _math_block_from_lines(lines, index)
        if math_block is not None:
            _flush_paragraph(paragraph_parts, story, styles)
            _flush_list(list_items, story, styles)
            expression, index, remainder = math_block
            _append_math_blocks([expression], story, styles)
            if remainder:
                lines.insert(index, remainder)
            continue

        if _is_table_start(lines, index):
            _flush_paragraph(paragraph_parts, story, styles)
            _flush_list(list_items, story, styles)
            rows = [_table_cells(lines[index])]
            index += 2
            while index < len(lines) and "|" in lines[index] and lines[index].strip():
                rows.append(_table_cells(lines[index]))
                index += 1
            _append_table(rows, story, styles)
            continue

        stripped = line.strip()
        if not stripped:
            _flush_paragraph(paragraph_parts, story, styles)
            _flush_list(list_items, story, styles)
            index += 1
            continue

        heading = re.match(r"^(#{1,6})\s+(.+)$", stripped)
        if heading:
            _flush_paragraph(paragraph_parts, story, styles)
            _flush_list(list_items, story, styles)
            style = styles["title"] if len(heading.group(1)) == 1 else styles["heading"]
            story.append(Paragraph(_inline_markdown(heading.group(2)), style))
            index += 1
            continue

        list_match = re.match(r"^[-*]\s+(.+)$", stripped)
        if list_match:
            _flush_paragraph(paragraph_parts, story, styles)
            list_items.append(list_match.group(1))
            index += 1
            continue

        paragraph_parts.append(stripped)
        index += 1

    _flush_paragraph(paragraph_parts, story, styles)
    _flush_list(list_items, story, styles)
    if code_lines:
        story.append(Preformatted("\n".join(code_lines), styles["code"], maxLineLength=88))

    buffer = BytesIO()
    document = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        leftMargin=14 * mm,
        rightMargin=14 * mm,
        topMargin=14 * mm,
        bottomMargin=14 * mm,
        title="DailyReview Report",
        author="DailyReview",
    )
    document.build(story or [Paragraph("无报告内容", styles["body"])])
    return buffer.getvalue()
