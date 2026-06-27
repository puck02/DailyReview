import type { Env } from "./env";
import { adminRoutes } from "./admin/routes";
import { attachmentRoutes } from "./attachments/routes";
import { ensureInitialAdmin, authRoutes } from "./auth/routes";
import { chatRoutes } from "./chat/routes";
import { essayRoutes } from "./essay/routes";
import { dispatch, errorResponse, json } from "./http";
import { runScheduledJobs } from "./cron/jobs";
import { reportRoutes } from "./reports/routes";
import { settingsRoutes } from "./settings/routes";
import { translationRoutes } from "./translation/routes";

export { ReportScheduler } from "./report-scheduler";

function redirectToHttps(request: Request): Response | null {
  const url = new URL(request.url);
  const localHosts = new Set(["localhost", "127.0.0.1", "0.0.0.0"]);
  if (url.protocol !== "http:" || localHosts.has(url.hostname)) {
    return null;
  }
  url.protocol = "https:";
  return Response.redirect(url.toString(), 308);
}

async function handleApi(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/api/health") {
    await ensureInitialAdmin(env);
    return json({ status: "ok", runtime: "cloudflare-workers" });
  }
  const response = await dispatch(
    [
      ...authRoutes(env),
      ...settingsRoutes(env),
      ...adminRoutes(env),
      ...attachmentRoutes(env),
      ...chatRoutes(env),
      ...essayRoutes(env),
      ...translationRoutes(env),
      ...reportRoutes(env)
    ],
    request,
    ctx
  );
  if (response) {
    return response;
  }
  return json({ detail: "接口未实现" }, { status: 404 });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    try {
      const httpsRedirect = redirectToHttps(request);
      if (httpsRedirect) {
        return httpsRedirect;
      }
      if (url.pathname.startsWith("/api/")) {
        return await handleApi(request, env, ctx);
      }
      return env.ASSETS.fetch(request);
    } catch (error) {
      return errorResponse(error);
    }
  },
  async scheduled(event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    await runScheduledJobs(env, new Date(event.scheduledTime), event.cron);
  }
};
