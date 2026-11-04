/**
 * 提示词寄居守卫：内置提示词文本统一存放 prompts/，实现文件里出现
 * "多行中文字符串字面量"形态的文本即失败（四类特征在收拢前的真实源码上
 * 验证过：九处提示词全覆盖、白名单外零漏报）。
 * 白名单只收非提示词文本：工具描述与输出（tools/，按设计不收拢）、
 * 沙箱命令包装、通知文案模板、CLI 帮助、项目记忆表格。
 */
import { describe, expect, it } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const SRC_ROOT = fileURLToPath(new URL("..", import.meta.url))

/** 目录级白名单：整目录豁免（相对 SRC_ROOT）。 */
const DIRECTORY_ALLOW = new Set(["tools", "sandbox", "notify"])
/** 文件级白名单（相对 SRC_ROOT）。 */
const FILE_ALLOW = new Set(["commands.ts"])
/** 行级白名单：文件 + 行内特征串（防止行号漂移）。前两条是合法拼装点：
 *  文本本体已在 prompts/，行内引用 prompts 导出常量做数组 join。 */
const LINE_ALLOW: Array<{ file: string; contains: string }> = [
  { file: "agent/context.ts", contains: "SUMMARY_PREAMBLE" }, // 摘要注入包装与 token 估算基准
  { file: "agent/run-assembly.ts", contains: "TOOL_DIRECTORY" }, // 工具目录段组装（prompts/system.ts 文本）
  { file: "memory/threads.ts", contains: "| topic |" }, // 项目记忆 markdown 表格（CLI 展示）
]

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      if (name === "prompts") continue // 提示词本体所在地，扫描其余实现文件
      out.push(...walk(p))
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
      out.push(p)
    }
  }
  return out
}

const HAS_CN = /[\u4e00-\u9fff]/
// D 特征的提示词起手式（autoname 这类短提示词的唯一可抓特征）。
const PROMPT_OPENERS = /^(你是|只输出|请把|以下是)/

function collectHits(): string[] {
  const hits: string[] = []
  for (const file of walk(SRC_ROOT)) {
    const rel = relative(SRC_ROOT, file)
    if (DIRECTORY_ALLOW.has(rel.split(/[/\\]/)[0]!)) continue
    if (FILE_ALLOW.has(rel)) continue
    const lines = readFileSync(file, "utf8").split("\n")
    // 命中行连同上方 5 行一起匹配白名单：].join 闭合行本身不含 prompts 常量名（在数组起始行）。
    const allowedLine = (i: number): boolean => {
      const window = lines.slice(Math.max(0, i - 5), i + 1).join("\n")
      return LINE_ALLOW.some((w) => w.file === rel && window.includes(w.contains))
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      // A. 数组字面量直接 join（提示词段数组的惯用形态）
      if (/\]\s*\.join\("\\n"\)/.test(line) && !allowedLine(i)) hits.push(`A ${rel}:${i + 1}`)
      // C/D. 字符串字面量：长中文串 / 提示词起手式
      const literals = line.match(/"([^"\\]|\\.)*"|'([^'\\]|\\.)*'/g) ?? []
      for (const s of literals) {
        if (allowedLine(i)) continue
        if (s.length >= 52 && HAS_CN.test(s)) {
          hits.push(`C ${rel}:${i + 1}（${s.slice(1, 31)}…）`)
          break
        }
        if (PROMPT_OPENERS.test(s.slice(1))) {
          hits.push(`D ${rel}:${i + 1}（${s.slice(1, 31)}…）`)
          break
        }
      }
    }

    // B. 跨行反引号模板串含中文
    let i = 0
    while (i < lines.length) {
      const line = lines[i]!
      if ((line.match(/`/g) ?? []).length % 2 === 1 && HAS_CN.test(line) && !allowedLine(i)) {
        let j = i + 1
        while (j < lines.length && !lines[j]!.includes("`")) j++
        if (j < lines.length && j > i) {
          hits.push(`B ${rel}:${i + 1} 模板串跨行 ${j - i + 1} 行`)
          i = j
        }
      }
      i++
    }
  }
  return hits
}

describe("提示词寄居守卫", () => {
  it("实现文件里不出现提示词形态的文本", () => {
    expect(collectHits()).toEqual([])
  })
})
