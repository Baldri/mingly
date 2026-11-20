/**
 * Coding store: the trigger and the approval surface of ONE coding run.
 * The store decides what may start, what the human may answer, and what is sent
 * to the main process; the main process re-checks all of it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CodingConsentRequest } from '../../src/shared/coding-types'

const h = vi.hoisted(() => ({
  consentCallback: null as null | ((r: unknown) => void),
  api: {
    agent: {
      execute: vi.fn(),
      cancel: vi.fn(),
      getConfig: vi.fn(),
      updateConfig: vi.fn(),
      onStep: vi.fn(() => () => undefined)
    },
    fileAccess: { listDirectories: vi.fn(), requestDirectory: vi.fn() },
    codingMode: { get: vi.fn(), set: vi.fn() },
    codingEdits: {
      pending: vi.fn(),
      accept: vi.fn(),
      reject: vi.fn(),
      undo: vi.fn(),
      exportAudit: vi.fn()
    },
    codingConsent: {
      onRequest: vi.fn(),
      respond: vi.fn()
    }
  }
}))

h.api.codingConsent.onRequest.mockImplementation((cb: (r: unknown) => void) => {
  h.consentCallback = cb
  return () => undefined
})
vi.stubGlobal('window', { electronAPI: h.api })

const { useCodingStore, consentOptions, isCodingRunStartable } = await import(
  '../../src/renderer/stores/coding-store'
)
const initialState = useCodingStore.getState()

const GRANT = {
  id: 'd1',
  path: '/Users/x/proj',
  name: 'proj',
  location: 'local',
  permissions: ['read', 'create', 'edit'],
  recursive: true,
  grantedAt: 1,
  confirmedAt: 1,
  accessCount: 0
}

const RUN = { id: 'run_1', status: 'completed', steps: [], task: 't' }

const EDIT = {
  path: 'src/a.ts',
  diff: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n-x\n+y',
  addedLines: 1,
  removedLines: 1,
  introducesHiddenCharacters: false
}

function request(offers: CodingConsentRequest['offers']): CodingConsentRequest {
  return {
    requestId: 'q1',
    runId: 'run_1',
    stepNumber: 2,
    toolName: 'mingly_read_file',
    filePath: 'config/.env',
    matches: [{ type: 'api_key', riskLevel: 'critical' }],
    offers
  }
}

async function ready(mode: string): Promise<void> {
  h.api.fileAccess.listDirectories.mockResolvedValue({ success: true, directories: [GRANT] })
  h.api.codingMode.get.mockResolvedValue({ success: true, mode })
  await useCodingStore.getState().loadProjects()
  useCodingStore.getState().selectProject('d1')
}

const START = { viewMode: 'chat', task: 'fix it', provider: 'anthropic', model: 'm', conversationId: 'c1' }

describe('coding store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.api.codingConsent.onRequest.mockImplementation((cb: (r: unknown) => void) => {
      h.consentCallback = cb
      return () => undefined
    })
    useCodingStore.setState(initialState, true)
    h.api.agent.execute.mockResolvedValue({ success: true, run: RUN })
    h.api.codingEdits.pending.mockResolvedValue({
      success: true,
      kind: 'pending',
      directoryId: 'd1',
      digest: 'dig1',
      edits: [EDIT]
    })
  })

  describe('starting a run', () => {
    it('a coding run is only startable in the chat view', async () => {
      await ready('propose')
      for (const viewMode of ['comparison', 'agent_comparison', 'subagent', '']) {
        const out = await useCodingStore.getState().startRun({ ...START, viewMode })
        expect(out.started).toBe(false)
      }
      expect(h.api.agent.execute).not.toHaveBeenCalled()
      // Positive control: the same state in the chat view does start.
      const ok = await useCodingStore.getState().startRun(START)
      expect(ok.started).toBe(true)
      expect(h.api.agent.execute).toHaveBeenCalledTimes(1)
    })

    it('does not start while the mode is off', async () => {
      await ready('off')
      const out = await useCodingStore.getState().startRun(START)
      expect(out.started).toBe(false)
      expect(h.api.agent.execute).not.toHaveBeenCalled()
    })

    it('reads an unknown stored mode (even "auto") as off', async () => {
      await ready('auto')
      expect(useCodingStore.getState().modes.d1).toBe('off')
      expect(isCodingRunStartable('chat', 'auto' as never)).toBe(false)
      const out = await useCodingStore.getState().startRun(START)
      expect(out.started).toBe(false)
    })

    it('does not start without a selected project', async () => {
      h.api.fileAccess.listDirectories.mockResolvedValue({ success: true, directories: [GRANT] })
      h.api.codingMode.get.mockResolvedValue({ success: true, mode: 'propose' })
      await useCodingStore.getState().loadProjects()
      const out = await useCodingStore.getState().startRun(START)
      expect(out.started).toBe(false)
    })

    it('sends only the directory id: no path, no mode (R35)', async () => {
      await ready('propose')
      await useCodingStore.getState().startRun(START)
      const args = h.api.agent.execute.mock.calls[0]
      expect(args[6]).toEqual({ directoryId: 'd1' })
      expect(JSON.stringify(args)).not.toContain('/Users/x/proj')
    })

    it('loads the pending package after a run that may propose', async () => {
      await ready('propose')
      await useCodingStore.getState().startRun(START)
      expect(h.api.codingEdits.pending).toHaveBeenCalledWith('run_1')
      expect(useCodingStore.getState().pending).toMatchObject({ runId: 'run_1', digest: 'dig1' })
      expect(useCodingStore.getState().lastRun).toEqual({ runId: 'run_1', directoryId: 'd1' })
    })

    it('does not ask for a package after a read-only run', async () => {
      await ready('read-only')
      await useCodingStore.getState().startRun(START)
      expect(h.api.codingEdits.pending).not.toHaveBeenCalled()
      expect(useCodingStore.getState().pending).toBeNull()
    })

    it('a refused start (main process said no) is surfaced, not swallowed', async () => {
      await ready('propose')
      h.api.agent.execute.mockResolvedValue({ success: false, error: 'coding run refused: path does not match the grant' })
      const out = await useCodingStore.getState().startRun(START)
      expect(out.started).toBe(false)
      expect(useCodingStore.getState().error).toContain('refused')
    })
  })

  describe('mode picker', () => {
    it('the mode picker never offers auto', async () => {
      const { CODING_MODE_CHOICES } = await import('../../src/shared/coding-types')
      const options: string[] = CODING_MODE_CHOICES.map((c) => c.mode)
      expect(options).not.toContain('auto')
      expect(options).toEqual(['off', 'read-only', 'propose', 'propose-run'])
    })

    it('does not send a mode the picker does not offer', async () => {
      await ready('off')
      await useCodingStore.getState().setMode('d1', 'auto' as never)
      expect(h.api.codingMode.set).not.toHaveBeenCalled()
      expect(useCodingStore.getState().modes.d1).toBe('off')
    })

    it('stores an offered mode only after the main process confirmed it', async () => {
      await ready('off')
      h.api.codingMode.set.mockResolvedValue({ success: false, error: 'grant cannot be edited' })
      await useCodingStore.getState().setMode('d1', 'propose')
      expect(useCodingStore.getState().modes.d1).toBe('off')
      expect(useCodingStore.getState().error).toContain('grant cannot be edited')

      h.api.codingMode.set.mockResolvedValue({ success: true, mode: 'propose' })
      await useCodingStore.getState().setMode('d1', 'propose')
      expect(h.api.codingMode.set).toHaveBeenLastCalledWith('d1', 'propose')
      expect(useCodingStore.getState().modes.d1).toBe('propose')
    })

    it('adds a project through the OS picker with read, create and edit', async () => {
      h.api.fileAccess.requestDirectory.mockResolvedValue({ success: true, directory: GRANT })
      h.api.codingMode.get.mockResolvedValue({ success: true, mode: 'off' })
      await useCodingStore.getState().addProject()
      expect(h.api.fileAccess.requestDirectory).toHaveBeenCalledWith(['read', 'create', 'edit'])
      expect(useCodingStore.getState().selectedDirectoryId).toBe('d1')
      expect(useCodingStore.getState().modes.d1).toBe('off')
    })
  })

  describe('consent', () => {
    it('shows only the consent options the request offers', () => {
      expect(consentOptions(request(['send', 'drop-file']))).toEqual(['send', 'drop-file'])
      expect(consentOptions(request(['drop-file']))).toEqual(['drop-file'])
      expect(consentOptions(request(['send', 'anonymize', 'drop-file']))).toEqual(['send', 'anonymize', 'drop-file'])
      expect(consentOptions(request(['send', 'drop-file']))).not.toContain('anonymize')
    })

    it('a malformed offers list shows nothing it did not offer', () => {
      const bad = { ...request(['send']), offers: ['send', 'wipe-disk', 7] } as unknown as CodingConsentRequest
      expect(consentOptions(bad)).toEqual(['send'])
    })

    it('opens on a request from the main process and answers with its ids', async () => {
      expect(h.consentCallback).toBeTypeOf('function')
      h.consentCallback?.(request(['send', 'drop-file']))
      expect(useCodingStore.getState().consent?.requestId).toBe('q1')
      h.api.codingConsent.respond.mockResolvedValue({ success: true, settled: true })
      await useCodingStore.getState().respondConsent('drop-file')
      expect(h.api.codingConsent.respond).toHaveBeenCalledWith('run_1', 'q1', 'drop-file')
      expect(useCodingStore.getState().consent).toBeNull()
    })

    it('tells the user when the answer settled nothing, without naming a cause it cannot know', async () => {
      h.consentCallback?.(request(['send', 'drop-file']))
      h.api.codingConsent.respond.mockResolvedValue({ success: true, settled: false })
      await useCodingStore.getState().respondConsent('send')
      const state = useCodingStore.getState()
      // The question is gone, but the user is told what really happened.
      expect(state.consent).toBeNull()
      expect(state.error).toMatch(/nicht mehr offen/)
      expect(state.error).toMatch(/ohne diese Datei/)
      // `settled: false` covers four causes (expired, replaced by a newer
      // question, cancelled run, stale requestId) and the broker does not say
      // which. Naming the expiry was a guess that happened to be the common case.
      expect(state.error).not.toMatch(/abgelaufen|Zeit|Frist/)
    })

    it('a reply without a settled flag is not read as settled', async () => {
      h.consentCallback?.(request(['send', 'drop-file']))
      h.api.codingConsent.respond.mockResolvedValue({ success: true })
      await useCodingStore.getState().respondConsent('send')
      expect(useCodingStore.getState().error).toMatch(/nicht mehr offen/)
    })

    it('a refused call (success: false) keeps the question open and shows the reason', async () => {
      h.consentCallback?.(request(['send', 'drop-file']))
      h.api.codingConsent.respond.mockResolvedValue({ success: false, error: 'Rate limit exceeded.' })
      await useCodingStore.getState().respondConsent('send')
      const state = useCodingStore.getState()
      expect(state.consent).not.toBeNull()
      expect(state.error).toContain('Rate limit exceeded.')
    })

    it('a non-Error throw still renders a non-empty error', async () => {
      h.consentCallback?.(request(['send', 'drop-file']))
      h.api.codingConsent.respond.mockRejectedValue('boom')
      await useCodingStore.getState().respondConsent('send')
      const error = useCodingStore.getState().error
      expect(typeof error).toBe('string')
      expect((error ?? '').length).toBeGreaterThan(0)
    })

    it('does not send a choice the request did not offer', async () => {
      h.consentCallback?.(request(['send', 'drop-file']))
      await useCodingStore.getState().respondConsent('anonymize')
      expect(h.api.codingConsent.respond).not.toHaveBeenCalled()
      // The question stays open: nothing was answered.
      expect(useCodingStore.getState().consent).not.toBeNull()
    })
  })

  describe('package decision', () => {
    async function withPending(): Promise<void> {
      await ready('propose')
      await useCodingStore.getState().startRun(START)
    }

    it('sends the rejection reason along with the rejection', async () => {
      await withPending()
      h.api.codingEdits.reject.mockResolvedValue({ success: true, outcome: { kind: 'rejected', count: 1 } })
      await useCodingStore.getState().rejectPending('Falsche Datei angepasst')
      expect(h.api.codingEdits.reject).toHaveBeenCalledWith('run_1', 'Falsche Datei angepasst')
      expect(useCodingStore.getState().pending).toBeNull()
    })

    it('accepts with the digest of the package the human was shown', async () => {
      await withPending()
      h.api.codingEdits.accept.mockResolvedValue({
        success: true,
        outcome: { kind: 'applied', paths: ['src/a.ts'] }
      })
      await useCodingStore.getState().acceptPending()
      expect(h.api.codingEdits.accept).toHaveBeenCalledWith('run_1', 'd1', 'dig1')
      expect(useCodingStore.getState().pending).toBeNull()
      expect(useCodingStore.getState().applied).toEqual({ runId: 'run_1', directoryId: 'd1', paths: ['src/a.ts'] })
    })

    it('a refused accept keeps the package and shows the reason', async () => {
      await withPending()
      h.api.codingEdits.accept.mockResolvedValue({
        success: false,
        outcome: { kind: 'refused', reason: 'Nothing was written: the package changed.' }
      })
      await useCodingStore.getState().acceptPending()
      expect(useCodingStore.getState().pending).not.toBeNull()
      expect(useCodingStore.getState().error).toContain('Nothing was written')
      expect(useCodingStore.getState().applied).toBeNull()
    })

    it('refuses to start a new run while a package is waiting for review', async () => {
      // The start used to clear `pending`: the package vanished from the
      // surface without a rejection and without an audit entry, while the
      // main process still held it. Reachable with a keyboard, because the
      // dialog traps no focus by itself.
      await withPending()
      expect(useCodingStore.getState().pending).not.toBeNull()
      h.api.agent.execute.mockClear()

      const out = await useCodingStore.getState().startRun(START)

      expect(out.started).toBe(false)
      // The refusal has to say what to do, not just that it refused.
      expect(out.reason).toMatch(/vorgeschlagene Änderungen/)
      expect(out.reason).toMatch(/Nehmen Sie sie an|lehnen Sie sie ab/)
      expect(h.api.agent.execute).not.toHaveBeenCalled()
      expect(useCodingStore.getState().pending).not.toBeNull()
      // The caller in MessageInput reads only `started`, so the reason has to
      // reach the surface through `error` as well, or nothing visible happens.
      expect(useCodingStore.getState().error).toBe(out.reason)
    })

    it('refuses to start a new run while a consent question is open', async () => {
      await ready('propose')
      h.consentCallback?.(request(['send', 'drop-file']))
      expect(useCodingStore.getState().consent).not.toBeNull()
      h.api.agent.execute.mockClear()

      const out = await useCodingStore.getState().startRun(START)

      expect(out.started).toBe(false)
      expect(h.api.agent.execute).not.toHaveBeenCalled()
      expect(useCodingStore.getState().consent).not.toBeNull()
      expect(useCodingStore.getState().error).toBe(out.reason)
    })

    it('keeps the undo target of an accepted package across a later run', async () => {
      // The snapshot is still on disk and this is the only undo the surface
      // offers; clearing it took the one way back away from the user.
      await withPending()
      h.api.codingEdits.accept.mockResolvedValue({
        success: true,
        outcome: { kind: 'applied', paths: ['src/a.ts'] }
      })
      await useCodingStore.getState().acceptPending()
      expect(useCodingStore.getState().applied).toMatchObject({ runId: 'run_1' })

      h.api.codingEdits.pending.mockResolvedValue({ success: true, edits: [] })
      const out = await useCodingStore.getState().startRun(START)

      expect(out.started).toBe(true)
      expect(useCodingStore.getState().applied).toMatchObject({ runId: 'run_1', paths: ['src/a.ts'] })
      // The user dismisses it themselves.
      useCodingStore.getState().clearResult()
      expect(useCodingStore.getState().applied).toBeNull()
    })

    it('a partially written accept offers an undo target instead of leaving the proposal open', async () => {
      await withPending()
      h.api.codingEdits.accept.mockResolvedValue({
        success: false,
        outcome: {
          kind: 'refused',
          code: 'partial',
          reason: 'A write failed after other files were already written, and not every file could be restored.'
        }
      })

      await useCodingStore.getState().acceptPending()

      const state = useCodingStore.getState()
      // The package is no longer the one that was approved: accepting again is
      // not an option the surface may offer.
      expect(state.pending).toBeNull()
      expect(state.applied).toMatchObject({ runId: 'run_1', directoryId: 'd1', uncertain: true })
      expect(state.applied?.paths).toEqual([])
      // German, and not the English sentence from the main process.
      expect(state.error).not.toMatch(/A write failed/)
      expect(state.error).toMatch(/rückgängig/i)
    })

    it.each(['withdrawn', 'interrupted'])(
      'the %s refusal also sets an undo target',
      async (code) => {
        await withPending()
        h.api.codingEdits.accept.mockResolvedValue({
          success: false,
          outcome: { kind: 'refused', code, reason: 'english text' }
        })
        await useCodingStore.getState().acceptPending()
        expect(useCodingStore.getState().applied).toMatchObject({ uncertain: true })
        expect(useCodingStore.getState().pending).toBeNull()
      }
    )

    it.each(['partial', 'withdrawn', 'interrupted'])(
      'an accept that broke off (%s) also rejects the package in the main process',
      async (code) => {
        // The surface stops offering the package; the main process has to learn
        // the same thing. Nothing else resolves it afterwards, so without this
        // the proposals stay in `retained`: no coding.change_rejected row in the
        // audit export, and one of the retention slots is held until the process
        // ends. Point 13's own sentence, on the accept path.
        await withPending()
        h.api.codingEdits.accept.mockResolvedValue({
          success: false,
          outcome: { kind: 'refused', code, reason: 'english text' }
        })
        h.api.codingEdits.reject.mockResolvedValue({ success: true, outcome: { kind: 'rejected', count: 1 } })

        await useCodingStore.getState().acceptPending()

        expect(h.api.codingEdits.reject).toHaveBeenCalledTimes(1)
        const [runId, reason] = h.api.codingEdits.reject.mock.calls[0]
        expect(runId).toBe('run_1')
        // A reason, so the audit row says WHY these proposals were refused.
        expect(typeof reason).toBe('string')
        expect((reason as string).length).toBeGreaterThan(0)
        // The undo target still appears: the files may be on disk either way.
        expect(useCodingStore.getState().applied).toMatchObject({ uncertain: true })
        expect(useCodingStore.getState().pending).toBeNull()
      }
    )

    it('says so when the package could not be marked as rejected', async () => {
      // The undo box is the user's only way back, so it is shown whatever the
      // rejection answered — but a trail that is now incomplete is not hidden.
      await withPending()
      h.api.codingEdits.accept.mockResolvedValue({
        success: false,
        outcome: { kind: 'refused', code: 'partial', reason: 'english text' }
      })
      h.api.codingEdits.reject.mockResolvedValue({ success: false, error: 'gate' })

      await useCodingStore.getState().acceptPending()

      const state = useCodingStore.getState()
      expect(state.applied).toMatchObject({ uncertain: true })
      expect(state.error).toMatch(/rückgängig/i)
      expect(state.error).toMatch(/Audit/)
    })

    it('an accept that wrote nothing does not reject the package in the main process', async () => {
      // Negative control for the two tests above: the package STAYS, so
      // rejecting it here would throw away a decision the human has not made.
      await withPending()
      h.api.codingEdits.accept.mockResolvedValue({
        success: false,
        outcome: { kind: 'refused', code: 'fs', reason: 'english text' }
      })
      await useCodingStore.getState().acceptPending()
      expect(h.api.codingEdits.reject).not.toHaveBeenCalled()
      expect(useCodingStore.getState().pending).not.toBeNull()
    })

    it('a refusal that wrote nothing keeps the package and says so in German', async () => {
      await withPending()
      h.api.codingEdits.accept.mockResolvedValue({
        success: false,
        outcome: {
          kind: 'refused',
          code: 'fs',
          reason: 'Nothing was written: a file could not be verified as unchanged since it was proposed.'
        }
      })
      await useCodingStore.getState().acceptPending()
      const state = useCodingStore.getState()
      expect(state.pending).not.toBeNull()
      expect(state.applied).toBeNull()
      expect(state.error).not.toMatch(/Nothing was written/)
      expect(state.error).toMatch(/Es wurde nichts geschrieben/)
    })

    it('a changed package is fetched again and the NEW list is shown', async () => {
      await withPending()
      h.api.codingEdits.accept.mockResolvedValue({
        success: false,
        outcome: { kind: 'refused', code: 'package-changed', reason: 'english text' }
      })
      const NEWER = { ...EDIT, path: 'src/b.ts' }
      h.api.codingEdits.pending.mockResolvedValue({
        success: true,
        directoryId: 'd1',
        digest: 'dig2',
        edits: [EDIT, NEWER]
      })

      await useCodingStore.getState().acceptPending()

      const state = useCodingStore.getState()
      expect(h.api.codingEdits.pending).toHaveBeenLastCalledWith('run_1')
      expect(state.pending).toMatchObject({ runId: 'run_1', digest: 'dig2' })
      expect(state.pending?.edits.map((e) => e.path)).toEqual(['src/a.ts', 'src/b.ts'])
      expect(state.error).toMatch(/geändert/)
    })

    /**
     * Z1 — the third instance of one class in this review round: a package
     * vanishes from the surface while the MAIN process still holds it, so no
     * `coding.change_rejected` row is written and one of the
     * EDIT_MAX_RETAINED_RUNS slots stays occupied for the rest of the session.
     * Point 13 was the start path, A1 the accept path, this is the refresh path.
     *
     * The question that catches it: who else believes something about this
     * package? Here nothing resolved it — the reload FAILED — so the main
     * process still holds it and has to be told.
     */
    it('a refresh that FAILS rejects the package in the main process too', async () => {
      await withPending()
      h.api.codingEdits.accept.mockResolvedValue({
        success: false,
        outcome: { kind: 'refused', code: 'package-changed', reason: 'english text' }
      })
      h.api.codingEdits.pending.mockResolvedValue({ success: false, error: 'store unreachable' })
      h.api.codingEdits.reject.mockResolvedValue({ success: true })

      await useCodingStore.getState().acceptPending()

      expect(h.api.codingEdits.reject).toHaveBeenCalledTimes(1)
      expect(h.api.codingEdits.reject.mock.calls[0][0]).toBe('run_1')
      // A reason is recorded, so the audit row says what happened.
      expect(typeof h.api.codingEdits.reject.mock.calls[0][1]).toBe('string')
      const state = useCodingStore.getState()
      expect(state.pending).toBeNull()
      expect(state.error).toContain('store unreachable')
    })

    it('a refresh that fails AND cannot be rejected says the rejection was not recorded', async () => {
      await withPending()
      h.api.codingEdits.accept.mockResolvedValue({
        success: false,
        outcome: { kind: 'refused', code: 'package-changed', reason: 'english text' }
      })
      h.api.codingEdits.pending.mockResolvedValue({ success: false, error: 'store unreachable' })
      h.api.codingEdits.reject.mockResolvedValue({ success: false })

      await useCodingStore.getState().acceptPending()

      expect(useCodingStore.getState().pending).toBeNull()
      expect(useCodingStore.getState().error).toMatch(/weder als angewendet noch als abgelehnt/)
    })

    it('a refresh that SUCCEEDS does not reject anything (false-alarm direction)', async () => {
      await withPending()
      h.api.codingEdits.accept.mockResolvedValue({
        success: false,
        outcome: { kind: 'refused', code: 'package-changed', reason: 'english text' }
      })
      h.api.codingEdits.pending.mockResolvedValue({
        success: true,
        directoryId: 'd1',
        digest: 'dig2',
        edits: [EDIT]
      })

      await useCodingStore.getState().acceptPending()

      expect(h.api.codingEdits.reject).not.toHaveBeenCalled()
      expect(useCodingStore.getState().pending).not.toBeNull()
    })

    it('a changed package that is now empty closes the dialog instead of showing a stale list', async () => {
      await withPending()
      h.api.codingEdits.accept.mockResolvedValue({
        success: false,
        outcome: { kind: 'refused', code: 'package-changed', reason: 'english text' }
      })
      h.api.codingEdits.pending.mockResolvedValue({ success: true, edits: [] })
      await useCodingStore.getState().acceptPending()
      expect(useCodingStore.getState().pending).toBeNull()
      expect(useCodingStore.getState().error).toMatch(/geändert/)
      // Checked, not assumed: an EMPTY reply means the main process has no
      // entries for this run any more, which only happens once it recorded the
      // package as accepted, rejected or abandoned. Nothing left to reject.
      expect(h.api.codingEdits.reject).not.toHaveBeenCalled()
    })

    it('a package reported without a digest is not offered for acceptance, and says why', async () => {
      // Carried as `digest: ''` it produced a dialog whose accept the main
      // process refuses every time, with no explanation.
      await ready('propose')
      h.api.codingEdits.pending.mockResolvedValue({ success: true, edits: [EDIT] })
      const out = await useCodingStore.getState().startRun(START)
      expect(out.started).toBe(true)
      expect(useCodingStore.getState().pending).toBeNull()
      expect(useCodingStore.getState().error).toMatch(/Prüfsumme/)
    })

    it('shows what undo did not restore, with the reason', async () => {
      await withPending()
      h.api.codingEdits.accept.mockResolvedValue({ success: true, outcome: { kind: 'applied', paths: ['src/a.ts', 'src/b.ts'] } })
      await useCodingStore.getState().acceptPending()
      h.api.codingEdits.undo.mockResolvedValue({
        success: true,
        outcome: {
          kind: 'restored',
          restored: ['src/a.ts'],
          skipped: [{ path: 'src/b.ts', reason: 'changed-since-apply' }]
        }
      })
      await useCodingStore.getState().undoLast()
      expect(h.api.codingEdits.undo).toHaveBeenCalledWith('run_1', 'd1')
      const undo = useCodingStore.getState().undo
      expect(undo?.complete).toBe(false)
      expect(undo?.skipped.map((s) => s.path)).toEqual(['src/b.ts'])
    })

    it('exports the audit as CSV text, without a feature gate argument', async () => {
      h.api.codingEdits.exportAudit.mockResolvedValue({ success: true, csv: 'a,b\n1,2\n' })
      const csv = await useCodingStore.getState().exportAudit()
      expect(csv).toBe('a,b\n1,2\n')
      expect(h.api.codingEdits.exportAudit).toHaveBeenCalledTimes(1)
    })

    it('a failed export is an error, not an empty file', async () => {
      h.api.codingEdits.exportAudit.mockResolvedValue({ success: false, error: 'bad since' })
      expect(await useCodingStore.getState().exportAudit()).toBeNull()
      expect(useCodingStore.getState().error).toContain('bad since')
    })
  })
})
