import { z } from "zod";

import type { Env } from "../env";
import { json, parseJson, route, type Route } from "../http";
import { requireUser } from "../auth/routes";
import { scheduleUserReports } from "../report-scheduler";
import {
  getAppSettings,
  setGlobalWordCloudEnabled,
  setUserReportSettings,
  validateReportTime,
  validateWeeklyReportDay
} from "./report-settings";

const settingsSchema = z.object({
  daily_report_time: z.string(),
  weekly_report_time: z.string(),
  weekly_report_day: z.string(),
  word_cloud_enabled: z.boolean()
});

async function readSettings(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  return json(await getAppSettings(env, user.id));
}

async function updateSettings(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  const payload = settingsSchema.parse(await parseJson<unknown>(request));
  const dailyReportTime = validateReportTime(payload.daily_report_time);
  const weeklyReportTime = validateReportTime(payload.weekly_report_time);
  const weeklyReportDay = validateWeeklyReportDay(payload.weekly_report_day);
  await setUserReportSettings(env, user.id, {
    daily_report_time: dailyReportTime,
    weekly_report_time: weeklyReportTime,
    weekly_report_day: weeklyReportDay
  });
  if (user.role === "admin") {
    await setGlobalWordCloudEnabled(env, payload.word_cloud_enabled);
  }
  await scheduleUserReports(env, user.id);
  return json(await getAppSettings(env, user.id));
}

export function settingsRoutes(env: Env): Route[] {
  return [
    route("GET", "/api/settings", (request) => readSettings(request, env)),
    route("PUT", "/api/settings", (request) => updateSettings(request, env))
  ];
}
