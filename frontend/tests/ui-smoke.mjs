import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const chromePort = process.env.CHROME_PORT || "9334";
const appUrl = process.env.APP_URL || "http://127.0.0.1:8082";
const screenshotPath = process.env.SCREENSHOT_PATH || "/tmp/dailyreview-ui-smoke.png";
const imagePath = process.env.IMAGE_PATH || "/tmp/dailyreview-smoke-image.svg";

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
    this.ws = new WebSocket(wsUrl);
    this.opened = new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
    this.ws.onmessage = (event) => {
      const payload = JSON.parse(event.data);
      if (!payload.id) return;
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
}

async function openPage() {
  const response = await fetch(`http://127.0.0.1:${chromePort}/json/new?${encodeURIComponent(appUrl)}`, {
    method: "PUT"
  });
  if (!response.ok) throw new Error(`cannot open chrome target: ${response.status}`);
  const target = await response.json();
  const client = new Cdp(target.webSocketDebuggerUrl);
  await client.send("Page.enable");
  await client.send("Runtime.enable");
  await client.send("DOM.enable");
  return client;
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

async function uploadImage(client) {
  fs.writeFileSync(
    imagePath,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160">
      <rect width="160" height="160" rx="26" fill="#faae2b"/>
      <circle cx="80" cy="74" r="34" fill="#00473e"/>
      <path d="M42 119h76" stroke="#00473e" stroke-width="12" stroke-linecap="round"/>
    </svg>`
  );
  const document = await client.send("DOM.getDocument");
  const input = await client.send("DOM.querySelector", {
    nodeId: document.root.nodeId,
    selector: 'input[type="file"]'
  });
  if (!input.nodeId) throw new Error("file input not found");
  await client.send("DOM.setFileInputFiles", {
    nodeId: input.nodeId,
    files: [imagePath]
  });
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
  if (checks.removePosition !== "absolute") throw new Error("attachment remove button is not positioned");
  if (checks.previewCount < 1) throw new Error("attachment preview is missing");
}

async function removePreview(client) {
  await evaluate(client, "document.querySelector('.attachment-remove').click()");
  await waitFor(client, "document.querySelectorAll('.attachment-preview').length === 0", "preview removal");
}

async function capture(client) {
  const screenshot = await client.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false
  });
  fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, "base64"));
}

const client = await openPage();
try {
  await loginIfNeeded(client, requireLoginConfig());
  await uploadImage(client);
  await checkLayout(client);
  await capture(client);
  await removePreview(client);
  console.log(`ui-smoke-ok ${screenshotPath}`);
} finally {
  client.close();
}
