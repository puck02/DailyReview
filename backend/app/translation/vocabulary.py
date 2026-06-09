import json
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any


DATA_PATH = Path(__file__).resolve().parent / "data" / "netem_vocabulary.json"


@dataclass(frozen=True)
class NetemVocabularyEntry:
    word: str
    rank: int
    frequency: int
    definition: str
    variants: list[str]
    category: str
    subcategory: str
    phonetic: str


def normalize_lookup_word(value: str) -> str:
    return re.sub(r"\s+", " ", value.strip().lower())


@lru_cache(maxsize=1)
def _load_vocabulary() -> dict[str, Any]:
    if not DATA_PATH.exists():
        return {"lookup": {}, "entries": {}}
    return json.loads(DATA_PATH.read_text(encoding="utf-8"))


def find_netem_word(word: str) -> NetemVocabularyEntry | None:
    vocabulary = _load_vocabulary()
    lookup_word = normalize_lookup_word(word)
    primary = vocabulary["lookup"].get(lookup_word)
    if not primary:
        return None
    entry = vocabulary["entries"].get(primary)
    if not entry:
        return None
    return NetemVocabularyEntry(
        word=entry["word"],
        rank=int(entry["rank"]),
        frequency=int(entry["frequency"]),
        definition=entry["definition"],
        variants=list(entry.get("variants") or []),
        category=entry.get("category") or "",
        subcategory=entry.get("subcategory") or "",
        phonetic=entry.get("phonetic") or "",
    )


def render_netem_markdown(entry: NetemVocabularyEntry) -> str:
    category = " / ".join(item for item in [entry.category, entry.subcategory] if item)
    variants = "、".join(entry.variants) if entry.variants else "无"
    lines = [
        "### 考纲释义",
        f"- **{entry.word}**：{entry.definition}",
        "",
        "### 记忆信息",
        f"- 词频：{entry.frequency}（考纲排序第 {entry.rank}）",
        f"- 分类：{category or '未分类'}",
        f"- 其他拼写：{variants}",
        "",
        "### 用法提示",
        f"- 先记核心义“{entry.definition}”，再结合阅读语境判断具体译法。",
    ]
    return "\n".join(lines)
