/**
 * Team facade — the boundary the team tools (and the run assembly's identity
 * probe) program against. Core owns the interface and the identity rules in
 * prose; the server's team host owns the implementation (session creation,
 * run dispatch, mailbox delivery). Everything is async: implementations may
 * hit the filesystem, the run manager and the bus.
 *
 * Identity rules enforced by implementations:
 *   - create/spawn: lead only, and only with no existing team / no multi-level.
 *   - task_create: any member (dependencies must exist).
 *   - task_update: owner or lead may transition/edit; assignee (direct
 *     assignment) is lead-only; progress on an in_progress task must echo
 *     the current attemptId (late-write protection, enforced by the store).
 *   - send_message: sender identity is fixed by the caller's identity —
 *     impersonation is impossible by construction.
 */
import type { TaskSnapshot, TeamRecord, TeamSenderKind } from "../protocol/team.js"

/** The caller's team identity, resolved by the run assembly from the session. */
export type TeamIdentity =
  | { role: "lead"; teamId: string; sessionId: string }
  | { role: "member"; teamId: string; sessionId: string; name: string }

/** Message recipient: the lead, a named member, or (future) broadcast. */
export interface SendTarget {
  kind: TeamSenderKind
  name?: string
}

export interface AgentSummary {
  name: string
  status: "provisioning" | "active" | "failed"
  /** Derived runtime observation — true while the member has a live run. */
  busy?: boolean
  role?: string
  model?: string
  failReason?: string
  sessionId?: string
  /** Subject of the in_progress task the member currently holds. */
  currentTask?: string
}

export interface TeamTaskCreateRequest {
  subject: string
  detail?: string
  dependencies?: number[]
  assignee?: string
}

export interface TeamTaskUpdateRequest {
  id: number
  expectedRevision: number
  attemptId?: string
  status?: TaskSnapshot["status"]
  subject?: string
  detail?: string
  assignee?: string | null
  dependencies?: number[]
}

export interface TeamFacade {
  /** Which team (if any) does this session belong to, and as whom. The run
   * assembly calls this once per run to pick the team tool surface and the
   * member system prompt; implementations reconcile pending provisioning
   * for the team on the lead's first touch after a daemon restart. */
  describeSession(sessionId: string): Promise<TeamIdentity | null>

  /** Lead-only, once per lead session: materialize the team directory. */
  createTeam(leadSessionId: string, name?: string): Promise<{ teamId: string; name: string }>

  /** Lead-only: spawn one resident member (provisioning transaction with
   * crash reconciliation). The initial task rides the identity message. */
  spawnTeammate(
    lead: Extract<TeamIdentity, { role: "lead" }>,
    req: { name: string; role?: string; task: string; model?: string },
  ): Promise<{ name: string; sessionId: string; model?: string }>

  /** Send a message through the durable mailbox (append pending → submit
   * dispatch → mark delivered). Sender identity comes from `from`. */
  sendMessage(from: TeamIdentity, req: { to: SendTarget; text: string }): Promise<{ id: string }>

  /** Member list with derived runtime observations. */
  listAgents(identity: TeamIdentity): Promise<{ members: AgentSummary[] }>

  taskCreate(identity: TeamIdentity, req: TeamTaskCreateRequest): Promise<TaskSnapshot>
  taskUpdate(identity: TeamIdentity, req: TeamTaskUpdateRequest): Promise<TaskSnapshot>
  taskList(identity: TeamIdentity): Promise<{ tasks: TaskSnapshot[] }>
}

/** The `GET /sessions/:id/team` payload: the whole team view in one read. */
export interface TeamPanel {
  team: TeamRecord
  identity: "lead" | "member"
  members: AgentSummary[]
  tasks: TaskSnapshot[]
}
