/**
 * MarkdownText — renders an assistant text block as structured Markdown
 * (GFM tables, task lists, strikethrough included). Raw HTML never renders:
 * react-markdown skips it by default, so markup smuggled inside model output
 * stays inert text rather than becoming a second injection channel. Code
 * fences get highlight.js token classes (themed in index.css) and a copy
 * button; links open in a new tab so a chat message never navigates away
 * from the live session.
 */
import { useEffect, useRef, useState, type ReactNode } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import rehypeHighlight from "rehype-highlight"

const components: Components = {
  pre: CodeBlock,
  a: ({ node, ...rest }) => <a {...rest} target="_blank" rel="noreferrer" />,
}

export function MarkdownText({ text }: { text: string }) {
  return (
    <div className="md" data-testid="blk-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

/**
 * One fenced code block. The wrapper div is what carries the copy button;
 * keeping the button a SIBLING of the <pre> (not a child) keeps it out of
 * the copied text.
 */
function CodeBlock({ children }: { children?: ReactNode }) {
  const preRef = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)
  // The "已复制" flip resets after a beat; the pending timer is cancelled on
  // unmount so a late tick never lands on a dead component.
  const timerRef = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timerRef.current), [])

  const copy = (): void => {
    // The fence syntax guarantees one trailing newline inside the block —
    // strip that artifact, keep every interior byte exact.
    const text = (preRef.current?.textContent ?? "").replace(/\n$/, "")
    // Optional chaining guards the whole chain: where the clipboard API is
    // missing (denied permission, insecure context, old webview) the click is
    // a quiet no-op instead of a crash.
    navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(true)
        timerRef.current = window.setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => {
        // Write rejected — stay on the 复制 label.
      })
  }

  return (
    <div className="md-code" data-testid="code-block">
      <pre ref={preRef}>{children}</pre>
      <button type="button" className="code-copy" data-testid="code-copy" onClick={copy}>
        {copied ? "已复制" : "复制"}
      </button>
    </div>
  )
}
