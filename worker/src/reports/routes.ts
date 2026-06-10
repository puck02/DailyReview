import { z } from "zod";

import { requireUser } from "../auth/routes";
import type { Env } from "../env";
import { HttpError, json, route, type Route } from "../http";
import { PDF_DOWNGRADE_MESSAGE, reportById, reportContent, reportListItem, reportsForUser } from "./service";

const reportTypeSchema = z.enum(["daily", "weekly", "monthly"]);

async function listReports(request: Request, env: Env): Promise<Response> {
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

async function getReportPdf(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const user = await requireUser(request, env);
  const id = Number.parseInt(params.report_id || "", 10);
  const report = Number.isFinite(id) ? await reportById(env, id) : null;
  if (!report || report.user_id !== user.id) {
    throw new HttpError(404, "报告不存在");
  }
  return json({ detail: PDF_DOWNGRADE_MESSAGE }, { status: 501 });
}

export function reportRoutes(env: Env): Route[] {
  return [
    route("GET", "/api/reports", (request) => listReports(request, env)),
    route("GET", "/api/reports/:report_id/pdf", (request, params) => getReportPdf(request, env, params)),
    route("GET", "/api/reports/:report_id", (request, params) => getReport(request, env, params))
  ];
}
