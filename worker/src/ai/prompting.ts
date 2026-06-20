import type { ChatMessage } from "./client";

export const MATH_MARKDOWN_PROTOCOL = `数学公式输出规范：
- 行内公式只使用 $...$，例如 $f'(1)=6$。
- 独立成行或多行推导只使用 $$...$$。
- 不要使用 \\(...\\)、\\[...\\]、\\$...$ 或 Markdown 代码反引号包裹公式。
- 不要输出裸露的 \\frac、\\lim、\\sqrt 等 LaTeX 命令；它们必须放在 $...$ 或 $$...$$ 内。
- 普通斜杠分隔（如 中文 / English、A/B 测试、登录/注册）保持普通文本，不要当作分式。`;

export function withMathMarkdownProtocol(messages: ChatMessage[]): ChatMessage[] {
  return [{ role: "system", content: MATH_MARKDOWN_PROTOCOL }, ...messages];
}
