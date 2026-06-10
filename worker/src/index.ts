import type { Env } from "./env";
import { adminRoutes } from "./admin/routes";
import { ensureInitialAdmin, authRoutes } from "./auth/routes";
import { dispatch, errorResponse, json } from "./http";
import { settingsRoutes } from "./settings/routes";

async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/api/health") {
    await ensureInitialAdmin(env);
    return json({ status: "ok", runtime: "cloudflare-workers" });
  }
  const response = await dispatch([...authRoutes(env), ...settingsRoutes(env), ...adminRoutes(env)], request);
  if (response) {
    return response;
  }
  return json({ detail: "接口未实现" }, { status: 404 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/api/")) {
        return await handleApi(request, env);
      }
      return env.ASSETS.fetch(request);
    } catch (error) {
      return errorResponse(error);
    }
  },
  async scheduled(_event: ScheduledEvent, _env: Env): Promise<void> {
    return;
  }
};
