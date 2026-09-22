/**
 * MCP wire shapes (type-only re-export from the manager implementation):
 * the named canon server/web/cli share instead of hand-copied mirrors. The
 * protocol exit stays type-only on purpose — the manager module pulls in
 * the MCP SDK and must never become a client-side runtime dependency.
 */
export type { McpServerConfig, McpScope, McpToolEntry, McpServerStatus } from "../mcp/manager.js"
