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

// ── Consent mid-run ─────────────────────────────────────────

/**
 * What the user may decide about ONE tool result the guard flagged.
 *
 * `drop-file` is the third option the loop lacked: the run neither dies nor
 * ships the finding, it continues without that one result.
 */
export type CodingConsentChoice = "send" | "anonymize" | "drop-file";

/** Every choice there is. The source for parsing, so the two cannot drift. */
export const CODING_CONSENT_CHOICES: readonly CodingConsentChoice[] = [
  "send",
  "anonymize",
  "drop-file",
];

/**
 * The question put to the user, as it crosses into the renderer.
 *
 * It carries NO match value. The finding is described by type and risk level
 * only: a dialog payload holding the credential it warns about would have
 * reopened the hole at the surface, and this object reaches a window, a log and
 * possibly a screenshot.
 */
export interface CodingConsentRequest {
  /**
   * Identity of THIS question, generated in the main process. An answer must
   * quote it: the run id alone cannot tell a late answer to file A from an
   * answer to file B asked a moment later.
   */
  requestId: string;
  runId: string;
  stepNumber: number;
  toolName: string;
  filePath?: string;
  /** Type and risk level of every finding. Never the value. */
  matches: Array<{ type: string; riskLevel: string }>;
  /** `anonymize` appears only when every finding is anonymizable. */
  offers: readonly CodingConsentChoice[];
}

/**
 * Parse an untrusted answer into a CodingConsentChoice; anything unrecognised
 * is `drop-file`.
 *
 * The strict side is the default here, exactly as `parseCodingMode` returns
 * `off`: an unparseable answer is not a reason to send. Whether the parsed
 * choice was actually OFFERED is a separate question, answered against the
 * request itself (see the consent broker).
 */
export function parseCodingConsentChoice(raw: unknown): CodingConsentChoice {
  return CODING_CONSENT_CHOICES.find((choice) => choice === raw) ?? "drop-file";
}

// -- Edit proposals ----------------------------------------------

/**
 * One proposed change to one file. `edit_file` records it; nothing is written
 * until a human accepts the step's package.
 *
 * `path` is the REAL path relative to the project root, as the file system
 * spells it (never the model's spelling). `oldText` and `newText` are kept so
 * the accept step can re-verify `oldText` against the file as it is THEN.
 * `diff` is for the human: it carries context lines from the file and is never
 * returned to the model.
 */
export interface ProposedEdit {
  path: string;
  oldText: string;
  newText: string;
  diff: string;
  addedLines: number;
  removedLines: number;
  /**
   * True when the proposal puts invisible or direction-changing characters
   * (bidi controls, zero-width, other control and format characters) into the
   * file that its old text did not contain. The reviewer must be told: the
   * displayed diff shows them escaped, the write is byte-exact.
   */
  introducesHiddenCharacters: boolean;
  /**
   * SHA-256 (hex) of the file content the diff was computed against, and the
   * position (UTF-16 index into that content decoded as UTF-8) where `oldText`
   * matched. The apply step verifies both before writing, so the approved diff
   * is provably what gets written.
   */
  baseSha256: string;
  matchIndex: number;
}
