import { z } from "zod";

import { getAiConfig } from "../admin/routes";
import { requireUser } from "../auth/routes";
import { all, boolFromDb, boolToDb, first, insertAndReturnId, nowIso, type Row } from "../db/d1";
import type { Env } from "../env";
import { HttpError, json, parseJson, route, type Route } from "../http";
import { completeChat } from "../ai/client";
import {
  DEFAULT_TRANSLATION_PROMPT,
  TRANSLATION_INPUT_LIMIT,
  TRANSLATION_LIMIT_MESSAGE,
  TRANSLATION_PROMPT_PREFIX,
  buildTranslationUserPrompt,
  correctedWordFromMarkdown,
  detectSourceKind,
  extractCanonicalWordAndMarkdown,
  extractPhoneticAndMarkdown,
  fallbackTranslation,
  isNormalizedWord,
  isFallbackTranslationMarkdown,
  isThinDictionaryMarkdown,
  labelsForAutoWordDetails,
  normalizeWord,
  type SourceKind
} from "./service";

type TranslationEntryRow = Row & {
  id: number;
  user_id: number;
  source_text: string;
  source_kind: SourceKind;
  phonetic: string | null;
  result_markdown: string;
  detail_status: "queued" | "processing" | "ready" | "failed";
  is_auto_detail: number;
  created_at: string;
};

type DictionaryEntryRow = Row & {
  id: number;
  source_text: string;
  phonetic: string | null;
  result_markdown: string;
  created_at: string;
  updated_at: string;
};

const promptSchema = z.object({
  system_prompt: z.string().max(5000)
});

const translationSchema = z.object({
  text: z.string().min(1)
});

function entryResponse(entry: TranslationEntryRow): Record<string, unknown> {
  return {
    id: entry.id,
    source_text: entry.source_text,
    source_kind: entry.source_kind,
    phonetic: entry.phonetic,
    result_markdown: entry.result_markdown,
    detail_status: entry.detail_status,
    is_auto_detail: boolFromDb(entry.is_auto_detail),
    created_at: entry.created_at
  };
}

async function getSetting(env: Env, key: string): Promise<string> {
  const row = await first<Row & { value: string }>(env.DB.prepare("SELECT value FROM app_settings WHERE key = ?").bind(key));
  return row?.value || "";
}

async function setSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  )
    .bind(key, value, nowIso())
    .run();
}

async function getTranslationPrompt(env: Env, userId: number): Promise<string> {
  return (await getSetting(env, `${TRANSLATION_PROMPT_PREFIX}${userId}`)).trim() || DEFAULT_TRANSLATION_PROMPT;
}

async function getEntry(env: Env, id: number): Promise<TranslationEntryRow | null> {
  return await first<TranslationEntryRow>(env.DB.prepare("SELECT * FROM translation_entries WHERE id = ?").bind(id));
}

async function findCachedWordDetail(env: Env, sourceText: string): Promise<DictionaryEntryRow | null> {
  const normalized = normalizeWord(sourceText);
  if (!normalized) {
    return null;
  }
  const entry = await first<DictionaryEntryRow>(
    env.DB.prepare("SELECT * FROM translation_dictionary_entries WHERE source_text = ?").bind(normalized)
  );
  if (
    !entry?.phonetic?.trim() ||
    !entry.result_markdown.trim() ||
    isThinDictionaryMarkdown(entry.result_markdown) ||
    isFallbackTranslationMarkdown(entry.result_markdown)
  ) {
    return null;
  }
  const correctedWord = correctedWordFromMarkdown(entry.result_markdown);
  if (correctedWord && correctedWord !== normalized) {
    return null;
  }
  return entry;
}

async function saveCachedWordDetail(env: Env, sourceText: string, phonetic: string | null, markdown: string): Promise<void> {
  const normalized = normalizeWord(sourceText);
  const resultMarkdown = markdown.trim();
  if (!normalized || !resultMarkdown || isThinDictionaryMarkdown(resultMarkdown) || isFallbackTranslationMarkdown(resultMarkdown)) {
    return;
  }
  await env.DB.prepare(
    `INSERT INTO translation_dictionary_entries (source_text, phonetic, result_markdown, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(source_text) DO UPDATE SET
       phonetic = COALESCE(excluded.phonetic, translation_dictionary_entries.phonetic),
       result_markdown = excluded.result_markdown,
       updated_at = excluded.updated_at`
  )
    .bind(normalized, phonetic, resultMarkdown, nowIso(), nowIso())
    .run();
}

async function deleteCachedWordDetail(env: Env, sourceText: string): Promise<void> {
  const normalized = normalizeWord(sourceText);
  if (!normalized) {
    return;
  }
  await env.DB.prepare("DELETE FROM translation_dictionary_entries WHERE source_text = ?").bind(normalized).run();
}

async function insertEntry(
  env: Env,
  values: {
    userId: number;
    sourceText: string;
    sourceKind: SourceKind;
    phonetic: string | null;
    resultMarkdown: string;
    detailStatus: "queued" | "processing" | "ready" | "failed";
    isAutoDetail: boolean;
  }
): Promise<TranslationEntryRow> {
  const result = await env.DB.prepare(
    `INSERT INTO translation_entries
       (user_id, source_text, source_kind, phonetic, result_markdown, detail_status, is_auto_detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      values.userId,
      values.sourceText,
      values.sourceKind,
      values.phonetic,
      values.resultMarkdown,
      values.detailStatus,
      boolToDb(values.isAutoDetail),
      nowIso()
    )
    .run();
  const entry = await getEntry(env, await insertAndReturnId(result));
  if (!entry) {
    throw new HttpError(500, "服务器内部错误");
  }
  return entry;
}

async function queueWordDetail(env: Env, userId: number, text: string, isAutoDetail: boolean): Promise<TranslationEntryRow> {
  const sourceText = normalizeWord(text);
  const cached = await findCachedWordDetail(env, sourceText);
  return await insertEntry(env, {
    userId,
    sourceText,
    sourceKind: "word",
    phonetic: cached?.phonetic || null,
    resultMarkdown: cached?.result_markdown || "",
    detailStatus: cached ? "ready" : "queued",
    isAutoDetail
  });
}

async function readPrompt(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  return json({ system_prompt: await getTranslationPrompt(env, user.id) });
}

async function updatePrompt(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  const payload = promptSchema.parse(await parseJson<unknown>(request));
  const value = payload.system_prompt.trim() || DEFAULT_TRANSLATION_PROMPT;
  await setSetting(env, `${TRANSLATION_PROMPT_PREFIX}${user.id}`, value);
  return json({ system_prompt: value });
}

async function listEntries(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  const entries = await all<TranslationEntryRow>(
    env.DB.prepare(
      "SELECT * FROM translation_entries WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 30"
    ).bind(user.id)
  );
  return json(entries.map(entryResponse));
}

async function clearEntries(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  await env.DB.prepare("DELETE FROM translation_entries WHERE user_id = ?").bind(user.id).run();
  return json({ status: "ok" });
}

async function dictionaryEntry(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  const payload = translationSchema.parse(await parseJson<unknown>(request));
  const entry = await queueWordDetail(env, user.id, payload.text, true);
  return json(entryResponse(entry));
}

async function translate(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  const payload = translationSchema.parse(await parseJson<unknown>(request));
  if (payload.text.length > TRANSLATION_INPUT_LIMIT) {
    throw new HttpError(400, TRANSLATION_LIMIT_MESSAGE);
  }
  let text = payload.text.trim();
  const sourceKind = detectSourceKind(text);
  if (sourceKind === "word") {
    text = normalizeWord(text);
  }

  const fallback = fallbackTranslation(text, sourceKind);
  const aiConfig = await getAiConfig(env);
  if (sourceKind === "word") {
    const cached = await findCachedWordDetail(env, text);
    if (cached) {
      const entry = await insertEntry(env, {
        userId: user.id,
        sourceText: text,
        sourceKind,
        phonetic: cached.phonetic,
        resultMarkdown: cached.result_markdown,
        detailStatus: "ready",
        isAutoDetail: false
      });
      return json(entryResponse(entry));
    }
  }
  let result: string;
  try {
    result = await completeChat(
      [
        { role: "system", content: await getTranslationPrompt(env, user.id) },
        { role: "user", content: buildTranslationUserPrompt(text, sourceKind) }
      ],
      env.AI_DEFAULT_MODEL,
      fallback,
      env,
      aiConfig
    );
  } catch {
    result = fallback;
  }
  const canonical = sourceKind === "word" ? extractCanonicalWordAndMarkdown(result) : { canonicalWord: null, markdown: result };
  const correctedText = canonical.canonicalWord && isNormalizedWord(canonical.canonicalWord) ? canonical.canonicalWord : text;
  const extracted = extractPhoneticAndMarkdown(canonical.markdown);
  if (sourceKind === "word") {
    await saveCachedWordDetail(env, correctedText, extracted.phonetic, extracted.markdown);
    if (correctedText !== text) {
      await deleteCachedWordDetail(env, text);
    }
  }
  const entry = await insertEntry(env, {
    userId: user.id,
    sourceText: correctedText,
    sourceKind,
    phonetic: extracted.phonetic,
    resultMarkdown: extracted.markdown,
    detailStatus: "ready",
    isAutoDetail: false
  });

  if (sourceKind === "english") {
    const existingRows = await all<Row & { source_text: string }>(
      env.DB.prepare("SELECT source_text FROM translation_entries WHERE user_id = ? AND source_kind = 'word'").bind(user.id)
    );
    const existing = new Set(existingRows.map((row) => row.source_text.toLowerCase()));
    for (const label of labelsForAutoWordDetails(text)) {
      if (existing.has(label)) {
        continue;
      }
      await queueWordDetail(env, user.id, label, true);
      existing.add(label);
    }
  }

  return json(entryResponse(entry));
}

export function translationRoutes(env: Env): Route[] {
  return [
    route("GET", "/api/translation/prompt", (request) => readPrompt(request, env)),
    route("PUT", "/api/translation/prompt", (request) => updatePrompt(request, env)),
    route("GET", "/api/translation/entries", (request) => listEntries(request, env)),
    route("DELETE", "/api/translation/entries", (request) => clearEntries(request, env)),
    route("POST", "/api/translation/dictionary-entry", (request) => dictionaryEntry(request, env)),
    route("POST", "/api/translation", (request) => translate(request, env))
  ];
}
