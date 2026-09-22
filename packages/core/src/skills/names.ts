/**
 * Skill identity rules (leaf module — importable from siblings without a
 * cycle through index.ts): the Agent Skills format constrains a skill's
 * directory name to lowercase alphanumerics and hyphens, 1–64 chars. The
 * directory name IS the skill's unique identity and the skill_read key.
 * Dot-prefixed entries (`.links.json`, `.proposals`) fail the regex by
 * construction, which is exactly why sidecar directories are safe there.
 */

/** Directory names the Agent Skills format allows for a skill. */
export const SKILL_DIR_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/

export function isSkillDirName(name: string): boolean {
  return SKILL_DIR_NAME.test(name) && name.length <= 64
}
