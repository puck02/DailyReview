import { z } from "zod";

import type { Env } from "../env";
import { all, boolFromDb, boolToDb, first, insertAndReturnId, nowIso, type Row } from "../db/d1";
import {
  expiredSessionCookie,
  getCookie,
  HttpError,
  json,
  parseJson,
  route,
  sessionCookie,
  type Route
} from "../http";
import {
  hashPassword,
  isPasswordHashSupported,
  sessionMaxAgeSeconds,
  signSession,
  verifyPassword,
  verifySession
} from "./security";
import { scheduleUserReports } from "../report-scheduler";

type UserRow = Row & {
  id: number;
  email: string;
  password_hash: string;
  role: string;
  created_at: string;
};

type InviteRow = Row & {
  code: string;
  is_used: number;
  expires_at: string | null;
  created_at: string;
};

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
});

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  invite_code: z.string().min(1)
});

const createInviteSchema = z.object({
  expires_days: z.number().int().min(1).max(365).default(7)
});

function userResponse(user: UserRow): Record<string, unknown> {
  return { id: user.id, email: user.email, role: user.role };
}

function inviteResponse(invite: InviteRow): Record<string, unknown> {
  return {
    code: invite.code,
    is_used: boolFromDb(invite.is_used),
    expires_at: invite.expires_at,
    created_at: invite.created_at
  };
}

function tokenUrlSafe(bytes: number): string {
  const raw = new Uint8Array(bytes);
  crypto.getRandomValues(raw);
  return btoa(String.fromCharCode(...raw)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function findUserByEmail(env: Env, email: string): Promise<UserRow | null> {
  return await first<UserRow>(env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email.toLowerCase()));
}

async function findUserById(env: Env, id: number): Promise<UserRow | null> {
  return await first<UserRow>(env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id));
}

export async function ensureInitialAdmin(env: Env): Promise<void> {
  if (!env.ADMIN_EMAIL || !env.ADMIN_INITIAL_PASSWORD) {
    return;
  }
  const existing = await first<UserRow>(env.DB.prepare("SELECT * FROM users WHERE role = 'admin' LIMIT 1"));
  if (existing) {
    const isConfiguredAdmin = existing.email === env.ADMIN_EMAIL.toLowerCase();
    const needsPasswordReset =
      isConfiguredAdmin &&
      (!isPasswordHashSupported(existing.password_hash) ||
        !(await verifyPassword(env.ADMIN_INITIAL_PASSWORD, existing.password_hash)));
    if (needsPasswordReset) {
      await env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?")
        .bind(await hashPassword(env.ADMIN_INITIAL_PASSWORD), existing.id)
        .run();
    }
    return;
  }
  await env.DB.prepare("INSERT INTO users (email, password_hash, role, created_at) VALUES (?, ?, 'admin', ?)")
    .bind(env.ADMIN_EMAIL.toLowerCase(), await hashPassword(env.ADMIN_INITIAL_PASSWORD), nowIso())
    .run();
}

export async function requireUser(request: Request, env: Env): Promise<UserRow> {
  const token = getCookie(request, "session");
  if (!token) {
    throw new HttpError(401, "未登录");
  }
  let userId: number;
  try {
    userId = (await verifySession(token, env.SECRET_KEY)).userId;
  } catch (error) {
    throw new HttpError(401, "登录已失效");
  }
  const user = await findUserById(env, userId);
  if (!user) {
    throw new HttpError(401, "用户不存在");
  }
  return user;
}

export async function requireAdmin(request: Request, env: Env): Promise<UserRow> {
  const user = await requireUser(request, env);
  if (user.role !== "admin") {
    throw new HttpError(403, "需要管理员权限");
  }
  return user;
}

async function login(request: Request, env: Env): Promise<Response> {
  await ensureInitialAdmin(env);
  const payload = loginSchema.parse(await parseJson<unknown>(request));
  const user = await findUserByEmail(env, payload.email);
  if (!user || !(await verifyPassword(payload.password, user.password_hash))) {
    throw new HttpError(401, "邮箱或密码错误");
  }
  await scheduleUserReports(env, user.id);
  const token = await signSession(user.id, env.SECRET_KEY);
  return json(userResponse(user), {
    headers: { "set-cookie": sessionCookie(token, sessionMaxAgeSeconds) }
  });
}

async function register(request: Request, env: Env): Promise<Response> {
  const payload = registerSchema.parse(await parseJson<unknown>(request));
  const email = payload.email.toLowerCase();
  if (await findUserByEmail(env, email)) {
    throw new HttpError(400, "邮箱已注册");
  }
  const invite = await first<Row & { id: number; is_used: number; expires_at: string | null }>(
    env.DB.prepare("SELECT id, is_used, expires_at FROM invite_codes WHERE code = ?").bind(payload.invite_code)
  );
  const now = Date.now();
  if (!invite || boolFromDb(invite.is_used) || (invite.expires_at && Date.parse(invite.expires_at) < now)) {
    throw new HttpError(400, "邀请码无效");
  }
  const created = nowIso();
  const insert = await env.DB.prepare("INSERT INTO users (email, password_hash, role, created_at) VALUES (?, ?, 'user', ?)")
    .bind(email, await hashPassword(payload.password), created)
    .run();
  const userId = await insertAndReturnId(insert);
  await env.DB.prepare("UPDATE invite_codes SET is_used = 1, used_by_id = ? WHERE id = ?").bind(userId, invite.id).run();
  const user = await findUserById(env, userId);
  if (!user) {
    throw new HttpError(500, "服务器内部错误");
  }
  await scheduleUserReports(env, user.id);
  const token = await signSession(user.id, env.SECRET_KEY);
  return json(userResponse(user), {
    headers: { "set-cookie": sessionCookie(token, sessionMaxAgeSeconds) }
  });
}

function logout(): Response {
  return json({ status: "ok" }, { headers: { "set-cookie": expiredSessionCookie() } });
}

async function me(request: Request, env: Env): Promise<Response> {
  return json(userResponse(await requireUser(request, env)));
}

async function createInvite(request: Request, env: Env): Promise<Response> {
  const admin = await requireAdmin(request, env);
  const payload = createInviteSchema.parse(await parseJson<unknown>(request));
  const code = tokenUrlSafe(18);
  const expiresAt = new Date(Date.now() + payload.expires_days * 24 * 60 * 60 * 1000).toISOString();
  const createdAt = nowIso();
  await env.DB.prepare(
    "INSERT INTO invite_codes (code, created_by_id, is_used, expires_at, created_at) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(code, admin.id, boolToDb(false), expiresAt, createdAt)
    .run();
  return json({ code, is_used: false, expires_at: expiresAt, created_at: createdAt });
}

async function listInvites(request: Request, env: Env): Promise<Response> {
  await requireAdmin(request, env);
  const invites = await all<InviteRow>(
    env.DB.prepare("SELECT code, is_used, expires_at, created_at FROM invite_codes ORDER BY created_at DESC")
  );
  return json(invites.map(inviteResponse));
}

export function authRoutes(env: Env): Route[] {
  return [
    route("POST", "/api/auth/login", (request) => login(request, env)),
    route("POST", "/api/auth/register", (request) => register(request, env)),
    route("POST", "/api/auth/logout", () => logout()),
    route("GET", "/api/auth/me", (request) => me(request, env)),
    route("POST", "/api/invites", (request) => createInvite(request, env)),
    route("GET", "/api/invites", (request) => listInvites(request, env))
  ];
}
