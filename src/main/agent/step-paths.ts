/**
 * Per-step sink for resolved paths. Closed when its step is over: a straggler
 * (a handler still running after a timeout, say) writes nothing afterwards.
 * A new sink per step also means no entry can leak into the next step.
 */
export class StepPaths {
  private entries = new Map<string, string>()
  private closed = false

  set(callKey: string, resolvedPath: string): void {
    if (!this.closed) this.entries.set(callKey, resolvedPath)
  }

  get(callKey: string): string | undefined {
    return this.entries.get(callKey)
  }

  close(): void {
    this.closed = true
    this.entries.clear()
  }
}
