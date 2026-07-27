import { describe, expect, it } from "vitest";

import { selectChatContext, type ContextMessage } from "../src/chat/context";

function message(id: number, role: "user" | "assistant", content: string, status: ContextMessage["status"] = "complete"): ContextMessage {
  return { id, role, content, status };
}

describe("chat context selection", () => {
  it("keeps at most 120 recent candidates within an 80000 character budget", () => {
    const messages = Array.from({ length: 141 }, (_, index) =>
      message(index, index % 2 === 0 ? "user" : "assistant", `${String(index).padStart(3, "0")}${"x".repeat(997)}`)
    );

    const selected = selectChatContext(messages);

    expect(selected.length).toBeLessThanOrEqual(120);
    expect(selected.reduce((total, item) => total + item.content.length, 0)).toBeLessThanOrEqual(80_000);
    expect(selected.at(-1)?.id).toBe(140);
  });

  it("removes an assistant orphaned by the character budget", () => {
    const latest = message(3, "user", "最新问题");
    const selected = selectChatContext([
      message(1, "user", "x".repeat(79_995)),
      message(2, "assistant", "上一条回答"),
      latest
    ]);

    expect(selected).toEqual([latest]);
  });

  it("excludes pending streaming and failed assistant messages", () => {
    const selected = selectChatContext([
      message(1, "user", "问题一"),
      message(2, "assistant", "未开始", "pending"),
      message(3, "assistant", "未结束", "streaming"),
      message(4, "assistant", "错误提示", "failed"),
      message(5, "user", "问题二")
    ]);

    expect(selected.map((item) => item.id)).toEqual([1, 5]);
  });

  it("preserves the newest user message before newer assistant content", () => {
    const latest = message(1, "user", "必须保留的问题");
    const selected = selectChatContext([
      latest,
      message(2, "assistant", "x".repeat(80_000))
    ]);

    expect(selected).toEqual([latest]);
  });
});
