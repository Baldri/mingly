/**
 * What the renderer may ASK for around a coding run, and what the main process
 * makes of it.
 *
 * R35: the project path of a run is derived HERE from the grant for the
 * directory id. A `projectPath` in the renderer's request is a claim, checked
 * against the grant and REJECTED on mismatch. Never corrected: a silent
 * correction would erase the one signal that the renderer tried to aim the run
 * at a directory the user never granted. (Same class as the renderer extending
 * the directory allowlist itself.)
 *
 * Everything arriving here is an input of unknown shape.
 */

import * as path from 'path'
import {
  CODING_MODE_CHOICES,
  parseCodingMode,
  type CodingMode,
  type CodingRunOptions,
  type PendingEditView,
  type PendingPackageView
} from '../../shared/coding-types'
import { hasPermission, type AllowedDirectory } from '../../shared/file-access-types'
import { defaultReadToolDeps } from './read-tools'
import { getEditProposalStore, packageDigest, type EditProposalStore } from './edit-proposals'
import { getRunDirectoryRegistry, type RunDirectoryRegistry } from './run-directories'
import { SAFE_RUN_ID } from './apply-edits'

export interface CodingRunDeps {
  findGrant(directoryId: string): Promise<AllowedDirectory | undefined>
  getMode(directoryId: string): CodingMode | Promise<CodingMode>
  setMode(directoryId: string, mode: CodingMode): void | Promise<void>
}

/** Loaded lazily: the mode store pulls in electron. */
let modeStoreModule: Promise<typeof import('./coding-mode-store')> | undefined

export function defaultCodingRunDeps(): CodingRunDeps {
  return {
    findGrant: (id) => defaultReadToolDeps.findGrant(id),
    async getMode(id) {
      modeStoreModule ??= import('./coding-mode-store')
      return (await modeStoreModule).getCodingModeStore().getMode(id)
    },
    async setMode(id, mode) {
      modeStoreModule ??= import('./coding-mode-store')
      ;(await modeStoreModule).getCodingModeStore().setMode(id, mode)
    }
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ---------------------------------------------------------------------------
// Starting a run
// ---------------------------------------------------------------------------

export type ResolvedRun =
  | { kind: 'resolved'; coding: CodingRunOptions }
  | { kind: 'refused'; reason: string }

const REFUSE_REQUEST = 'Coding run refused: the request names no valid project directory.'
const REFUSE_GRANT = 'Coding run refused: no usable grant for that directory.'
const REFUSE_PATH =
  'Coding run refused: the project path in the request does not belong to the grant for that directory.'
const REFUSE_MODE =
  'Coding run refused: the mode in the request is not the mode stored for that directory.'
const REFUSE_STORE = 'Coding run refused: the coding mode could not be read.'

function refusedRun(reason: string): ResolvedRun {
  return { kind: 'refused', reason }
}

export async function resolveCodingRun(
  raw: unknown,
  deps: CodingRunDeps = defaultCodingRunDeps()
): Promise<ResolvedRun> {
  try {
    if (!isPlainRecord(raw)) return refusedRun(REFUSE_REQUEST)
    const directoryId = raw.directoryId
    if (typeof directoryId !== 'string' || directoryId === '') return refusedRun(REFUSE_REQUEST)

    const grant = await deps.findGrant(directoryId)
    if (!grant || typeof grant.path !== 'string' || !hasPermission(grant, 'read')) {
      return refusedRun(REFUSE_GRANT)
    }
    const projectPath = path.resolve(grant.path)

    // A claimed path is checked, never used. `undefined` is "no claim"; every
    // other value, including null and the empty string, is a claim that must match.
    if (raw.projectPath !== undefined) {
      if (typeof raw.projectPath !== 'string' || path.resolve(raw.projectPath) !== projectPath) {
        return refusedRun(REFUSE_PATH)
      }
    }

    const mode = parseCodingMode(await deps.getMode(directoryId))
    if (raw.mode !== undefined && raw.mode !== mode) return refusedRun(REFUSE_MODE)

    return { kind: 'resolved', coding: { directoryId, projectPath, mode } }
  } catch {
    // A store that throws is a refusal, never a run on a guessed mode.
    return refusedRun(REFUSE_STORE)
  }
}

// ---------------------------------------------------------------------------
// Setting the mode
// ---------------------------------------------------------------------------

export type SetModeOutcome =
  | { kind: 'set'; mode: CodingMode }
  | { kind: 'refused'; reason: string }

/**
 * Stores a mode only if it is one the picker offers, for a directory that is a
 * grant. An unlisted value is REFUSED, not coerced to `off`: the stored value is
 * what a later run is checked against, and "you asked for X, you got off" is a
 * surprise nobody should have to debug.
 */
export async function setCodingModeForDirectory(
  directoryId: unknown,
  mode: unknown,
  deps: CodingRunDeps = defaultCodingRunDeps()
): Promise<SetModeOutcome> {
  const choice = CODING_MODE_CHOICES.find((c) => c.mode === mode)
  if (!choice) return { kind: 'refused', reason: 'That coding mode does not exist.' }
  if (typeof directoryId !== 'string' || directoryId === '') {
    return { kind: 'refused', reason: 'No project directory was named.' }
  }
  try {
    const grant = await deps.findGrant(directoryId)
    if (!grant) return { kind: 'refused', reason: 'That directory is not a granted project.' }
    // A mode that proposes edits on a grant that cannot be edited would be
    // stored and then fail at every run. Say so now.
    if (
      (choice.mode === 'propose' || choice.mode === 'propose-run') &&
      !hasPermission(grant, 'edit')
    ) {
      return {
        kind: 'refused',
        reason: 'This mode proposes edits, but the grant for that directory has no edit permission.'
      }
    }
    await deps.setMode(directoryId, choice.mode)
    return { kind: 'set', mode: choice.mode }
  } catch {
    return { kind: 'refused', reason: 'The coding mode could not be stored.' }
  }
}

// ---------------------------------------------------------------------------
// The pending package
// ---------------------------------------------------------------------------

export type PendingOutcome =
  | ({ kind: 'pending' } & PendingPackageView)
  | { kind: 'refused'; reason: string }

export interface PendingDeps {
  store: Pick<EditProposalStore, 'pending'>
  runDirectories: Pick<RunDirectoryRegistry, 'get'>
}

/**
 * The package the human is asked to approve, in the form the renderer may see.
 * The digest covers the FULL proposals; the view carries no file text.
 */
export function getPendingPackage(
  runId: unknown,
  deps: PendingDeps = { store: getEditProposalStore(), runDirectories: getRunDirectoryRegistry() }
): PendingOutcome {
  if (typeof runId !== 'string' || !SAFE_RUN_ID.test(runId)) {
    return { kind: 'refused', reason: 'That is not a valid run id.' }
  }
  const edits = deps.store.pending(runId)
  const views: PendingEditView[] = edits.map((edit) => ({
    path: edit.path,
    diff: edit.diff,
    addedLines: edit.addedLines,
    removedLines: edit.removedLines,
    introducesHiddenCharacters: edit.introducesHiddenCharacters
  }))
  return {
    kind: 'pending',
    directoryId: deps.runDirectories.get(runId),
    digest: packageDigest(edits),
    edits: views
  }
}
