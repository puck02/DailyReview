export type ContextMessage = {
  id: number;
  role: string;
  content: string;
  status: "pending" | "streaming" | "complete" | "failed" | "cancelled";
};

export const CHAT_CONTEXT_MAX_MESSAGES = 120;
export const CHAT_CONTEXT_MAX_CHARS = 80_000;

export function selectChatContext(messages: ContextMessage[]): ContextMessage[] {
  const candidates = messages
    .slice(-CHAT_CONTEXT_MAX_MESSAGES)
    .filter((message) => message.role !== "assistant" || !["pending", "streaming", "failed"].includes(message.status));
  let newestUserIndex = -1;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    if (candidates[index]?.role === "user") {
      newestUserIndex = index;
      break;
    }
  }
  if (newestUserIndex < 0) return [];

  const selected: ContextMessage[] = [];
  let characterCount = 0;
  for (let index = newestUserIndex; index >= 0; index -= 1) {
    const candidate = candidates[index];
    if (!candidate || characterCount + candidate.content.length > CHAT_CONTEXT_MAX_CHARS) break;
    selected.unshift(candidate);
    characterCount += candidate.content.length;
  }
  while (selected[0]?.role === "assistant") selected.shift();
  return selected;
}
