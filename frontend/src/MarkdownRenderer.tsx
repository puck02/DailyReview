import { ReactNode, isValidElement, useMemo, useState } from "react";
import ReactMarkdown, { Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { Check, Copy } from "lucide-react";

import { normalizeMarkdownMath } from "./markdown";

type MarkdownRendererProps = {
  markdown: string;
  className: string;
  copyable?: boolean;
};

function safeMarkdownUrl(href: string) {
  try {
    const url = new URL(href, window.location.origin);
    if (["http:", "https:", "mailto:"].includes(url.protocol)) return href;
  } catch {
    return "";
  }
  return "";
}

function markdownTextFromNode(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(markdownTextFromNode).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return markdownTextFromNode(node.props.children);
  return "";
}

async function copyMarkdownText(text: string) {
  const value = text.trim();
  if (!value) return false;
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return true;
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  return copied;
}

function CopyableMarkdownBlock({
  children,
  text,
  className = ""
}: {
  children: ReactNode;
  text: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    if (!(await copyMarkdownText(text))) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  return (
    <div className={`copyable-markdown-block ${className}`}>
      {children}
      <button
        type="button"
        className={copied ? "copy-block-button copied" : "copy-block-button"}
        onClick={handleCopy}
        aria-label={copied ? "已复制" : "复制此块"}
        title={copied ? "已复制" : "复制"}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
    </div>
  );
}

function copyableComponents(copyable: boolean): Components {
  return {
    a({ href = "", children }) {
      const safeHref = safeMarkdownUrl(href);
      if (!safeHref) return <>{children}</>;
      return (
        <a href={safeHref} rel="noreferrer" target="_blank">
          {children}
        </a>
      );
    },
    h1({ children }) {
      return <h1>{children}</h1>;
    },
    h2({ children }) {
      return <h2>{children}</h2>;
    },
    h3({ children }) {
      return <h3>{children}</h3>;
    },
    p({ children }) {
      return <p>{children}</p>;
    },
    code({ className, children, node: _node, ...props }) {
      const isMath = className?.includes("language-math");
      const isInlineMath = className?.includes("math-inline");
      return (
        <code
          className={
            isMath
              ? isInlineMath
                ? "markdown-math-inline"
                : "markdown-math-block"
              : className
                ? `markdown-inline-code ${className}`
                : "markdown-inline-code"
          }
          {...props}
        >
          {children}
        </code>
      );
    },
    pre({ children }) {
      const code = <pre className="markdown-code">{children}</pre>;
      if (!copyable) return code;
      return (
        <CopyableMarkdownBlock className="copyable-code-block" text={markdownTextFromNode(children)}>
          {code}
        </CopyableMarkdownBlock>
      );
    },
    table({ children }) {
      return (
        <div className="markdown-table-wrap">
          <table className="markdown-table">{children}</table>
        </div>
      );
    },
    ul({ children }) {
      return <ul className="markdown-list">{children}</ul>;
    },
    ol({ children }) {
      return <ol className="markdown-list">{children}</ol>;
    },
    blockquote({ children }) {
      return <blockquote>{children}</blockquote>;
    }
  };
}

export default function MarkdownRenderer({ markdown, className, copyable = false }: MarkdownRendererProps) {
  const normalizedMarkdown = normalizeMarkdownMath(markdown);
  const components = useMemo(() => copyableComponents(copyable), [copyable]);
  return (
    <div className={className}>
      <ReactMarkdown
        key={normalizedMarkdown}
        components={components}
        rehypePlugins={[rehypeKatex, [rehypeHighlight, { ignoreMissing: true, detect: true }]]}
        remarkPlugins={[remarkGfm, remarkMath]}
        skipHtml
        urlTransform={(url) => safeMarkdownUrl(url)}
      >
        {normalizedMarkdown}
      </ReactMarkdown>
    </div>
  );
}
