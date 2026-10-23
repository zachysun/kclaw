/**
 * cron_create / cron_list / cron_update / cron_delete: the model-facing
 * projection of the scheduler. kclaw crons are a daemon-level resource
 * (shared with the HTTP/CLI surfaces); the model's write path is the same
 * scheduler, but every write tool is SENSITIVE — the approval card showing
 * name/prompt/schedule is the user's explicit say-so. The standing rule:
 * the model never schedules without the user asking.
 *
 * Anti-recursion: runs fired by a cron (trigger "cron") must not carry the
 * write trio — a scheduled session scheduling its own successors is an
 * unattended self-breeding loop (two surveyed harnesses implement the same
 * guard). The assembly withholds `writeTools` for those runs; cron_list
 * stays available.
 *
 * No `model` parameter on create/update: the per-cron model override is a
 * cost-bearing decision reserved to the user's HTTP/CLI surface.
 */
import type { ToolExecutor } from "../agent/tools.js"
import type { Cron, CronScheduler } from "../cron/scheduler.js"
import { def, makeTool, optString, requireString, str, type ToolEntry } from "./shared.js"

const DELAY_MIN = 1
const DELAY_MAX = 525_600

export function createCronTools(opts: {
  scheduler: CronScheduler
  /** false = cron-fired run: register only cron_list (anti-recursion). */
  writeTools?: boolean
}): {
  "cron_create": ToolExecutor & { name: "cron_create" }
  "cron_list": ToolExecutor & { name: "cron_list" }
  "cron_update": ToolExecutor & { name: "cron_update" }
  "cron_delete": ToolExecutor & { name: "cron_delete" }
} {
  const { scheduler, writeTools = true } = opts

  const render = (c: Cron): string => {
    const schedule =
      c.kind === "delay"
        ? `一次性：${c.delayMinutes} 分钟后（${c.nextRunAt}）`
        : `cron：${c.cron}（下次 ${c.nextRunAt}）`
    const last =
      c.lastRunAt === undefined
        ? "尚未运行"
        : `上次 ${c.lastRunAt} ${c.lastStatus ?? ""}${c.lastError !== undefined ? `（${c.lastError}）` : ""}`
    return [`${c.id}  ${c.enabled ? "启用" : "停用"}  ${schedule}`, `  名称: ${c.name}`, `  ${last}`, `  prompt: ${c.prompt.slice(0, 200)}`].join("\n")
  }

  const cron_create = makeTool("cron_create", "sensitive", "serial", (args) => {
    const name = requireString(args, "name")
    const prompt = requireString(args, "prompt")
    const cron = optString(args, "cron")
    const delayMinutes = (args as { delayMinutes?: unknown }).delayMinutes
    if (cron === undefined && delayMinutes === undefined) {
      return { status: "error", output: "cron_create: cron 与 delayMinutes 必须提供其一（二选一）" }
    }
    if (cron !== undefined && delayMinutes !== undefined) {
      return { status: "error", output: "cron_create: cron 与 delayMinutes 只能二选一" }
    }
    if (delayMinutes !== undefined && (typeof delayMinutes !== "number" || !Number.isInteger(delayMinutes))) {
      return { status: "error", output: "cron_create: args.delayMinutes must be an integer" }
    }
    try {
      const created = scheduler.create({
        name,
        prompt,
        ...(cron !== undefined ? { cron } : { delayMinutes: Math.min(DELAY_MAX, Math.max(DELAY_MIN, delayMinutes as number)) }),
      })
      return { status: "ok", output: `已创建（需用户批准后生效）：\n${render(created)}`, data: created }
    } catch (e) {
      return { status: "error", output: `cron_create: ${e instanceof Error ? e.message : String(e)}` }
    }
  })

  const cron_list = makeTool("cron_list", "safe", "parallel", () => {
    const all = scheduler.list()
    if (all.length === 0) return { status: "ok", output: "(没有定时任务)" }
    return { status: "ok", output: all.map(render).join("\n\n") }
  })

  const cron_update = makeTool("cron_update", "sensitive", "serial", (args) => {
    const id = requireString(args, "id")
    const name = optString(args, "name")
    const prompt = optString(args, "prompt")
    const cron = optString(args, "cron")
    const enabled = (args as { enabled?: unknown }).enabled
    const delayMinutes = (args as { delayMinutes?: unknown }).delayMinutes
    if (name === undefined && prompt === undefined && cron === undefined && enabled === undefined && delayMinutes === undefined) {
      return { status: "error", output: "cron_update: 至少提供一个要修改的字段" }
    }
    if (cron !== undefined && delayMinutes !== undefined) {
      return { status: "error", output: "cron_update: cron 与 delayMinutes 只能二选一" }
    }
    if (delayMinutes !== undefined && (typeof delayMinutes !== "number" || !Number.isInteger(delayMinutes))) {
      return { status: "error", output: "cron_update: args.delayMinutes must be an integer" }
    }
    if (enabled !== undefined && typeof enabled !== "boolean") {
      return { status: "error", output: "cron_update: args.enabled must be a boolean" }
    }
    try {
      const updated = scheduler.update(id, {
        ...(name !== undefined ? { name } : {}),
        ...(prompt !== undefined ? { prompt } : {}),
        ...(cron !== undefined ? { cron } : {}),
        ...(enabled !== undefined ? { enabled } : {}),
        ...(delayMinutes !== undefined
          ? { delayMinutes: Math.min(DELAY_MAX, Math.max(DELAY_MIN, delayMinutes)) }
          : {}),
      })
      if (updated === undefined) return { status: "error", output: `cron_update: cron not found: ${id}` }
      return { status: "ok", output: `已更新：\n${render(updated)}`, data: updated }
    } catch (e) {
      return { status: "error", output: `cron_update: ${e instanceof Error ? e.message : String(e)}` }
    }
  })

  const cron_delete = makeTool("cron_delete", "sensitive", "serial", (args) => {
    const id = requireString(args, "id")
    if (!scheduler.remove(id)) {
      return { status: "error", output: `cron_delete: cron not found: ${id}` }
    }
    return { status: "ok", output: `已删除：${id}` }
  })

  // `writeTools === false`（cron 触发的 run，防递归）不改变本工厂的返回：
  // entries 工厂按该标志只挂 cron_list，写执行器不进模型面。
  return { "cron_create": cron_create, "cron_list": cron_list, "cron_update": cron_update, "cron_delete": cron_delete }
}

/**
 * The registry-facing bundle: executors + schemas owned beside each other.
 * writeTools=false（cron 触发的 run，防递归：定时会话不能再建定时）只挂
 * cron_list，写三件不进模型面。
 */
export function createCronToolEntries(opts: Parameters<typeof createCronTools>[0]): ToolEntry[] {
  const tools = createCronTools(opts)
  const cronListEntry: ToolEntry = {
    name: "cron_list",
    tool: tools.cron_list,
    def: def("cron_list", "List scheduled crons (id, schedule, enabled, next run, last result).", {}, []),
  }
  if (opts.writeTools === false) return [cronListEntry]
  return [
    {
      name: "cron_create",
      tool: tools.cron_create,
      def: def(
        "cron_create",
        "Create a scheduled cron ONLY when the user explicitly asked for a reminder/recurring task. Exactly one of `cron` (standard 5-field expression) or `delayMinutes` (one-shot, fires once then auto-disables — never compute an absolute time yourself). The prompt must be self-contained: firing creates a fresh session that sees nothing of this conversation.",
        {
          name: str("Display name of the cron"),
          prompt: str("Self-contained prompt fired as the user message of a fresh session"),
          cron: str("Standard 5-field cron expression (mutually exclusive with delayMinutes)"),
          delayMinutes: { type: "integer", minimum: 1, maximum: 525600, description: "One-shot: fire once N minutes from now (mutually exclusive with cron)" },
        },
        ["name", "prompt"],
      ),
    },
    cronListEntry,
    {
      name: "cron_update",
      tool: tools.cron_update,
      def: def(
        "cron_update",
        "Update a scheduled cron (partial patch; at least one field). Changing cron/delayMinutes converts the trigger form and reschedules from now.",
        {
          id: str("Cron id from cron_list"),
          name: str("Optional: new display name"),
          prompt: str("Optional: new prompt"),
          cron: str("Optional: switch to a recurring 5-field expression"),
          delayMinutes: { type: "integer", minimum: 1, maximum: 525600, description: "Optional: switch to one-shot N minutes from now" },
          enabled: { type: "boolean", description: "Optional: enable/disable without deleting" },
        },
        ["id"],
      ),
    },
    {
      name: "cron_delete",
      tool: tools.cron_delete,
      def: def("cron_delete", "Delete a scheduled cron permanently.", { id: str("Cron id from cron_list") }, ["id"]),
    },
  ]
}
