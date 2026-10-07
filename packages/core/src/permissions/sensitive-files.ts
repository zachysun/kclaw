/**
 * Built-in sensitive-file basenames (basename globs): credentials and key
 * material whose CONTENT must not slide into model context or audit streams
 * through a safe/auto-approved path. A fs call hitting one of these names
 * goes to a human even though the tool itself is "safe" — unless an explicit
 * allow/learned rule (or a run-scoped once-approval) covers it. Replaced
 * wholesale by config `permissions.sensitiveFiles` when set.
 *
 * 常量叶子：配置默认值（storage/config.ts 的 defaultConfig）与权限判定引擎
 * 共用这一份清单。单独成文件让 storage 不必依赖 engine 实现，分层方向不反。
 */
export const DEFAULT_SENSITIVE_FILES = [
  ".env",
  ".env.*",
  "*.env",
  "*.pem",
  "*.key",
  "id_rsa",
  "id_rsa.*",
  "id_ed25519",
  "id_ed25519.*",
  "*.p12",
  "*.pfx",
  "*.kdbx",
  "credentials.json",
  "credentials*.json",
]
