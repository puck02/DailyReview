import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { Options } from "react-markdown";

export const markdownRemarkPlugins: Options["remarkPlugins"] = [remarkGfm, remarkMath];
export const markdownRehypePlugins: Options["rehypePlugins"] = [
  rehypeKatex,
  [rehypeHighlight, { ignoreMissing: true, detect: true }]
];
