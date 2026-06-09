import json
import re
from collections import Counter
from datetime import date, datetime, time, timedelta
from pathlib import Path

from sqlalchemy import and_, select
from sqlalchemy.orm import Session

from app.admin.ai_config import get_ai_config
from app.ai_client import complete_chat
from app.config import settings
from app.models import ChatSession, Message, Report, User
from app.storage.files import report_root

DAILY_REPORT_MAX_CHARS = 1800
DAILY_REPORT_SECTION_ITEM_LIMIT = 4


def _day_bounds(day: date) -> tuple[datetime, datetime]:
    return datetime.combine(day, time.min), datetime.combine(day + timedelta(days=1), time.min)


def _daily_report_path(user_id: int, day: date) -> Path:
    return report_root() / f"user-{user_id}" / "daily" / f"{day:%Y}" / f"{day:%m}" / f"{day:%Y-%m-%d}.md"


def _summary_report_path(user_id: int, report_type: str, period: str) -> Path:
    year = period[:4]
    return report_root() / f"user-{user_id}" / report_type / year / f"{period}.md"


def _messages_for_day(db: Session, user_id: int, day: date) -> list[Message]:
    start, end = _day_bounds(day)
    return db.scalars(
        select(Message)
        .join(ChatSession, Message.session_id == ChatSession.id)
        .where(
            ChatSession.user_id == user_id,
            ChatSession.is_archived.is_(False),
            Message.created_at >= start,
            Message.created_at < end,
        )
        .order_by(Message.created_at.asc())
    ).all()


def _render_conversation(messages: list[Message]) -> str:
    return "\n".join(f"{message.role}: {message.content}" for message in messages if message.content.strip())


def extract_keywords(text: str, limit: int = 8) -> list[str]:
    words = re.findall(r"[\u4e00-\u9fa5]{2,}|[A-Za-z][A-Za-z0-9_+-]{2,}", text)
    ignored = {"assistant", "user", "今天", "学习", "解释", "这个", "一个", "什么", "如何", "用于"}
    counts = Counter(word for word in words if word.lower() not in ignored)
    return [word for word, _count in counts.most_common(limit)]


def _split_blocks(text: str) -> list[str]:
    parts = re.split(r"\n\s*\n", text)
    return [part.strip() for part in parts if part.strip() and not part.lstrip().startswith("#")]


def search_markdown_blocks(paths: list[Path], keywords: list[str], limit: int = 6) -> list[str]:
    results: list[str] = []
    seen: set[str] = set()
    for path in paths:
        if not path.exists():
            continue
        for block in _split_blocks(path.read_text(encoding="utf-8")):
            if any(keyword and keyword in block for keyword in keywords) and block not in seen:
                results.append(block)
                seen.add(block)
                if len(results) >= limit:
                    return results
    return results


def _recent_daily_paths(db: Session, user_id: int, day: date) -> list[Path]:
    start = day - timedelta(days=7)
    reports = db.scalars(
        select(Report)
        .where(
            Report.user_id == user_id,
            Report.report_type == "daily",
            Report.period >= f"{start:%Y-%m-%d}",
            Report.period < f"{day:%Y-%m-%d}",
        )
        .order_by(Report.period.desc())
    ).all()
    return [Path(report.markdown_path) for report in reports]


def _fallback_daily_markdown(day: date, conversation: str, keywords: list[str], related_blocks: list[str]) -> str:
    highlights = "\n".join(f"- {keyword}" for keyword in keywords[:6]) or "- 今日内容较少"
    related = "\n".join(f"- {block[:120]}" for block in related_blocks[:3]) or "- 暂无明显历史关联"
    first_lines = "\n".join(f"- {line[:120]}" for line in conversation.splitlines()[:6]) or "- 暂无"
    return f"""# {day:%Y-%m-%d} 学习日报

## 1. 今日学习概览
{first_lines}

## 2. 核心知识点
{highlights}

## 3. 典型问题与解法
- 只保留今日最典型的 1-2 个问题，并整理成可复述的解题步骤。

## 4. 易错点 / 未解决问题
- 标记仍然含糊的概念，下一次用例题验证。

## 5. 与历史内容的关联
{related}

## 6. 下一步建议
- 明天先用 10 分钟复述今日核心知识点。
- 针对最不确定的问题补 1-2 道练习题。

## 7. 简短复盘
- 控制篇幅，适合直接导出为 A4 PDF 4 页以内的复习材料。
"""


def _compact_daily_markdown(markdown: str) -> str:
    if len(markdown) <= DAILY_REPORT_MAX_CHARS:
        return markdown

    compacted: list[str] = []
    item_count = 0
    in_section = False
    for line in markdown.splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            compacted.append(stripped)
            in_section = stripped.startswith("## ")
            item_count = 0
            continue
        if not in_section:
            if stripped:
                compacted.append(stripped[:120])
            continue
        if not stripped:
            continue
        if stripped.startswith(("- ", "* ")):
            if item_count >= DAILY_REPORT_SECTION_ITEM_LIMIT:
                continue
            compacted.append(f"{stripped[:140]}{'...' if len(stripped) > 140 else ''}")
            item_count += 1
            continue
        if item_count < DAILY_REPORT_SECTION_ITEM_LIMIT:
            compacted.append(stripped[:140])
            item_count += 1

    result = "\n".join(compacted)
    if len(result) > DAILY_REPORT_MAX_CHARS:
        result = result[: DAILY_REPORT_MAX_CHARS - 34].rstrip()
    return f"{result}\n\n> 内容已按 PDF 篇幅要求压缩。"


async def _ai_daily_markdown(
    db: Session,
    day: date,
    conversation: str,
    keywords: list[str],
    related_blocks: list[str],
) -> str:
    prompt = f"""请根据以下学习问答生成一份适合导出为 A4 PDF 4 页以内的 Markdown 学习日报。
排版目标：结构清晰、留白稳定、适合打印；内容过多时只保留最重要的结论、错因和下一步建议，不要堆砌完整聊天流水。
篇幅控制：每节使用短段落或 2-5 条项目符号，整篇不超过 1400 个中文字符；历史关联最多 3 条，典型问题最多 2 个。
必须使用这些标题：
# {day:%Y-%m-%d} 学习日报
## 1. 今日学习概览
## 2. 核心知识点
## 3. 典型问题与解法
## 4. 易错点 / 未解决问题
## 5. 与历史内容的关联
## 6. 下一步建议
## 7. 简短复盘

关键词：{", ".join(keywords)}

历史相关内容：
{chr(10).join(related_blocks)}

今日问答：
{conversation}
"""
    markdown = await complete_chat(
        [{"role": "user", "content": prompt}],
        model=settings.ai_default_model,
        fallback=_fallback_daily_markdown(day, conversation, keywords, related_blocks),
        ai_config=get_ai_config(db),
    )
    return _compact_daily_markdown(markdown)


def _write_report(db: Session, user_id: int, report_type: str, period: str, path: Path, markdown: str, stats: dict) -> Report:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(markdown, encoding="utf-8")
    report = db.scalar(
        select(Report).where(Report.user_id == user_id, Report.report_type == report_type, Report.period == period)
    )
    if report is None:
        report = Report(user_id=user_id, report_type=report_type, period=period, markdown_path=str(path))
        db.add(report)
    report.markdown_path = str(path)
    report.stats_json = json.dumps(stats, ensure_ascii=False)
    db.commit()
    db.refresh(report)
    return report


def generate_daily_report(db: Session, user_id: int, day: date) -> Report | None:
    messages = _messages_for_day(db, user_id, day)
    if not messages:
        return None
    conversation = _render_conversation(messages)
    keywords = extract_keywords(conversation)
    related_blocks = search_markdown_blocks(_recent_daily_paths(db, user_id, day), keywords)
    markdown = _fallback_daily_markdown(day, conversation, keywords, related_blocks)
    stats = {"message_count": len(messages), "keywords": keywords, "related_count": len(related_blocks)}
    return _write_report(db, user_id, "daily", f"{day:%Y-%m-%d}", _daily_report_path(user_id, day), markdown, stats)


async def generate_daily_report_async(db: Session, user_id: int, day: date) -> Report | None:
    messages = _messages_for_day(db, user_id, day)
    if not messages:
        return None
    conversation = _render_conversation(messages)
    keywords = extract_keywords(conversation)
    related_blocks = search_markdown_blocks(_recent_daily_paths(db, user_id, day), keywords)
    markdown = await _ai_daily_markdown(db, day, conversation, keywords, related_blocks)
    stats = {"message_count": len(messages), "keywords": keywords, "related_count": len(related_blocks)}
    return _write_report(db, user_id, "daily", f"{day:%Y-%m-%d}", _daily_report_path(user_id, day), markdown, stats)


def _daily_reports_between(db: Session, user_id: int, start: str, end: str) -> list[Report]:
    return db.scalars(
        select(Report)
        .where(Report.user_id == user_id, Report.report_type == "daily", Report.period >= start, Report.period <= end)
        .order_by(Report.period.asc())
    ).all()


def generate_summary_report(db: Session, user_id: int, report_type: str, period: str, reports: list[Report]) -> Report | None:
    if not reports:
        return None
    contents = []
    for report in reports:
        path = Path(report.markdown_path)
        if path.exists():
            contents.append(path.read_text(encoding="utf-8"))
    title = "周学习总结" if report_type == "weekly" else "月学习总结"
    markdown = f"""# {period} {title}

## 学习主题分布
{len(reports)} 份日报参与汇总。

## 高频问题
请根据日报内容复盘反复出现的问题。

## 关键进展
{chr(10).join(content.splitlines()[0] for content in contents if content.splitlines())}

## 下阶段建议
- 保留每天复盘节奏。
- 优先处理日报中连续出现的未解决问题。
"""
    stats = {"daily_count": len(reports)}
    return _write_report(db, user_id, report_type, period, _summary_report_path(user_id, report_type, period), markdown, stats)


def generate_weekly_report(db: Session, user_id: int, day: date) -> Report | None:
    start = day - timedelta(days=day.weekday())
    reports = _daily_reports_between(db, user_id, f"{start:%Y-%m-%d}", f"{day:%Y-%m-%d}")
    return generate_summary_report(db, user_id, "weekly", f"{day:%G}-W{day:%V}", reports)


def generate_monthly_report(db: Session, user_id: int, day: date) -> Report | None:
    start = day.replace(day=1)
    reports = _daily_reports_between(db, user_id, f"{start:%Y-%m-%d}", f"{day:%Y-%m-%d}")
    return generate_summary_report(db, user_id, "monthly", f"{day:%Y-%m}", reports)


def all_users(db: Session) -> list[User]:
    return db.scalars(select(User).order_by(User.id)).all()
