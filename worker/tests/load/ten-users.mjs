#!/usr/bin/env node
const BASE_URL = (process.env.DAILYREVIEW_BASE_URL || "http://127.0.0.1:8787").replace(/\/+$/, "");
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.ADMIN_INITIAL_PASSWORD || process.env.ADMIN_PASSWORD || "admin-password";
const USER_COUNT = Number.parseInt(process.env.DAILYREVIEW_LOAD_USERS || "10", 10);
const DURATION_MS = Number.parseInt(process.env.DAILYREVIEW_LOAD_DURATION_MS || "180000", 10);
const RUN_ID = process.env.DAILYREVIEW_LOAD_RUN_ID || "local";
const TEST_PASSWORD = process.env.DAILYREVIEW_LOAD_PASSWORD || "Load-test-password-123";
const NON_AI_P95_LIMIT_MS = Number.parseInt(process.env.DAILYREVIEW_NON_AI_P95_LIMIT_MS || "500", 10);
const SSE_FIRST_TOKEN_P95_LIMIT_MS = Number.parseInt(process.env.DAILYREVIEW_SSE_FIRST_TOKEN_P95_LIMIT_MS || "1000", 10);

const tinyPng = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
  0x00, 0x03, 0x01, 0x01, 0x00, 0x18, 0xdd, 0x8d, 0xb0, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
  0x44, 0xae, 0x42, 0x60, 0x82
]);

const metrics = new Map();
const errors = [];

function record(name, ms) {
  const values = metrics.get(name) || [];
  values.push(ms);
  metrics.set(name, values);
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

function summarize(values) {
  return {
    count: values.length,
    p50: Math.round(percentile(values, 0.5)),
    p95: Math.round(percentile(values, 0.95)),
    max: Math.round(Math.max(...values, 0))
  };
}

function cookieFrom(response) {
  const cookie = response.headers.get("set-cookie");
  return cookie ? cookie.split(";", 1)[0] : "";
}

async function timed(name, fn) {
  const started = performance.now();
  try {
    const result = await fn();
    record(name, performance.now() - started);
    return result;
  } catch (error) {
    record(name, performance.now() - started);
    throw error;
  }
}

async function request(path, { method = "GET", cookie = "", json, body, headers = {}, metric = path } = {}) {
  return await timed(metric, async () => {
    const response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        ...(json === undefined ? {} : { "content-type": "application/json" }),
        ...(cookie ? { cookie } : {}),
        ...headers
      },
      body: json === undefined ? body : JSON.stringify(json)
    });
    if (response.status >= 500) {
      throw new Error(`${method} ${path} returned ${response.status}`);
    }
    return response;
  });
}

async function jsonRequest(path, options = {}) {
  const response = await request(path, options);
  if (!response.ok) {
    const data = await response.json().catch(() => ({ detail: `HTTP ${response.status}` }));
    throw new Error(`${options.method || "GET"} ${path}: ${data.detail || response.status}`);
  }
  return await response.json();
}

async function login(email, password, metric = "auth.login") {
  const response = await request("/api/auth/login", {
    method: "POST",
    json: { email, password },
    metric
  });
  if (!response.ok) {
    return { ok: false, status: response.status, cookie: "" };
  }
  return { ok: true, status: response.status, cookie: cookieFrom(response), body: await response.json() };
}

async function ensureUser(adminCookie, index) {
  const email = `dailyreview-load-${RUN_ID}-${index}@example.test`;
  const existing = await login(email, TEST_PASSWORD, "auth.user_login");
  if (existing.ok) return { email, cookie: existing.cookie };

  const invite = await jsonRequest("/api/invites", {
    method: "POST",
    cookie: adminCookie,
    json: { expires_days: 7 },
    metric: "auth.invite"
  });
  const register = await request("/api/auth/register", {
    method: "POST",
    json: { email, password: TEST_PASSWORD, invite_code: invite.code },
    metric: "auth.register"
  });
  if (!register.ok && register.status !== 400) {
    throw new Error(`register ${email} returned ${register.status}`);
  }
  const loggedIn = await login(email, TEST_PASSWORD, "auth.user_login");
  if (!loggedIn.ok) {
    throw new Error(`cannot login load user ${email}`);
  }
  return { email, cookie: loggedIn.cookie };
}

async function uploadTinyPng(cookie) {
  const form = new FormData();
  form.append("file", new Blob([tinyPng], { type: "image/png" }), "load.png");
  return await jsonRequest("/api/attachments", {
    method: "POST",
    cookie,
    body: form,
    metric: "attachments.upload"
  });
}

async function readSse(response) {
  if (!response.ok || !response.body) {
    const data = await response.json().catch(() => ({ detail: `HTTP ${response.status}` }));
    throw new Error(`chat stream failed: ${data.detail}`);
  }
  const started = performance.now();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let firstTokenMs = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() || "";
    for (const event of events) {
      const line = event.split("\n").find((item) => item.startsWith("data:"));
      if (!line) continue;
      const data = line.replace(/^data:\s?/, "");
      if (data === "[DONE]") return firstTokenMs;
      if (!firstTokenMs) firstTokenMs = performance.now() - started;
    }
  }
  return firstTokenMs;
}

async function streamChat(cookie, sessionId, attachmentId, index) {
  const response = await request("/api/chat/stream", {
    method: "POST",
    cookie,
    json: {
      session_id: sessionId,
      content: `load test ${index} ${Date.now()}`,
      model: "gpt-5.4-mini",
      attachment_ids: attachmentId ? [attachmentId] : []
    },
    metric: "chat.stream_response"
  });
  const firstTokenMs = await readSse(response);
  record("chat.sse_first_token", firstTokenMs);
}

async function userLoop(user, index, deadline) {
  const session = await jsonRequest("/api/sessions", {
    method: "POST",
    cookie: user.cookie,
    json: { title: "load-test", model: "gpt-5.4-mini" },
    metric: "sessions.create"
  });
  const attachment = await uploadTinyPng(user.cookie);
  await streamChat(user.cookie, session.id, attachment.id, index);

  let iteration = 0;
  while (Date.now() < deadline) {
    try {
      await jsonRequest("/api/sessions", { cookie: user.cookie, metric: "sessions.list" });
      await jsonRequest(`/api/sessions/${session.id}/messages`, { cookie: user.cookie, metric: "messages.list" });
      await jsonRequest("/api/reports?report_type=daily&month=2026-06", { cookie: user.cookie, metric: "reports.list" });
      if (iteration % 3 === 0) {
        await streamChat(user.cookie, session.id, 0, index);
      }
    } catch (error) {
      errors.push({ user: user.email, error: error instanceof Error ? error.message : String(error) });
    }
    iteration += 1;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
}

async function main() {
  console.log(`DailyReview load test: ${USER_COUNT} users, ${DURATION_MS}ms, ${BASE_URL}`);
  const health = await jsonRequest("/api/health", { metric: "health" });
  if (health.status !== "ok") throw new Error("health check did not return ok");

  const admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD, "auth.admin_login");
  if (!admin.ok) {
    throw new Error("admin login failed; set ADMIN_EMAIL and ADMIN_INITIAL_PASSWORD for the target deployment");
  }

  const users = [];
  for (let index = 0; index < USER_COUNT; index += 1) {
    users.push(await ensureUser(admin.cookie, index));
  }

  const deadline = Date.now() + DURATION_MS;
  await Promise.all(users.map((user, index) => userLoop(user, index, deadline)));

  const summary = Object.fromEntries([...metrics.entries()].map(([name, values]) => [name, summarize(values)]));
  const nonAiValues = [...metrics.entries()]
    .filter(([name]) => name !== "chat.sse_first_token" && name !== "chat.stream_response")
    .flatMap(([, values]) => values);
  const nonAi = summarize(nonAiValues);
  const sse = summarize(metrics.get("chat.sse_first_token") || []);

  console.log(JSON.stringify({ summary, non_ai: nonAi, sse_first_token: sse, errors: errors.slice(0, 10) }, null, 2));

  const failures = [];
  if (errors.length) failures.push(`${errors.length} request errors`);
  if (nonAi.p95 > NON_AI_P95_LIMIT_MS) failures.push(`non-AI p95 ${nonAi.p95}ms > ${NON_AI_P95_LIMIT_MS}ms`);
  if (sse.p95 > SSE_FIRST_TOKEN_P95_LIMIT_MS) {
    failures.push(`SSE first token p95 ${sse.p95}ms > ${SSE_FIRST_TOKEN_P95_LIMIT_MS}ms`);
  }
  if (failures.length) {
    throw new Error(failures.join("; "));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
