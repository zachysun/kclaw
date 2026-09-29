/**
 * MCP wire shapes (type-only re-export from the mcp types module): the
 * named canon server/web/cli share instead of hand-copied mirrors. The
 * protocol exit stays type-only on purpose — the manager modules pull in
 * the MCP SDK and must never become a client-side runtime dependency.
 * (GLOBAL_GROUP/isGroupId are constant + guard values with no runtime
 * dependency on the manager, safe for client bundles.)
 */
export type {
  McpConnState,
  McpGroupStatus,
  McpServerConfig,
  McpServerStatus,
  McpSnapshot,
  McpToolEntry,
} from "../mcp/types.js"
export { GLOBAL_GROUP, isGroupId } from "../mcp/types.js"
import type { McpSnapshot } from "../mcp/types.js"

/**
 * GET /mcp response envelope: the grouped snapshot plus the server-computed
 * defaults. `defaultGroup` is where a new entry lands by default — the
 * `?workdir=` query when the snapshot knows it, else `mainWorkspace` when
 * that is a group, else the global group. The fallback rule lives
 * server-side; clients consume the field instead of mirroring it.
 */
export interface McpSnapshotResponse extends McpSnapshot {
  mainWorkspace: string
  defaultGroup: string
}
