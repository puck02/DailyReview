import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

let server: ChildProcessWithoutNullStreams | null = null;

async function stopServer(): Promise<void> {
  if (!server || server.exitCode !== null) {
    server = null;
    return;
  }
  const active = server;
  await new Promise<void>((resolve) => {
    active.once("exit", () => resolve());
    active.kill("SIGTERM");
    setTimeout(() => {
      if (active.exitCode === null) {
        active.kill("SIGKILL");
      }
      resolve();
    }, 1_000).unref();
  });
  server = null;
}

async function fetchHealth(port: number): Promise<Response | null> {
  try {
    return await fetch(`http://127.0.0.1:${port}/api/health`);
  } catch {
    return null;
  }
}

describe("local load server", () => {
  afterEach(async () => {
    await stopServer();
  });

  it("serves the bundled Worker health endpoint", async () => {
    const port = 18_000 + Math.floor(Math.random() * 1_000);
    let output = "";
    server = spawn(process.execPath, ["tests/load/local-worker-server.mjs"], {
      cwd: new URL("../..", import.meta.url),
      env: { ...process.env, PORT: String(port) }
    });
    server.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    server.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });

    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (server.exitCode !== null) {
        throw new Error(output);
      }
      const health = await fetchHealth(port);
      if (health?.ok) {
        await expect(health.json()).resolves.toMatchObject({ status: "ok", runtime: "cloudflare-workers" });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    throw new Error(output || "local load server did not become ready");
  }, 15_000);

  it("supports batched attachment updates during chat", async () => {
    const port = 18_000 + Math.floor(Math.random() * 1_000);
    let output = "";
    server = spawn(process.execPath, ["tests/load/local-worker-server.mjs"], {
      cwd: new URL("../..", import.meta.url),
      env: { ...process.env, PORT: String(port) }
    });
    server.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    server.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });

    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (server.exitCode !== null) {
        throw new Error(output);
      }
      if ((await fetchHealth(port))?.ok) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    const baseUrl = `http://127.0.0.1:${port}`;
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "admin@example.com", password: "admin-password" })
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")?.split(";", 1)[0] || "";

    const sessionResponse = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ title: "batch-test", model: "gpt-5.4-mini" })
    });
    expect(sessionResponse.status).toBe(200);
    const session = await sessionResponse.json<{ id: number }>();

    const form = new FormData();
    form.append(
      "file",
      new Blob([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], { type: "image/png" }),
      "test.png"
    );
    const attachmentResponse = await fetch(`${baseUrl}/api/attachments`, {
      method: "POST",
      headers: { cookie },
      body: form
    });
    expect(attachmentResponse.status).toBe(200);
    const attachment = await attachmentResponse.json<{ id: number }>();

    const chatResponse = await fetch(`${baseUrl}/api/chat/stream`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        session_id: session.id,
        content: "test",
        model: "gpt-5.4-mini",
        attachment_ids: [attachment.id]
      })
    });
    expect(chatResponse.status).toBe(200);
    await expect(chatResponse.text()).resolves.toContain("data: [DONE]");
  }, 15_000);
});
