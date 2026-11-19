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
 * How long a consent question may stay open before the broker settles it
 * itself (to `drop-file`, letting the run carry on without that file).
 *
 * Here rather than in the broker because the dialog has to SAY it: a dialog
 * that claims the run is paused until the user answers, while a deadline runs
 * out behind it, is a false sentence on an approval surface. The renderer may
 * not import from the main process, so the number lives in the shared
 * vocabulary and both sides read it from here.
 */
export const CODING_CONSENT_ANSWER_TIMEOUT_MS = 300_000;

/**
 * What the renderer sends to start a coding run: the directory id, nothing else.
 * There is no path and no mode here on purpose (R35): the main process derives
 * the path from the grant and reads the mode from its own store. The IPC
 * handler still treats the argument as untrusted and refuses a `projectPath` or
 * `mode` that disagrees with what it derived.
 */
export interface CodingRunRequest {
  directoryId: string;
}

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
 * One proposed change to one file. `mingly_edit_file` records it; nothing is written
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

// -- What the renderer may see and send --------------------------

/**
 * One proposal as the approval dialog sees it. No `oldText` / `newText`: the
 * renderer gets what it must show (path, diff, counts, the hidden-character
 * flag), never the file text the proposal was computed from.
 */
export interface PendingEditView {
  path: string;
  diff: string;
  addedLines: number;
  removedLines: number;
  introducesHiddenCharacters: boolean;
}

/**
 * The package a run proposes. `digest` is computed in the main process over the
 * FULL proposals and sent back with the accept, so what is written is provably
 * the package the human was shown.
 */
export interface PendingPackageView {
  directoryId?: string;
  digest: string;
  edits: PendingEditView[];
}

// -- Why an apply or an undo refused ----------------------------
//
// The main process answers a refusal with its English text AND one of these
// codes. The codes exist so the renderer can say the same thing in German and
// can tell the three cases in which files may ALREADY have been written from
// the ones in which nothing was touched.
//
// One code per text, no splitting and no merging: everything that depends on
// the file system keeps sharing the single text it shares today (`fs`), so a
// refusal is still not an existence oracle. A new code may only be introduced
// together with a new text.

export type CodingRefusalCode =
  /** Everything that depends on the file system. ONE code, ONE text. */
  | "fs"
  | "grant"
  | "nothing-pending"
  | "input"
  | "run-directory"
  | "workspace"
  | "snapshot"
  | "no-snapshot"
  | "unrecorded"
  | "withdrawn"
  | "mixed"
  | "batch-unusable"
  | "interrupted"
  | "package-changed"
  | "busy"
  | "partial";

/** Every code there is. The source for parsing, so the two cannot drift. */
export const CODING_REFUSAL_CODES: readonly CodingRefusalCode[] = [
  "fs",
  "grant",
  "nothing-pending",
  "input",
  "run-directory",
  "workspace",
  "snapshot",
  "no-snapshot",
  "unrecorded",
  "withdrawn",
  "mixed",
  "batch-unusable",
  "interrupted",
  "package-changed",
  "busy",
  "partial",
];

/**
 * Parse an untrusted value into a CodingRefusalCode; anything unrecognised is
 * `undefined`, never a guess. A caller that gets `undefined` falls back to the
 * text the main process sent.
 */
export function parseCodingRefusalCode(
  raw: unknown,
): CodingRefusalCode | undefined {
  return CODING_REFUSAL_CODES.find((code) => code === raw);
}

/**
 * The refusals after which files may ALREADY be written.
 *
 * `partial` and `withdrawn` happen with files on disk; `interrupted` means an
 * earlier apply of the same run left some files written. All three tell the
 * user to run undo, so the surface has to offer it — and must stop offering
 * "accept", because the package is no longer in the state that was approved.
 */
export const CODING_REFUSALS_MAY_HAVE_WRITTEN: readonly CodingRefusalCode[] = [
  "partial",
  "withdrawn",
  "interrupted",
];

/** The undo answer as it crosses into the renderer (mirrors the main process's outcome). */
export interface CodingSkippedFile {
  path: string;
  reason: string;
}

export type CodingUndoOutcome =
  | {
      kind: "restored";
      restored: string[];
      skipped: CodingSkippedFile[];
      interrupted?: true;
    }
  | {
      kind: "refused";
      reason: string;
      code?: CodingRefusalCode;
      skipped?: CodingSkippedFile[];
    };

/**
 * One level of the mode picker. `auto` is not here and cannot be added by
 * accident: the picker is built from this list, and so is the main process's
 * check of what may be stored.
 *
 * R36: `scopeNote` is part of the level, shown with it, not behind a help text.
 * The wording follows the README ("die Stufen gelten nur für Minglys eigene
 * Werkzeuge, nicht für Ihre MCP-Server").
 */
export interface CodingModeChoice {
  mode: CodingMode;
  label: string;
  description: string;
  scopeNote: string;
}

export const CODING_SCOPE_NOTE =
  "Betrifft nur Minglys eigene Werkzeuge. Ihre MCP-Server bleiben in jedem Modus erreichbar, auch mit Schreibzugriff.";

export const CODING_MODE_CHOICES: readonly CodingModeChoice[] = [
  {
    mode: "off",
    label: "Aus",
    description: "Normaler Chat. Minglys Coding-Werkzeuge sehen das Projekt nicht.",
    scopeNote: CODING_SCOPE_NOTE,
  },
  {
    mode: "read-only",
    // Not "lesen und suchen": there is no search tool. A level must not
    // promise a capability that does not exist.
    label: "Nur lesen",
    description:
      "Minglys Coding-Werkzeuge dürfen Dateien des Projekts auflisten und lesen, aber nichts ändern.",
    scopeNote: CODING_SCOPE_NOTE,
  },
  {
    mode: "propose",
    label: "Vorschlagen",
    description:
      "Lesen und Änderungen vorschlagen. Geschrieben wird erst, wenn Sie den Vorschlag im Diff annehmen.",
    scopeNote: CODING_SCOPE_NOTE,
  },
  {
    mode: "propose-run",
    label: "Vorschlagen und ausführen",
    // This sentence is the ONLY thing the user reads at the moment of
    // choosing, so it has to say what the level really does. It used to say
    // "Jede Änderung braucht weiterhin Ihre Annahme", which the README of the
    // same branch contradicts: a command runs project code, and that code
    // writes without a diff. The strongest claim is the one that must be true.
    description:
      "Wie «Vorschlagen», dazu wenige freigegebene Befehle. Ein Befehl führt Projektcode mit Ihren " +
      "Benutzerrechten aus; dieser Code kann Dateien anlegen, ändern und löschen — auch ausserhalb " +
      "des Projekts und ohne Diff und ohne Ihre Zustimmung.",
    scopeNote: CODING_SCOPE_NOTE,
  },
];
