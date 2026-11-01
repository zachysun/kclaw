/**
 * Syntax highlighting for the diff/code views: highlight.js registered
 * lazily-but-explicitly (lib/core + the languages this UI actually shows),
 * so the bundle stays lean and imports never rely on a transitive dep.
 */
import hljs from "highlight.js/lib/core"
import bash from "highlight.js/lib/languages/bash"
import css from "highlight.js/lib/languages/css"
import go from "highlight.js/lib/languages/go"
import javascript from "highlight.js/lib/languages/javascript"
import json from "highlight.js/lib/languages/json"
import markdown from "highlight.js/lib/languages/markdown"
import python from "highlight.js/lib/languages/python"
import rust from "highlight.js/lib/languages/rust"
import typescript from "highlight.js/lib/languages/typescript"
import xml from "highlight.js/lib/languages/xml"
import yaml from "highlight.js/lib/languages/yaml"

let registered = false

function registerOnce(): void {
  if (registered) return
  registered = true
  hljs.registerLanguage("typescript", typescript)
  hljs.registerLanguage("javascript", javascript)
  hljs.registerLanguage("json", json)
  hljs.registerLanguage("xml", xml)
  hljs.registerLanguage("css", css)
  hljs.registerLanguage("bash", bash)
  hljs.registerLanguage("markdown", markdown)
  hljs.registerLanguage("yaml", yaml)
  hljs.registerLanguage("python", python)
  hljs.registerLanguage("rust", rust)
  hljs.registerLanguage("go", go)
}

/** File extension → highlight.js language, undefined when not one we ship. */
export function langFromPath(path: string): string | undefined {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase()
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
    js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    json: "json",
    html: "xml", htm: "xml", xml: "xml", svg: "xml",
    css: "css", scss: "css", less: "css",
    sh: "bash", bash: "bash", zsh: "bash",
    md: "markdown", markdown: "markdown",
    yml: "yaml", yaml: "yaml",
    py: "python", rs: "rust", go: "go",
  }
  return map[ext]
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/** Highlight one line of code; falls back to escaped plain text for unknown languages. */
export function highlightLine(text: string, lang: string | undefined): string {
  if (lang === undefined) return escapeHtml(text)
  registerOnce()
  try {
    return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value
  } catch {
    return escapeHtml(text)
  }
}
