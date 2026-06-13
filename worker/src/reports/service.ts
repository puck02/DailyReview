import { all, first, nowIso, type Row } from "../db/d1";
import type { Env } from "../env";
import { HttpError } from "../http";
import { getAiConfig } from "../admin/routes";
import { completeChat, isAiConfigured } from "../ai/client";

export const PDF_DOWNGRADE_MESSAGE = "Cloudflare Workers 部署暂不支持 PDF 导出，请先查看 Markdown 报告。";

type UserRow = Row & {
  id: number;
};

type MessageRow = Row & {
  id: number;
  session_id: number;
  role: string;
  content: string;
  created_at: string;
};

export type ReportRow = Row & {
  id: number;
  user_id: number;
  report_type: "daily" | "weekly" | "monthly";
  period: string;
  markdown_key: string;
  html_key: string | null;
  stats_json: string;
  created_at: string;
};

function parseDate(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function timeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const localAsUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second)
  );
  return localAsUtc - date.getTime();
}

function zonedLocalTimeToUtc(localTime: string, timeZone: string): Date {
  let result = new Date(`${localTime}Z`);
  for (let index = 0; index < 3; index += 1) {
    result = new Date(Date.parse(`${localTime}Z`) - timeZoneOffsetMs(result, timeZone));
  }
  return result;
}

function dayBounds(day: string, timeZone: string): { start: string; end: string } {
  const start = zonedLocalTimeToUtc(`${day}T00:00:00.000`, timeZone);
  const endLocal = formatDate(addDays(parseDate(day), 1));
  const end = zonedLocalTimeToUtc(`${endLocal}T00:00:00.000`, timeZone);
  return { start: start.toISOString(), end: end.toISOString() };
}

function mondayOfWeek(day: Date): Date {
  const result = new Date(day);
  const dayOfWeek = result.getUTCDay() || 7;
  result.setUTCDate(result.getUTCDate() - dayOfWeek + 1);
  return result;
}

function isoWeekPeriod(day: Date): string {
  const date = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
  const dayNumber = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNumber);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function reportKey(userId: number, reportType: string, period: string): string {
  const year = period.slice(0, 4);
  if (reportType === "daily") {
    return `reports/user-${userId}/daily/${year}/${period.slice(5, 7)}/${period}.md`;
  }
  return `reports/user-${userId}/${reportType}/${year}/${period}.md`;
}

function stats(report: ReportRow): Record<string, unknown> {
  try {
    return JSON.parse(report.stats_json || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function reportListItem(report: ReportRow): Record<string, unknown> {
  return {
    id: report.id,
    report_type: report.report_type,
    period: report.period,
    stats: stats(report),
    created_at: report.created_at
  };
}

export async function readReportMarkdown(env: Env, report: ReportRow): Promise<string> {
  const object = await env.BUCKET.get(report.markdown_key);
  if (!object) {
    return "";
  }
  if ("text" in object && typeof object.text === "function") {
    return await object.text();
  }
  return await new Response(object.body).text();
}

export async function reportContent(env: Env, report: ReportRow): Promise<Record<string, unknown>> {
  return {
    ...reportListItem(report),
    markdown: await readReportMarkdown(env, report)
  };
}

export async function reportById(env: Env, id: number): Promise<ReportRow | null> {
  return await first<ReportRow>(env.DB.prepare("SELECT * FROM reports WHERE id = ?").bind(id));
}

async function writeReport(
  env: Env,
  userId: number,
  reportType: "daily" | "weekly" | "monthly",
  period: string,
  markdown: string,
  reportStats: Record<string, unknown>
): Promise<ReportRow> {
  const key = reportKey(userId, reportType, period);
  await env.BUCKET.put(key, markdown, { httpMetadata: { contentType: "text/markdown; charset=utf-8" } });
  await env.DB.prepare(
    `INSERT INTO reports (user_id, report_type, period, markdown_key, html_key, stats_json, created_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?)
     ON CONFLICT(user_id, report_type, period) DO UPDATE SET
       markdown_key = excluded.markdown_key,
       stats_json = excluded.stats_json,
       created_at = excluded.created_at`
  )
    .bind(userId, reportType, period, key, JSON.stringify(reportStats), nowIso())
    .run();
  const report = await first<ReportRow>(
    env.DB.prepare("SELECT * FROM reports WHERE user_id = ? AND report_type = ? AND period = ?").bind(userId, reportType, period)
  );
  if (!report) {
    throw new HttpError(500, "服务器内部错误");
  }
  return report;
}

async function messagesForDay(env: Env, userId: number, day: string): Promise<MessageRow[]> {
  const { start, end } = dayBounds(day, env.APP_TIMEZONE || "UTC");
  return await all<MessageRow>(
    env.DB.prepare(
      `SELECT m.*
       FROM messages m
       JOIN chat_sessions s ON m.session_id = s.id
       WHERE s.user_id = ?
         AND s.is_archived = 0
         AND m.created_at >= ?
         AND m.created_at < ?
       ORDER BY m.created_at ASC, m.id ASC`
    ).bind(userId, start, end)
  );
}

function renderConversation(messages: MessageRow[]): string {
  return messages
    .filter((message) => message.content.trim())
    .map((message) => `${message.role}: ${message.content}`)
    .join("\n");
}

type LearningSegment = {
  user: string;
  assistant: string;
};

type LearningEvent = {
  subject: string;
  topic: string;
  question: string;
  insight: string;
  misconception: string;
  memory: string;
  value_score: number;
  evidence: string;
};

const STUDY_INCLUDE_PATTERNS = [
  /考研|英语一|英语二|长难句|阅读理解|完形|翻译|作文|词汇|单词|语法|真题|复习|背诵|例句|音标|词根|词缀|派生|近义|反义/,
  /数学|高数|线代|概率|极限|导数|微分|积分|矩阵|特征值|函数|级数|方程|证明|定理|公式|错题|题型|解题/,
  /可积|有界|无界|连续|间断|收敛|发散|单调|必要条件|充分条件|反例|洛必达|换元|根号/,
  /\b(?:word|vocabulary|grammar|sentence|translation|reading|writing|essay|derivative|limit|integral|matrix|probability)\b/i
];

const STUDY_EXCLUDE_PATTERNS = [
  /部署|服务器|Cloudflare|Worker|wrangler|token|登录|报错|缓存|域名|GitHub|commit|push|branch|README|接口|数据库|D1|R2/i,
  /冒泡排序|排序模板|代码|编程|C\+\+|Python|JavaScript|TypeScript|React|CSS|HTML|vector|include|bubbleSort|function|const|class|npm/i,
  /傻逼|操|卧槽|他妈/
];

function isStudyMessage(message: MessageRow): boolean {
  const content = message.content.trim();
  if (!content) {
    return false;
  }
  if (STUDY_EXCLUDE_PATTERNS.some((pattern) => pattern.test(content))) {
    return STUDY_INCLUDE_PATTERNS.some((pattern) => pattern.test(content)) && content.length >= 12;
  }
  return STUDY_INCLUDE_PATTERNS.some((pattern) => pattern.test(content));
}

function studyMessages(messages: MessageRow[]): MessageRow[] {
  return messages.filter(isStudyMessage);
}

function learningSegments(messages: MessageRow[]): LearningSegment[] {
  const segments: LearningSegment[] = [];
  const sorted = [...messages].sort((left, right) =>
    left.session_id === right.session_id
      ? left.created_at.localeCompare(right.created_at) || left.id - right.id
      : left.session_id - right.session_id
  );
  for (let index = 0; index < sorted.length; index += 1) {
    const message = sorted[index];
    if (!message || message.role !== "user" || !message.content.trim()) {
      continue;
    }
    const assistant = sorted
      .slice(index + 1)
      .find((candidate) => candidate.session_id === message.session_id && candidate.role === "assistant" && candidate.content.trim());
    segments.push({ user: message.content.trim(), assistant: assistant?.content.trim() || "" });
  }
  return segments;
}

function studySegments(segments: LearningSegment[]): LearningSegment[] {
  return segments.filter((segment) => {
    const combined = `${segment.user}\n${segment.assistant}`;
    return isStudyMessage({ id: 0, session_id: 0, role: "user", content: combined, created_at: "" });
  });
}

function renderSegments(segments: LearningSegment[]): string {
  return segments
    .map((segment, index) => [`片段 ${index + 1}`, `用户问题：${segment.user}`, `AI回答：${segment.assistant || "无"}`].join("\n"))
    .join("\n\n");
}

export function extractKeywords(text: string, limit = 8): string[] {
  const matches = text.match(/[\u4e00-\u9fa5]{2,}|[A-Za-z][A-Za-z0-9_+-]{2,}/g) || [];
  const ignored = new Set([
    "assistant",
    "user",
    "今天",
    "学习",
    "解释",
    "这个",
    "一个",
    "什么",
    "如何",
    "用于",
    "for",
    "int",
    "const",
    "function",
    "include",
    "vector",
    "swapped",
    "cpp",
    "cloudflare",
    "worker",
    "部署"
  ]);
  const counts = new Map<string, number>();
  for (const word of matches) {
    const key = word.toLowerCase();
    if (ignored.has(key)) {
      continue;
    }
    counts.set(word, (counts.get(word) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([word]) => word);
}

const DAILY_REPORT_MAX_CHARS = 1800;
const DAILY_REPORT_SECTION_ITEM_LIMIT = 4;
const LEARNING_EVENT_LIMIT = 12;

function compactDailyMarkdown(markdown: string): string {
  if (markdown.length <= DAILY_REPORT_MAX_CHARS) {
    return markdown;
  }
  const compacted: string[] = [];
  let itemCount = 0;
  let inSection = false;
  for (const line of markdown.split("\n")) {
    const stripped = line.trim();
    if (stripped.startsWith("#")) {
      compacted.push(stripped);
      inSection = stripped.startsWith("## ");
      itemCount = 0;
      continue;
    }
    if (!stripped) {
      continue;
    }
    if (!inSection) {
      compacted.push(stripped.slice(0, 120));
      continue;
    }
    if (itemCount >= DAILY_REPORT_SECTION_ITEM_LIMIT) {
      continue;
    }
    compacted.push(stripped.length > 140 ? `${stripped.slice(0, 140)}...` : stripped);
    itemCount += 1;
  }
  let result = compacted.join("\n");
  if (result.length > DAILY_REPORT_MAX_CHARS) {
    result = result.slice(0, DAILY_REPORT_MAX_CHARS - 34).trimEnd();
  }
  return `${result}\n\n> 内容已按日报篇幅要求压缩。`;
}

function fallbackDailyMarkdown(day: string, conversation: string, keywords: string[]): string {
  const highlights = keywords.slice(0, 6).map((keyword) => `- ${keyword}`).join("\n") || "- 今日有效学习内容较少";
  const evidence = conversation.split("\n").find((line) => line.trim())?.slice(0, 120) || "今日有效学习材料不足";
  return `# ${day} 学习日报

## 今天最大的收获
- ${evidence}

## 今天修正的误解
- 今日没有足够明确的误解修正记录。

## 核心知识
${highlights}

## 一句话记忆
- 只记住今天真正形成的新理解。

## 明日建议
- 明天先复述今天最重要的一条认知，再用题目验证。
`;
}

function safeJsonArray(text: string): unknown[] {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() || trimmed;
  try {
    const parsed = JSON.parse(candidate) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    const start = candidate.indexOf("[");
    const end = candidate.lastIndexOf("]");
    if (start === -1 || end <= start) {
      return [];
    }
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1)) as unknown;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
}

function normalizeLearningEvent(value: unknown): LearningEvent | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const source = value as Record<string, unknown>;
  const insight = String(source.insight || "").trim();
  const topic = String(source.topic || "").trim();
  const memory = String(source.memory || "").trim();
  const evidence = String(source.evidence || "").trim();
  const score = Number(source.value_score || 0);
  if (!insight || !topic || !memory || !evidence || score < 3) {
    return null;
  }
  const combined = [source.subject, source.topic, source.question, source.insight, source.misconception, source.memory, source.evidence]
    .map((item) => String(item || ""))
    .join("\n");
  if (!isStudyMessage({ id: 0, session_id: 0, role: "assistant", content: combined, created_at: "" })) {
    return null;
  }
  return {
    subject: String(source.subject || "学习").trim().slice(0, 20),
    topic: topic.slice(0, 80),
    question: String(source.question || "").trim().slice(0, 160),
    insight: insight.slice(0, 220),
    misconception: String(source.misconception || "").trim().slice(0, 220),
    memory: memory.slice(0, 120),
    value_score: Math.min(5, Math.max(1, Math.round(score))),
    evidence: evidence.slice(0, 220)
  };
}

function fallbackLearningEvents(segments: LearningSegment[], keywords: string[]): LearningEvent[] {
  return segments.slice(0, Math.min(LEARNING_EVENT_LIMIT, Math.max(1, segments.length))).map((segment, index) => {
    const topic = keywords[index] || keywords[0] || "今日学习重点";
    const evidence = segment.assistant || segment.user;
    return {
      subject: "学习",
      topic,
      question: segment.user.slice(0, 160),
      insight: evidence.slice(0, 220),
      misconception: "",
      memory: topic,
      value_score: 3,
      evidence: evidence.slice(0, 220)
    };
  });
}

function renderLearningEvents(events: LearningEvent[]): string {
  return events
    .map((event, index) =>
      [
        `事件 ${index + 1}`,
        `学科：${event.subject}`,
        `主题：${event.topic}`,
        `问题：${event.question}`,
        `认知增量：${event.insight}`,
        `修正误解：${event.misconception || "无明确误解"}`,
        `一句话记忆：${event.memory}`,
        `证据：${event.evidence}`,
        `价值评分：${event.value_score}`
      ].join("\n")
    )
    .join("\n\n");
}

async function extractLearningEvents(
  env: Env,
  segments: LearningSegment[],
  fallbackSegments: LearningSegment[],
  keywords: string[],
  aiConfig: Awaited<ReturnType<typeof getAiConfig>>
): Promise<LearningEvent[]> {
  if (!segments.length) {
    return [];
  }
  const prompt = `你是一名学习复盘信息抽取器。请从下面的问答片段中抽取高价值学习事件。

抽取原则：
- 只保留考研数学、考研英语或明确学习相关的内容。
- 忽略工具配置、部署、产品讨论、情绪表达和闲聊。
- 不要总结聊天过程，只抽取最终形成的认知增量。
- 同一知识点重复出现时只保留价值最高的一条。
- value_score 只允许 1-5，低于 3 的内容不要输出。
- 最多输出 ${LEARNING_EVENT_LIMIT} 条。

只输出 JSON 数组，不要输出 Markdown，不要输出代码块。每项字段必须是：
subject, topic, question, insight, misconception, memory, value_score, evidence

关键词：${keywords.join(", ")}

问答片段：
${renderSegments(segments)}`;
  const fallback = JSON.stringify(fallbackLearningEvents(fallbackSegments, keywords));
  const response = await completeChat([{ role: "user", content: prompt }], aiConfig.report_model, fallback, env, aiConfig);
  const events = safeJsonArray(response).map(normalizeLearningEvent).filter((event): event is LearningEvent => Boolean(event));
  return events.length ? events.slice(0, LEARNING_EVENT_LIMIT) : fallbackLearningEvents(fallbackSegments, keywords);
}

async function aiDailyMarkdown(
  env: Env,
  day: string,
  events: LearningEvent[],
  keywords: string[],
  aiConfig: Awaited<ReturnType<typeof getAiConfig>>,
  rewriteInstruction = ""
): Promise<string> {
  const eventSummary = renderLearningEvents(events);
  const prompt = `你是一名学习复盘助手。

下面我会提供一天内从有效学习对话中抽取出的高价值学习事件。

你的任务不是总结聊天内容，而是帮助我进行一次高质量的学习复盘。

核心目标：
- 不要关注“今天聊了什么”。
- 要关注今天真正理解了什么、建立了哪些新认知、修正了哪些错误理解、哪些知识值得长期记忆。
- 输出应该让我在 3 分钟内回顾完今天最有价值的学习收获。

内容筛选：
- 保留学习相关内容、知识理解过程、概念辨析、思维方式变化、问题解决过程中的关键认知。
- 忽略闲聊、情绪表达、产品讨论、工具使用、环境配置、与学习无关的话题。

输出原则：
- 不要按照聊天顺序总结。
- 不要出现“用户问了”“讨论了”“聊天中提到”等过程描述。
- 必须从对话中提炼最终形成的知识和认知。
- 合并重复问题，删除推导过程中已经被否定或修正的内容。
- 优先保留一个月后仍然值得回顾的内容。
- 语言简洁、信息密度高，整篇不超过 1400 个中文字符。
- 只输出 Markdown，不要输出代码块。

必须使用这些标题：
# ${day} 学习日报
## 今天最大的收获
## 今天修正的误解
## 核心知识
## 一句话记忆
## 明日建议

格式要求：
- “今天最大的收获”提炼 1-3 条最重要的认知增量，用完整句子表达“理解了什么”。
- “今天修正的误解”只列重要误解；没有明确误解时写“今日没有足够明确的误解修正记录。”。
- “核心知识”按知识点整理，每个知识点只保留核心结论、易混点、高频考点。
- “一句话记忆”提炼 3-10 条短句，尽可能短且准确。
- “明日建议”给出 1-3 条建议，优先针对尚未完全掌握、反复易错或值得深入的内容。

${rewriteInstruction}

关键词：${keywords.join(", ")}

高价值学习事件：
${eventSummary}`;
  const fallback = fallbackDailyMarkdown(day, eventSummary, keywords);
  const markdown = await completeChat(
    [{ role: "user", content: prompt }],
    aiConfig.report_model,
    fallback,
    env,
    aiConfig
  );
  return compactDailyMarkdown(markdown);
}

type QualityReview = {
  status: "pass" | "rewrite";
  feedback: string;
};

async function reviewDailyMarkdown(
  env: Env,
  day: string,
  markdown: string,
  events: LearningEvent[],
  aiConfig: Awaited<ReturnType<typeof getAiConfig>>
): Promise<QualityReview> {
  const prompt = `请审查这份学习日报是否合格。

审查标准：
- 必须围绕高价值学习事件，而不是总结聊天过程。
- 不得出现“用户问了”“讨论了”“聊天中提到”等过程描述。
- 必须有具体知识点、误解修正或一句话记忆。
- 必须忽略部署、工具、产品、情绪和闲聊内容。
- 语言要精炼，适合 3 分钟复盘。

如果合格，只回复 PASS。
如果不合格，回复 FAIL：后面接 1-3 条具体修改意见。

日期：${day}

高价值学习事件：
${renderLearningEvents(events)}

待审查日报：
${markdown}`;
  const fallback = "PASS";
  const response = await completeChat([{ role: "user", content: prompt }], aiConfig.report_model, fallback, env, aiConfig);
  const normalized = response.trim();
  if (/^PASS\b/i.test(normalized)) {
    return { status: "pass", feedback: "" };
  }
  return { status: "rewrite", feedback: normalized.slice(0, 500) || "日报质量不合格，请重写。" };
}

export async function generateDailyReport(env: Env, userId: number, day: string): Promise<ReportRow | null> {
  const messages = await messagesForDay(env, userId, day);
  const segments = learningSegments(messages);
  const filteredSegments = studySegments(segments);
  const aiConfig = await getAiConfig(env);
  if (!segments.length || (!filteredSegments.length && !isAiConfigured(aiConfig))) {
    return null;
  }
  const filteredMessages = studyMessages(messages);
  const conversation = renderConversation(filteredMessages.length ? filteredMessages : messages);
  const keywords = extractKeywords(conversation);
  const events = await extractLearningEvents(env, isAiConfigured(aiConfig) ? segments : filteredSegments, filteredSegments, keywords, aiConfig);
  if (!events.length) {
    return null;
  }
  let markdown = await aiDailyMarkdown(env, day, events, keywords, aiConfig);
  let rewriteCount = 0;
  const review = await reviewDailyMarkdown(env, day, markdown, events, aiConfig);
  if (review.status === "rewrite") {
    rewriteCount = 1;
    markdown = await aiDailyMarkdown(
      env,
      day,
      events,
      keywords,
      aiConfig,
      `根据以下审查意见重写日报，必须修正所有问题：${review.feedback}`
    );
  }
  return await writeReport(env, userId, "daily", day, markdown, {
    message_count: filteredSegments.length || events.length,
    raw_message_count: messages.length,
    keywords,
    event_count: events.length,
    quality_review: rewriteCount ? "rewrite" : "pass",
    rewrite_count: rewriteCount,
    related_count: 0
  });
}

async function dailyReportsBetween(env: Env, userId: number, start: string, end: string): Promise<ReportRow[]> {
  return await all<ReportRow>(
    env.DB.prepare(
      `SELECT * FROM reports
       WHERE user_id = ? AND report_type = 'daily' AND period >= ? AND period <= ?
       ORDER BY period ASC`
    ).bind(userId, start, end)
  );
}

async function generateSummaryReport(
  env: Env,
  userId: number,
  reportType: "weekly" | "monthly",
  period: string,
  reports: ReportRow[]
): Promise<ReportRow | null> {
  if (!reports.length) {
    return null;
  }
  const title = reportType === "weekly" ? "周学习总结" : "月学习总结";
  const contents = await Promise.all(reports.map((report) => readReportMarkdown(env, report)));
  const firstLines = contents
    .map((content) => content.split("\n").find((line) => line.trim()))
    .filter(Boolean)
    .join("\n");
  const markdown = `# ${period} ${title}

## 学习主题分布
${reports.length} 份日报参与汇总。

## 高频问题
请根据日报内容复盘反复出现的问题。

## 关键进展
${firstLines || "- 暂无日报正文"}

## 下阶段建议
- 保留每天复盘节奏。
- 优先处理日报中连续出现的未解决问题。
`;
  return await writeReport(env, userId, reportType, period, markdown, { daily_count: reports.length });
}

export async function generateWeeklyReport(env: Env, userId: number, day: string): Promise<ReportRow | null> {
  const date = parseDate(day);
  const start = mondayOfWeek(date);
  const reports = await dailyReportsBetween(env, userId, formatDate(start), day);
  return await generateSummaryReport(env, userId, "weekly", isoWeekPeriod(date), reports);
}

export async function generateMonthlyReport(env: Env, userId: number, day: string): Promise<ReportRow | null> {
  const date = parseDate(day);
  const start = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-01`;
  const period = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  const reports = await dailyReportsBetween(env, userId, start, day);
  return await generateSummaryReport(env, userId, "monthly", period, reports);
}

export async function allUsers(env: Env, limit = 100): Promise<UserRow[]> {
  return await all<UserRow>(env.DB.prepare("SELECT id FROM users ORDER BY id ASC LIMIT ?").bind(limit));
}

export async function reportsForUser(
  env: Env,
  userId: number,
  reportType: "daily" | "weekly" | "monthly",
  month: string | null
): Promise<ReportRow[]> {
  let sql = "SELECT * FROM reports WHERE user_id = ? AND report_type = ?";
  const values: Array<string | number> = [userId, reportType];
  if (month) {
    sql += " AND period LIKE ?";
    values.push(`${month}%`);
  }
  sql += " ORDER BY period DESC";
  return await all<ReportRow>(env.DB.prepare(sql).bind(...values));
}
