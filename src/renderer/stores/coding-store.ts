/**
 * Coding Store — the trigger and the approval surface of ONE coding run.
 *
 * It decides what may be started (chat view, mode above `off`, a project
 * picked), what the human may answer (only what a consent request offers) and
 * what crosses to the main process (a directory id, never a path: R35). The
 * main process re-checks all of it; nothing here is the security boundary, it
 * is the honest surface in front of it.
 *
 * No workspace, no file tree, no editor: that is Phase 2.
 */

import { create } from 'zustand'
import {
  CODING_CONSENT_CHOICES,
  CODING_MODE_CHOICES,
  CODING_MODE_ORDER,
  CODING_REFUSALS_MAY_HAVE_WRITTEN,
  parseCodingMode,
  parseCodingRefusalCode,
  type CodingConsentChoice,
  type CodingConsentRequest,
  type CodingMode,
  type CodingUndoOutcome,
  type PendingEditView
} from '../../shared/coding-types'
import type { AllowedDirectory } from '../../shared/file-access-types'
import { describeUndo, refusalText, type UndoView } from '../lib/coding-display'
import { useAgentStore } from './agent-store'

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

/**
 * A coding run starts in the chat view only, with a mode above `off`. The mode
 * is re-parsed: an unknown value reads as `off`, never as "high".
 */
export function isCodingRunStartable(viewMode: string, mode: CodingMode): boolean {
  return viewMode === 'chat' && CODING_MODE_ORDER[parseCodingMode(mode)] > 0
}

/**
 * The answers to show for a consent request: exactly those it offers, in the
 * canonical order. A choice the request did not offer (`anonymize` when it does
 * not hold) is not shown, and an unknown entry in `offers` is ignored.
 */
export function consentOptions(request: CodingConsentRequest): CodingConsentChoice[] {
  const offered: readonly unknown[] = Array.isArray(request.offers) ? request.offers : []
  return CODING_CONSENT_CHOICES.filter((choice) => offered.includes(choice))
}

// ---------------------------------------------------------------------------
// Replies from the main process (unchecked shapes, read defensively)
// ---------------------------------------------------------------------------

interface ModeReply {
  success?: boolean
  mode?: unknown
  error?: string
}
interface ListReply {
  success?: boolean
  directories?: AllowedDirectory[]
  directory?: AllowedDirectory
}
interface PendingReply {
  success?: boolean
  directoryId?: string
  digest?: string
  edits?: PendingEditView[]
  error?: string
}
interface AcceptReply {
  success?: boolean
  error?: string
  outcome?: { kind?: string; paths?: string[]; reason?: string; code?: unknown }
}
interface RejectReply {
  success?: boolean
  error?: string
  outcome?: { kind?: string; reason?: string; code?: unknown }
}
interface UndoReply {
  success?: boolean
  error?: string
  outcome?: CodingUndoOutcome
}
/** What CODING_CONSENT_RESPOND answers: `settled` is the broker's own boolean. */
interface ConsentReply {
  success?: boolean
  settled?: boolean
  error?: string
}
interface AuditReply {
  success?: boolean
  csv?: string
  error?: string
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface PendingPackage {
  runId: string
  directoryId: string
  digest: string
  edits: PendingEditView[]
}

/**
 * What an accept left behind.
 *
 * `uncertain` marks the three refusals after which files may ALREADY be on
 * disk (`partial`, `withdrawn`, `interrupted`). Their texts all tell the user
 * to run undo, so the surface has to offer an undo target — and must stop
 * offering «Annehmen», because the package is no longer the one that was
 * approved. `paths` is then empty: which files were written is not known
 * here, and guessing would be worse than saying so.
 */
export interface AppliedPackage {
  runId: string
  directoryId: string
  paths: string[]
  uncertain?: true
}

export interface StartRunArgs {
  viewMode: string
  task: string
  provider: string
  model: string
  conversationId?: string
}

interface CodingState {
  grants: AllowedDirectory[]
  selectedDirectoryId: string | null
  /** Mode per directory id, always parsed: an unknown stored value is `off`. */
  modes: Record<string, CodingMode>
  runInFlight: boolean
  consent: CodingConsentRequest | null
  pending: PendingPackage | null
  lastRun: { runId: string; directoryId: string } | null
  applied: AppliedPackage | null
  undo: UndoView | null
  error: string | null

  loadProjects: () => Promise<void>
  addProject: () => Promise<void>
  selectProject: (directoryId: string | null) => void
  setMode: (directoryId: string, mode: CodingMode) => Promise<void>
  startRun: (args: StartRunArgs) => Promise<{ started: boolean; reason?: string }>
  respondConsent: (choice: CodingConsentChoice) => Promise<void>
  acceptPending: () => Promise<void>
  rejectPending: (reason?: string) => Promise<void>
  undoLast: () => Promise<void>
  exportAudit: () => Promise<string | null>
  clearResult: () => void
  clearError: () => void
}

function api(): Window['electronAPI'] | null {
  return typeof window !== 'undefined' ? (window.electronAPI ?? null) : null
}

const NO_API = 'Die Anwendungsschnittstelle ist nicht verfügbar.'
const UNKNOWN_ERROR = 'Ein unbekannter Fehler ist aufgetreten.'
/**
 * `settled: false` says only that THIS answer settled nothing. The question
 * may have run out of time, but it may also have been replaced by a newer one,
 * belong to a run that was cancelled, or carry a stale requestId — the broker
 * does not say which. "Die Frage war bereits abgelaufen" named one cause out
 * of four; "nicht mehr offen" is what the flag actually means.
 */
const CONSENT_NOT_SETTLED =
  'Ihre Antwort wurde nicht übernommen: Die Frage war nicht mehr offen. ' +
  'Der Lauf wurde ohne diese Datei fortgesetzt.'
const CONSENT_REFUSED = 'Die Antwort wurde nicht angenommen. Die Frage bleibt offen.'
const NO_DIGEST =
  'Die vorgeschlagenen Änderungen wurden ohne Prüfsumme gemeldet und werden deshalb nicht zur ' +
  'Annahme angeboten. Starten Sie den Lauf neu.'
/**
 * The reason recorded for a package the surface stops offering after an accept
 * broke off. It lands in the audit trail as the refusal reason of every
 * proposal in the package, so it says what happened, not who clicked.
 */
const ACCEPT_ABORTED_REASON = 'Das Anwenden wurde abgebrochen; der Vorschlag wurde nicht weiter angeboten.'
/**
 * The same for a package the surface could not reload: it stops being offered,
 * so the main process has to stop holding it.
 */
const REFRESH_FAILED_REASON =
  'Die vorgeschlagenen Änderungen konnten nicht erneut geladen werden; der Vorschlag wurde nicht ' +
  'weiter angeboten.'
/** Appended when the main process did not confirm the rejection above. */
const REJECTION_NOT_RECORDED =
  'Hinweis: Die Ablehnung dieser Vorschläge konnte nicht vermerkt werden; im Audit-Export erscheinen ' +
  'sie weder als angewendet noch als abgelehnt.'

/**
 * A thrown value as text for the error box. The surface renders under
 * `{error && …}`, so a non-Error throw or an empty message must never become
 * `undefined` or `''`: the failure would vanish from the one place that reports it.
 */
function errorText(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message
  if (typeof error === 'string' && error !== '') return error
  return UNKNOWN_ERROR
}

export const useCodingStore = create<CodingState>((set, get) => {
  // The main process asks, mid-run, about a finding in ONE tool result. The run
  // is paused until the answer comes, so this has to be wired from the start.
  const consentApi = api()?.codingConsent
  if (consentApi?.onRequest) {
    consentApi.onRequest((request) => {
      set({ consent: request })
    })
  }

  /**
   * The package a run holds NOW, in the one place that decides what counts as
   * usable.
   *
   * The digest is what binds an accept to the list the human saw. A package
   * that arrives without one used to be carried as `digest: ''`, which the
   * main process refuses on every accept — a dialog whose only working button
   * is «Ablehnen», with no explanation. It is not offered at all instead.
   */
  const loadPending = async (
    runId: string,
    directoryId: string
  ): Promise<
    | { kind: 'package'; pending: PendingPackage }
    | { kind: 'empty' }
    | { kind: 'error'; error: string }
  > => {
    const bridge = api()?.codingEdits
    if (!bridge) return { kind: 'error', error: NO_API }
    try {
      const reply: PendingReply = await bridge.pending(runId)
      if (reply.success !== true) {
        return {
          kind: 'error',
          error: reply.error ?? 'Die vorgeschlagenen Änderungen konnten nicht geladen werden.'
        }
      }
      const edits = Array.isArray(reply.edits) ? reply.edits : []
      if (edits.length === 0) return { kind: 'empty' }
      if (typeof reply.digest !== 'string' || reply.digest === '') {
        return { kind: 'error', error: NO_DIGEST }
      }
      return { kind: 'package', pending: { runId, directoryId, digest: reply.digest, edits } }
    } catch (error) {
      return { kind: 'error', error: errorText(error) }
    }
  }

  /** Replace the shown package by what the run holds now, keeping `message` visible. */
  const refreshPending = async (previous: PendingPackage, message: string): Promise<void> => {
    const loaded = await loadPending(previous.runId, previous.directoryId)
    if (loaded.kind === 'package') {
      set({ pending: loaded.pending, error: message })
      return
    }
    if (loaded.kind === 'empty') {
      // Checked rather than assumed: an empty reply means the run has no
      // entries left in the main process, and entries only go away once it
      // recorded the package as accepted, rejected or abandoned
      // (EditProposalStore.resolve / resolveApplied / endRun). There is nothing
      // left for a rejection to resolve.
      set({ pending: null, error: message })
      return
    }
    // Who else believes something about this package? The main process does —
    // the reload FAILED, so nothing there resolved it, and dropping `pending`
    // alone would leave the proposals in neither half of the audit trail and
    // keep one of the EDIT_MAX_RETAINED_RUNS slots for the rest of the session.
    // Told BEFORE `pending` is cleared, as on the accept path; a rejection that
    // does not go through is NAMED and changes nothing else.
    const recorded = await rejectInMain(previous.runId, REFRESH_FAILED_REASON)
    const reason = `${message} ${loaded.error}`
    set({ pending: null, error: recorded ? reason : `${reason} ${REJECTION_NOT_RECORDED}` })
  }

  /**
   * Tell the MAIN process that a package the surface stopped offering is
   * refused. Returns whether it confirmed.
   *
   * The renderer dropping `pending` is only half of it: `resolve(runId, false,
   * …)` is reached from `rejectEditsForRun` alone, so nothing else resolves the
   * package afterwards. Left unresolved it produces no `coding.change_rejected`
   * row — the proposals appear in the export neither as applied nor as refused
   * — and it keeps one of the EDIT_MAX_RETAINED_RUNS slots for the rest of the
   * session, which eventually makes a NEW run's first proposal be refused.
   *
   * Not `rejectPending`: that one clears `error`, and the caller here has a
   * message the user must keep seeing.
   */
  const rejectInMain = async (runId: string, reason: string): Promise<boolean> => {
    const bridge = api()?.codingEdits
    if (!bridge) return false
    try {
      const reply: RejectReply = await bridge.reject(runId, reason)
      return reply.success === true
    } catch {
      return false
    }
  }

  const readMode = async (directoryId: string): Promise<CodingMode> => {
    const bridge = api()?.codingMode
    if (!bridge) return 'off'
    try {
      const reply: ModeReply = await bridge.get(directoryId)
      return reply.success === true ? parseCodingMode(reply.mode) : 'off'
    } catch {
      // Unreadable is `off`, never "whatever it was".
      return 'off'
    }
  }

  return {
    grants: [],
    selectedDirectoryId: null,
    modes: {},
    runInFlight: false,
    consent: null,
    pending: null,
    lastRun: null,
    applied: null,
    undo: null,
    error: null,

    loadProjects: async () => {
      const bridge = api()?.fileAccess
      if (!bridge) {
        set({ error: NO_API })
        return
      }
      try {
        const reply: ListReply = await bridge.listDirectories()
        const grants = (reply.directories ?? []).filter((dir) => dir.permissions.length > 0)
        const entries = await Promise.all(
          grants.map(async (dir) => [dir.id, await readMode(dir.id)] as const)
        )
        set({ grants, modes: Object.fromEntries(entries) })
      } catch (error) {
        set({ error: errorText(error) })
      }
    },

    addProject: async () => {
      const bridge = api()?.fileAccess
      if (!bridge) {
        set({ error: NO_API })
        return
      }
      try {
        // The OS picker is the user's gesture and sets `confirmedAt`; `edit` is
        // asked for here because a project without it can never be changed.
        const reply: ListReply = await bridge.requestDirectory(['read', 'create', 'edit'])
        const directory = reply.directory
        if (reply.success !== true || !directory) return
        const mode = await readMode(directory.id)
        set((state) => ({
          grants: [...state.grants.filter((g) => g.id !== directory.id), directory],
          modes: { ...state.modes, [directory.id]: mode },
          selectedDirectoryId: directory.id
        }))
      } catch (error) {
        set({ error: errorText(error) })
      }
    },

    selectProject: (directoryId) => {
      set({ selectedDirectoryId: directoryId })
    },

    setMode: async (directoryId, mode) => {
      // Only a level the picker offers is ever sent. The main process refuses
      // the rest too; this keeps the renderer from asking.
      if (!CODING_MODE_CHOICES.some((choice) => choice.mode === mode)) return
      const bridge = api()?.codingMode
      if (!bridge) {
        set({ error: NO_API })
        return
      }
      try {
        const reply: ModeReply = await bridge.set(directoryId, mode)
        if (reply.success !== true) {
          set({ error: reply.error ?? 'Der Modus konnte nicht gespeichert werden.' })
          return
        }
        // The state follows the main process's answer, not the request.
        set((state) => ({
          error: null,
          modes: { ...state.modes, [directoryId]: parseCodingMode(reply.mode) }
        }))
      } catch (error) {
        set({ error: errorText(error) })
      }
    },

    startRun: async ({ viewMode, task, provider, model, conversationId }) => {
      const { selectedDirectoryId, modes, runInFlight, pending, consent } = get()
      if (!selectedDirectoryId) {
        return { started: false, reason: 'Es ist kein Projekt gewählt.' }
      }
      const mode = parseCodingMode(modes[selectedDirectoryId])
      if (viewMode !== 'chat') {
        return { started: false, reason: 'Ein Coding-Lauf startet nur in der Chat-Ansicht.' }
      }
      if (!isCodingRunStartable(viewMode, mode)) {
        return { started: false, reason: 'Der Coding-Modus dieses Projekts ist aus.' }
      }
      if (runInFlight) {
        return { started: false, reason: 'Es läuft bereits ein Coding-Lauf.' }
      }
      // A new run used to clear `pending` and `consent` on its way in. An
      // unreviewed package then vanished from the surface without a rejection
      // and without an audit entry, while the main process still held it —
      // reachable with a keyboard, because the dialog traps no focus. A
      // decision that is open has to be made first.
      //
      // The reason also goes into `error`: the caller in MessageInput drops it
      // (it only reads `started`), so a refusal that lived in the return value
      // alone would look like nothing happening at all. `error` is rendered by
      // the diff dialog and the picker.
      if (pending) {
        const reason =
          'Es liegen noch vorgeschlagene Änderungen vor. Nehmen Sie sie an oder lehnen Sie sie ab, ' +
          'bevor Sie einen neuen Lauf starten.'
        set({ error: reason })
        return { started: false, reason }
      }
      if (consent) {
        const reason =
          'Eine Rückfrage des laufenden Vorgangs ist noch offen. Beantworten Sie sie zuerst.'
        set({ error: reason })
        return { started: false, reason }
      }

      const directoryId = selectedDirectoryId
      set({
        runInFlight: true,
        error: null,
        consent: null,
        pending: null,
        // `applied` SURVIVES a new run, decided rather than left to chance: it
        // is the undo target of the run that was accepted, the snapshot for it
        // is still on disk, and this is the only place the surface offers an
        // undo. Clearing it took the one way back from the user as soon as
        // they asked anything else. The box names it as the LAST applied
        // package so it cannot be read as this run's result, and
        // clearResult() dismisses it when the user chooses to.
        // `undo` is cleared: it is the report of an undo already carried out.
        undo: null
      })

      // The directory id is all that is sent. The path comes from the grant, in
      // the main process (R35).
      const run = await useAgentStore
        .getState()
        .executeAgent(task, provider, model, conversationId, [], undefined, { directoryId })

      if (!run) {
        set({
          runInFlight: false,
          consent: null,
          error: useAgentStore.getState().error ?? 'Der Coding-Lauf konnte nicht gestartet werden.'
        })
        return { started: false, reason: 'Der Coding-Lauf wurde abgelehnt.' }
      }

      set({
        runInFlight: false,
        consent: null,
        lastRun: { runId: run.id, directoryId },
        error: run.status === 'failed' ? (run.error ?? 'Der Coding-Lauf ist fehlgeschlagen.') : null
      })

      // Only a mode that may propose can have a package to approve.
      if (CODING_MODE_ORDER[mode] >= CODING_MODE_ORDER.propose) {
        const loaded = await loadPending(run.id, directoryId)
        if (loaded.kind === 'package') set({ pending: loaded.pending })
        else if (loaded.kind === 'error') set({ error: loaded.error })
      }
      return { started: true }
    },

    respondConsent: async (choice) => {
      const { consent } = get()
      if (!consent) return
      // Never send what the request did not offer; the question stays open.
      if (!consentOptions(consent).includes(choice)) return
      const bridge = api()?.codingConsent
      if (!bridge) {
        set({ error: NO_API })
        return
      }
      try {
        const reply: ConsentReply | undefined = await bridge.respond(
          consent.runId,
          consent.requestId,
          choice
        )
        // A refused call (rate limit, feature gate) settled nothing and the
        // question is still open: say why, and leave it open.
        if (reply?.success !== true) {
          set({ error: reply?.error ?? CONSENT_REFUSED })
          return
        }
        // `settled` is the broker's verdict. Anything but an explicit true is
        // read as "not settled by this click": the question had already expired
        // (it settles itself to drop-file) and the run went on without the file.
        const notice = reply.settled === true ? {} : { error: CONSENT_NOT_SETTLED }
        // Only the question that was answered is closed: a newer one stays.
        set((state) =>
          state.consent?.requestId === consent.requestId ? { consent: null, ...notice } : notice
        )
      } catch (error) {
        set({ error: errorText(error) })
      }
    },

    acceptPending: async () => {
      const { pending } = get()
      const bridge = api()?.codingEdits
      if (!pending || !bridge) return
      try {
        // The digest names the package the human was shown.
        const reply: AcceptReply = await bridge.accept(pending.runId, pending.directoryId, pending.digest)
        if (reply.success === true && reply.outcome?.kind === 'applied') {
          set({
            pending: null,
            error: null,
            applied: {
              runId: pending.runId,
              directoryId: pending.directoryId,
              paths: reply.outcome.paths ?? []
            }
          })
          return
        }

        // A refusal is a normal answer. Which refusal it is decides what the
        // surface must do next, so the code is read, not the sentence.
        const code = parseCodingRefusalCode(reply.outcome?.code)
        const message = refusalText(code, reply.outcome?.reason ?? reply.error)

        // The package changed after it was shown: showing the OLD list again
        // would invite the same refusal forever, with «Ablehnen» as the only
        // way out. Fetch what is pending NOW and let the human review that.
        if (code === 'package-changed') {
          await refreshPending(pending, message)
          return
        }

        // Files may already be on disk. Every one of these texts tells the
        // user to run undo, so the undo target has to exist — and «Annehmen»
        // must stop being offered, because what is on disk is no longer the
        // package that was approved.
        //
        // Who else believes something about this package? The main process
        // does: it still holds the proposals. It is told BEFORE the uncertain
        // state is set, so the audit trail says what happened. A rejection that
        // does not go through is NAMED and changes nothing else — the undo box
        // is the only way back and must appear either way.
        if (code !== undefined && CODING_REFUSALS_MAY_HAVE_WRITTEN.includes(code)) {
          const recorded = await rejectInMain(pending.runId, ACCEPT_ABORTED_REASON)
          set({
            pending: null,
            error: recorded ? message : `${message} ${REJECTION_NOT_RECORDED}`,
            applied: {
              runId: pending.runId,
              directoryId: pending.directoryId,
              paths: [],
              uncertain: true
            }
          })
          return
        }

        // Everything else wrote nothing: the package stays and the reason is shown.
        set({ error: message })
      } catch (error) {
        set({ error: errorText(error) })
      }
    },

    rejectPending: async (reason) => {
      const { pending } = get()
      const bridge = api()?.codingEdits
      if (!pending || !bridge) return
      const trimmed = reason?.trim()
      try {
        const reply: RejectReply = await bridge.reject(pending.runId, trimmed ? trimmed : undefined)
        if (reply.success === true) {
          set({ pending: null, error: null })
          return
        }
        set({
          error: refusalText(
            reply.outcome?.code,
            reply.outcome?.reason ?? reply.error ?? 'Die Ablehnung wurde nicht übernommen.'
          )
        })
      } catch (error) {
        set({ error: errorText(error) })
      }
    },

    undoLast: async () => {
      const target = get().applied ?? get().lastRun
      const bridge = api()?.codingEdits
      if (!target || !bridge) return
      try {
        const reply: UndoReply = await bridge.undo(target.runId, target.directoryId)
        if (reply.outcome) {
          // Restored AND refused both carry a report; both are shown in full.
          set({ undo: describeUndo(reply.outcome), error: null })
          return
        }
        set({ error: reply.error ?? 'Rückgängig machen ist fehlgeschlagen.' })
      } catch (error) {
        set({ error: errorText(error) })
      }
    },

    exportAudit: async () => {
      const bridge = api()?.codingEdits
      if (!bridge) {
        set({ error: NO_API })
        return null
      }
      try {
        const reply: AuditReply = await bridge.exportAudit()
        if (reply.success === true && typeof reply.csv === 'string') return reply.csv
        set({ error: reply.error ?? 'Der Audit-Export ist fehlgeschlagen.' })
        return null
      } catch (error) {
        set({ error: errorText(error) })
        return null
      }
    },

    clearResult: () => {
      set({ applied: null, undo: null })
    },

    clearError: () => {
      set({ error: null })
    }
  }
})
