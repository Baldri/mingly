/**
 * What the coding UI shows, as pure functions.
 *
 * The dialogs fed by these are approval surfaces. Every string that originates
 * with the model (paths, reasons, diff text, file names in an undo report) goes
 * through `displayText` / `diffLines`, which render hidden characters VISIBLY as
 * `<U+XXXX>` instead of stripping them: stripping would turn the line breaks of
 * a diff into spaces, and a visible escape tells the reviewer more than a
 * silent space. The list of what counts as hidden is the shared one; there is
 * no second list.
 */

import {
  escapeHiddenCharacters,
  escapeHiddenPerLine
} from '../../shared/hidden-characters'
import type { CodingUndoOutcome } from '../../shared/coding-types'
import type { FileAccessPermission } from '../../shared/file-access-types'

/** Text from outside the renderer, safe to put in front of a human. */
export function displayText(text: string): string {
  return escapeHiddenPerLine(text)
}

export interface DiffLineView {
  kind: 'add' | 'remove' | 'context' | 'meta'
  text: string
}

/**
 * A diff split into display lines, each escaped.
 *
 * Only the header block `buildDiff` emits is `meta`: optional `!!` warning
 * lines, then `--- `, then `+++ `, then the `@@` hunk header. After the hunk
 * header every line is body and its kind follows its single prefix character,
 * so model-supplied content such as `++i` (shown as `+++i`) or a deleted SQL
 * comment `-- x` (shown as `--- x`) cannot pass for a header. The header is read
 * in that exact order; the first line that does not fit it starts the body, so
 * without a hunk header nothing beyond the expected prefix can hide as meta.
 */
export function diffLines(diff: string): DiffLineView[] {
  // 0: warnings or `---`, 1: expects `+++`, 2: expects `@@`, 3: body.
  let stage = 0
  return diff.split('\n').map((line) => {
    const text = escapeHiddenCharacters(line)
    if (stage === 0 && line.startsWith('!!')) return { kind: 'meta', text }
    if (stage === 0 && line.startsWith('--- ')) {
      stage = 1
      return { kind: 'meta', text }
    }
    if (stage === 1 && line.startsWith('+++ ')) {
      stage = 2
      return { kind: 'meta', text }
    }
    if (stage === 2 && line.startsWith('@@')) {
      stage = 3
      return { kind: 'meta', text }
    }
    stage = 3
    if (line.startsWith('+')) return { kind: 'add', text }
    if (line.startsWith('-')) return { kind: 'remove', text }
    return { kind: 'context', text }
  })
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

/** Plain-language reasons for the skip reasons the main process knows. */
const SKIP_REASON_TEXT: Readonly<Record<string, string>> = {
  'changed-since-apply':
    'Die Datei wurde seit dem Anwenden verändert und bleibt unangetastet (spätere Arbeit wird nie überschrieben).',
  'snapshot-damaged': 'Die gesicherte Fassung ist beschädigt oder passt nicht mehr zu ihrer Prüfsumme.',
  'path-not-allowed': 'Der Pfad liegt nicht (mehr) in der freigegebenen Verzeichnisstruktur.',
  unreadable: 'Die Datei konnte nicht gelesen werden.',
  'write-failed': 'Das Zurückschreiben ist fehlgeschlagen.',
  'not-written-interrupted': 'Das Anwenden wurde unterbrochen; diese Datei wurde nie geschrieben und hat noch den alten Inhalt.',
  'batch-not-recorded': 'Diese Sicherung ist in dieser App nicht verzeichnet.',
  'batch-manifest-changed': 'Das Verzeichnis der Sicherung wurde seit der Aufzeichnung verändert.',
  'batch-manifest-missing': 'Das Verzeichnis der Sicherung fehlt.',
  'batch-manifest-invalid': 'Das Verzeichnis der Sicherung ist nicht lesbar.'
}

export interface UndoView {
  /** True only when every file was restored and the apply was not interrupted. */
  complete: boolean
  headline: string
  restored: string[]
  skipped: Array<{ path: string; reason: string; reasonText: string }>
}

/**
 * What undo did, as paths: restored AND not restored, each skipped file with its
 * reason. A count alone is not a description, and "undone" alone would be false
 * whenever anything was skipped. An unknown reason is shown as it came.
 */
export function describeUndo(outcome: CodingUndoOutcome): UndoView {
  const skippedRaw = outcome.skipped ?? []
  const skipped = skippedRaw.map((file) => ({
    path: displayText(file.path),
    reason: file.reason,
    reasonText: SKIP_REASON_TEXT[file.reason] ?? `Grund: ${displayText(file.reason)}`
  }))

  if (outcome.kind === 'refused') {
    return {
      complete: false,
      headline: `Nichts wurde rückgängig gemacht: ${displayText(outcome.reason)}`,
      restored: [],
      skipped
    }
  }

  const restored = outcome.restored.map(displayText)
  const complete = skipped.length === 0 && outcome.interrupted !== true
  if (complete) {
    return {
      complete,
      headline: `Rückgängig gemacht: ${restored.length} ${restored.length === 1 ? 'Datei' : 'Dateien'} wiederhergestellt`,
      restored,
      skipped
    }
  }
  const interruptedNote = outcome.interrupted === true ? ' Das Anwenden war unterbrochen.' : ''
  return {
    complete,
    headline:
      `Nur teilweise rückgängig gemacht: ${restored.length} wiederhergestellt, ` +
      `${skipped.length} nicht wiederhergestellt.${interruptedNote}`,
    restored,
    skipped
  }
}

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

/**
 * The label of a directory grant. `edit` is named whenever it is granted: it is
 * the permission that overwrites existing files, and a product whose argument is
 * "I can prove what the agent may do" must not hide it behind "Read + Create".
 */
export function getPermissionLabel(permissions: readonly FileAccessPermission[]): string {
  const canRead = permissions.includes('read') || permissions.includes('read-create')
  const canCreate = permissions.includes('create') || permissions.includes('read-create')
  const canEdit = permissions.includes('edit')

  const base = canRead && canCreate
    ? 'Read + Create'
    : canRead
      ? 'Read Only'
      : canCreate
        ? 'Create Only'
        : ''

  if (canEdit) return base === '' ? 'Edit' : `${base} + Edit`
  return base === '' ? 'Unknown' : base
}

// ---------------------------------------------------------------------------
// Feature gate
// ---------------------------------------------------------------------------

/**
 * Whether the coding controls may be offered. The main process gates every coding
 * channel on `agentic_mode`; the renderer mirrors it so a tier without it is sent
 * to the upgrade dialog instead of into a gate error. Unknown (not loaded yet,
 * absent key) is NOT allowed: the stricter side.
 */
export function isCodingFeatureAllowed(
  features: Readonly<Record<string, { allowed?: boolean } | undefined>> | undefined
): boolean {
  return features?.agentic_mode?.allowed === true
}
