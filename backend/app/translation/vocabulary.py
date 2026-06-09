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


def _candidate_lemmas(word: str) -> list[str]:
    normalized = normalize_lookup_word(word)
    candidates = [normalized]
    if not re.fullmatch(r"[a-z][a-z'-]*", normalized):
        return candidates

    if normalized.endswith("ies") and len(normalized) > 4:
        candidates.append(normalized[:-3] + "y")
    if normalized.endswith("ied") and len(normalized) > 4:
        candidates.append(normalized[:-3] + "y")
    if normalized.endswith("ing") and len(normalized) > 5:
        stem = normalized[:-3]
        candidates.append(stem)
        candidates.append(stem + "e")
        if len(stem) > 2 and stem[-1] == stem[-2]:
            candidates.append(stem[:-1])
    if normalized.endswith("ed") and len(normalized) > 4:
        stem = normalized[:-2]
        candidates.append(stem)
        candidates.append(stem + "e")
        if len(stem) > 2 and stem[-1] == stem[-2]:
            candidates.append(stem[:-1])
    if normalized.endswith("es") and len(normalized) > 4:
        candidates.append(normalized[:-1])
        if re.search(r"(ches|shes|xes|zes|sses|oes)$", normalized):
            candidates.append(normalized[:-2])
    if normalized.endswith("s") and len(normalized) > 3 and not normalized.endswith(("ss", "us", "is")):
        candidates.append(normalized[:-1])

    return list(dict.fromkeys(candidates))


@lru_cache(maxsize=1)
def _load_vocabulary() -> dict[str, Any]:
    if not DATA_PATH.exists():
        return {"lookup": {}, "entries": {}}
    return json.loads(DATA_PATH.read_text(encoding="utf-8"))


def find_netem_word(word: str) -> NetemVocabularyEntry | None:
    vocabulary = _load_vocabulary()
    primary = None
    for lookup_word in _candidate_lemmas(word):
        primary = vocabulary["lookup"].get(lookup_word)
        if primary:
            break
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


def normalize_word_lemma(word: str) -> str:
    dictionary_entry = find_netem_word(word)
    if dictionary_entry is not None:
        return dictionary_entry.word
    candidates = _candidate_lemmas(word)
    return candidates[1] if len(candidates) > 1 else candidates[0]
