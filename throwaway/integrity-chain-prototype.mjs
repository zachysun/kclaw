// PROTOTYPE — throwaway. 哈希链设计验证脚本，验证后结论折进 feat/session-integrity 实现。
// 问题：$prev 行内链 + meta 链头锚定，能否检出 spec 列出的全部篡改形态，且 fork/旧会话/撕裂尾兼容？
// 本轮修正：fork 复制段创世绑定源会话 → verify 以 session.forked 事件为新链身份起点；meta.id 核对堵整目录置换。
// 跑法：node throwaway/integrity-chain-prototype.mjs
import { createHash } from "node:crypto"
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { join } from "node:path"

const root = join(process.cwd(), "throwaway", ".proto-sessions")
rmSync(root, { recursive: true, force: true })

// ---- 可搬进真实代码的核心模块（store 写入 + verify） ----
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex")
const genesis = (sessionId) => sha(`kclaw-chain-v1:${sessionId}`)

const parseLine = (l) => { try { return JSON.parse(l) } catch { return null } }

function appendEvent(dir, sessionId, event) {
  const metaPath = join(dir, "meta.json")
  const eventsPath = join(dir, "events.jsonl")
  const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")) : null
  // 链头优先取 meta（零额外读）；meta 缺失/损坏回退读末行
  let prev
  if (meta?.chainHead) prev = meta.chainHead
  else {
    const raw = existsSync(eventsPath) ? readFileSync(eventsPath, "utf8") : ""
    const lines = raw.split("\n").filter((l) => l !== "")
    if (lines.length === 0) prev = genesis(sessionId)
    else {
      const last = parseLine(lines[lines.length - 1])
      // 末行带 $prev → 续链；末行无 $prev（旧会话升级）→ 新链从创世起，
      // 起点锚定不可伪造值，防止链中段伪造"新起点"
      prev = last !== null && last.$prev !== undefined ? sha(lines[lines.length - 1]) : genesis(sessionId)
    }
  }
  const line = JSON.stringify({ ...event, $prev: prev })
  const prior = existsSync(eventsPath) ? readFileSync(eventsPath, "utf8") : ""
  writeFileSync(eventsPath, prior + line + "\n")
  // chainLength = 文件总行数（含旧前缀），meta 缺失时数旧行
  const priorLines = prior.split("\n").filter((l) => l !== "").length
  writeFileSync(metaPath, JSON.stringify({ id: sessionId, chainHead: sha(line), chainLength: priorLines + 1 }))
}

function verify(dir, sessionId) {
  const eventsPath = join(dir, "events.jsonl")
  const metaPath = join(dir, "meta.json")
  if (!existsSync(eventsPath)) return { status: "not-chained", checked: 0 }
  const raw = readFileSync(eventsPath, "utf8")
  let lines = raw.split("\n")
  const tornTail = lines[lines.length - 1] !== "" // 末行无换行符 = 撕裂痕迹
  if (lines[lines.length - 1] === "") lines.pop()
  const meta = existsSync(metaPath) ? parseLine(readFileSync(metaPath, "utf8")) : null
  if (meta !== null && meta.id !== undefined && meta.id !== sessionId)
    return { status: "broken", reason: `session id mismatch: meta.id=${meta.id} expected=${sessionId}` }
  const parsed = lines.map(parseLine)
  if (tornTail && parsed[lines.length - 1] === null)
    return { status: "torn-tail", brokenAt: lines.length }
  const firstBad = parsed.indexOf(null)
  if (firstBad !== -1) return { status: "broken", brokenAt: firstBad + 1, reason: "unparsable line" }
  // fork 血缘：forked 链行之前存在链行 → 复制段用源会话创世验（复制段归源会话的链）；
  // 复制段无链（旧会话 fork）或无复制段 → 整条用本会话创世
  let forkAt = -1
  for (let i = 0; i < parsed.length; i++) if (parsed[i].type === "session.forked" && parsed[i].$prev !== undefined) { forkAt = i; break }
  const prefixHasChain = forkAt > 0 && parsed.slice(0, forkAt).some((p) => p.$prev !== undefined)
  const genesisId = prefixHasChain ? parsed[forkAt].sourceSessionId : sessionId
  let start = parsed.findIndex((p) => p.$prev !== undefined)
  if (start === -1) return { status: "not-chained", checked: 0 }
  if (parsed[start].$prev !== genesis(genesisId))
    return { status: "broken", brokenAt: start + 1, reason: `genesis mismatch (foreign stream?)` }
  let prev = parsed[start].$prev
  for (let i = start; i < lines.length; i++) {
    if (parsed[i].$prev !== prev) {
      if (i === lines.length - 1 && tornTail) return { status: "torn-tail", brokenAt: i + 1 }
      // 断裂在 i：被改的是 i-1 或 i（链语义：篡改行的下一行才报断）
      return { status: "broken", brokenAt: i + 1, suspect: i, reason: parsed[i].$prev === undefined ? "missing $prev" : "prev mismatch" }
    }
    prev = sha(lines[i])
  }
  if (meta) {
    if (meta.chainLength !== undefined && meta.chainLength !== lines.length)
      return { status: "broken", reason: `truncated: meta chainLength=${meta.chainLength} actual=${lines.length}` }
    if (meta.chainHead !== undefined && meta.chainHead !== sha(lines[lines.length - 1]))
      return { status: "broken", reason: "chain head mismatch (file changed after last meta write, or meta tampered)" }
  }
  return { status: start > 0 ? "partial" : "ok", verifiedFrom: start + 1, checked: lines.length - start }
}

// ---- 场景驱动 ----
const results = []
const check = (name, cond, detail) => results.push({ name, pass: cond, detail: detail ?? "" })
const newSession = (id) => { const dir = join(root, id); mkdirSync(dir, { recursive: true }); return dir }
const ev = (type, at, extra = {}) => ({ type, at, ...extra })

// S1 正常追加 → ok
{
  const d = newSession("s1"); const sid = "s1"
  appendEvent(d, sid, ev("session.created", "t0", { title: "S1" }))
  appendEvent(d, sid, ev("run.started", "t1", { trigger: "user" }))
  appendEvent(d, sid, ev("message", "t2", { id: "m1", blocks: [] }))
  const r = verify(d, sid)
  check("S1 正常链 ok", r.status === "ok" && r.checked === 3, JSON.stringify(r))
}
// S2 改中间一行 → broken + 行号
{
  const d = newSession("s2"); const sid = "s2"
  for (let i = 0; i < 5; i++) appendEvent(d, sid, ev("message", `t${i}`, { id: `m${i}` }))
  const raw = readFileSync(join(d, "events.jsonl"), "utf8").split("\n")
  const tampered = JSON.parse(raw[2]); tampered.id = "HACKED"; raw[2] = JSON.stringify(tampered)
  writeFileSync(join(d, "events.jsonl"), raw.join("\n"))
  const r = verify(d, sid)
  check("S2 改第3行 → broken 断在4/嫌第3行", r.status === "broken" && r.brokenAt === 4 && r.suspect === 3, JSON.stringify(r))
}
// S3 删中间一行 → broken
{
  const d = newSession("s3"); const sid = "s3"
  for (let i = 0; i < 5; i++) appendEvent(d, sid, ev("message", `t${i}`, { id: `m${i}` }))
  const raw = readFileSync(join(d, "events.jsonl"), "utf8").split("\n")
  raw.splice(2, 1)
  writeFileSync(join(d, "events.jsonl"), raw.join("\n"))
  const r = verify(d, sid)
  check("S3 删第3行 → broken", r.status === "broken", JSON.stringify(r))
}
// S4 删末尾两行 → chainLength 检出
{
  const d = newSession("s4"); const sid = "s4"
  for (let i = 0; i < 5; i++) appendEvent(d, sid, ev("message", `t${i}`, { id: `m${i}` }))
  const raw = readFileSync(join(d, "events.jsonl"), "utf8").split("\n")
  raw.splice(3, 2) // 保留前3行；剩链自洽但比 meta 记录短
  writeFileSync(join(d, "events.jsonl"), raw.join("\n"))
  const r = verify(d, sid)
  check("S4 删尾2行 → broken(truncated)", r.status === "broken" && /truncated/.test(r.reason ?? ""), JSON.stringify(r))
}
// S5 调换相邻两行 → broken
{
  const d = newSession("s5"); const sid = "s5"
  for (let i = 0; i < 5; i++) appendEvent(d, sid, ev("message", `t${i}`, { id: `m${i}` }))
  const raw = readFileSync(join(d, "events.jsonl"), "utf8").split("\n")
  ;[raw[1], raw[2]] = [raw[2], raw[1]]
  writeFileSync(join(d, "events.jsonl"), raw.join("\n"))
  const r = verify(d, sid)
  check("S5 调换2/3行 → broken", r.status === "broken", JSON.stringify(r))
}
// S6 换入别的会话的文件（连 meta 一起）→ meta.id 检出
{
  const dA = newSession("s6a"), sidA = "s6a"; for (let i = 0; i < 3; i++) appendEvent(dA, sidA, ev("message", `t${i}`, { id: `a${i}` }))
  const dB = newSession("s6b"), sidB = "s6b"; for (let i = 0; i < 3; i++) appendEvent(dB, sidB, ev("message", `t${i}`, { id: `b${i}` }))
  writeFileSync(join(dB, "events.jsonl"), readFileSync(join(dA, "events.jsonl"), "utf8"))
  writeFileSync(join(dB, "meta.json"), readFileSync(join(dA, "meta.json"), "utf8"))
  const r = verify(dB, sidB)
  check("S6 文件置换 → broken(id mismatch)", r.status === "broken" && /mismatch/.test(r.reason ?? ""), JSON.stringify(r))
}
// S6b 只换 events 不换 meta → 链头不符检出
{
  const dA = newSession("s6ba"), sidA = "s6ba"; for (let i = 0; i < 3; i++) appendEvent(dA, sidA, ev("message", `t${i}`, { id: `a${i}` }))
  const dB = newSession("s6bb"), sidB = "s6bb"; for (let i = 0; i < 3; i++) appendEvent(dB, sidB, ev("message", `t${i}`, { id: `b${i}` }))
  writeFileSync(join(dB, "events.jsonl"), readFileSync(join(dA, "events.jsonl"), "utf8"))
  const r = verify(dB, sidB)
  check("S6b 只换文件 → broken(genesis/head)", r.status === "broken", JSON.stringify(r))
}
// S7 旧前缀 + 新后缀 → partial
{
  const d = newSession("s7"); const sid = "s7"
  writeFileSync(join(d, "events.jsonl"), JSON.stringify(ev("session.created", "t0", { title: "old" })) + "\n" + JSON.stringify(ev("message", "t1", { id: "m0" })) + "\n")
  rmSync(join(d, "meta.json"), { force: true })
  appendEvent(d, sid, ev("message", "t2", { id: "m1" })) // 无 meta → 读末行续链，创世语义 = 本会话新链起点
  appendEvent(d, sid, ev("message", "t3", { id: "m2" }))
  const r = verify(d, sid)
  check("S7 旧前缀+新链 → partial verifiedFrom=3", r.status === "partial" && r.verifiedFrom === 3 && r.checked === 2, JSON.stringify(r))
}
// S8 纯旧会话 → not-chained
{
  const d = newSession("s8")
  writeFileSync(join(d, "events.jsonl"), JSON.stringify(ev("message", "t0", { id: "m0" })) + "\n")
  const r = verify(d, "s8")
  check("S8 纯旧会话 → not-chained", r.status === "not-chained", JSON.stringify(r))
}
// S9 末行撕裂 → torn-tail 非篡改
{
  const d = newSession("s9"); const sid = "s9"
  for (let i = 0; i < 4; i++) appendEvent(d, sid, ev("message", `t${i}`, { id: `m${i}` }))
  const raw = readFileSync(join(d, "events.jsonl"), "utf8")
  writeFileSync(join(d, "events.jsonl"), raw.slice(0, raw.length - 10)) // 砍掉末行尾巴
  const r = verify(d, sid)
  check("S9 末行撕裂 → torn-tail", r.status === "torn-tail", JSON.stringify(r))
}
// S9b 撕裂且 $prev 也被砍掉 → torn-tail
{
  const d = newSession("s9b"); const sid = "s9b"
  for (let i = 0; i < 4; i++) appendEvent(d, sid, ev("message", `t${i}`, { id: `m${i}` }))
  const raw = readFileSync(join(d, "events.jsonl"), "utf8").split("\n")
  const last = raw[3]
  writeFileSync(join(d, "events.jsonl"), raw.slice(0, 3).join("\n") + "\n" + last.slice(0, last.length - 80))
  const r = verify(d, sid)
  check("S9b 撕裂掉 $prev → torn-tail", r.status === "torn-tail", JSON.stringify(r))
}
// S10 fork 复制段续接 → ok（forked 行为新链身份起点）
{
  const dS = newSession("s10src"); const sidS = "s10src"
  for (let i = 0; i < 3; i++) appendEvent(dS, sidS, ev("message", `t${i}`, { id: `m${i}` }))
  const dF = newSession("s10fork"); const sidF = "s10fork"
  writeFileSync(join(dF, "events.jsonl"), readFileSync(join(dS, "events.jsonl"), "utf8")) // writeEventsRaw 逐字复制
  writeFileSync(join(dF, "meta.json"), readFileSync(join(dS, "meta.json"), "utf8").replace(`"id":"s10src"`, `"id":"s10fork"`))
  appendEvent(dF, sidF, ev("session.forked", "t9", { sourceSessionId: sidS, title: "F" })) // 续接复制段末行
  appendEvent(dF, sidF, ev("message", "t10", { id: "f1" }))
  const r = verify(dF, sidF)
  check("S10 fork 续链 → ok（复制段用源创世整条验）", r.status === "ok" && r.checked === 5, JSON.stringify(r))
}
// S10b fork 后篡改复制段 → broken（forked 行的 $prev 与被改行摘要不符）
{
  const dS = newSession("s10bsrc"); const sidS = "s10bsrc"
  for (let i = 0; i < 3; i++) appendEvent(dS, sidS, ev("message", `t${i}`, { id: `m${i}` }))
  const dF = newSession("s10bfork"); const sidF = "s10bfork"
  writeFileSync(join(dF, "events.jsonl"), readFileSync(join(dS, "events.jsonl"), "utf8"))
  writeFileSync(join(dF, "meta.json"), readFileSync(join(dS, "meta.json"), "utf8").replace(`"id":"s10bsrc"`, `"id":"s10bfork"`))
  appendEvent(dF, sidF, ev("session.forked", "t9", { sourceSessionId: sidS, title: "F" }))
  // 篡改复制段第2行
  const raw = readFileSync(join(dF, "events.jsonl"), "utf8").split("\n")
  const t = JSON.parse(raw[1]); t.id = "HACK"; raw[1] = JSON.stringify(t)
  writeFileSync(join(dF, "events.jsonl"), raw.join("\n"))
  const r = verify(dF, sidF)
  check("S10b fork 后改复制段 → broken 断在3", r.status === "broken" && r.brokenAt === 3, JSON.stringify(r))
}
// S11 meta 链头被改 → broken
{
  const d = newSession("s11"); const sid = "s11"
  for (let i = 0; i < 3; i++) appendEvent(d, sid, ev("message", `t${i}`, { id: `m${i}` }))
  const meta = JSON.parse(readFileSync(join(d, "meta.json"), "utf8")); meta.chainHead = sha("fake")
  writeFileSync(join(d, "meta.json"), JSON.stringify(meta))
  const r = verify(d, sid)
  check("S11 meta 链头被改 → broken", r.status === "broken" && /head/.test(r.reason ?? ""), JSON.stringify(r))
}
// S12 原文摘要 vs 重序列化：不同构造路径的同数据对象键序不同
{
  const a = {}; a.b = 1; a.a = 2
  const b = { a: 2, b: 1 }
  check("S12 重序列化会因键序假红（证明按行文本算的必要性）", JSON.stringify(a) !== JSON.stringify(b), `${JSON.stringify(a)} vs ${JSON.stringify(b)}`)
}

let fail = 0
for (const r of results) { if (!r.pass) fail++; console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.detail ? "  → " + r.detail : ""}`) }
console.log(`\n${results.length - fail}/${results.length} passed`)
rmSync(root, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)
