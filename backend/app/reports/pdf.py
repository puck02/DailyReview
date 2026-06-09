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
    escaped = html.escape(text.strip())
    escaped = re.sub(r"`([^`]+)`", r"<font name='DailyReviewMono'>\1</font>", escaped)
    escaped = re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", escaped)
    escaped = re.sub(r"\*([^*]+)\*", r"<i>\1</i>", escaped)
    return escaped


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
