export type EssayParagraphStage = "opening" | "development" | "transition" | "conclusion" | "unknown";

export type EssayAcceptedSuggestion = {
  text: string;
  range: {
    start: number;
    end: number;
  };
  insertedText: string;
};

const wordPattern = /[A-Za-z][A-Za-z'-]*/g;
const sentenceEndPattern = /[.!?]$/;
const leadingPunctuationPattern = /^[,.;:!?)]/;
const duplicateLeadingPunctuationPattern = /^([.!?])\s*\1+/;

export function countEssayWords(text: string) {
  return text.match(wordPattern)?.length || 0;
}

export function deriveEssayParagraphStage(text: string, cursorIndex: number): EssayParagraphStage {
  const prefix = text.slice(0, Math.max(0, Math.min(cursorIndex, text.length)));
  const words = countEssayWords(prefix);
  const paragraphs = prefix.split(/\n{2,}|\r?\n/);
  const currentParagraph = paragraphs[paragraphs.length - 1]?.trim().toLowerCase() || "";
  if (/\b(in conclusion|to conclude|all in all|to sum up|in short)\b/.test(currentParagraph)) return "conclusion";
  if (/\b(moreover|furthermore|however|therefore|besides|meanwhile|from another perspective)\b/.test(currentParagraph)) {
    return "transition";
  }
  if (!prefix.trim() || words < 10) return "opening";
  if (words > 120) return "conclusion";
  return "development";
}

export function normalizeEssaySuggestionForInsert(value: string) {
  return value.trim().replace(/\s+/g, " ").replace(duplicateLeadingPunctuationPattern, "$1");
}

function formatSuggestionForCursor(prefix: string, suggestion: string) {
  const normalized = normalizeEssaySuggestionForInsert(suggestion);
  if (!normalized) return "";
  const trimmedPrefix = prefix.replace(/\s+$/, "");
  if (!trimmedPrefix) return normalized;
  if (sentenceEndPattern.test(trimmedPrefix) && sentenceEndPattern.test(normalized)) {
    return ` ${normalized.replace(/^[.!?]\s*/, "")}`;
  }
  if (leadingPunctuationPattern.test(normalized)) return normalized;
  if (/\s$/.test(prefix)) return normalized;
  return ` ${normalized}`;
}

export function insertEssaySuggestionAtCursor(text: string, suggestion: string, cursorIndex: number): EssayAcceptedSuggestion {
  const start = Math.max(0, Math.min(cursorIndex, text.length));
  const prefix = text.slice(0, start);
  const suffix = text.slice(start);
  const insertedText = formatSuggestionForCursor(prefix, suggestion);
  return {
    text: `${prefix}${insertedText}${suffix}`,
    range: {
      start,
      end: start + insertedText.length
    },
    insertedText
  };
}

export function undoAcceptedEssaySuggestion(text: string, accepted: EssayAcceptedSuggestion | null) {
  if (!accepted) return null;
  const { start, end } = accepted.range;
  if (text.slice(start, end) !== accepted.insertedText) return null;
  if (end !== text.length) return null;
  return `${text.slice(0, start)}${text.slice(end)}`;
}
