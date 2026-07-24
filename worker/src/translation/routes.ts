import { z } from "zod";

import { getAiConfig } from "../admin/routes";
import { requireUser } from "../auth/routes";
import { all, boolFromDb, boolToDb, first, insertAndReturnId, nowIso, type Row } from "../db/d1";
import type { Env } from "../env";
import { HttpError, json, parseJson, route, type Route } from "../http";
import { aiTranslationModel, completeChatWithUsage, isAiConfigured } from "../ai/client";
import { withMathMarkdownProtocol } from "../ai/prompting";
import { scheduleTokenUsage } from "../ai/usage";
import {
  DEFAULT_TRANSLATION_PROMPT,
  TRANSLATION_INPUT_LIMIT,
  TRANSLATION_LIMIT_MESSAGE,
  TRANSLATION_PROMPT_PREFIX,
  buildTranslationUserPrompt,
  buildWordDetailUserPrompt,
  correctedWordFromMarkdown,
  detectSourceKind,
  extractCanonicalWordAndMarkdown,
  extractPhoneticAndMarkdown,
  fallbackTranslation,
  isNormalizedWord,
  isFallbackTranslationMarkdown,
  isThinDictionaryMarkdown,
  labelsForWordCloud,
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

const wordCloudReviewSchema = z.object({
  key: z.string().min(1).max(TRANSLATION_INPUT_LIMIT + 16),
  entry_id: z.number().int().positive()
});

type WordCloudSourceRow = Row & {
  id: number;
  source_text: string;
  source_kind: SourceKind;
  created_at: string;
};

type WordCloudReviewRow = Row & {
  item_key: string;
  reviewed_at: string;
};

type WordCloudCandidate = {
  key: string;
  label: string;
  count: number;
  recentCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  representativeId: number;
  representativeKind: SourceKind;
  lastReviewedAt: string | null;
};

type WordCloudReason = "recent" | "overdue" | "weak" | "explore";

const WORD_CLOUD_LIMIT = 40;
const DAY_MS = 24 * 60 * 60 * 1000;

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

async function generateWordDetail(
  env: Env,
  userId: number,
  text: string,
  signal?: AbortSignal,
  ctx?: ExecutionContext
): Promise<{ sourceText: string; phonetic: string | null; resultMarkdown: string } | null> {
  const cached = await findCachedWordDetail(env, text);
  if (cached) {
    return { sourceText: cached.source_text, phonetic: cached.phonetic, resultMarkdown: cached.result_markdown };
  }

  const aiConfig = await getAiConfig(env);
  const fallback = fallbackTranslation(text, "word");
  let result: string;
  try {
    const model = aiTranslationModel(aiConfig);
    const response = await completeChatWithUsage(
      withMathMarkdownProtocol([
        { role: "system", content: await getTranslationPrompt(env, userId) },
        { role: "user", content: buildWordDetailUserPrompt(text) }
      ]),
      model,
      fallback,
      env,
      aiConfig,
      signal ? { signal } : {}
    );
    await scheduleTokenUsage(ctx, env, userId, aiConfig, response.model, response.totalTokens);
    result = response.content;
  } catch {
    result = fallback;
  }

  if (isFallbackTranslationMarkdown(result)) {
    return null;
  }

  const canonical = extractCanonicalWordAndMarkdown(result);
  const correctedText = canonical.canonicalWord && isNormalizedWord(canonical.canonicalWord) ? canonical.canonicalWord : text;
  const extracted = extractPhoneticAndMarkdown(canonical.markdown);
  await saveCachedWordDetail(env, correctedText, extracted.phonetic, extracted.markdown);
  if (correctedText !== text) {
    await deleteCachedWordDetail(env, text);
  }
  return { sourceText: correctedText, phonetic: extracted.phonetic, resultMarkdown: extracted.markdown };
}

async function completeWordDetail(env: Env, entry: TranslationEntryRow): Promise<void> {
  if (entry.source_kind !== "word" || entry.detail_status === "ready") {
    return;
  }
  const text = normalizeWord(entry.source_text);
  if (!text) {
    await env.DB.prepare("UPDATE translation_entries SET detail_status = 'failed' WHERE id = ?").bind(entry.id).run();
    return;
  }

  await env.DB.prepare("UPDATE translation_entries SET detail_status = 'processing' WHERE id = ? AND detail_status != 'ready'")
    .bind(entry.id)
    .run();
  const detail = await generateWordDetail(env, entry.user_id, text);
  if (!detail) {
    await env.DB.prepare("UPDATE translation_entries SET detail_status = 'failed' WHERE id = ?").bind(entry.id).run();
    return;
  }
  await env.DB.prepare(
    `UPDATE translation_entries
     SET source_text = ?, phonetic = ?, result_markdown = ?, detail_status = 'ready'
     WHERE id = ?`
  )
    .bind(detail.sourceText, detail.phonetic, detail.resultMarkdown, entry.id)
    .run();
}

export async function processQueuedWordDetails(env: Env, limit = 10): Promise<void> {
  const entries = await all<TranslationEntryRow>(
    env.DB.prepare(
      `SELECT * FROM translation_entries
       WHERE source_kind = 'word' AND detail_status IN ('queued', 'processing')
       ORDER BY created_at ASC, id ASC
       LIMIT ?`
    ).bind(limit)
  );
  for (const entry of entries) {
    try {
      await completeWordDetail(env, entry);
    } catch (error) {
      console.error("Queued word detail failed", {
        entryId: entry.id,
        message: error instanceof Error ? error.message : String(error)
      });
      await env.DB.prepare("UPDATE translation_entries SET detail_status = 'failed' WHERE id = ?").bind(entry.id).run();
    }
  }
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

function stableWordCloudHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function chooseWordCloudCandidates(
  candidates: WordCloudCandidate[],
  userId: number,
  now: Date,
  dayKey: string
): Array<WordCloudCandidate & { reason: WordCloudReason }> {
  const selected = new Map<string, WordCloudCandidate & { reason: WordCloudReason }>();
  const add = (items: WordCloudCandidate[], limit: number, reason: WordCloudReason) => {
    for (const item of items) {
      if (selected.size >= WORD_CLOUD_LIMIT || limit <= 0) break;
      if (selected.has(item.key)) continue;
      selected.set(item.key, { ...item, reason });
      limit -= 1;
    }
  };
  const reviewTime = (item: WordCloudCandidate) => Date.parse(item.lastReviewedAt || item.lastSeenAt);
  const coolingCutoff = now.getTime() - 2 * DAY_MS;
  const eligible = candidates.filter(
    (item) => !item.lastReviewedAt || Date.parse(item.lastReviewedAt) < coolingCutoff
  );
  const recent = [...eligible]
    .filter((item) => item.recentCount > 0)
    .sort(
      (left, right) =>
        right.recentCount - left.recentCount ||
        right.count - left.count ||
        Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt)
    );
  const overdue = [...eligible].sort(
    (left, right) => reviewTime(left) - reviewTime(right) || right.count - left.count
  );
  const weak = [...eligible].sort(
    (left, right) => left.count - right.count || reviewTime(left) - reviewTime(right)
  );
  const dailySeed = `${userId}:${dayKey}:`;
  const explore = [...eligible].sort(
    (left, right) => stableWordCloudHash(dailySeed + left.key) - stableWordCloudHash(dailySeed + right.key)
  );

  add(recent, 16, "recent");
  add(overdue, 14, "overdue");
  add(weak, 6, "weak");
  add(explore, 4, "explore");
  if (selected.size < Math.min(WORD_CLOUD_LIMIT, eligible.length)) {
    add(overdue, WORD_CLOUD_LIMIT - selected.size, "overdue");
  }
  if (selected.size < Math.min(WORD_CLOUD_LIMIT, candidates.length)) {
    add([...candidates].sort((left, right) => reviewTime(left) - reviewTime(right)), WORD_CLOUD_LIMIT - selected.size, "overdue");
  }
  return Array.from(selected.values());
}

async function listWordCloud(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  const now = new Date();
  const dayKey = new Intl.DateTimeFormat("en-CA", {
    timeZone: env.APP_TIMEZONE || "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(now);
  const recentCutoff = now.getTime() - 30 * DAY_MS;
  const [sources, reviews] = await Promise.all([
    all<WordCloudSourceRow>(
      env.DB.prepare(
        `SELECT id, source_text, source_kind, created_at
         FROM translation_entries
         WHERE user_id = ? AND is_auto_detail = 0 AND source_kind IN ('word', 'english')
         ORDER BY id ASC`
      ).bind(user.id)
    ),
    all<WordCloudReviewRow>(
      env.DB.prepare(
        "SELECT item_key, reviewed_at FROM translation_word_reviews WHERE user_id = ?"
      ).bind(user.id)
    )
  ]);
  const reviewTimes = new Map(reviews.map((row) => [row.item_key, row.reviewed_at]));
  const candidates = new Map<string, WordCloudCandidate>();
  for (const source of sources) {
    const sourceTime = Date.parse(source.created_at);
    for (const label of labelsForWordCloud(source.source_text, source.source_kind)) {
      const existing = candidates.get(label.key);
      if (!existing) {
        candidates.set(label.key, {
          ...label,
          count: 1,
          recentCount: sourceTime >= recentCutoff ? 1 : 0,
          firstSeenAt: source.created_at,
          lastSeenAt: source.created_at,
          representativeId: source.id,
          representativeKind: source.source_kind,
          lastReviewedAt: reviewTimes.get(label.key) || null
        });
        continue;
      }
      existing.count += 1;
      if (sourceTime >= recentCutoff) existing.recentCount += 1;
      if (sourceTime < Date.parse(existing.firstSeenAt)) existing.firstSeenAt = source.created_at;
      if (sourceTime > Date.parse(existing.lastSeenAt)) existing.lastSeenAt = source.created_at;
      if (
        (source.source_kind === "word" && existing.representativeKind !== "word") ||
        (source.source_kind === existing.representativeKind && source.id > existing.representativeId)
      ) {
        existing.representativeId = source.id;
        existing.representativeKind = source.source_kind;
      }
    }
  }

  const selected = chooseWordCloudCandidates(Array.from(candidates.values()), user.id, now, dayKey);
  if (!selected.length) return json([]);

  const wordLabels = selected.filter((item) => item.key.startsWith("word:")).map((item) => item.label);
  if (wordLabels.length) {
    const placeholders = wordLabels.map(() => "?").join(", ");
    const details = await all<TranslationEntryRow>(
      env.DB.prepare(
        `SELECT * FROM translation_entries
         WHERE user_id = ? AND source_kind = 'word' AND lower(source_text) IN (${placeholders})
         ORDER BY is_auto_detail ASC, created_at DESC, id DESC`
      ).bind(user.id, ...wordLabels)
    );
    const detailByLabel = new Map<string, TranslationEntryRow>();
    for (const detail of details) {
      const key = detail.source_text.toLowerCase();
      if (!detailByLabel.has(key)) detailByLabel.set(key, detail);
    }
    for (const item of selected) {
      const detail = detailByLabel.get(item.label.toLowerCase());
      if (detail) item.representativeId = detail.id;
    }
  }

  const ids = Array.from(new Set(selected.map((item) => item.representativeId)));
  const placeholders = ids.map(() => "?").join(", ");
  const entries = await all<TranslationEntryRow>(
    env.DB.prepare(`SELECT * FROM translation_entries WHERE user_id = ? AND id IN (${placeholders})`).bind(user.id, ...ids)
  );
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  const counts = selected.map((item) => item.count);
  const minCount = Math.min(...counts);
  const maxCount = Math.max(...counts);
  const spread = maxCount - minCount;
  return json(
    selected.map((item) => ({
      key: item.key,
      label: item.label,
      count: item.count,
      weight: spread ? 1 + Math.round(((item.count - minCount) / spread) * 4) : 3,
      reason: item.reason,
      first_seen_at: item.firstSeenAt,
      last_seen_at: item.lastSeenAt,
      last_reviewed_at: item.lastReviewedAt,
      entry: entryResponse(entriesById.get(item.representativeId)!)
    }))
  );
}

async function reviewWordCloudItem(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  const payload = wordCloudReviewSchema.parse(await parseJson<unknown>(request));
  const entry = await first<TranslationEntryRow>(
    env.DB.prepare("SELECT * FROM translation_entries WHERE id = ? AND user_id = ?").bind(payload.entry_id, user.id)
  );
  if (!entry || !labelsForWordCloud(entry.source_text, entry.source_kind).some((item) => item.key === payload.key)) {
    throw new HttpError(404, "词条不存在");
  }
  const reviewedAt = nowIso();
  await env.DB.prepare(
    `INSERT INTO translation_word_reviews (user_id, item_key, entry_id, reviewed_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, item_key) DO UPDATE SET
       entry_id = excluded.entry_id,
       reviewed_at = excluded.reviewed_at`
  )
    .bind(user.id, payload.key, entry.id, reviewedAt)
    .run();
  return json({ reviewed_at: reviewedAt });
}

async function clearEntries(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM translation_word_reviews WHERE user_id = ?").bind(user.id),
    env.DB.prepare("DELETE FROM translation_entries WHERE user_id = ?").bind(user.id)
  ]);
  return json({ status: "ok" });
}

async function dictionaryEntry(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const user = await requireUser(request, env);
  const payload = translationSchema.parse(await parseJson<unknown>(request));
  const entry = await queueWordDetail(env, user.id, payload.text, true);
  if (entry.detail_status === "queued") {
    ctx?.waitUntil(processQueuedWordDetails(env, 3));
  }
  return json(entryResponse(entry));
}

async function translate(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
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
    const aiConfig = await getAiConfig(env);
    if (!isAiConfigured(aiConfig)) {
      const extracted = extractPhoneticAndMarkdown(fallbackTranslation(text, sourceKind));
      const entry = await insertEntry(env, {
        userId: user.id,
        sourceText: text,
        sourceKind,
        phonetic: extracted.phonetic,
        resultMarkdown: extracted.markdown,
        detailStatus: "ready",
        isAutoDetail: false
      });
      return json(entryResponse(entry));
    }
    const detail = await generateWordDetail(env, user.id, text, request.signal, ctx);
    if (!detail) {
      const extracted = extractPhoneticAndMarkdown(fallbackTranslation(text, sourceKind));
      const entry = await insertEntry(env, {
        userId: user.id,
        sourceText: text,
        sourceKind,
        phonetic: extracted.phonetic,
        resultMarkdown: extracted.markdown,
        detailStatus: "ready",
        isAutoDetail: false
      });
      return json(entryResponse(entry));
    }
    const entry = await insertEntry(env, {
      userId: user.id,
      sourceText: detail.sourceText,
      sourceKind,
      phonetic: detail.phonetic,
      resultMarkdown: detail.resultMarkdown,
      detailStatus: "ready",
      isAutoDetail: false
    });
    return json(entryResponse(entry));
  }
  const fallback = fallbackTranslation(text, sourceKind);
  const aiConfig = await getAiConfig(env);
  let result: string;
  try {
    const model = aiTranslationModel(aiConfig);
    const response = await completeChatWithUsage(
      withMathMarkdownProtocol([
        { role: "system", content: await getTranslationPrompt(env, user.id) },
        { role: "user", content: buildTranslationUserPrompt(text, sourceKind) }
      ]),
      model,
      fallback,
      env,
      aiConfig,
      { signal: request.signal }
    );
    await scheduleTokenUsage(ctx, env, user.id, aiConfig, response.model, response.totalTokens);
    result = response.content;
  } catch {
    result = fallback;
  }
  const extracted = extractPhoneticAndMarkdown(result);
  const entry = await insertEntry(env, {
    userId: user.id,
    sourceText: text,
    sourceKind,
    phonetic: extracted.phonetic,
    resultMarkdown: extracted.markdown,
    detailStatus: "ready",
    isAutoDetail: false
  });

  if (sourceKind === "english") {
    const task = (async () => {
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
    })();
    if (ctx) {
      ctx.waitUntil(task.catch((error) => {
        console.error("Automatic word extraction failed", {
          userId: user.id,
          message: error instanceof Error ? error.message : String(error)
        });
      }));
    } else {
      await task;
    }
  }

  return json(entryResponse(entry));
}

export function translationRoutes(env: Env): Route[] {
  return [
    route("GET", "/api/translation/prompt", (request) => readPrompt(request, env)),
    route("PUT", "/api/translation/prompt", (request) => updatePrompt(request, env)),
    route("GET", "/api/translation/word-cloud", (request) => listWordCloud(request, env)),
    route("POST", "/api/translation/word-cloud/review", (request) => reviewWordCloudItem(request, env)),
    route("GET", "/api/translation/entries", (request) => listEntries(request, env)),
    route("DELETE", "/api/translation/entries", (request) => clearEntries(request, env)),
    route("POST", "/api/translation/dictionary-entry", (request, _params, ctx) => dictionaryEntry(request, env, ctx)),
    route("POST", "/api/translation", (request, _params, ctx) => translate(request, env, ctx))
  ];
}
