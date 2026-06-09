import json
import re
import urllib.request
from pathlib import Path
from typing import Any


NETEM_URL = "https://raw.githubusercontent.com/exam-data/NETEMVocabulary/master/netem_full_list.json"
IPA_URL = "https://raw.githubusercontent.com/open-dict-data/ipa-dict/master/data/en_US.txt"
OUTPUT_PATH = Path(__file__).resolve().parents[1] / "app" / "translation" / "data" / "netem_vocabulary.json"


def fetch_json(url: str) -> Any:
    with urllib.request.urlopen(url, timeout=30) as response:
        return json.load(response)


def fetch_text(url: str) -> str:
    with urllib.request.urlopen(url, timeout=30) as response:
        return response.read().decode("utf-8")


def normalize_word(value: str) -> str:
    return re.sub(r"\s+", " ", value.strip().lower())


def parse_variants(value: Any) -> list[str]:
    if not value:
        return []
    variants: list[str] = []
    for part in re.split(r"[,，;；/、]", str(value)):
        word = normalize_word(part)
        if word:
            variants.append(word)
    return list(dict.fromkeys(variants))


def parse_ipa(text: str) -> dict[str, str]:
    pronunciations: dict[str, str] = {}
    for line in text.splitlines():
        if "\t" not in line:
            continue
        word, phonetic = line.split("\t", 1)
        normalized = normalize_word(word)
        if normalized and phonetic.strip():
            pronunciations.setdefault(normalized, phonetic.strip())
    return pronunciations


def build_dictionary() -> dict[str, Any]:
    source = fetch_json(NETEM_URL)
    rows = next(iter(source.values()))
    ipa = parse_ipa(fetch_text(IPA_URL))
    entries: dict[str, dict[str, Any]] = {}
    lookup: dict[str, str] = {}

    for row in rows:
        word = normalize_word(row["单词"])
        variants = [variant for variant in parse_variants(row.get("其他拼写")) if variant != word]
        phonetic = ipa.get(word) or next((ipa[variant] for variant in variants if variant in ipa), None)
        definition = str(row["释义"]).strip()
        category = row.get("分类") or ""
        subcategory = row.get("子分类") or ""
        if word in entries:
            entry = entries[word]
            definitions = [item.strip() for item in entry["definition"].split("；") if item.strip()]
            if definition and definition not in definitions:
                definitions.append(definition)
            entry["definition"] = "；".join(definitions)
            entry["rank"] = min(entry["rank"], row["序号"])
            entry["frequency"] += row["词频"]
            entry["variants"] = list(dict.fromkeys([*entry["variants"], *variants]))
            entry["category"] = " / ".join(
                dict.fromkeys(item for item in [*entry["category"].split(" / "), category] if item)
            )
            entry["subcategory"] = " / ".join(
                dict.fromkeys(item for item in [*entry["subcategory"].split(" / "), subcategory] if item)
            )
            entry["phonetic"] = entry["phonetic"] or phonetic or ""
        else:
            entries[word] = {
                "word": word,
                "rank": row["序号"],
                "frequency": row["词频"],
                "definition": definition,
                "variants": variants,
                "category": category,
                "subcategory": subcategory,
                "phonetic": phonetic or "",
            }
        lookup[word] = word
        for variant in variants:
            lookup[variant] = word

    return {
        "metadata": {
            "name": "NETEM vocabulary cache",
            "source_row_count": len(rows),
            "word_count": len(entries),
            "lookup_count": len(lookup),
            "netem_source": NETEM_URL,
            "netem_license": "CC BY-NC-SA 4.0",
            "ipa_source": IPA_URL,
            "ipa_license": "MIT",
        },
        "lookup": dict(sorted(lookup.items())),
        "entries": dict(sorted(entries.items())),
    }


def main() -> None:
    dictionary = build_dictionary()
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(dictionary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {dictionary['metadata']['word_count']} NETEM entries to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
