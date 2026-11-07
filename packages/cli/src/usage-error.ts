/**
 * A command-line usage mistake (exit code 2, spec A6): the command prints the
 * message on stderr — followed by its usage when `showHelp` is set — and
 * writes nothing to stdout.
 */
export class UsageError extends Error {
  readonly showHelp: boolean

  constructor(message: string, opts: { showHelp?: boolean } = {}) {
    super(message)
    this.name = "UsageError"
    this.showHelp = opts.showHelp === true
  }
}
