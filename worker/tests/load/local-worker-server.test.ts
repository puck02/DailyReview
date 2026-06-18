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
});
