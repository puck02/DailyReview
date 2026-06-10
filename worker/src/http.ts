export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export type RouteHandler = (request: Request, params: Record<string, string>) => Promise<Response> | Response;

export type Route = {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: RouteHandler;
};

export function route(method: string, path: string, handler: RouteHandler): Route {
  const keys: string[] = [];
  const source = path
    .replace(/\/:([^/]+)/g, (_match, key: string) => {
      keys.push(key);
      return "/([^/]+)";
    })
    .replace(/\//g, "\\/");
  return { method, pattern: new RegExp(`^${source}$`), keys, handler };
}

export async function dispatch(routes: Route[], request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  for (const item of routes) {
    if (item.method !== request.method) {
      continue;
    }
    const match = item.pattern.exec(url.pathname);
    if (!match) {
      continue;
    }
    const params: Record<string, string> = {};
    item.keys.forEach((key, index) => {
      params[key] = decodeURIComponent(match[index + 1] || "");
    });
    return await item.handler(request, params);
  }
  return null;
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init.headers || {})
    }
  });
}

export function empty(status = 204, init: ResponseInit = {}): Response {
  return new Response(null, { ...init, status });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return json({ detail: error.message }, { status: error.status });
  }
  if (error instanceof Error) {
    console.error("Unhandled request error", { name: error.name, message: error.message });
  } else {
    console.error("Unhandled request error", { valueType: typeof error });
  }
  return json({ detail: "服务器内部错误" }, { status: 500 });
}

export async function parseJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new HttpError(400, "请求格式无效");
  }
}

export function getCookie(request: Request, name: string): string | null {
  const cookie = request.headers.get("cookie") || "";
  for (const part of cookie.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return null;
}

export function sessionCookie(value: string, maxAge: number): string {
  return `session=${encodeURIComponent(value)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

export function expiredSessionCookie(): string {
  return "session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0";
}
