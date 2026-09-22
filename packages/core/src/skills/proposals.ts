/**
 * Skill proposals: the pending-change sidecar of skill evolution (spec:
 * docs/superpowers/self-evolving-skill-spec.md). A proposal is a full
 * candidate SKILL.md (plus rationale and, for revisions, a baseline) stored
 * as one JSON file under `<skillsDir>/.proposals/` — a dot-prefixed directory
 * the skill scanner never treats as a skill (directory names must match
 * `^[a-z0-9]+(-[a-z0-9]+)*$`). Proposals NEVER touch the live skill
 * directories; the only path into them is an explicit human `apply`.
 *
 * Lifecycle: `proposed → applied | rejected`, `applied → reverted`;
 * `rejected`/`reverted` entries are kept until manually removed. Rollback
 * rides on the proposal file itself: before an apply overwrites a live
 * SKILL.md, the previous content is snapshotted into the proposal (`snapshot`)
 * — no git, no .bak files. A corrupt proposal file is skipped (with a log),
 * never allowed to break listing.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { writeFileAtomic } from "../storage/atomic.js"
import { linkedSkillNames } from "./links.js"
import { isSkillDirName } from "./names.js"

export interface SkillProposal {
  /** File name minus .json. */
  id: string
  status: "proposed" | "applied" | "rejected" | "reverted"
  kind: "new" | "revise"
  /** Target skill directory name (isSkillDirName-validated). */
  name: string
  scope: "global" | "project"
  /** Project root when scope=project (required there). */
  workdir?: string
  title: string
  /** Why this proposal exists (extracted experience / the model's argument). */
  rationale: string
  /** Revision-only: what changed and why (the human-readable diff narrative). */
  changes?: string
  /** Full candidate SKILL.md (frontmatter + body). */
  content: string
  /** Revision-only: the live content as seen when the proposal was written
   * (review-time对照展示; apply re-reads the file and snapshots THAT). */
  baseline?: string
  /** Revision-only: the live content captured at apply time, right before
   * the overwrite — the rollback source for `revert`. */
  snapshot?: string
  source: "follow" | "skill_create"
  /** Session the proposal is attributed to (follow: the scheduling session;
   * skill_create: the calling session). */
  sourceSessionId: string
  createdAt: string
  decidedAt?: string
  /** Apply timestamp — the start of the usage-telemetry window. */
  appliedAt?: string
}

export type SkillProposalResult =
  | { ok: true; proposal: SkillProposal; /** Non-fatal apply notice (e.g. a same-named project skill will shadow the global one). */ warning?: string }
  | { ok: false; error: string; /** true = an expected governance conflict (409 for the routes); false/absent = not found / broken state. */ conflict?: boolean }

export interface ProposalStoreDeps {
  proposalsDir: string
  /**
   * 落点目录解析：scope=global → 全局技能目录；scope=project → 该提案
   * workdir 的项目技能目录（调用方保证 workdir 存在）。生效写入与冲突
   * 检查都按这里解析出的目录执行。
   */
  resolveDir: (scope: "global" | "project", workdir?: string) => string
  log?: (m: string) => void
}

export class ProposalStore {
  readonly #dir: string
  readonly #resolveDir: ProposalStoreDeps["resolveDir"]
  readonly #log: (m: string) => void

  constructor(deps: ProposalStoreDeps) {
    this.#dir = deps.proposalsDir
    this.#resolveDir = deps.resolveDir
    this.#log = deps.log ?? ((m) => console.error(m))
  }

  /** 全部提案（按文件名字典序 ≈ 创建序）；单个损坏文件跳过并 log，不拖垮列表。 */
  list(): SkillProposal[] {
    if (!existsSync(this.#dir)) return []
    let names: string[]
    try {
      names = readdirSync(this.#dir).filter((n) => n.endsWith(".json")).sort()
    } catch {
      return []
    }
    const out: SkillProposal[] = []
    for (const f of names) {
      try {
        out.push(JSON.parse(readFileSync(join(this.#dir, f), "utf8")) as SkillProposal)
      } catch (e) {
        this.#log(`kclaw skills proposals: skipping corrupt file ${f}: ${String(e)}`)
      }
    }
    return out
  }

  get(id: string): SkillProposal | undefined {
    return this.list().find((p) => p.id === id)
  }

  #path(id: string): string {
    return join(this.#dir, `${id}.json`)
  }

  #save(p: SkillProposal): void {
    mkdirSync(this.#dir, { recursive: true })
    writeFileAtomic(this.#path(p.id), JSON.stringify(p, null, 2))
  }

  /**
   * 新提案（status=proposed）。id = `<createdEpochMs>-<name>`，同毫秒同名
   * 追加短随机后缀。名字与 content 在这里做最后一道校验（调用方各自已
   * 校验过；store 是防御性的——放行非法名字会造出扫描器/路由都定位不到
   * 的提案文件）。
   */
  create(fields: Omit<SkillProposal, "id" | "status" | "createdAt">): SkillProposal {
    if (!isSkillDirName(fields.name)) throw new Error(`invalid skill dir name: ${fields.name}`)
    if (fields.content === "") throw new Error("proposal content must not be empty")
    if (fields.scope === "project" && (fields.workdir === undefined || fields.workdir === "")) {
      throw new Error("scope=project requires workdir")
    }
    let id = `${Date.now()}-${fields.name}`
    if (existsSync(this.#path(id))) id = `${id}-${Math.random().toString(36).slice(2, 6)}`
    const p: SkillProposal = { ...fields, id, status: "proposed", createdAt: new Date().toISOString() }
    this.#save(p)
    return p
  }

  /**
   * proposed → applied：new 建目录写文件；revise 先存快照再覆盖。返回值可带
   * 非致命 warning（拼接为一条）：revise 的现正文与提案时 baseline 不一致
   * （第三方改动过，apply 以提案内容覆盖）；scope=global 且某已知项目目录
   * 有同名技能（项目副本将遮蔽全局版，shadowDirs 由调用方传入候选）。
   */
  apply(id: string, opts: { at?: string; shadowDirs?: string[] } = {}): SkillProposalResult {
    const p = this.get(id)
    if (p === undefined) return { ok: false, error: "提案不存在" }
    if (p.status !== "proposed") return { ok: false, error: `非法流转 ${p.status} → applied`, conflict: true }
    const root = this.#resolveDir(p.scope, p.workdir)
    if (linkedSkillNames(root).includes(p.name)) {
      return { ok: false, error: `目标是复用链接技能，由源目录维护：${p.name}`, conflict: true }
    }
    const target = join(root, p.name, "SKILL.md")
    const warnings: string[] = []
    if (p.kind === "new") {
      if (existsSync(target)) return { ok: false, error: `同名技能已存在：${p.name}`, conflict: true }
      mkdirSync(join(root, p.name), { recursive: true })
      writeFileAtomic(target, p.content)
    } else {
      if (!existsSync(target)) return { ok: false, error: `修订目标已不存在：${p.name}`, conflict: true }
      const current = readFileSync(target, "utf8")
      // 提案后正文已被第三方改动：不阻止 apply（决策权在用户按下的那一刻），
      // 但必须提示——覆盖的是提案内容，不是用户上次看到的那份。
      if (p.baseline !== undefined && p.baseline !== current) {
        warnings.push("提案后正文已被改动，本次生效以提案内容覆盖")
      }
      // 回滚快照 = 覆盖前的真实正文（可能与提案时的 baseline 有漂移——revert
      // 恢复的是 apply 前一刻的状态，不是提案时看到的状态）。
      p.snapshot = current
      writeFileAtomic(target, p.content)
    }
    p.status = "applied"
    p.decidedAt = opts.at ?? new Date().toISOString()
    p.appliedAt = p.decidedAt
    this.#save(p)
    // 遮蔽提示（读侧语义：项目覆盖全局）放在写入之后，apply 本身不受影响。
    if (p.scope === "global") {
      const shadow = (opts.shadowDirs ?? []).find((d) => existsSync(join(d, p.name, "SKILL.md")))
      if (shadow !== undefined) {
        warnings.push(`项目 ${shadow} 存在同名技能，将在该项目遮蔽全局版本`)
      }
    }
    return warnings.length === 0 ? { ok: true, proposal: p } : { ok: true, proposal: p, warning: warnings.join("；") }
  }

  /** proposed → rejected：只改状态，文件保留（日后可手动清理或重新捡起）。 */
  reject(id: string, opts: { at?: string } = {}): SkillProposalResult {
    const p = this.get(id)
    if (p === undefined) return { ok: false, error: "提案不存在" }
    if (p.status !== "proposed") return { ok: false, error: `非法流转 ${p.status} → rejected`, conflict: true }
    p.status = "rejected"
    p.decidedAt = opts.at ?? new Date().toISOString()
    this.#save(p)
    return { ok: true, proposal: p }
  }

  /** applied → reverted：revise 把快照写回；new 删除已生效的技能目录本身。 */
  revert(id: string, opts: { at?: string } = {}): SkillProposalResult {
    const p = this.get(id)
    if (p === undefined) return { ok: false, error: "提案不存在" }
    if (p.status !== "applied") return { ok: false, error: `非法流转 ${p.status} → reverted`, conflict: true }
    const root = this.#resolveDir(p.scope, p.workdir)
    if (p.kind === "revise") {
      if (p.snapshot === undefined) return { ok: false, error: "提案缺少回滚快照，无法回滚" }
      writeFileAtomic(join(root, p.name, "SKILL.md"), p.snapshot)
    } else {
      rmSync(join(root, p.name), { recursive: true, force: true }) // 只删该技能目录本身
    }
    p.status = "reverted"
    p.decidedAt = opts.at ?? new Date().toISOString()
    this.#save(p)
    return { ok: true, proposal: p }
  }

  /** 仅 rejected/reverted 可删（删提案文件）；其余状态 409 语义。 */
  remove(id: string): SkillProposalResult {
    const p = this.get(id)
    if (p === undefined) return { ok: false, error: "提案不存在" }
    if (p.status !== "rejected" && p.status !== "reverted") {
      return { ok: false, error: `仅 rejected/reverted 提案可删除（当前 ${p.status}）`, conflict: true }
    }
    rmSync(this.#path(p.id), { force: true })
    return { ok: true, proposal: p }
  }
}
