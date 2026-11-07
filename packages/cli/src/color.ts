/**
 * Colour discipline (clig): the one place that decides whether stdout carries
 * colour. An explicit --color wins; auto needs a TTY, no NO_COLOR and a TERM
 * other than dumb.
 *
 * The verdict also has to reach the third-party colour libraries, which judge
 * for themselves when they load: picocolors (clack) and chalk (ink) both react
 * to a bare `--color` in argv — `--color never` reads as "force colour on" —
 * and chalk ignores NO_COLOR altogether. So configureColor runs before anything
 * imports them (index.ts loads chat and the wizard dynamically for this reason)
 * and writes the verdict into the env vars they read. Those settings stay in
 * this process: spawnDaemon passes {@link originalEnv}, so the daemon and its
 * tool subprocesses never inherit them.
 */

export const COLOR_MODES = ["auto", "always", "never"] as const
export type ColorMode = (typeof COLOR_MODES)[number]

export function shouldColor(mode: ColorMode, stream: { isTTY?: boolean }, env: NodeJS.ProcessEnv): boolean {
  if (mode !== "auto") return mode === "always"
  if (stream.isTTY !== true) return false
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false
  return env.TERM !== "dumb"
}

let stdoutColor = shouldColor("auto", process.stdout, process.env)

/** Values configureColor replaced, per env object; undefined = the variable was unset. */
const replaced = new WeakMap<NodeJS.ProcessEnv, Map<string, string | undefined>>()

function setEnv(env: NodeJS.ProcessEnv, name: string, value: string | undefined): void {
  const saved = replaced.get(env) ?? new Map<string, string | undefined>()
  replaced.set(env, saved)
  if (!saved.has(name)) saved.set(name, env[name])
  if (value === undefined) delete env[name]
  else env[name] = value
}

/**
 * Decide once for this command. Colour on under auto leaves the libraries'
 * env alone: their own detection also picks the colour depth, which a forced
 * value would flatten to 16 colours.
 */
export function configureColor(
  mode: ColorMode,
  env: NodeJS.ProcessEnv = process.env,
  stdout: { isTTY?: boolean } = process.stdout,
): void {
  stdoutColor = shouldColor(mode, stdout, env)
  if (!stdoutColor) {
    setEnv(env, "NO_COLOR", "1") // picocolors
    setEnv(env, "FORCE_COLOR", "0") // chalk: picocolors treats any non-empty value as "on", NO_COLOR outranks it there
  } else if (mode === "always") {
    setEnv(env, "NO_COLOR", undefined)
    setEnv(env, "FORCE_COLOR", "1")
  }
}

/** A copy of the environment as it was before {@link configureColor} touched it. */
export function originalEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const copy = { ...env }
  for (const [name, value] of replaced.get(env) ?? []) {
    if (value === undefined) delete copy[name]
    else copy[name] = value
  }
  return copy
}

export function dim(text: string): string {
  return stdoutColor ? `\x1b[2m${text}\x1b[22m` : text
}

export function red(text: string): string {
  return stdoutColor ? `\x1b[31m${text}\x1b[39m` : text
}
