import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, join, resolve } from "node:path"
import { writeFileAtomic } from "../storage/atomic.js"

/** 项目标识 = <目录名>-<绝对路径 SHA-1 前 6 位>（spec 2.1）：确定性、可读、唯一。 */
export function projectIdFor(workdir: string): string {
  const abs = resolve(workdir)
  const hash = createHash("sha1").update(abs).digest("hex").slice(0, 6)
  return `${basename(abs) || "project"}-${hash}`
}

/** 记忆塔目录布局：global/（L2）与 projects/<id>/（L1），见 spec 2.1。 */
export class MemoryLayout {
  readonly globalDir: string
  readonly projectsDir: string

  constructor(memoryDir: string) {
    this.globalDir = join(memoryDir, "global")
    this.projectsDir = join(memoryDir, "projects")
    mkdirSync(join(this.globalDir, "wiki"), { recursive: true })
    mkdirSync(join(this.globalDir, "rule"), { recursive: true })
    mkdirSync(this.projectsDir, { recursive: true })
  }

  projectDir(id: string): string {
    return join(this.projectsDir, id)
  }

  /** 惰性创建：项目首次产生记忆时建目录并落 workdir.txt（人可读映射）。 */
  ensureProject(workdir: string): { id: string; dir: string } {
    const id = projectIdFor(workdir)
    const dir = this.projectDir(id)
    mkdirSync(dir, { recursive: true })
    const marker = join(dir, "workdir.txt")
    if (!existsSync(marker)) writeFileAtomic(marker, resolve(workdir))
    return { id, dir }
  }

  resolveProject(workdir: string): { id: string; dir: string } {
    const { id } = this.ensureProject(workdir) // 读侧也统一走 ensure：目录无记忆时创建空目录无害且幂等
    return { id, dir: this.projectDir(id) }
  }

  listProjectIds(): string[] {
    return readdirSync(this.projectsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
  }

  workdirOf(id: string): string | undefined {
    try {
      return readFileSync(join(this.projectDir(id), "workdir.txt"), "utf8").trim()
    } catch {
      return undefined
    }
  }
}
