import type { Env } from "./env";
import { errorResponse, json } from "./http";

async function handleApi(request: Request, _env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/api/health") {
    return json({ status: "ok", runtime: "cloudflare-workers" });
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
