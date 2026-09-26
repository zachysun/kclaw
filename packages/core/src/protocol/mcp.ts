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
