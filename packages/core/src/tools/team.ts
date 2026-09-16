/**
 * Team tools: the model-facing surface of the agent team. Thin shells over
 * the TeamFacade — the facade owns identity rules and
 * dispatch; these factories only validate args and shape results.
 *
 * Surface rules: the lead gets all seven; a member gets send/list/task_*
 * but never create_team / spawn_teammate (no second team, no multi-level
 * delegation); job sessions get none (the assembly simply omits opts.team).
 */
import type { TeamFacade, TeamIdentity } from "../team/facade.js"
import { ToolError, makeTool, requireString } from "./shared.js"
import type { ToolExecutor } from "../agent/tools.js"
import type { ToolDefinition } from "../provider/types.js"

export const CREATE_TEAM_DESCRIPTION =
  "Create your agent team: materializes the team state directory and makes this session the team lead. One team per session; call this once before spawn_teammate / task_create."

export const SPAWN_TEAMMATE_DESCRIPTION =
  "Recruit a resident teammate: spawns a persistent child agent with its own session, registers it on the member list and delivers the initial task. The teammate stays available for further messages and task dispatch after finishing. Give a self-contained task — the teammate starts with an empty history."

function str(description: string) {
  return { type: "string", description }
}

function def(name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolDefinition {
  return { name, description, parameters: { type: "object", properties, required } }
}

type TeamEntry = { name: string; tool: ToolExecutor; def: ToolDefinition }

/** The seven team tools, paired executor + schema. */
export function createTeamToolEntries(facade: TeamFacade, identity: TeamIdentity): TeamEntry[] {
  const entries: TeamEntry[] = []

  if (identity.role === "lead") {
    entries.push({
      name: "create_team",
      tool: makeTool("create_team", "safe", "serial", async (args) => {
        const name = typeof (args as Record<string, unknown>)?.name === "string" ? (args as { name: string }).name : undefined
        const created = await facade.createTeam(identity.sessionId, name)
        return {
          status: "ok" as const,
          output: `team "${created.name}" created (id ${created.teamId}). Recruit members with spawn_teammate, then break work down with task_create.`,
          data: created,
        }
      }),
      def: def("create_team", CREATE_TEAM_DESCRIPTION, { name: str("Optional display name; defaults to the session title") }, []),
    })
    entries.push({
      name: "spawn_teammate",
      tool: makeTool("spawn_teammate", "safe", "serial", async (args) => {
        const a = args as Record<string, unknown> | null
        const name = requireString(args, "name")
        const task = requireString(args, "task")
        const role = typeof a?.role === "string" ? a.role : undefined
        const model = typeof a?.model === "string" ? a.model : undefined
        const spawned = await facade.spawnTeammate(identity, { name, role, task, model })
        return {
          status: "ok" as const,
          output: `teammate "${spawned.name}" recruited (session ${spawned.sessionId}${spawned.model ? `, model ${spawned.model}` : ""}) and the initial task was delivered. It will start working on its own; reach it with send_message.`,
          data: spawned,
        }
      }),
      def: def(
        "spawn_teammate",
        SPAWN_TEAMMATE_DESCRIPTION,
        {
          name: str("Member name: lowercase letters/digits/hyphen, starts with a letter, permanent (never reused)"),
          task: str("Self-contained initial task description — the teammate starts with an empty history"),
          role: str("Optional one-line role summary shown on the team panel"),
          model: str("Optional provider/model for heterogeneous staffing (defaults to your current routing, snapshotted at spawn)"),
        },
        ["name", "task"],
      ),
    })
  }

  entries.push({
    name: "send_message",
    tool: makeTool("send_message", "safe", "parallel", async (args) => {
      const a = args as Record<string, unknown> | null
      const text = requireString(args, "text")
      let to: { kind: "lead" } | { kind: "member"; name: string }
      if (typeof a?.to === "string" && a.to !== "") {
        if (a.to === "lead") to = { kind: "lead" }
        else to = { kind: "member", name: a.to }
      } else {
        // Default recipient: a member reports to the lead; the lead messages a member by name.
        to = identity.role === "member" ? { kind: "lead" } : (() => { throw new ToolError("args.to is required: a member name, or \"lead\"") })()
      }
      const sent = await facade.sendMessage(identity, { to, text })
      return {
        status: "ok" as const,
        output: `message ${sent.id} delivered to ${to.kind === "lead" ? "the lead" : `teammate "${to.name}"`} (durable mailbox; they will receive it automatically).`,
        data: sent,
      }
    }),
    def: def(
      "send_message",
      "Send a durable mailbox message to the lead or a teammate; the engine delivers it automatically (mid-run injection or a wake-up) — no polling needed. Sender identity is fixed to you; impersonation is impossible.",
      { to: str("Recipient: a teammate name, or \"lead\" (default for members)"), text: str("Message text") },
      ["text"],
    ),
  })

  entries.push({
    name: "list_agents",
    tool: makeTool("list_agents", "safe", "parallel", async () => {
      const { members } = await facade.listAgents(identity)
      if (members.length === 0) return { status: "ok" as const, output: "No teammates recruited yet." }
      const lines = members.map((m) => {
        const bits = [m.name, m.status, m.busy === true ? "working" : "idle"]
        if (m.role) bits.push(`role: ${m.role}`)
        if (m.model) bits.push(`model: ${m.model}`)
        if (m.currentTask) bits.push(`task: ${m.currentTask}`)
        if (m.failReason) bits.push(`failed: ${m.failReason}`)
        return `- ${bits.join(" · ")}`
      })
      return { status: "ok" as const, output: lines.join("\n"), data: { members } }
    }),
      def: def("list_agents", "List your team's members: name, lifecycle status, busy/idle, current task.", {}, []),
  })

  entries.push({
    name: "task_create",
    tool: makeTool("task_create", "safe", "serial", async (args) => {
      const a = args as Record<string, unknown> | null
      const subject = requireString(args, "subject")
      const detail = typeof a?.detail === "string" ? a.detail : undefined
      const dependencies = Array.isArray(a?.dependencies) && a.dependencies.every((d) => typeof d === "number")
        ? (a.dependencies as number[])
        : undefined
      const assignee = typeof a?.assignee === "string" ? a.assignee : undefined
      const task = await facade.taskCreate(identity, { subject, detail, dependencies, assignee })
      return {
        status: "ok" as const,
        output: `task #${task.id} "${task.subject}" created (status ${task.status}${task.assignee ? `, assigned to ${task.assignee}` : ", unclaimed"}${task.dependencies.length ? `, depends on #${task.dependencies.join(", #")}` : ""}). Idle teammates auto-claim unclaimed ready tasks.`,
        data: task,
      }
    }),
    def: def(
      "task_create",
      "Create a task on the shared board: subject + detail + dependencies (team-local ids). Unclaimed tasks with completed dependencies are auto-claimed by idle teammates; assignee pins one member (lead only).",
      {
        subject: str("Short task title"),
        detail: str("Full task description — write it self-contained: context, paths, acceptance criteria"),
        dependencies: { type: "array", items: { type: "integer" }, description: "Task ids that must complete before this one can be claimed" },
        assignee: str("Optional: assign directly to one member (lead only)"),
      },
      ["subject"],
    ),
  })

  entries.push({
    name: "task_update",
    tool: makeTool("task_update", "safe", "serial", async (args) => {
      const a = args as Record<string, unknown> | null
      if (typeof a?.id !== "number" || typeof a?.expected_revision !== "number") {
        throw new ToolError("args.id and args.expected_revision must be numbers (from your last task_list/task_create read)")
      }
      const patch: Record<string, unknown> = { id: a.id, expectedRevision: a.expected_revision }
      if (typeof a.attempt_id === "string") patch.attemptId = a.attempt_id
      if (typeof a.status === "string") patch.status = a.status
      if (typeof a.subject === "string") patch.subject = a.subject
      if (typeof a.detail === "string") patch.detail = a.detail
      if (typeof a.assignee === "string" || a.assignee === null) patch.assignee = a.assignee
      if (Array.isArray(a.dependencies) && a.dependencies.every((d) => typeof d === "number")) patch.dependencies = a.dependencies
      const task = await facade.taskUpdate(identity, patch as unknown as Parameters<TeamFacade["taskUpdate"]>[1])
      return {
        status: "ok" as const,
        output: `task #${task.id} "${task.subject}" is now ${task.status} (revision ${task.revision}${task.attempt ? `, attempt ${task.attempt}` : ""}). ${task.status === "completed" ? "Report completion to the lead with send_message." : ""}`,
        data: task,
      }
    }),
    def: def(
      "task_update",
      "Advance or edit a board task. Progress rules: echo expected_revision from your last read; completing/failing a task you started requires your attempt_id (stale writers are rejected). Completing a task unlocks its dependents.",
      {
        id: { type: "integer", description: "Task id" },
        expected_revision: { type: "integer", description: "The revision you last read — mismatch means someone changed it; re-read with task_list" },
        attempt_id: str("Your current attempt id (from the task dispatch input) — required to complete/fail a started task"),
        status: str("New status: in_progress | completed | failed | cancelled"),
        subject: str("Optional: edit the title"),
        detail: str("Optional: edit the description"),
        assignee: str("Optional: reassign (lead only)"),
        dependencies: { type: "array", items: { type: "integer" }, description: "Optional: replace the dependency list" },
      },
      ["id", "expected_revision"],
    ),
  })

  entries.push({
    name: "task_list",
    tool: makeTool("task_list", "safe", "parallel", async () => {
      const { tasks } = await facade.taskList(identity)
      if (tasks.length === 0) return { status: "ok" as const, output: "The task board is empty." }
      const lines = tasks.map((t) => {
        const bits = [`#${t.id}`, `"${t.subject}"`, t.status]
        if (t.assignee) bits.push(`owner: ${t.assignee}`)
        else if (t.status === "pending") bits.push("unclaimed")
        if (t.dependencies.length) bits.push(`depends: #${t.dependencies.join(", #")}`)
        if (t.status === "in_progress" && t.attempt) bits.push(`attempt ${t.attempt}`)
        return `- ${bits.join(" · ")} (revision ${t.revision})`
      })
      return { status: "ok" as const, output: lines.join("\n"), data: { tasks } }
    }),
    def: def("task_list", "Read the shared task board: id, title, status, owner, dependencies, revision (echo it in task_update).", {}, []),
  })

  return entries
}
