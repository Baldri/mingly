/**
 * Wiring of a coding run in AgentExecutor (Task 7).
 *
 * What matters here is NOT that ensureProjectWorkspace or compactToolResult work
 * on their own (their own tests cover that) but that the executor connects them:
 * an externalized tool result of a coding run must land under the project path,
 * and a run without coding options must keep using os.tmpdir().
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { AgentExecutor } from '../../src/main/agent/agent-executor'
import type { Message, ToolDefinition, AgentToolCall } from '../../src/shared/types'
import type { ToolUseResponse } from '../../src/main/llm-clients/client-manager'
import type { CodingMode } from '../../src/shared/coding-types'
import type { ToolContext } from '../../src/main/agent/tool-registry'
import { getEditProposalStore } from '../../src/main/coding/edit-proposals'
import { getRunDirectoryRegistry } from '../../src/main/coding/run-directories'
import { getRunAuditContext } from '../../src/main/coding/coding-audit'
import { getGuardDeps } from '../../src/main/security/request-guard-deps'

// What the guard does to the big tool result: nothing, block it as an injection,
// or find a sensitive value in it (which asks the user). Default: nothing.
const guardCfg = vi.hoisted(() => ({
  mode: 'clean' as 'clean' | 'inject' | 'sensitive' | 'cleaning',
  big: 'x'.repeat(5000)
}))

/**
 * A zero-width space, the cheapest thing the sanitizer rewrites without
 * blocking: `unicode_abuse` at a risk score well under the block threshold of
 * 80. Mode `cleaning` makes the double behave like the real sanitizer does on
 * such a result — it returns a DIFFERENT string and says why.
 */
const ZWSP = '\u200b'

vi.mock('../../src/main/security/request-guard-deps', () => ({
  getGuardDeps: () => ({
    sanitize: (text: string) => {
      if (guardCfg.mode === 'inject' && text === guardCfg.big) {
        return { safe: false, sanitized: text, riskScore: 100, warnings: ['injection'] }
      }
      if (guardCfg.mode === 'cleaning' && text.includes(ZWSP)) {
        return {
          safe: true,
          riskScore: 30,
          warnings: [{ type: 'unicode_abuse', severity: 'medium' }],
          sanitized: text.split(ZWSP).join('')
        }
      }
      return { safe: true, riskScore: 0, warnings: [], sanitized: text }
    },
    scanSensitive: (text: string) =>
      guardCfg.mode === 'sensitive' && text.includes(guardCfg.big)
        ? { hasSensitiveData: true, matches: [], overallRiskLevel: 'high' }
        : { hasSensitiveData: false, matches: [], overallRiskLevel: 'none' },
    checkUploadPermission: async () =>
      guardCfg.mode === 'sensitive'
        ? { decision: 'ask', requiresUserConsent: true, request: {} }
        : { decision: 'allowed', requiresUserConsent: false },
    checkBudget: () => ({ allowed: true }),
    checkRouting: () => ({ allowed: true }),
    isCloudProvider: () => guardCfg.mode === 'sensitive',
    scanOutput: () => ({ violations: [] }),
  }),
}))

// The audit trail goes through the activity logger; a double keeps what was logged.
const auditLog = vi.hoisted(() => ({ rows: [] as Array<{ action: string; entityId: string; details: Record<string, unknown> | null }> }))
vi.mock('../../src/main/audit/activity-logger', () => ({
  getActivityLogger: () => ({ log: (e: { action: string; entityId: string; details: Record<string, unknown> | null }) => void auditLog.rows.push(e), query: () => [] }),
}))

// What the model sees on each call: a snapshot of the tool messages, taken at call time.
let llmCallCount = 0
let llmResponses: ToolUseResponse[] = []
let seenToolMessages: string[][] = []

vi.mock('../../src/main/llm-clients/client-manager', () => ({
  getClientManager: vi.fn(() => ({
    providerSupportsToolUse: vi.fn().mockReturnValue(true),
    sendMessageWithTools: vi.fn().mockImplementation(async (_p: string, messages: Message[]) => {
      seenToolMessages.push(messages.filter((m) => m.role === 'tool').map((m) => m.content))
      const response = llmResponses[llmCallCount] ?? {
        text: 'Final answer.',
        toolCalls: [],
        done: true,
        stopReason: 'stop' as const,
        tokens: { input: 10, output: 10 },
      }
      llmCallCount++
      return response
    }),
  })),
}))

const BIG = 'x'.repeat(5000)
/** What the tool "returns"; `null` keeps BIG, which the compaction externalizes. */
let toolResultContent: string | null = null
let registryCalls: Array<{ ctx: ToolContext | undefined }> = []
// Runs inside the mocked executeToolCalls, with the step's context.
let toolCallHook: ((ctx: ToolContext | undefined) => void | Promise<void>) | undefined
let toolListCtx: Array<ToolContext | undefined> = []

vi.mock('../../src/main/agent/tool-registry', () => ({
  getToolRegistry: vi.fn(() => ({
    refreshMCPTools: vi.fn(),
    getAvailableTools: vi.fn((ctx?: ToolContext) => {
      toolListCtx.push(ctx)
      return [
        { name: 'mingly_read_file', description: 'r', inputSchema: { type: 'object', properties: {} } },
      ] as ToolDefinition[]
    }),
    executeToolCalls: vi.fn(async (calls: AgentToolCall[], ctx?: ToolContext) => {
      registryCalls.push({ ctx })
      await toolCallHook?.(ctx)
      return calls.map((tc) => ({ toolCallId: tc.id, content: toolResultContent ?? BIG, isError: false }))
    }),
  })),
}))

let storedModes: Record<string, CodingMode> = {}
vi.mock('../../src/main/coding/coding-mode-store', () => ({
  getCodingModeStore: () => ({
    getMode: (id: string): CodingMode => storedModes[id] ?? 'off',
    setMode: vi.fn(),
  }),
}))

const ensureSpy = vi.fn()
vi.mock('../../src/main/coding/project-workspace', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/coding/project-workspace')>()
  return {
    ...actual,
    ensureProjectWorkspace: (...args: Parameters<typeof actual.ensureProjectWorkspace>) => {
      ensureSpy(...args)
      return actual.ensureProjectWorkspace(...args)
    },
  }
})

function toolCallStep(id: string): ToolUseResponse {
  return {
    text: 'reading',
    toolCalls: [{ id, name: 'mingly_read_file', arguments: { path: 'a.ts' } }],
    done: false,
    stopReason: 'tool_use',
    tokens: { input: 10, output: 10 },
  }
}

/** Extract the externalized path out of the compaction text the model receives. */
function externalizedPaths(messages: string[]): string[] {
  return messages
    .map((m) => /externalized to file: (.+?)\]/.exec(m)?.[1])
    .filter((p): p is string => typeof p === 'string')
}

let projectPath: string
let executor: AgentExecutor

beforeEach(() => {
  vi.clearAllMocks()
  llmCallCount = 0
  llmResponses = []
  seenToolMessages = []
  registryCalls = []
  toolResultContent = null
  toolCallHook = undefined
  toolListCtx = []
  storedModes = {}
  guardCfg.mode = 'clean'
  auditLog.rows.length = 0
  projectPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mingly-coding-wiring-')))
  executor = new AgentExecutor({
    maxSteps: 5,
    maxTokensPerRun: 50000,
    runTimeoutMs: 10000,
  })
})

afterEach(() => {
  fs.chmodSync(projectPath, 0o700)
  fs.rmSync(projectPath, { recursive: true, force: true })
})

describe('coding run workspace wiring', () => {
  it('externalizes a large tool result of a coding run UNDER the project path', async () => {
    storedModes['dir-1'] = 'read-only'
    llmResponses = [toolCallStep('tc-1')]

    const run = await executor.execute('task', 'anthropic', 'm', [], undefined, {
      directoryId: 'dir-1',
      projectPath,
      mode: 'read-only',
    })

    expect(run.status).toBe('completed')
    const [paths] = [externalizedPaths(seenToolMessages[1])]
    expect(paths).toHaveLength(1)
    const contextRoot = path.join(projectPath, '.mingly', 'context') + path.sep
    expect(paths[0].startsWith(contextRoot)).toBe(true)
    expect(paths[0].startsWith(path.join(os.tmpdir(), 'mingly-agent'))).toBe(false)
  })

  it('keeps a run WITHOUT coding options on the temp directory', async () => {
    llmResponses = [toolCallStep('tc-1')]

    const run = await executor.execute('task', 'anthropic', 'm')

    expect(run.status).toBe('completed')
    const paths = externalizedPaths(seenToolMessages[1])
    expect(paths).toHaveLength(1)
    expect(paths[0].startsWith(path.join(os.tmpdir(), 'mingly-agent') + path.sep)).toBe(true)
    expect(fs.existsSync(path.join(projectPath, '.mingly'))).toBe(false)
    expect(ensureSpy).not.toHaveBeenCalled()
  })

  it('creates the workspace once per run and reuses it across steps', async () => {
    storedModes['dir-1'] = 'read-only'
    llmResponses = [toolCallStep('tc-1'), toolCallStep('tc-2')]

    await executor.execute('task', 'anthropic', 'm', [], undefined, {
      directoryId: 'dir-1',
      projectPath,
      mode: 'read-only',
    })

    expect(ensureSpy).toHaveBeenCalledTimes(1)
    expect(ensureSpy.mock.calls[0][0]).toBe(projectPath)
    const second = externalizedPaths(seenToolMessages[2])
    expect(second).toHaveLength(2)
    expect(path.dirname(second[0])).toBe(path.dirname(second[1]))
  })

  it('ends the run, without calling the model, when the workspace cannot be created', async () => {
    storedModes['dir-1'] = 'read-only'
    const missing = path.join(projectPath, 'does-not-exist')

    const run = await executor.execute('task', 'anthropic', 'm', [], undefined, {
      directoryId: 'dir-1',
      projectPath: missing,
      mode: 'read-only',
    })

    expect(run.status).toBe('failed')
    expect(llmCallCount).toBe(0)
    expect(registryCalls).toHaveLength(0)
  })
})

describe('coding run mode and tool context', () => {
  it('records which directory the run belongs to, in the main process', async () => {
    storedModes['dir-1'] = 'propose'
    llmResponses = [toolCallStep('tc-1')]
    const run = await executor.execute('task', 'anthropic', 'm', [], undefined, {
      directoryId: 'dir-1',
      projectPath,
      mode: 'propose' as const
    })
    expect(getRunDirectoryRegistry().get(run.id)).toBe('dir-1')
  })

  it('records nothing for a run that is refused (mode mismatch) or has no coding options', async () => {
    storedModes['dir-1'] = 'read-only'
    const refused = await executor.execute('task', 'anthropic', 'm', [], undefined, {
      directoryId: 'dir-1',
      projectPath,
      mode: 'propose-run' as const
    })
    expect(getRunDirectoryRegistry().get(refused.id)).toBeUndefined()
    const plain = await executor.execute('task', 'anthropic', 'm')
    expect(getRunDirectoryRegistry().get(plain.id)).toBeUndefined()
  })

  it('hands the tool context to the tool list and to execution of a coding run', async () => {
    storedModes['dir-1'] = 'propose'
    llmResponses = [toolCallStep('tc-1')]
    const coding = { directoryId: 'dir-1', projectPath, mode: 'propose' as const }

    await executor.execute('task', 'anthropic', 'm', [], undefined, coding)

    expect(toolListCtx[0]?.coding).toEqual(coding)
    expect(registryCalls[0].ctx?.coding).toEqual(coding)
  })

  it('gives every step the run id and its own step number (edit proposals are keyed on them)', async () => {
    storedModes['dir-1'] = 'propose'
    llmResponses = [toolCallStep('tc-1'), toolCallStep('tc-2')]
    const coding = { directoryId: 'dir-1', projectPath, mode: 'propose' as const }

    const run = await executor.execute('task', 'anthropic', 'm', [], undefined, coding)

    expect(registryCalls).toHaveLength(2)
    const [first, second] = registryCalls.map((c) => c.ctx)
    expect(typeof first?.runId).toBe('string')
    expect(first?.runId).toBe(run.id)
    expect(second?.runId).toBe(run.id)
    expect(Number.isInteger(first?.stepNumber)).toBe(true)
    expect(second?.stepNumber).toBe((first?.stepNumber ?? 0) + 1)
  })

  it('passes no context at all for a run without coding options', async () => {
    llmResponses = [toolCallStep('tc-1')]

    await executor.execute('task', 'anthropic', 'm')

    expect(toolListCtx[0]).toBeUndefined()
    expect(registryCalls[0].ctx).toBeUndefined()
  })

  it('ends the run when the stored mode differs from the one the caller claims', async () => {
    storedModes['dir-1'] = 'read-only'

    const run = await executor.execute('task', 'anthropic', 'm', [], undefined, {
      directoryId: 'dir-1',
      projectPath,
      mode: 'propose-run',
    })

    expect(run.status).toBe('failed')
    expect(run.error).toMatch(/mode/i)
    expect(llmCallCount).toBe(0)
    expect(ensureSpy).not.toHaveBeenCalled()
    expect(fs.existsSync(path.join(projectPath, '.mingly'))).toBe(false)
  })

  it('treats a directory the store does not know as off, so a claimed mode is refused', async () => {
    const run = await executor.execute('task', 'anthropic', 'm', [], undefined, {
      directoryId: 'unknown-dir',
      projectPath,
      mode: 'propose',
    })

    expect(run.status).toBe('failed')
    expect(llmCallCount).toBe(0)
  })

  it('refuses a claimed mode outside the vocabulary', async () => {
    storedModes['dir-1'] = 'read-only'

    const run = await executor.execute('task', 'anthropic', 'm', [], undefined, {
      directoryId: 'dir-1',
      projectPath,
      mode: 'auto' as unknown as CodingMode,
    })

    expect(run.status).toBe('failed')
    expect(llmCallCount).toBe(0)
  })
})

describe('coding run with mode off behaves like a plain run', () => {
  const offCoding = () => ({ directoryId: 'dir-1', projectPath, mode: 'off' as const })

  it('leaves no .mingly directory behind and offers no tool context', async () => {
    storedModes['dir-1'] = 'off'
    llmResponses = [toolCallStep('tc-1')]

    const run = await executor.execute('task', 'anthropic', 'm', [], undefined, offCoding())

    expect(run.status).toBe('completed')
    expect(fs.existsSync(path.join(projectPath, '.mingly'))).toBe(false)
    expect(ensureSpy).not.toHaveBeenCalled()
    expect(toolListCtx[0]).toBeUndefined()
    expect(registryCalls[0].ctx).toBeUndefined()
  })

  it('externalizes to the temp directory, not into the project', async () => {
    storedModes['dir-1'] = 'off'
    llmResponses = [toolCallStep('tc-1')]

    await executor.execute('task', 'anthropic', 'm', [], undefined, offCoding())

    const paths = externalizedPaths(seenToolMessages[1])
    expect(paths).toHaveLength(1)
    expect(paths[0].startsWith(path.join(os.tmpdir(), 'mingly-agent') + path.sep)).toBe(true)
  })

  it('succeeds in a project where the workspace could not be created', async () => {
    storedModes['dir-1'] = 'off'
    fs.chmodSync(projectPath, 0o500)
    llmResponses = [toolCallStep('tc-1')]

    const run = await executor.execute('task', 'anthropic', 'm', [], undefined, offCoding())

    expect(run.status).toBe('completed')
  })

  it('control: the same non-writable project DOES fail a read-only run', async () => {
    storedModes['dir-1'] = 'read-only'
    fs.chmodSync(projectPath, 0o500)

    const run = await executor.execute('task', 'anthropic', 'm', [], undefined, {
      directoryId: 'dir-1',
      projectPath,
      mode: 'read-only',
    })

    expect(run.status).toBe('failed')
    expect(llmCallCount).toBe(0)
  })

  it('a mode mismatch still ends the run when the claim is off', async () => {
    storedModes['dir-1'] = 'propose'

    const run = await executor.execute('task', 'anthropic', 'm', [], undefined, offCoding())

    expect(run.status).toBe('failed')
    expect(llmCallCount).toBe(0)
  })
})

describe('edit proposals do not outlive their run', () => {
  const coding = () => ({ directoryId: 'dir-1', projectPath, mode: 'propose' as const })

  function seedProposal(ctx: ToolContext | undefined): void {
    const out = getEditProposalStore().propose(
      ctx?.runId ?? '',
      ctx?.stepNumber ?? 0,
      { path: 'a.ts', oldText: 'a', newText: 'b' },
      'a'
    )
    expect(out.kind).toBe('proposed')
  }

  it('KEEPS the proposals of a run that completes: they are the deliverable awaiting review', async () => {
    storedModes['dir-1'] = 'propose'
    llmResponses = [toolCallStep('tc-1')]
    toolCallHook = seedProposal

    const run = await executor.execute('task', 'anthropic', 'm', [], undefined, coding())

    expect(run.status).toBe('completed')
    const store = getEditProposalStore()
    expect(store.pending(run.id)).toHaveLength(1)
    store.resolve(run.id, true)
    expect(store.pending(run.id)).toEqual([])
  })

  it('KEEPS the proposals of a run that ran out of steps (it still did real work)', async () => {
    storedModes['dir-1'] = 'propose'
    llmResponses = Array.from({ length: 10 }, (_, i) => toolCallStep(`tc-${i}`))
    let seeded = false
    toolCallHook = (ctx) => {
      if (seeded) return
      seeded = true
      seedProposal(ctx)
    }

    const run = await executor.execute('task', 'anthropic', 'm', [], undefined, coding())

    expect(run.status).toBe('max_steps_reached')
    const store = getEditProposalStore()
    expect(store.pending(run.id)).toHaveLength(1)
    store.resolve(run.id, false)
  })

  it('clears the proposals of a CANCELLED run', async () => {
    storedModes['dir-1'] = 'propose'
    llmResponses = [toolCallStep('tc-1'), toolCallStep('tc-2')]
    toolCallHook = (ctx) => {
      seedProposal(ctx)
      expect(executor.cancelRun(ctx?.runId ?? '')).toBe(true)
    }

    const run = await executor.execute('task', 'anthropic', 'm', [], undefined, coding())

    expect(run.status).toBe('cancelled')
    expect(getEditProposalStore().pending(run.id)).toEqual([])
  })

  it('clears the proposals of a run that THROWS', async () => {
    storedModes['dir-1'] = 'propose'
    llmResponses = [toolCallStep('tc-1')]
    toolCallHook = (ctx) => {
      seedProposal(ctx)
      throw new Error('boom')
    }

    const run = await executor.execute('task', 'anthropic', 'm', [], undefined, coding())

    expect(run.status).toBe('failed')
    expect(getEditProposalStore().pending(run.id)).toEqual([])
  })

  it('records the abandoned package of a failed run for the audit', async () => {
    storedModes['dir-1'] = 'propose'
    llmResponses = [toolCallStep('tc-1')]
    toolCallHook = (ctx) => {
      seedProposal(ctx)
      throw new Error('boom')
    }

    const run = await executor.execute('task', 'anthropic', 'm', [], undefined, coding())

    const { records } = getEditProposalStore().auditRecords(run.id)
    expect(records.some((r) => r.outcome === 'package-abandoned' && r.edits === 1)).toBe(true)
  })
})

describe('coding run audit context (Task 13)', () => {
  const coding = (): { directoryId: string; projectPath: string; mode: 'propose' } => ({ directoryId: 'dir-1', projectPath, mode: 'propose' })

  it('records the provider and model the run acts under, so the apply can audit them', async () => {
    storedModes['dir-1'] = 'propose'
    const run = await executor.execute('task', 'anthropic', 'claude-opus-5', [], undefined, coding())
    expect(getRunAuditContext(run.id)).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-5',
      guardRedirected: false,
      guardBlocked: false
    })
  })

  it('records nothing for a run without coding options', async () => {
    const plain = await executor.execute('task', 'anthropic', 'm')
    expect(getRunAuditContext(plain.id)).toBeUndefined()
  })

  it('records the guard blocking a coding run as coding.guard_blocked, without the reason text', async () => {
    storedModes['dir-1'] = 'propose'
    guardCfg.mode = 'inject'
    llmResponses = [toolCallStep('tc-1')]
    const run = await executor.execute('task', 'anthropic', 'claude-opus-5', [], undefined, coding())
    expect(run.status).toBe('failed')
    expect(getRunAuditContext(run.id)).toMatchObject({ guardBlocked: true })
    const blocked = auditLog.rows.filter((r) => r.action === 'coding.guard_blocked')
    expect(blocked).toHaveLength(1)
    expect(blocked[0].entityId).toBe(run.id)
    expect(blocked[0].details).toMatchObject({ projectPath, provider: 'anthropic', model: 'claude-opus-5', guardBlocked: true })
    expect(JSON.stringify(blocked[0].details)).not.toContain('injection')
  })

  it('does not write coding.guard_blocked for a plain run the guard blocks', async () => {
    guardCfg.mode = 'inject'
    llmResponses = [toolCallStep('tc-1')]
    const run = await executor.execute('task', 'anthropic', 'm')
    expect(run.status).toBe('failed')
    expect(auditLog.rows.filter((r) => r.action === 'coding.guard_blocked')).toEqual([])
  })

  /**
   * C5. The sanitizer is the same DETECTOR on the chat path and in the agent
   * loop, but not the same TREATMENT: chat sends the cleaned text, a tool
   * result is forwarded byte-for-byte because mingly_edit_file matches its
   * `oldText` against the REAL file. The asymmetry stays and is RECORDED.
   */
  it('forwards a tool result the sanitizer cleaned BYTE-IDENTICALLY to the provider', async () => {
    storedModes['dir-1'] = 'propose'
    guardCfg.mode = 'cleaning'
    toolResultContent = `oldText-anchor${ZWSP}-line`
    llmResponses = [toolCallStep('tc-1')]

    const run = await executor.execute('task', 'anthropic', 'claude-opus-5', [], undefined, coding())

    expect(run.status).toBe('completed')
    // What the model was handed on the second call is the tool message.
    expect(seenToolMessages[1]).toEqual([toolResultContent])
    // Spelled out rather than left to toEqual: the zero-width space survived.
    expect(seenToolMessages[1][0].includes(ZWSP)).toBe(true)
  })

  it('positive control: the cleaned version existed and differed — it was simply not sent', () => {
    // The shared guardInput both paths call is what produces it; the chat path
    // forwards `sanitizedText` (ipc-handlers.ts) and the loop does not.
    const raw = `oldText-anchor${ZWSP}-line`
    const report = getGuardDeps().sanitize(raw)
    guardCfg.mode = 'cleaning'
    const cleaning = getGuardDeps().sanitize(raw)
    expect(report.sanitized).toBe(raw)
    expect(cleaning.sanitized).not.toBe(raw)
    expect(cleaning.riskScore).toBeLessThan(80)
  })

  it('writes coding.guard_flagged for the cleaned result, with the type and no content', async () => {
    storedModes['dir-1'] = 'propose'
    guardCfg.mode = 'cleaning'
    toolResultContent = `secret-canary-4242${ZWSP}`
    llmResponses = [toolCallStep('tc-1')]

    const run = await executor.execute('task', 'anthropic', 'claude-opus-5', [], undefined, coding())

    const flagged = auditLog.rows.filter((r) => r.action === 'coding.guard_flagged')
    expect(flagged).toHaveLength(1)
    expect(flagged[0].entityId).toBe(run.id)
    expect(flagged[0].details).toMatchObject({
      projectPath,
      provider: 'anthropic',
      model: 'claude-opus-5',
      guardBlocked: false,
      flaggedTypes: ['unicode_abuse']
    })
    // The row says it happened, which type and in which run — never what was in it.
    expect(JSON.stringify(flagged[0])).not.toContain('secret-canary')
  })

  it('marks the step result the surface shows, for a plain run as well as a coding run', async () => {
    guardCfg.mode = 'cleaning'
    toolResultContent = `marked${ZWSP}result`

    for (const options of [undefined, coding()]) {
      storedModes['dir-1'] = 'propose'
      llmCallCount = 0
      llmResponses = [toolCallStep('tc-1')]
      const run = await executor.execute('task', 'anthropic', 'm', [], undefined, options)
      expect(run.steps[0].toolResults[0].sanitizerCleaned).toBe(true)
    }
  })

  it('does not mark a result the sanitizer left alone', async () => {
    guardCfg.mode = 'cleaning'
    toolResultContent = 'nothing to clean'
    llmResponses = [toolCallStep('tc-1')]

    const run = await executor.execute('task', 'anthropic', 'm')

    expect(run.steps[0].toolResults[0].sanitizerCleaned).toBeUndefined()
  })

  it('writes nothing when the sanitizer changed nothing (false-alarm direction)', async () => {
    storedModes['dir-1'] = 'propose'
    guardCfg.mode = 'cleaning'
    toolResultContent = 'nothing to clean here'
    llmResponses = [toolCallStep('tc-1')]

    await executor.execute('task', 'anthropic', 'm', [], undefined, coding())

    expect(auditLog.rows.filter((r) => r.action === 'coding.guard_flagged')).toEqual([])
  })

  it('writes no coding.guard_flagged for a run without coding options', async () => {
    guardCfg.mode = 'cleaning'
    toolResultContent = `plain run${ZWSP}`
    llmResponses = [toolCallStep('tc-1')]

    await executor.execute('task', 'anthropic', 'm')

    expect(auditLog.rows.filter((r) => r.action === 'coding.guard_flagged')).toEqual([])
  })

  it('marks the run when the user withheld a file at the consent question, and not when they sent it', async () => {
    storedModes['dir-1'] = 'propose'
    for (const [choice, expected] of [['drop-file', true], ['send', false]] as const) {
      guardCfg.mode = 'sensitive'
      llmCallCount = 0
      llmResponses = [toolCallStep('tc-1')]
      const asker = new AgentExecutor(
        { maxSteps: 5, maxTokensPerRun: 50000, runTimeoutMs: 10000 },
        { consentBroker: { askWithSource: async () => ({ choice, decidedBy: 'user' }), cancel: () => undefined } as never }
      )
      const run = await asker.execute('task', 'anthropic', 'm', [], undefined, coding())
      expect(run.status).toBe('completed')
      expect(getRunAuditContext(run.id)?.guardRedirected).toBe(expected)
    }
  })
})
