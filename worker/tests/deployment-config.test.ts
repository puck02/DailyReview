import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const wranglerConfig = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
const loadSmoke = readFileSync(new URL("./load/ten-users.mjs", import.meta.url), "utf8");
const deployWorkflow = readFileSync(
  new URL("../../.github/workflows/deploy-cloudflare-worker.yml", import.meta.url),
  "utf8"
);

describe("deployment config", () => {
  it("preserves dashboard-managed model variables across deploys", () => {
    expect(wranglerConfig).toMatch(/^keep_vars = true$/m);
    expect(wranglerConfig).not.toMatch(/^AI_(?:DEFAULT_MODEL|COMPLEX_MODEL|VISION_MODEL)\s*=/m);
  });

  it("propagates browser disconnects through incoming request signals", () => {
    expect(wranglerConfig).toMatch(/^compatibility_flags = \[.*"enable_request_signal".*\]$/m);
  });

  it("requires completed SSE streams and verifies per-session concurrency", () => {
    expect(loadSmoke).toContain("receivedDone");
    expect(loadSmoke).toContain("AI stream ended before [DONE]");
    expect(loadSmoke).toContain("verifySessionConcurrency");
    expect(loadSmoke).toMatch(/responses\.filter\(\(response\) => response\.status === 409\)/);
    expect(loadSmoke).toMatch(/successful\.length !== 1 \|\| conflicts\.length !== 1/);
  });

  it("classifies D1 migration failures without printing credentials", () => {
    expect(deployWorkflow).toContain("diagnostic=d1_auth_or_permission");
    expect(deployWorkflow).toContain("diagnostic=d1_schema_conflict");
    expect(deployWorkflow).not.toContain("printenv CLOUDFLARE_API_TOKEN");
  });
});
