import { describe, expect, it, vi } from "vitest";

import { hashPassword, signSession, verifyPassword, verifySession } from "../src/auth/security";
import { cookieFrom, createTestEnv, fetchWorker } from "./helpers";

const LEGACY_HASH =
  "pbkdf2_sha256$240000$0123456789abcdef0123456789abcdef$d6f16137374d885080f468d07c645eba1b226a49f701c7ee1290ee85c7dc9d6a";

describe("auth security", () => {
  it("verifies Python PBKDF2 password hashes", async () => {
    await expect(verifyPassword("CorrectHorseBatteryStaple1!", LEGACY_HASH)).resolves.toBe(true);
  });

  it("rejects wrong passwords for PBKDF2 hashes", async () => {
    await expect(verifyPassword("wrong-password", LEGACY_HASH)).resolves.toBe(false);
  });

  it("verifies PBKDF2 hashes without WebCrypto deriveBits", async () => {
    const spy = vi.spyOn(crypto.subtle, "deriveBits").mockRejectedValue(new Error("deriveBits unavailable"));
    try {
      await expect(verifyPassword("CorrectHorseBatteryStaple1!", LEGACY_HASH)).resolves.toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("hashes new passwords using the compatible PBKDF2 format", async () => {
    const hash = await hashPassword("new-password-123");

    expect(hash).toMatch(/^pbkdf2_sha256\$240000\$[a-f0-9]{32}\$[a-f0-9]{64}$/);
    await expect(verifyPassword("new-password-123", hash)).resolves.toBe(true);
  });

  it("signs and verifies session tokens", async () => {
    const token = await signSession(42, "test-secret");

    await expect(verifySession(token, "test-secret")).resolves.toMatchObject({ userId: 42 });
  });
});

describe("auth and invite routes", () => {
  it("logs in the initial admin and reads current user from the session cookie", async () => {
    const env = createTestEnv();
    await fetchWorker(env, "/api/health");

    const login = await fetchWorker(env, "/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "admin@example.com", password: "admin-password" })
    });

    expect(login.status).toBe(200);
    const cookie = cookieFrom(login);
    const me = await fetchWorker(env, "/api/auth/me", {
      headers: { cookie }
    });
    await expect(me.json()).resolves.toMatchObject({ email: "admin@example.com", role: "admin" });
  });

  it("allows admins to create invites and blocks normal users from creating invites", async () => {
    const env = createTestEnv();
    await fetchWorker(env, "/api/health");
    const adminLogin = await fetchWorker(env, "/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "admin@example.com", password: "admin-password" })
    });
    const adminCookie = cookieFrom(adminLogin);

    const invite = await fetchWorker(env, "/api/invites", {
      method: "POST",
      headers: { cookie: adminCookie },
      body: JSON.stringify({ expires_days: 7 })
    });
    expect(invite.status).toBe(200);
    const inviteBody = (await invite.json()) as { code: string };
    expect(inviteBody.code).toHaveLength(24);

    const register = await fetchWorker(env, "/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ email: "user@example.com", password: "user-password", invite_code: inviteBody.code })
    });
    expect(register.status).toBe(200);
    const userCookie = cookieFrom(register);

    const blocked = await fetchWorker(env, "/api/invites", {
      method: "POST",
      headers: { cookie: userCookie },
      body: JSON.stringify({ expires_days: 7 })
    });

    expect(blocked.status).toBe(403);
    await expect(blocked.json()).resolves.toEqual({ detail: "需要管理员权限" });
  });
});
