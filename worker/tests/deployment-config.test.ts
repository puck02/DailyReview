import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const wranglerConfig = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");

describe("deployment config", () => {
  it("preserves dashboard-managed model variables across deploys", () => {
    expect(wranglerConfig).toMatch(/^keep_vars = true$/m);
    expect(wranglerConfig).not.toMatch(/^AI_(?:DEFAULT_MODEL|COMPLEX_MODEL|VISION_MODEL)\s*=/m);
  });

  it("propagates browser disconnects through incoming request signals", () => {
    expect(wranglerConfig).toMatch(/^compatibility_flags = \[.*"enable_request_signal".*\]$/m);
  });
});
