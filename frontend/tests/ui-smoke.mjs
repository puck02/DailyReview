import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const chromePort = process.env.CHROME_PORT || "9334";
const appUrl = process.env.APP_URL || "http://127.0.0.1:8082";
const screenshotPath = process.env.SCREENSHOT_PATH || "/tmp/dailyreview-ui-smoke.png";
const imagePath = process.env.IMAGE_PATH || "/tmp/dailyreview-smoke-image.png";

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  return Object.fromEntries(
    fs
      .readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const index = line.indexOf("=");
        const key = line.slice(0, index).trim();
        let value = line.slice(index + 1).trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        return [key, value];
      })
  );
}

const localEnv = {
  ...parseEnvFile(path.join(root, ".env")),
  ...parseEnvFile(path.join(root, "backend/.env")),
  ...process.env
};

function requireLoginConfig() {
  const email = localEnv.ADMIN_EMAIL;
  const password = localEnv.ADMIN_INITIAL_PASSWORD;
  if (!email || !password) throw new Error("missing admin login config");
  return { email, password };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class Cdp {
  constructor(wsUrl) {
    this.nextId = 1;
    this.pending = new Map();
    this.events = new Map();
    this.ws = new WebSocket(wsUrl);
    this.opened = new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
    this.ws.onmessage = (event) => {
      const payload = JSON.parse(event.data);
      if (!payload.id) {
        const listeners = this.events.get(payload.method) || [];
        this.events.set(payload.method, []);
        for (const listener of listeners) listener(payload.params || {});
        return;
      }
      const callbacks = this.pending.get(payload.id);
      if (!callbacks) return;
      this.pending.delete(payload.id);
      if (payload.error) callbacks.reject(new Error(payload.error.message));
      else callbacks.resolve(payload.result || {});
    };
  }

  async send(method, params = {}) {
    await this.opened;
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  close() {
    this.ws.close();
  }

  once(method) {
    return new Promise((resolve) => {
      const listeners = this.events.get(method) || [];
      listeners.push(resolve);
      this.events.set(method, listeners);
    });
  }
}

async function openPage() {
  const response = await fetch(`http://127.0.0.1:${chromePort}/json/new?about:blank`, {
    method: "PUT"
  });
  if (!response.ok) throw new Error(`cannot open chrome target: ${response.status}`);
  const target = await response.json();
  const client = new Cdp(target.webSocketDebuggerUrl);
  await client.send("Page.enable");
  await client.send("Runtime.enable");
  await client.send("DOM.enable");
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: 1366,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  });
  const loaded = client.once("Page.loadEventFired");
  await client.send("Page.navigate", { url: appUrl });
  await loaded;
  return client;
}

async function reloadPage(client) {
  const loaded = client.once("Page.loadEventFired");
  await client.send("Page.reload");
  await loaded;
}

async function evaluate(client, expression, awaitPromise = false) {
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "runtime evaluation failed");
  return result.result.value;
}

async function waitFor(client, expression, label, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await evaluate(client, expression)) return;
    await sleep(200);
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function loginIfNeeded(client, credentials) {
  await waitFor(
    client,
    "Boolean(document.querySelector('.auth-form') || document.querySelector('.workspace'))",
    "initial screen"
  );
  const authed = await evaluate(client, "Boolean(document.querySelector('.workspace'))");
  if (authed) return;

  await evaluate(
    client,
    `(() => {
      const email = ${JSON.stringify(credentials.email)};
      const password = ${JSON.stringify(credentials.password)};
      const setValue = (element, value) => {
        const setter = Object.getOwnPropertyDescriptor(element.constructor.prototype, "value").set;
        setter.call(element, value);
        element.dispatchEvent(new Event("input", { bubbles: true }));
      };
      setValue(document.querySelector('input[type="email"]'), email);
      setValue(document.querySelector('input[type="password"]'), password);
      document.querySelector("form").requestSubmit();
    })()`
  );
  await waitFor(client, "Boolean(document.querySelector('.workspace'))", "chat workspace");
}

async function pasteImage(client) {
  const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lH9u2wAAAABJRU5ErkJggg==";
  fs.writeFileSync(imagePath, Buffer.from(pngBase64, "base64"));
  await evaluate(
    client,
    `(() => {
      const bytes = Uint8Array.from(atob(${JSON.stringify(pngBase64)}), (char) => char.charCodeAt(0));
      const file = new File([bytes], "clipboard", { type: "application/octet-stream" });
      const data = new DataTransfer();
      data.items.add(file);
      document.dispatchEvent(new ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true
      }));
    })()`
  );
  await waitFor(
    client,
    `Boolean(document.querySelector('.attachment-preview img')?.complete && document.querySelector('.attachment-remove'))`,
    "attachment preview"
  );
}

async function checkLayout(client) {
  const checks = await evaluate(
    client,
    `(() => {
      const host = document.querySelector('.messages') || document.body;
      const assistant = document.createElement('div');
      assistant.className = 'message assistant';
      assistant.innerHTML = '<div class="message-avatar ai-avatar"></div><div class="message-content">AI</div>';
      const user = document.createElement('div');
      user.className = 'message user';
      user.innerHTML = '<div class="message-content">用户</div><div class="message-avatar user-avatar">我</div>';
      host.append(assistant, user);
      const result = {
        assistantJustify: getComputedStyle(assistant).justifyContent,
        userJustify: getComputedStyle(user).justifyContent,
        iconHref: Boolean(document.querySelector('link[rel="icon"]')?.href),
        navWidth: Math.round(document.querySelector('.app-nav')?.getBoundingClientRect().width || 0),
        removePosition: getComputedStyle(document.querySelector('.attachment-remove')).position,
        previewCount: document.querySelectorAll('.attachment-preview').length
      };
      assistant.remove();
      user.remove();
      return result;
    })()`
  );
  if (checks.assistantJustify !== "start") throw new Error("assistant bubble is not left aligned");
  if (checks.userJustify !== "end") throw new Error("user bubble is not right aligned");
  if (!checks.iconHref) throw new Error("favicon is missing");
  if (checks.navWidth > 64) throw new Error(`global sidebar is too wide: ${checks.navWidth}px`);
  if (checks.removePosition !== "absolute") throw new Error("attachment remove button is not positioned");
  if (checks.previewCount < 1) throw new Error("attachment preview is missing");
}

async function removePreview(client) {
  await evaluate(client, "document.querySelector('.attachment-remove').click()");
  await waitFor(client, "document.querySelectorAll('.attachment-preview').length === 0", "preview removal");
}

async function checkLiveMathRendering(client) {
  const liveToken = "[ e^x = 1+x+\\frac{x^2}{2}+o(x^2) ]";
  await evaluate(
    client,
    `(async () => {
      const originalFetch = window.fetch.bind(window);
      window.__dailyreviewOriginalFetch = originalFetch;
      window.fetch = (input, init) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.includes("/api/chat/stream")) {
          const encoder = new TextEncoder();
          const body = new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode("data: " + JSON.stringify(${JSON.stringify(liveToken)}) + "\\n\\n"));
              controller.enqueue(encoder.encode("data: [DONE]\\n\\n"));
              controller.close();
            }
          });
          return Promise.resolve(new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }));
        }
        return originalFetch(input, init);
      };
      const textarea = document.querySelector(".composer textarea");
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
      setter.call(textarea, "实时公式测试");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector(".send-button").click();
      return true;
    })()`,
    true
  );
  await waitFor(
    client,
    `Boolean(document.querySelector('.message.assistant .katex'))`,
    "live math rendering without refresh",
    15000
  );
  await evaluate(
    client,
    `(() => {
      if (window.__dailyreviewOriginalFetch) {
        window.fetch = window.__dailyreviewOriginalFetch;
        delete window.__dailyreviewOriginalFetch;
      }
      return true;
    })()`,
    true
  );
}

async function checkDraftFirstMessageStreaming(client) {
  const fakeSession = {
    id: 990901,
    title: "首条回复 smoke",
    default_model: "gpt-5.4-mini",
    is_archived: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  const streamedText = "首条回复已显示";
  await evaluate(client, "document.querySelector('.app-nav button[aria-label=\"问答\"]').click()");
  await waitFor(client, "Boolean(document.querySelector('.new-session') && document.querySelector('.composer textarea'))", "chat composer");
  await evaluate(
    client,
    `(() => {
      const fakeSession = ${JSON.stringify(fakeSession)};
      const streamedText = ${JSON.stringify(streamedText)};
      const originalFetch = window.fetch.bind(window);
      window.__dailyreviewDraftFirstFetch = originalFetch;
      window.__dailyreviewDraftFirstMessagesRequested = false;
      window.fetch = (input, init = {}) => {
        const url = typeof input === "string" ? input : input.url;
        const method = init.method || (typeof input === "string" ? "GET" : input.method);
        if (url.endsWith("/api/sessions") && method === "POST") {
          return Promise.resolve(new Response(JSON.stringify(fakeSession), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }));
        }
        if (url.endsWith("/api/sessions/" + fakeSession.id + "/messages")) {
          window.__dailyreviewDraftFirstMessagesRequested = true;
          return new Promise((resolve) => {
            window.setTimeout(() => {
              resolve(new Response(JSON.stringify([]), {
                status: 200,
                headers: { "Content-Type": "application/json" }
              }));
            }, 80);
          });
        }
        if (url.endsWith("/api/chat/stream")) {
          const encoder = new TextEncoder();
          const body = new ReadableStream({
            start(controller) {
              window.setTimeout(() => {
                controller.enqueue(encoder.encode("data: " + JSON.stringify(streamedText) + "\\n\\n"));
                controller.enqueue(encoder.encode("data: [DONE]\\n\\n"));
                controller.close();
              }, 160);
            }
          });
          return Promise.resolve(new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }));
        }
        if (url.endsWith("/api/sessions") && method === "GET") {
          return Promise.resolve(new Response(JSON.stringify([fakeSession]), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }));
        }
        return originalFetch(input, init);
      };
      document.querySelector(".new-session").click();
      const textarea = document.querySelector(".composer textarea");
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
      setter.call(textarea, "首条回复测试");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector(".send-button").click();
      return true;
    })()`,
    true
  );
  await waitFor(
    client,
    `document.querySelector('.message.assistant .message-content')?.textContent.includes(${JSON.stringify(streamedText)})`,
    "draft first assistant reply",
    15000
  );
  const result = await evaluate(
    client,
    `(() => ({
      messagesRequested: Boolean(window.__dailyreviewDraftFirstMessagesRequested),
      assistantText: document.querySelector('.message.assistant .message-content')?.textContent || ""
    }))()`
  );
  await evaluate(
    client,
    `(() => {
      if (window.__dailyreviewDraftFirstFetch) {
        window.fetch = window.__dailyreviewDraftFirstFetch;
        delete window.__dailyreviewDraftFirstFetch;
      }
      delete window.__dailyreviewDraftFirstMessagesRequested;
      return true;
    })()`,
    true
  );
  if (result.messagesRequested) {
    throw new Error(`draft first message loaded history while streaming: ${JSON.stringify(result)}`);
  }
  if (!result.assistantText.includes(streamedText)) {
    throw new Error(`draft first assistant reply is missing: ${JSON.stringify(result)}`);
  }
}

async function checkTranslationLoadingLayout(client) {
  await evaluate(client, "document.querySelector('.app-nav button[aria-label=\"翻译\"]').click()");
  await waitFor(client, "Boolean(document.querySelector('.translation-panel'))", "translation panel");
  await waitFor(client, "Boolean(document.querySelector('.translation-submit') && document.querySelector('.translation-result'))", "translation workbench");
  const before = await evaluate(
    client,
    `(() => {
      const button = document.querySelector('.translation-submit').getBoundingClientRect();
      const result = document.querySelector('.translation-result').getBoundingClientRect();
      const loader = document.querySelector('.translation-submit-loader');
      return {
        buttonWidth: Math.round(button.width),
        buttonHeight: Math.round(button.height),
        resultHeight: Math.round(result.height),
        loaderPosition: getComputedStyle(loader).gridArea
      };
    })()`
  );
  await evaluate(
    client,
    `(() => {
      const originalFetch = window.fetch.bind(window);
      window.__dailyreviewTranslationFetch = originalFetch;
      window.fetch = (input, init) => {
        const url = typeof input === "string" ? input : input.url;
        const method = init?.method || (typeof input === "string" ? "GET" : input.method);
        if (url.endsWith("/api/translation") && method === "POST") {
          return new Promise((resolve) => {
            window.setTimeout(() => {
              resolve(new Response(JSON.stringify({
                id: 999999,
                source_text: "layout",
                source_kind: "word",
                phonetic: "/ˈleɪaʊt/",
                result_markdown: "layout",
                detail_status: "ready",
                is_auto_detail: false,
                created_at: new Date().toISOString()
              }), { status: 200, headers: { "Content-Type": "application/json" } }));
            }, 800);
          });
        }
        return originalFetch(input, init);
      };
      const textarea = document.querySelector('.translation-input');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
      setter.call(textarea, "layout");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector('.translation-submit').click();
      return true;
    })()`,
    true
  );
  await waitFor(client, "Boolean(document.querySelector('.translation-submit.is-loading') && document.querySelector('.translation-result-loading'))", "translation loading state");
  const during = await evaluate(
    client,
    `(() => {
      const button = document.querySelector('.translation-submit').getBoundingClientRect();
      const result = document.querySelector('.translation-result').getBoundingClientRect();
      const overlay = document.querySelector('.translation-result-loading');
      const overlayRect = overlay.getBoundingClientRect();
      const dot = document.querySelector('.translation-submit-loader .translation-loading span').getBoundingClientRect();
      return {
        buttonWidth: Math.round(button.width),
        buttonHeight: Math.round(button.height),
        resultHeight: Math.round(result.height),
        overlayPosition: getComputedStyle(overlay).position,
        overlayWidth: Math.round(overlayRect.width),
        dotWidth: Math.round(dot.width),
        dotHeight: Math.round(dot.height)
      };
    })()`
  );
  if (during.buttonWidth !== before.buttonWidth || during.buttonHeight !== before.buttonHeight) {
    throw new Error(`translation button shifts during loading: ${JSON.stringify({ before, during })}`);
  }
  if (Math.abs(during.resultHeight - before.resultHeight) > 2) {
    throw new Error(`translation result shifts during loading: ${JSON.stringify({ before, during })}`);
  }
  if (during.overlayPosition !== "absolute") throw new Error("translation loading overlay participates in layout");
  if (during.overlayWidth <= 0) throw new Error("translation loading overlay is not visible");
  if (during.dotWidth !== 4 || during.dotHeight !== 4) {
    throw new Error(`translation loading dots are distorted: ${JSON.stringify(during)}`);
  }
  await waitFor(client, "Boolean(!document.querySelector('.translation-submit.is-loading'))", "translation loading completion");
  await evaluate(
    client,
    `(() => {
      if (window.__dailyreviewTranslationFetch) {
        window.fetch = window.__dailyreviewTranslationFetch;
        delete window.__dailyreviewTranslationFetch;
      }
      return true;
    })()`,
    true
  );
}

async function checkWordCloudDetail(client) {
  await waitFor(
    client,
    "Boolean(document.querySelector('.word-cloud-stage') && document.querySelector('.word-cloud-run') && document.querySelector('.word-cloud-chip'))",
    "translation word cloud chips"
  );
  const cloud = await evaluate(
    client,
    `(() => {
      const stageElement = document.querySelector('.word-cloud-stage');
      const laneElement = document.querySelector('.word-cloud-lane');
      const runElement = document.querySelector('.word-cloud-run');
      const stage = stageElement.getBoundingClientRect();
      const run = runElement.getBoundingClientRect();
      const chip = document.querySelector('.word-cloud-chip');
      const stageStyle = getComputedStyle(stageElement);
      const cloudStyle = getComputedStyle(document.querySelector('.translation-cloud'));
      const laneStyle = getComputedStyle(laneElement);
      const runStyle = getComputedStyle(runElement);
      const chipStyle = getComputedStyle(chip);
      return {
        stageWidth: Math.round(stage.width),
        stageHeight: Math.round(stage.height),
        runWidth: Math.round(run.width),
        stageMarginLeft: stageStyle.marginLeft,
        cloudBackground: cloudStyle.backgroundColor,
        cloudBorder: cloudStyle.borderTopWidth,
        cloudShadow: cloudStyle.boxShadow,
        laneCount: document.querySelectorAll('.word-cloud-lane').length,
        duration: runStyle.animationDuration,
        stageOverflowY: stageStyle.overflowY,
        laneOverflowY: laneStyle.overflowY,
        laneBackground: laneStyle.backgroundColor,
        runBackground: runStyle.backgroundColor,
        tone: chip.dataset.tone,
        color: chipStyle.color,
        background: chipStyle.backgroundColor
      };
    })()`
  );
  if (cloud.runWidth < cloud.stageWidth * 2) {
    throw new Error(`word cloud run does not fill the lane: ${JSON.stringify(cloud)}`);
  }
  if (!["1", "2", "3", "4", "5", "6"].includes(cloud.tone)) {
    throw new Error(`word cloud chip tone is missing: ${JSON.stringify(cloud)}`);
  }
  if (cloud.laneCount !== 4) throw new Error(`word cloud lane count is not four: ${JSON.stringify(cloud)}`);
  if (cloud.stageHeight > 270) throw new Error(`word cloud is too tall: ${JSON.stringify(cloud)}`);
  if (Number.parseFloat(cloud.duration) < 70) throw new Error(`word cloud animation is too fast: ${JSON.stringify(cloud)}`);
  if (cloud.stageOverflowY !== "visible" || cloud.laneOverflowY !== "visible") {
    throw new Error(`word cloud lanes clip chips vertically: ${JSON.stringify(cloud)}`);
  }
  if (cloud.laneBackground !== "rgba(0, 0, 0, 0)" || cloud.runBackground !== "rgba(0, 0, 0, 0)") {
    throw new Error(`word cloud lane background is visible: ${JSON.stringify(cloud)}`);
  }
  if (cloud.cloudBackground !== "rgba(0, 0, 0, 0)" || cloud.cloudBorder !== "0px" || cloud.cloudShadow !== "none") {
    throw new Error(`word cloud container is still card-like: ${JSON.stringify(cloud)}`);
  }
  if (!cloud.stageMarginLeft.startsWith("-")) {
    throw new Error(`word cloud stage does not extend to the edge: ${JSON.stringify(cloud)}`);
  }
  if (cloud.background === "rgb(255, 255, 255)" || cloud.background === "rgba(0, 0, 0, 0)") {
    throw new Error(`word cloud chip does not use a soft color: ${JSON.stringify(cloud)}`);
  }
  await evaluate(client, "document.querySelector('.word-cloud-chip').click()");
  await waitFor(client, "Boolean(document.querySelector('.word-cloud-detail-backdrop') && document.querySelector('.word-cloud-detail-card'))", "word cloud detail modal");
  const detail = await evaluate(
    client,
    `(() => {
      const backdrop = document.querySelector('.word-cloud-detail-backdrop');
      const card = document.querySelector('.word-cloud-detail-card');
      const content = document.querySelector('.word-cloud-detail-content');
      return {
        backdropFilter: getComputedStyle(backdrop).backdropFilter,
        cardFilter: getComputedStyle(card).backdropFilter,
        contentOverflow: getComputedStyle(content).overflowY,
        cardHeight: Math.round(card.getBoundingClientRect().height)
      };
    })()`
  );
  if (!detail.backdropFilter.includes("blur")) throw new Error(`detail backdrop is not glassy: ${JSON.stringify(detail)}`);
  if (!detail.cardFilter.includes("blur")) throw new Error(`detail card is not glassy: ${JSON.stringify(detail)}`);
  if (detail.contentOverflow !== "auto") throw new Error(`detail content is not scrollable: ${JSON.stringify(detail)}`);
  if (detail.cardHeight <= 0) throw new Error(`detail card is not visible: ${JSON.stringify(detail)}`);
  await evaluate(client, "document.querySelector('.word-cloud-detail-close').click()");
  await waitFor(client, "!document.querySelector('.word-cloud-detail-backdrop')", "word cloud detail close button");
  await evaluate(client, "document.querySelector('.word-cloud-chip').click()");
  await waitFor(client, "Boolean(document.querySelector('.word-cloud-detail-backdrop'))", "word cloud detail reopen");
  await evaluate(client, "document.querySelector('.word-cloud-detail-backdrop').click()");
  await waitFor(client, "!document.querySelector('.word-cloud-detail-backdrop')", "word cloud detail backdrop close");

  const splitWord = await evaluate(
    client,
    `(async () => {
      const originalFetch = window.fetch.bind(window);
      window.__dailyreviewWordCloudFetch = originalFetch;
      window.fetch = (input, init) => {
        const url = typeof input === "string" ? input : input.url;
        const method = init?.method || (typeof input === "string" ? "GET" : input.method);
        if (url.endsWith("/api/translation/entries")) {
          return Promise.resolve(new Response(JSON.stringify([{
            id: 880001,
            source_text: "The derivative problem requires careful limits",
            source_kind: "english",
            phonetic: null,
            result_markdown: "ORIGINAL SENTENCE DETAIL",
            detail_status: "ready",
            is_auto_detail: false,
            created_at: new Date().toISOString()
          }, {
            id: 880000,
            source_text: "中文词条不应收录",
            source_kind: "chinese",
            phonetic: null,
            result_markdown: "CHINESE DETAIL",
            detail_status: "ready",
            is_auto_detail: false,
            created_at: new Date().toISOString()
          }, {
            id: 880002,
            source_text: "derivative",
            source_kind: "word",
            phonetic: "/dɪˈrɪvətɪv/",
            result_markdown: "WORD DETAIL ONLY",
            detail_status: "ready",
            is_auto_detail: true,
            created_at: new Date().toISOString()
          }]), { status: 200, headers: { "Content-Type": "application/json" } }));
        }
        if (url.endsWith("/api/translation") && method === "POST") {
          const body = JSON.parse(init.body);
          window.__dailyreviewWordCloudTranslatedText = body.text;
          return Promise.resolve(new Response(JSON.stringify({
            id: 880002,
            source_text: body.text,
            source_kind: "word",
            phonetic: null,
            result_markdown: "WORD DETAIL ONLY",
            detail_status: "ready",
            is_auto_detail: false,
            created_at: new Date().toISOString()
          }), { status: 200, headers: { "Content-Type": "application/json" } }));
        }
        return originalFetch(input, init);
      };
      document.querySelector('.app-nav button[aria-label="翻译"]').click();
      document.querySelector('.app-nav button[aria-label="问答"]').click();
      window.setTimeout(() => document.querySelector('.app-nav button[aria-label="翻译"]').click(), 0);
      return true;
    })()`,
    true
  );
  if (!splitWord) throw new Error("failed to set up split-word word cloud check");
  await waitFor(client, "Boolean([...document.querySelectorAll('.word-cloud-chip')].find((chip) => chip.dataset.label === 'derivative'))", "split word chip");
  const hasChineseCloudChip = await evaluate(
    client,
    `[...document.querySelectorAll('.word-cloud-chip')].some((chip) => chip.dataset.label === '中文词条不应收录')`
  );
  if (hasChineseCloudChip) throw new Error("Chinese translation entry should not be collected into the word cloud");
  await evaluate(client, "[...document.querySelectorAll('.word-cloud-chip')].find((chip) => chip.dataset.label === 'derivative').click()");
  await waitFor(client, "document.querySelector('.word-cloud-detail-content')?.textContent.includes('WORD DETAIL ONLY')", "split word detail");
  const splitWordDetail = await evaluate(
    client,
    `(() => ({
      requestedText: window.__dailyreviewWordCloudTranslatedText,
      phoneticText: document.querySelector('.word-cloud-detail-content .translation-phonetic')?.textContent || "",
      detailText: document.querySelector('.word-cloud-detail-content')?.textContent || ""
    }))()`
  );
  if (splitWordDetail.requestedText) {
    throw new Error(`split word detail should not request on click: ${JSON.stringify(splitWordDetail)}`);
  }
  if (!splitWordDetail.phoneticText.includes("/dɪˈrɪvətɪv/")) {
    throw new Error(`split word detail phonetic is missing: ${JSON.stringify(splitWordDetail)}`);
  }
  if (splitWordDetail.detailText.includes("ORIGINAL SENTENCE DETAIL")) {
    throw new Error(`split word detail shows original sentence detail: ${JSON.stringify(splitWordDetail)}`);
  }
  await evaluate(
    client,
    `(() => {
      if (window.__dailyreviewWordCloudFetch) {
        window.fetch = window.__dailyreviewWordCloudFetch;
        delete window.__dailyreviewWordCloudFetch;
        delete window.__dailyreviewWordCloudTranslatedText;
      }
      document.querySelector('.word-cloud-detail-backdrop')?.click();
      return true;
    })()`,
    true
  );
  await waitFor(client, "!document.querySelector('.word-cloud-detail-backdrop')", "split word detail close");
}

async function checkTranslationInputLimit(client) {
  await waitFor(client, "Boolean(document.querySelector('.translation-input') && document.querySelector('.translation-submit'))", "translation input limit controls");
  const checks = await evaluate(
    client,
    `(() => {
      const textarea = document.querySelector('.translation-input');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
      setter.call(textarea, "a".repeat(2001));
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      const submit = document.querySelector('.translation-submit');
      return {
        disabled: submit.disabled,
        meta: document.querySelector('.translation-input-meta')?.textContent || "",
        overLimit: Boolean(document.querySelector('.translation-input-meta.over-limit')),
        loading: Boolean(document.querySelector('.translation-submit.is-loading'))
      };
    })()`
  );
  if (!checks.disabled) throw new Error(`over-limit translation submit is not disabled: ${JSON.stringify(checks)}`);
  if (!checks.overLimit || !checks.meta.includes("输入超过 2000 字")) {
    throw new Error(`over-limit translation prompt is missing: ${JSON.stringify(checks)}`);
  }
  if (checks.loading) throw new Error(`over-limit translation entered loading state: ${JSON.stringify(checks)}`);
}

async function checkSessionArchive(client) {
  await evaluate(client, "document.querySelector('.app-nav button[aria-label=\"问答\"]').click()");
  const sessionId = await evaluate(
    client,
    `(async () => {
      const session = await fetch("/api/sessions", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Smoke Archive Session", model: "gpt-5.4-mini" })
      }).then((response) => response.json());
      await fetch("/api/sessions/" + session.id + "/archive", {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: true })
      });
      window.__dailyreviewArchiveSessionId = session.id;
      return session.id;
    })()`,
    true
  );
  await reloadPage(client);
  await waitFor(
    client,
    `Boolean([...document.querySelectorAll('.session-section-archived .session-row')].find((row) => row.textContent.includes("Smoke Archive Session")))`,
    "archived smoke session"
  );
  await evaluate(
    client,
    `(() => {
      const row = [...document.querySelectorAll('.session-section-archived .session-row')]
        .find((item) => item.textContent.includes("Smoke Archive Session"));
      row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 220, clientY: 520 }));
      return true;
    })()`
  );
  await waitFor(
    client,
    `Boolean(document.querySelector('.session-context-menu')?.textContent.includes("取消归档"))`,
    "unarchive context menu"
  );
  await evaluate(
    client,
    `[...document.querySelectorAll('.session-context-menu button')]
      .find((button) => button.textContent.includes("取消归档"))
      .click()`
  );
  await waitFor(
    client,
    `![...document.querySelectorAll('.session-section-archived .session-row')].some((row) => row.textContent.includes("Smoke Archive Session"))`,
    "unarchived empty smoke session hidden from archive section"
  );
  await evaluate(
    client,
    `(async () => {
      await fetch("/api/sessions/${sessionId}", { method: "DELETE", credentials: "same-origin" });
      delete window.__dailyreviewArchiveSessionId;
      return true;
    })()`,
    true
  );
}

async function checkReportPdfDownload(client) {
  const longReportMarkdown = [
    "# 2026-06-09 学习日报",
    "",
    "## 今日重点",
    "",
    "- 导数与极限：梳理了连续、可导和极限存在之间的关系。",
    "- 泰勒展开：复习了常见等价无穷小和二阶展开式。",
    "- 英语长难句：练习了主从句识别、插入语剥离和谓语定位。",
    "",
    "| 模块 | 今日进展 | 下一步 |",
    "| --- | --- | --- |",
    "| 高数 | 复盘 6 道极限题 | 归纳洛必达和等价替换的触发条件 |",
    "| 英语 | 拆解 5 个长难句 | 继续补充同义替换和语法标记 |",
    "| 复盘 | 记录 3 个易错点 | 明天先做 15 分钟错题回看 |",
    "",
    ...Array.from({ length: 18 }, (_, index) => {
      const dayIndex = index + 1;
      return [
        `## 知识块 ${dayIndex}`,
        "",
        "### 关键结论",
        "",
        `- 本轮重点是把概念、公式和题目触发条件连接起来，避免只记结论。`,
        `- 例题中最容易出错的是条件判断，尤其是第 ${dayIndex} 组题里变量趋近方式变化后，原公式不能直接套用。`,
        "- 做题时先写出目标形式，再决定使用等价替换、泰勒展开或拆分因式。",
        "",
        "### 例题整理",
        "",
        "```text",
        "先判断目标极限的阶数，再比较分子分母的主导项。",
        "如果出现复合函数，先把内层变量替换成趋近于 0 的标准形式。",
        "```",
        "",
        "### 下一步",
        "",
        "- 明天优先回看今天标记的错题。",
        "- 用 10 分钟默写常见展开式，再做一组限时训练。",
        ""
      ].join("\\n");
    }),
    "## 简洁建议",
    "",
    "明天先用短时间复现今天的错因，再进入新题。重点不是多刷，而是确认每个公式的使用边界。"
  ].join("\\n");
  await evaluate(
    client,
    `(() => {
      const longReportMarkdown = ${JSON.stringify(longReportMarkdown)};
      const originalFetch = window.fetch.bind(window);
      window.__dailyreviewReportFetch = originalFetch;
      window.fetch = (input, init) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.includes("/api/reports?")) {
          return Promise.resolve(new Response(JSON.stringify([{
            id: 990001,
            report_type: "daily",
            period: "2026-06-09",
            stats: { message_count: 2 },
            created_at: new Date().toISOString()
          }]), { status: 200, headers: { "Content-Type": "application/json" } }));
        }
        if (url.endsWith("/api/reports/990001")) {
          return Promise.resolve(new Response(JSON.stringify({
            id: 990001,
            report_type: "daily",
            period: "2026-06-09",
            stats: { message_count: 48 },
            created_at: new Date().toISOString(),
            markdown: longReportMarkdown
          }), { status: 200, headers: { "Content-Type": "application/json" } }));
        }
        if (url.endsWith("/api/reports/990001/pdf")) {
          window.__dailyreviewReportPdfRequested = true;
          return Promise.resolve(new Response("%PDF-1.4\\n% searchable smoke pdf\\n", {
            status: 200,
            headers: { "Content-Type": "application/pdf" }
          }));
        }
        return originalFetch(input, init);
      };
      return true;
    })()`
  );
  await evaluate(client, "document.querySelector('.app-nav button[aria-label=\"报告\"]').click()");
  await waitFor(client, "Boolean(document.querySelector('.report-content'))", "reports panel");
  await evaluate(
    client,
    `(() => {
      window.__dailyreviewPrinted = false;
      window.__dailyreviewSavePickerOpened = false;
      window.__dailyreviewSavedPdf = false;
      window.__dailyreviewSavedPdfSize = 0;
      window.__dailyreviewReportPdfRequested = false;
      window.__dailyreviewOriginalPrint = window.print;
      window.__dailyreviewOriginalSavePicker = window.showSaveFilePicker;
      window.print = () => { window.__dailyreviewPrinted = true; };
      window.showSaveFilePicker = async () => {
        window.__dailyreviewSavePickerOpened = true;
        return {
          createWritable: async () => ({
            write: async (blob) => {
              window.__dailyreviewSavedPdf = blob instanceof Blob && blob.type === "application/pdf";
              window.__dailyreviewSavedPdfSize = blob instanceof Blob ? blob.size : 0;
            },
            close: async () => {}
          })
        };
      };
      return true;
    })()`
  );
  await waitFor(client, "Boolean(document.querySelector('.print-export-button') && !document.querySelector('.print-export-button').disabled)", "report export button", 15000);
  await evaluate(client, "document.querySelector('.print-export-button').click()");
  await waitFor(client, "Boolean(window.__dailyreviewSavedPdf || window.__dailyreviewPrinted)", "pdf export completion", 30000);
  const result = await evaluate(
    client,
    `(() => ({
      printed: window.__dailyreviewPrinted,
      savePickerOpened: window.__dailyreviewSavePickerOpened,
      savedPdf: window.__dailyreviewSavedPdf,
      savedPdfSize: window.__dailyreviewSavedPdfSize,
      reportPdfRequested: window.__dailyreviewReportPdfRequested,
      exportError: document.querySelector('.report-export-error')?.textContent || ""
    }))()`
  );
  await evaluate(
    client,
    `(() => {
      if (window.__dailyreviewReportFetch) {
        window.fetch = window.__dailyreviewReportFetch;
        delete window.__dailyreviewReportFetch;
      }
      if (window.__dailyreviewOriginalPrint) window.print = window.__dailyreviewOriginalPrint;
      if (window.__dailyreviewOriginalSavePicker) window.showSaveFilePicker = window.__dailyreviewOriginalSavePicker;
      else delete window.showSaveFilePicker;
      delete window.__dailyreviewPrinted;
      delete window.__dailyreviewSavePickerOpened;
      delete window.__dailyreviewSavedPdf;
      delete window.__dailyreviewSavedPdfSize;
      delete window.__dailyreviewReportPdfRequested;
      delete window.__dailyreviewOriginalPrint;
      delete window.__dailyreviewOriginalSavePicker;
      return true;
    })()`
  );
  if (result.printed) throw new Error(`pdf export opened print: ${JSON.stringify(result)}`);
  if (!result.savePickerOpened) throw new Error(`pdf export did not open save picker: ${JSON.stringify(result)}`);
  if (!result.reportPdfRequested) throw new Error(`pdf export did not request backend PDF: ${JSON.stringify(result)}`);
  if (!result.savedPdf) throw new Error(`pdf export did not write a PDF blob: ${JSON.stringify(result)}`);
  if (!result.savedPdfSize || result.savedPdfSize > 2_500_000) {
    throw new Error(`pdf export is too large: ${JSON.stringify(result)}`);
  }
}

async function createRenderedMessage(client) {
  const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lH9u2wAAAABJRU5ErkJggg==";
  const markdownText = [
    "# 图片复盘",
    "- 关键点：`坐标`",
    "行内公式 $E = mc^2$",
    "[ e^x = 1+x+\\frac{x^2}{2}+o(x^2) ]",
    "",
    "$$",
    "\\frac{d}{dx}x^2 = 2x",
    "$$"
  ].join("\n");
  const sessionId = await evaluate(
    client,
    `(async () => {
      const bytes = Uint8Array.from(atob(${JSON.stringify(pngBase64)}), (char) => char.charCodeAt(0));
      const session = await fetch("/api/sessions", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Smoke Markdown Image", model: "gpt-5.4-mini" })
      }).then((response) => response.json());
      const form = new FormData();
      form.append("file", new File([bytes], "history.png", { type: "image/png" }));
      const attachment = await fetch("/api/attachments", {
        method: "POST",
        credentials: "same-origin",
        body: form
      }).then((response) => response.json());
      const stream = await fetch("/api/chat/stream", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: session.id,
          content: ${JSON.stringify(markdownText)},
          model: "gpt-5.4-mini",
          attachment_ids: [attachment.id]
        })
      });
      await stream.text();
      return session.id;
    })()`,
    true
  );
  await reloadPage(client);
  await waitFor(
    client,
    `Boolean(
      document.querySelector('.message-attachment-thumb img')?.complete &&
      document.querySelector('.message-markdown h1') &&
      document.querySelector('.markdown-list') &&
      document.querySelector('.markdown-inline-code') &&
      document.querySelector('.message-markdown .katex')
    )`,
    "rendered markdown message with image",
    15000
  );
  return sessionId;
}

async function deleteSession(client, sessionId) {
  await evaluate(
    client,
    `(async () => {
      await fetch("/api/sessions/${sessionId}", { method: "DELETE", credentials: "same-origin" });
      return true;
    })()`,
    true
  );
}

async function capture(client) {
  const screenshot = await client.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false
  });
  fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, "base64"));
}

const client = await openPage();
let createdSessionId = null;
try {
  await loginIfNeeded(client, requireLoginConfig());
  await pasteImage(client);
  await checkLayout(client);
  await removePreview(client);
  await checkLiveMathRendering(client);
  await checkDraftFirstMessageStreaming(client);
  await checkTranslationLoadingLayout(client);
  await checkWordCloudDetail(client);
  await checkTranslationInputLimit(client);
  await checkSessionArchive(client);
  await checkReportPdfDownload(client);
  createdSessionId = await createRenderedMessage(client);
  await capture(client);
  console.log(`ui-smoke-ok ${screenshotPath}`);
} finally {
  if (createdSessionId !== null) await deleteSession(client, createdSessionId);
  client.close();
}
