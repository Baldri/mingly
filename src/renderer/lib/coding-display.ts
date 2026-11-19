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
import {
  CODING_CONSENT_ANSWER_TIMEOUT_MS,
  parseCodingRefusalCode,
  type CodingRefusalCode,
  type CodingUndoOutcome
} from '../../shared/coding-types'
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
// Refusals from the main process, in German
// ---------------------------------------------------------------------------

/**
 * One German sentence per refusal code, mapping the main process's English
 * texts one to one.
 *
 * No code is split and none is merged: everything that depends on the file
 * system arrives as `fs` and gets exactly ONE text here, so a refusal stays
 * no existence oracle for the agent. An unknown code is not guessed at — the
 * caller falls back to the text the main process sent.
 */
const REFUSAL_TEXT: Readonly<Record<CodingRefusalCode, string>> = {
  fs:
    'Es wurde nichts geschrieben: Eine Datei konnte nicht als unverändert seit dem Vorschlag ' +
    'bestätigt werden. Prüfen Sie den Vorschlag erneut.',
  grant:
    'Es wurde nichts geschrieben: Die Freigabe des Verzeichnisses oder der Coding-Modus erlaubt ' +
    'keine Änderungen mehr.',
  'nothing-pending': 'Es wurde nichts geschrieben: Für diesen Lauf ist nichts offen.',
  input: 'Es wurde nichts getan: Die Anfrage nennt keinen gültigen Lauf und kein gültiges Verzeichnis.',
  'run-directory':
    'Es wurde nichts getan: Nach dem Stand des Hauptprozesses gehört dieser Lauf nicht zu diesem ' +
    'Verzeichnis.',
  workspace:
    'Es wurde nichts geschrieben: Der Arbeitsbereich des Projekts gehört nicht zu dieser Freigabe.',
  snapshot:
    'Es wurde nichts geschrieben: Die Sicherung konnte nicht angelegt werden, und ohne Sicherung ' +
    'wird keine Datei geändert.',
  'no-snapshot':
    'Es wurde nichts wiederhergestellt: Für diesen Lauf gibt es in diesem Verzeichnis keine Sicherung.',
  unrecorded:
    'Es wurde nichts wiederhergestellt: Diese Sicherung ist in dieser App nicht verzeichnet (sie ' +
    'wurde nicht hier angelegt, ihr Verzeichnis wurde nachträglich verändert, oder der Eintrag ' +
    'fehlt). Sie wird nicht wiederhergestellt.',
  withdrawn:
    'Die Berechtigung wurde entzogen, während das Paket angewendet wurde. Bereits geschriebene ' +
    'Dateien bleiben geschrieben und können ohne Berechtigung nicht wiederhergestellt werden. ' +
    'Stellen Sie die Freigabe wieder her und machen Sie diesen Lauf rückgängig.',
  mixed:
    'Es wurde nichts wiederhergestellt: Die Dateien der verzeichneten Sicherung wurden nach dem ' +
    'Anwenden verändert, und andere Sicherungen dieses Laufs haben keinen gültigen Eintrag. Die ' +
    'Liste nennt jede einzeln.',
  'batch-unusable':
    'Es wurde nichts wiederhergestellt: Die Sicherungen dieses Laufs fehlen oder sind nicht lesbar.',
  interrupted:
    'Es wurde nichts geschrieben: Ein früheres Anwenden dieses Laufs wurde unterbrochen und hat ' +
    'möglicherweise einige Dateien geschrieben und andere nicht. Übrig gebliebene temporäre ' +
    'Dateien wurden entfernt. Machen Sie diesen Lauf zuerst rückgängig; dabei wird gemeldet, ' +
    'welche Dateien geschrieben wurden.',
  'package-changed':
    'Es wurde nichts geschrieben: Die Vorschläge haben sich geändert, nachdem sie angezeigt ' +
    'wurden, und müssen erneut geprüft werden.',
  busy:
    'Es wurde nichts geschrieben: Für dieses Projekt läuft gerade ein anderes Anwenden oder ' +
    'Rückgängigmachen.',
  partial:
    'Ein Schreibvorgang ist fehlgeschlagen, nachdem andere Dateien bereits geschrieben waren, und ' +
    'nicht jede Datei konnte wiederhergestellt werden. Machen Sie diesen Lauf rückgängig, um ' +
    'wiederherzustellen, was die Sicherung noch erlaubt.'
}

/** Shown when neither a known code nor a usable text arrived. */
const REFUSAL_UNKNOWN = 'Die Aktion wurde abgelehnt. Ein Grund wurde nicht übermittelt.'

/**
 * The German text for a refusal from the main process.
 *
 * `code` is the machine-readable cause; `fallback` is the text that came with
 * it. An unrecognised code falls back to that text rather than to a guess —
 * a future cause must be visible, even in English, instead of silently
 * becoming a wrong German sentence.
 */
export function refusalText(code: unknown, fallback?: unknown): string {
  const known = parseCodingRefusalCode(code)
  if (known) return REFUSAL_TEXT[known]
  if (typeof fallback === 'string' && fallback.trim() !== '') return displayText(fallback)
  return REFUSAL_UNKNOWN
}

// ---------------------------------------------------------------------------
// Sentences the approval surfaces make
// ---------------------------------------------------------------------------

/** Minutes the consent dialog may name, from the ONE place the deadline lives. */
const CONSENT_TIMEOUT_MINUTES = Math.round(CODING_CONSENT_ANSWER_TIMEOUT_MS / 60_000)

/**
 * What the consent dialog says about waiting.
 *
 * The old sentence ("Der Coding-Lauf ist angehalten, bis Sie antworten.") was
 * not true: the broker settles the question itself after the deadline and the
 * run carries on without that file. The minute figure is derived from the
 * shared constant, so the sentence cannot drift from the deadline.
 */
export const CODING_CONSENT_WAIT_NOTICE =
  `Der Coding-Lauf wartet auf Ihre Antwort. Antworten Sie nicht innerhalb von ` +
  `${CONSENT_TIMEOUT_MINUTES} Minuten, läuft er ohne diese Datei weiter.`

/**
 * What «Annehmen» in the diff dialog does, and what it does not cover.
 *
 * "es wird nichts geschrieben, was hier nicht steht" is true of the accept and
 * of nothing else: in mode `propose-run` a command runs project code, and
 * that code writes without a diff.
 */
export const CODING_ACCEPT_SCOPE_NOTICE =
  '«Annehmen» schreibt genau die Dateien dieser Liste, mit genau diesen Änderungen. Das gilt für ' +
  'diese Annahme: im Modus «Vorschlagen und ausführen» kann zusätzlich Projektcode, den ein ' +
  'Befehl startet, Dateien ohne Diff ändern.'

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
    // The German text comes from the code, not from the English sentence the
    // main process sent: prefixing that one produced "Nichts wurde rückgängig
    // gemacht: Nothing was restored: …". Only a cause with no known code
    // still gets the prefix, so an unexpected one stays visible.
    return {
      complete: false,
      headline: refusalText(
        outcome.code,
        `Nichts wurde rückgängig gemacht: ${outcome.reason}`
      ),
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
