export const TRANSLATION_INPUT_LIMIT = 2000;
export const TRANSLATION_LIMIT_MESSAGE = "输入超过 2000 字，已超限，不予翻译。";
export const TRANSLATION_PROMPT_PREFIX = "translation_prompt:";

const ENGLISH_STOP_WORDS = new Set([
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
  "you"
]);

export const DEFAULT_TRANSLATION_PROMPT = `你是一个面向考研英语一的中英互译和词汇讲解助手。
任务范围：围绕考研英语一考纲常见词汇、短语和句式，用简洁、准确、可复习的方式解释。

输出要求：
- 如果输出中包含英文单词或英文表达，在第一行用 \`音标：/.../\` 给出核心单词或表达的音标。
- 如果输入是中文：先给英文译文，再说明关键表达和可替换说法。
- 如果输入是英文：先给中文译文，再说明核心含义和用法。
- 如果输入是单个英文单词：必须给音标，补充词根词缀、长得像或容易混淆的词、常见搭配，并给 1-2 句短例句。
- 如果输入是短语或句子：拆解语法/表达，提炼 2-4 个重点，不要逐词堆砌。
- 篇幅控制在 220 个中文字符以内；使用 Markdown 小标题和短项目符号。
- 不要输出寒暄、免责声明或与学习无关的内容。
`;

export type SourceKind = "chinese" | "word" | "english";

export function detectSourceKind(text: string): SourceKind {
  const stripped = text.trim();
  if (/[\u4e00-\u9fff]/.test(stripped)) {
    return "chinese";
  }
  if (/^[A-Za-z][A-Za-z'-]*$/.test(stripped)) {
    return "word";
  }
  return "english";
}

export function normalizeWord(text: string): string {
  return text.trim().toLowerCase();
}

export function isNormalizedWord(text: string): boolean {
  return /^[a-z][a-z'-]*$/.test(text);
}

export function fallbackTranslation(text: string, sourceKind: SourceKind): string {
  if (sourceKind === "chinese") {
    return `### 译文
${text}

### 重点
- AI 配置不可用时暂时返回原文；配置完成后会生成英文译文和表达讲解。`;
  }
  if (sourceKind === "word") {
    return `### 释义
${text}

### 重点
- AI 配置不可用时暂时返回原词；配置完成后会补充词根词缀、易混词、用法和例句。`;
  }
  return `### 译文
${text}

### 重点
- AI 配置不可用时暂时返回原文；配置完成后会生成中文译文和句式拆解。`;
}

export function isFallbackTranslationMarkdown(markdown: string): boolean {
  return markdown.includes("AI 配置不可用时暂时返回");
}

export function extractPhoneticAndMarkdown(markdown: string): { phonetic: string | null; markdown: string } {
  const lines = markdown.trim().split(/\r?\n/);
  let phonetic: string | null = null;
  const kept: string[] = [];
  for (const line of lines) {
    const match = line.match(/^\s*(?:音标|IPA|Phonetic)\s*[:：]\s*(.+?)\s*$/i);
    if (match && !phonetic) {
      phonetic = (match[1] || "").trim() || null;
      continue;
    }
    kept.push(line);
  }
  const cleaned = kept.join("\n").trim().replace(/\n{3,}/g, "\n\n");
  return { phonetic, markdown: cleaned };
}

export function extractCanonicalWordAndMarkdown(markdown: string): { canonicalWord: string | null; markdown: string } {
  const lines = markdown.trim().split(/\r?\n/);
  let canonicalWord: string | null = null;
  const kept: string[] = [];
  for (const line of lines) {
    const match = line.match(/^\s*(?:词条|单词|Canonical Word)\s*[:：]\s*([A-Za-z][A-Za-z'-]*)\s*$/i);
    if (match && !canonicalWord) {
      const normalized = normalizeWord(match[1] || "");
      if (isNormalizedWord(normalized)) {
        canonicalWord = normalized;
      }
      continue;
    }
    kept.push(line);
  }
  return { canonicalWord, markdown: kept.join("\n").trim().replace(/\n{3,}/g, "\n\n") };
}

export function isThinDictionaryMarkdown(markdown: string): boolean {
  return markdown.includes("### 考纲释义") && markdown.includes("词频：");
}

export function correctedWordFromMarkdown(markdown: string): string | null {
  const match = markdown.match(/正确拼写是\s*[`"“]?([A-Za-z][A-Za-z'-]*)[`"”]?/);
  if (!match) {
    return null;
  }
  const normalized = normalizeWord(match[1] || "");
  return isNormalizedWord(normalized) ? normalized : null;
}

export function buildTranslationUserPrompt(text: string, sourceKind: SourceKind): string {
  const typeLabel = { chinese: "中文", word: "英文单词", english: "英文短语或句子" }[sourceKind];
  return `输入类型：${typeLabel}
输入内容：
${text.trim()}

固定要求：如果输入或译文包含英文，请在第一行输出 \`音标：/.../\`，给出最核心英文单词或表达的音标。
如果输入类型是英文单词，请在音标行前额外输出一行 \`词条：correct-word\`，其中 correct-word 必须是纠正拼写后的标准小写英文单词；如果用户输入拼写错误，不要把错误拼写作为词条。
请按系统要求输出简洁 Markdown。`;
}

export function buildWordDetailUserPrompt(word: string): string {
  return `输入类型：英文单词
输入内容：
${word.trim()}

请在第一行输出 \`词条：correct-word\`，第二行输出 \`音标：/.../\`，然后用简洁 Markdown 给出释义、词根词缀、易混词、常见搭配和 1-2 句例句。correct-word 必须是纠正拼写后的标准小写英文单词。`;
}

export function labelsForAutoWordDetails(text: string): string[] {
  const words = text.match(/[A-Za-z][A-Za-z'-]*/g) || [];
  if (words.length <= 3) {
    return [];
  }
  const labels = words
    .map((word) => word.toLowerCase())
    .filter((word) => word.length > 2 && !ENGLISH_STOP_WORDS.has(word));
  return Array.from(new Set(labels)).slice(0, 8);
}
