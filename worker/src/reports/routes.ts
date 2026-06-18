import { z } from "zod";

import { requireUser } from "../auth/routes";
import type { Env } from "../env";
import { HttpError, json, route, type Route } from "../http";
import {
  processReportPdfQueue,
  readReportPdf,
  refreshReportPdfCache,
  reportById,
  reportContent,
  reportListItem,
  reportsForUser
} from "./service";

const reportTypeSchema = z.enum(["daily", "weekly", "monthly"]);

function pdfResponse(pdf: ArrayBuffer, filename: string): Response {
  return new Response(pdf, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

async function listReports(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const user = await requireUser(request, env);
  const url = new URL(request.url);
  const reportType = reportTypeSchema.parse(url.searchParams.get("report_type") || "daily");
  const month = url.searchParams.get("month");
  const reports = await reportsForUser(env, user.id, reportType, month);
  return json(reports.map(reportListItem));
}

async function getReport(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const user = await requireUser(request, env);
  const id = Number.parseInt(params.report_id || "", 10);
  const report = Number.isFinite(id) ? await reportById(env, id) : null;
  if (!report || report.user_id !== user.id) {
    throw new HttpError(404, "报告不存在");
  }
  return json(await reportContent(env, report));
}

async function getReportPdf(request: Request, env: Env, params: Record<string, string>, ctx?: ExecutionContext): Promise<Response> {
  const user = await requireUser(request, env);
  const id = Number.parseInt(params.report_id || "", 10);
  const report = Number.isFinite(id) ? await reportById(env, id) : null;
  if (!report || report.user_id !== user.id) {
    throw new HttpError(404, "报告不存在");
  }
  const filename = `${report.period}-${report.report_type}.pdf`;
  const title = `${report.period} ${report.report_type}`;
  const cached = await readReportPdf(env, report);
  if (cached) {
    return pdfResponse(cached, filename);
  }
  if (env.BROWSER) {
    ctx?.waitUntil(refreshReportPdfCache(env, report, title));
  }
  return json(
    { detail: "PDF 正在生成，请稍后重试" },
    {
      status: 503,
      headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
      }
    }
  );
}

export function reportRoutes(env: Env): Route[] {
  return [
    route("GET", "/api/reports", (request, params, ctx) => listReports(request, env, ctx)),
    route("GET", "/api/reports/:report_id/pdf", (request, params, ctx) => getReportPdf(request, env, params, ctx)),
    route("GET", "/api/reports/:report_id", (request, params, ctx) => getReport(request, env, params))
  ];
}
