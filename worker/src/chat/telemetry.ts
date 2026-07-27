export type ChatTelemetryContext = {
  requestId: string;
  turnId: string;
  sessionId: number;
  userId: number;
  model: string;
  startedAt: number;
};

type ChatTelemetryEvent = {
  phase: "start" | "finish" | "error";
  outcome: "started" | "complete" | "failed" | "cancelled";
  model?: string;
  outputChars?: number;
  errorType?: string;
};

export function createChatTelemetryContext(
  request: Request,
  turnId: string,
  sessionId: number,
  userId: number,
  model: string
): ChatTelemetryContext {
  const rayId = request.headers.get("cf-ray") || "";
  return {
    requestId: /^[a-zA-Z0-9-]{1,128}$/.test(rayId) ? rayId : crypto.randomUUID(),
    turnId,
    sessionId,
    userId,
    model,
    startedAt: Date.now()
  };
}

export function safeChatErrorType(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") return "upstream_timeout";
  if (error instanceof SyntaxError) return "invalid_upstream_payload";
  if (error instanceof Error && /interrupted|done/i.test(error.message)) return "stream_interrupted";
  if (error instanceof Error && /upstream|fetch|network|http|unavailable|timeout/i.test(error.message)) return "upstream_error";
  return "internal_error";
}

export function emitChatTelemetry(context: ChatTelemetryContext, event: ChatTelemetryEvent): void {
  console.log({
    event: "chat_generation",
    requestId: context.requestId,
    turnId: context.turnId,
    sessionId: context.sessionId,
    userId: context.userId,
    model: event.model || context.model,
    phase: event.phase,
    outcome: event.outcome,
    durationMs: Math.max(0, Date.now() - context.startedAt),
    outputChars: event.outputChars || 0,
    ...(event.errorType ? { errorType: event.errorType } : {})
  });
}
