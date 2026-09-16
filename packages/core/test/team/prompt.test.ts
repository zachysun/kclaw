import { describe, it, expect } from "vitest"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { teamLeadProtocol, teamMemberSystemPrompt } from "../../src/team/prompt.js"
import { resolveBasePrompt } from "../../src/agent/run-assembly.js"
import { subagentSystemPrompt } from "../../src/agent/subagent.js"
import type { TeamIdentity } from "../../src/team/facade.js"

const WORKSPACE = "/tmp/kclaw-team-fixture"
const LEAD: TeamIdentity = { role: "lead", teamId: "tm_1", sessionId: "ses_lead" }
const MEMBER: TeamIdentity = { role: "member", teamId: "tm_1", sessionId: "ses_m1", name: "builder" }

function mainlineWith(agentsMd: string): string {
  const dir = mkdtempSync(join(tmpdir(), "kclaw-team-prompt-"))
  const file = join(dir, "AGENTS.md")
  writeFileSync(file, agentsMd, "utf8")
  return file
}

describe("team prompts", () => {
  it("member prompt carries the name, the workspace and the task-centric rules, and grants no create/spawn", () => {
    const text = teamMemberSystemPrompt(WORKSPACE, "builder")
    expect(text).toContain("builder")
    expect(text).toContain(WORKSPACE)
    expect(text).toContain("task_list")
    expect(text).toContain("attempt_id")
    expect(text).toContain("send_message")
    expect(text).toContain("没有 create_team / spawn_teammate")
  })

  it("lead protocol is task-centric and states the no-cascade stop model", () => {
    const text = teamLeadProtocol()
    // Reads truthfully BEFORE a team exists too: create_team is the entry.
    expect(text).toContain("create_team")
    expect(text).toContain("task_create")
    expect(text).toContain("dependencies")
    expect(text).toContain("assignee")
    expect(text).toContain("没有级联停止")
    expect(text).not.toContain("你已创建")
  })

  it("resolveBasePrompt: member runs the member template even though the session is a child", () => {
    const base = resolveBasePrompt({ childRun: true, team: MEMBER, workspace: WORKSPACE, agentsMd: "/nonexistent/AGENTS.md" })
    expect(base).toBe(teamMemberSystemPrompt(WORKSPACE, "builder"))
  })

  it("resolveBasePrompt: lead appends the protocol after the mainline persona (hot-applies via baseline mismatch)", () => {
    const agentsMd = mainlineWith("MAINLINE PERSONA")
    const base = resolveBasePrompt({ childRun: false, team: LEAD, workspace: WORKSPACE, agentsMd })
    expect(base).toBe(`MAINLINE PERSONA\n\n${teamLeadProtocol()}`)
  })

  it("resolveBasePrompt: no team keeps both existing paths byte-identical", () => {
    const agentsMd = mainlineWith("MAINLINE PERSONA")
    expect(resolveBasePrompt({ childRun: false, team: null, workspace: WORKSPACE, agentsMd })).toBe("MAINLINE PERSONA")
    expect(resolveBasePrompt({ childRun: true, team: null, workspace: WORKSPACE, agentsMd })).toBe(subagentSystemPrompt(WORKSPACE))
  })
})
