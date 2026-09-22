/**
 * Skill identity rules (leaf module — importable from siblings without a
 * cycle through index.ts): the Agent Skills format constrains a skill's
 * directory name to lowercase alphanumerics and hyphens, 1–64 chars. The
 * directory name IS the skill's unique identity and the skill_read key.
 * Dot-prefixed entries (`.links.json`, `.proposals`) fail the regex by
 * construction, which is exactly why sidecar directories are safe there.
 */
import { join } from "node:path"

/** Directory names the Agent Skills format allows for a skill. */
export const SKILL_DIR_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/

export function isSkillDirName(name: string): boolean {
  return SKILL_DIR_NAME.test(name) && name.length <= 64
}

/** Project-scope skill directory: `<workdir>/.kclaw/skills` (project copies
 * shadow the global directory as a whole). The single path authority shared
 * by evolution, run assembly and the routes layer. */
export function projectSkillsDir(workdir: string): string {
  return join(workdir, ".kclaw", "skills")
}

/**
 * Slash-mention token: every `/<name>` whose preceding character is not ASCII
 * alphanumeric (URL fragments like com/test stay out; unspaced CJK text like
 * "帮我/test" matches). The single source shared by matchSkillInvocations
 * (user-facing wrap) and the evolution coarse check (observation); the two
 * consumers must drift together by construction, not by comment.
 */
export const SKILL_MENTION_REGEX = /(?<![A-Za-z0-9])\/([a-z0-9]+(?:-[a-z0-9]+)*)/g
