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
  parseCodingMode,
  type CodingConsentChoice,
  type CodingConsentRequest,
  type CodingMode,
  type CodingUndoOutcome,
  type PendingEditView
} from '../../shared/coding-types'
import type { AllowedDirectory } from '../../shared/file-access-types'
import { describeUndo, type UndoView } from '../lib/coding-display'
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
  outcome?: { kind?: string; paths?: string[]; reason?: string }
}
interface RejectReply {
  success?: boolean
  error?: string
  outcome?: { kind?: string; reason?: string }
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
  applied: { runId: string; directoryId: string; paths: string[] } | null
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
const CONSENT_NOT_SETTLED =
  'Ihre Antwort wurde nicht übernommen: Die Frage war bereits abgelaufen. ' +
  'Der Lauf wurde ohne diese Datei fortgesetzt.'
const CONSENT_REFUSED = 'Die Antwort wurde nicht angenommen. Die Frage bleibt offen.'

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
      const { selectedDirectoryId, modes, runInFlight } = get()
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

      const directoryId = selectedDirectoryId
      set({
        runInFlight: true,
        error: null,
        consent: null,
        pending: null,
        applied: null,
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
        const bridge = api()?.codingEdits
        if (bridge) {
          try {
            const reply: PendingReply = await bridge.pending(run.id)
            if (reply.success === true && Array.isArray(reply.edits) && reply.edits.length > 0) {
              set({
                pending: {
                  runId: run.id,
                  directoryId,
                  digest: reply.digest ?? '',
                  edits: reply.edits
                }
              })
            } else if (reply.success !== true) {
              set({ error: reply.error ?? 'Die vorgeschlagenen Änderungen konnten nicht geladen werden.' })
            }
          } catch (error) {
            set({ error: errorText(error) })
          }
        }
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
        // A refusal is a normal answer: the package stays, the reason is shown.
        set({
          error: reply.outcome?.reason ?? reply.error ?? 'Die Änderungen wurden nicht geschrieben.'
        })
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
        set({ error: reply.outcome?.reason ?? reply.error ?? 'Die Ablehnung wurde nicht übernommen.' })
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
