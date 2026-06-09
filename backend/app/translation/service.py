import re

from sqlalchemy.orm import Session

from app.models import AppSetting


TRANSLATION_PROMPT_PREFIX = "translation_prompt:"
ENGLISH_STOP_WORDS = {
    "and",
    "are",
    "but",
    "for",
    "from",
    "has",
    "have",
    "into",
    "not",
    "that",
    "the",
    "this",
    "was",
    "were",
    "with",
    "you",
}

DEFAULT_TRANSLATION_PROMPT = """你是一个面向考研英语一的中英互译和词汇讲解助手。
任务范围：围绕考研英语一考纲常见词汇、短语和句式，用简洁、准确、可复习的方式解释。

输出要求：
- 如果输出中包含英文单词或英文表达，在第一行用 `音标：/.../` 给出核心单词或表达的音标。
- 如果输入是中文：先给英文译文，再说明关键表达和可替换说法。
- 如果输入是英文：先给中文译文，再说明核心含义和用法。
- 如果输入是单个英文单词：必须给音标，补充词根词缀、长得像或容易混淆的词、常见搭配，并给 1-2 句短例句。
- 如果输入是短语或句子：拆解语法/表达，提炼 2-4 个重点，不要逐词堆砌。
- 篇幅控制在 220 个中文字符以内；使用 Markdown 小标题和短项目符号。
- 不要输出寒暄、免责声明或与学习无关的内容。
"""


def detect_source_kind(text: str) -> str:
    stripped = text.strip()
    if re.search(r"[\u4e00-\u9fff]", stripped):
        return "chinese"
    if re.fullmatch(r"[A-Za-z][A-Za-z'-]*", stripped):
        return "word"
    return "english"


def get_translation_prompt(db: Session, user_id: int) -> str:
    setting = db.get(AppSetting, f"{TRANSLATION_PROMPT_PREFIX}{user_id}")
    if setting is None or not setting.value.strip():
        return DEFAULT_TRANSLATION_PROMPT
    return setting.value


def update_translation_prompt(db: Session, user_id: int, system_prompt: str) -> str:
    key = f"{TRANSLATION_PROMPT_PREFIX}{user_id}"
    setting = db.get(AppSetting, key)
    value = system_prompt.strip() or DEFAULT_TRANSLATION_PROMPT
    if setting is None:
        setting = AppSetting(key=key, value=value)
        db.add(setting)
    else:
        setting.value = value
    db.commit()
    return value


def fallback_translation(text: str, source_kind: str) -> str:
    if source_kind == "chinese":
        return f"""### 译文
{text}

### 重点
- AI 配置不可用时暂时返回原文；配置完成后会生成英文译文和表达讲解。"""
    if source_kind == "word":
        return f"""### 释义
{text}

### 重点
- AI 配置不可用时暂时返回原词；配置完成后会补充词根词缀、易混词、用法和例句。"""
    return f"""### 译文
{text}

### 重点
- AI 配置不可用时暂时返回原文；配置完成后会生成中文译文和句式拆解。"""


def extract_phonetic_and_markdown(markdown: str) -> tuple[str | None, str]:
    match = re.search(r"(?im)^\s*(?:音标|IPA|Phonetic)\s*[:：]\s*(.+?)\s*$", markdown)
    if match is None:
        return None, markdown.strip()
    phonetic = match.group(1).strip()
    cleaned = (markdown[: match.start()] + markdown[match.end() :]).strip()
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return phonetic, cleaned


def is_thin_dictionary_markdown(markdown: str) -> bool:
    return "### 考纲释义" in markdown and "词频：" in markdown


def build_translation_user_prompt(text: str, source_kind: str) -> str:
    type_label = {"chinese": "中文", "word": "英文单词", "english": "英文短语或句子"}[source_kind]
    return f"""输入类型：{type_label}
输入内容：
{text.strip()}

固定要求：如果输入或译文包含英文，请在第一行输出 `音标：/.../`，给出最核心英文单词或表达的音标。
请按系统要求输出简洁 Markdown。"""


def build_word_detail_user_prompt(word: str) -> str:
    return f"""输入类型：英文单词
输入内容：
{word.strip()}

请在第一行输出 `音标：/.../`，然后用简洁 Markdown 给出释义、词根词缀、易混词、常见搭配和 1-2 句例句。"""


def labels_for_auto_word_details(text: str) -> list[str]:
    words = re.findall(r"[A-Za-z][A-Za-z'-]*", text)
    if len(words) <= 3:
        return []
    labels = [
        word.lower()
        for word in words
        if len(word) > 2 and word.lower() not in ENGLISH_STOP_WORDS
    ]
    return list(dict.fromkeys(labels))[:8]
