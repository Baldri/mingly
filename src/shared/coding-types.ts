/**
 * Coding-mode vocabulary.
 *
 * Pure vocabulary: no Electron, no node builtins, no src/main imports, so the
 * main process, the agent layer and the renderer can all share it.
 *
 * There is deliberately no `auto` mode in Phase 1. A stored `auto` (for
 * example left behind by a later phase) parses to `off`.
 */

/** How much a coding run may do inside a granted project directory. */
export type CodingMode = "off" | "read-only" | "propose" | "propose-run";

/** Rank of each mode. Only meaningful through atLeast(). */
export const CODING_MODE_ORDER: Record<CodingMode, number> = {
  off: 0,
  "read-only": 1,
  propose: 2,
  "propose-run": 3,
};

/**
 * Parse an untrusted value into a CodingMode; anything unrecognised is `off`.
 *
 * Checks own keys only, so inherited names such as `toString` are rejected.
 * No `as CodingMode` on unchecked input — that cast is exactly how an
 * unrecognised level once released every provider in the policy engine.
 */
export function parseCodingMode(raw: unknown): CodingMode {
  if (
    typeof raw === "string" &&
    Object.prototype.hasOwnProperty.call(CODING_MODE_ORDER, raw)
  ) {
    return raw as CodingMode;
  }
  return "off";
}

/**
 * What a coding run knows about its project.
 *
 * Lives in src/shared/ because agent-executor, tool-registry and the renderer
 * all need the type; defined in agent-executor it would be an import cycle,
 * since agent-executor imports from tool-registry.
 */
export interface CodingRunOptions {
  directoryId: string;
  projectPath: string;
  mode: CodingMode;
}
