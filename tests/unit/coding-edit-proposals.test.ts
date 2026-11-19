/**
 * mingly_edit_file as a proposal (Task 10).
 *
 * Two layers: the store is tested synchronously with the file content handed
 * in; the handler is tested through ToolRegistry.executeTool so the gate and
 * the path discipline run exactly as in a coding run. Files are real, in a real
 * temp directory.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createHash } from 'crypto'
import { ToolRegistry, type ToolContext } from '../../src/main/agent/tool-registry'
import { registerReadTools } from '../../src/main/coding/read-tools'
import {
  registerEditTools,
  createEditProposalStore,
  getEditProposalStore,
  EDIT_MAX_FAILED_ATTEMPTS_PER_PATH,
  EDIT_MAX_RETAINED_RUNS,
  EDIT_PENDING_BYTES_BUDGET,
  EDIT_MAX_PENDING_PER_RUN,
  editStillMatches,
  findUpToTwo,
  type EditProposalStore
} from '../../src/main/coding/edit-proposals'
import { ensureProjectWorkspace } from '../../src/main/coding/project-workspace'
import type { AllowedDirectory } from '../../src/shared/file-access-types'
import type { CodingMode } from '../../src/shared/coding-types'

vi.mock('../../src/main/mcp/mcp-client-manager', () => ({
  getMCPClientManager: vi.fn(() => ({ listAllTools: vi.fn().mockReturnValue([]) }))
}))

const RUN = 'run1'

let project: string
let outside: string
let registry: ToolRegistry
let store: EditProposalStore
let grants: AllowedDirectory[]

function grant(overrides: Partial<AllowedDirectory> = {}): AllowedDirectory {
  return {
    id: 'dir-1',
    path: project,
    name: 'p',
    location: 'local',
    permissions: ['read', 'edit'],
    recursive: true,
    grantedAt: 1,
    confirmedAt: 1,
    ...overrides
  }
}

async function ctxFor(
  mode: CodingMode = 'propose',
  extra: Partial<ToolContext> = {}
): Promise<ToolContext> {
  const workspace = await ensureProjectWorkspace(project, RUN)
  return {
    coding: { directoryId: 'dir-1', projectPath: project, mode },
    workspace,
    runId: RUN,
    stepNumber: 1,
    ...extra
  }
}

async function edit(args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
  const result = await registry.executeTool({ id: 't1', name: 'mingly_edit_file', arguments: args }, ctx)
  return result.content
}

function write(rel: string, content: string | Buffer): string {
  const full = path.join(project, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
  return full
}

beforeEach(() => {
  project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mingly-edit-')))
  outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mingly-edit-outside-')))
  grants = [grant()]
  store = createEditProposalStore()
  registry = new ToolRegistry({ toolTimeoutMs: 5000, maxResultChars: 1_000_000 })
  const deps = { findGrant: async (id: string) => grants.find((g) => g.id === id) }
  registerReadTools(registry, deps)
  registerEditTools(registry, { ...deps, store })
})

afterEach(() => {
  fs.rmSync(project, { recursive: true, force: true })
  fs.rmSync(outside, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

describe('EditProposalStore.propose', () => {
  const base = { path: 'a.ts', oldText: 'return x', newText: 'return y' }

  const NOT_ONCE = /exactly once/i

  it('rejects an old text that occurs twice, with a reason that does not depend on the content', () => {
    const out = store.propose(RUN, 1, base, 'function a(){ return x }\nfunction b(){ return x }')
    expect(out).toEqual({ kind: 'rejected', reason: expect.stringMatching(NOT_ONCE) })
    expect(store.pending(RUN)).toHaveLength(0)
  })

  it('rejects an old text that does not occur', () => {
    const out = store.propose(RUN, 1, base, 'nothing to see here')
    expect(out).toEqual({ kind: 'rejected', reason: expect.stringMatching(NOT_ONCE) })
    expect(store.pending(RUN)).toHaveLength(0)
  })

  it('the reason is IDENTICAL for zero matches and for several, carries no number and says what to do', () => {
    const none = store.propose(RUN, 1, base, 'nothing')
    const many = store.propose(RUN, 2, base, 'return x return x return x')
    if (none.kind !== 'rejected' || many.kind !== 'rejected') throw new Error('expected rejections')
    expect(none.reason).toBe(many.reason)
    expect(none.reason).not.toMatch(/[0-9]|occurs|times/i)
    expect(none.reason).toMatch(/longer/i)
  })

  it('counts overlapping occurrences: "aa" in "aaa" is ambiguous', () => {
    const out = store.propose(RUN, 1, { path: 'a.ts', oldText: 'aa', newText: 'b' }, 'aaa')
    expect(out).toEqual({ kind: 'rejected', reason: expect.stringMatching(NOT_ONCE) })
  })

  it('rejects an empty old text', () => {
    const out = store.propose(RUN, 1, { path: 'a.ts', oldText: '', newText: 'x' }, 'abc')
    expect(out.kind).toBe('rejected')
  })

  it('rejects a second proposal for the same path in the same step', () => {
    const content = 'let a = 1\nlet b = 2\n'
    const first = store.propose(RUN, 1, { path: 'a.ts', oldText: 'let a = 1', newText: 'let a = 9' }, content)
    expect(first.kind).toBe('proposed')
    const second = store.propose(RUN, 1, { path: 'a.ts', oldText: 'let b = 2', newText: 'let b = 9' }, content)
    expect(second).toEqual({ kind: 'rejected', reason: expect.stringMatching(/same file|already/i) })
    expect(store.pending(RUN)).toHaveLength(1)
  })

  it('treats paths that differ only in case as the same file', () => {
    const content = 'let a = 1\nlet b = 2\n'
    store.propose(RUN, 1, { path: 'src/A.ts', oldText: 'let a = 1', newText: 'let a = 9' }, content)
    const second = store.propose(RUN, 1, { path: 'src/a.ts', oldText: 'let b = 2', newText: 'let b = 9' }, content)
    expect(second.kind).toBe('rejected')
  })

  it('rejects a no-op edit', () => {
    const out = store.propose(RUN, 1, { path: 'a.ts', oldText: 'x', newText: 'x' }, 'x')
    expect(out).toEqual({ kind: 'rejected', reason: expect.stringMatching(/no change|identical|same/i) })
  })

  it('rejects a second proposal for the same path in a LATER step while the first is pending, and says to combine', () => {
    // Its old text would be checked against the file WITHOUT the first change,
    // so the human would approve a diff computed against stale content.
    const content = 'let a = 1\nlet b = 2\n'
    store.propose(RUN, 1, { path: 'a.ts', oldText: 'let a = 1', newText: 'let a = 9' }, content)
    const next = store.propose(RUN, 2, { path: 'a.ts', oldText: 'let b = 2', newText: 'let b = 9' }, content)
    expect(next).toEqual({ kind: 'rejected', reason: expect.stringMatching(/single mingly_edit_file call|combine/i) })
    expect(store.pending(RUN)).toHaveLength(1)
  })

  it('allows the same path again once the pending package is resolved (false-alarm control)', () => {
    const content = 'let a = 1\nlet b = 2\n'
    store.propose(RUN, 1, { path: 'a.ts', oldText: 'let a = 1', newText: 'let a = 9' }, content)
    store.resolve(RUN, true)
    const next = store.propose(RUN, 2, { path: 'a.ts', oldText: 'let a = 9', newText: 'let a = 7' }, 'let a = 9\nlet b = 2\n')
    expect(next.kind).toBe('proposed')
  })

  it('allows a different path in a later step', () => {
    const content = 'let a = 1\n'
    store.propose(RUN, 1, { path: 'a.ts', oldText: 'let a = 1', newText: 'let a = 9' }, content)
    expect(store.propose(RUN, 2, { path: 'b.ts', oldText: 'let a = 1', newText: 'let a = 9' }, content).kind).toBe('proposed')
  })

  it('allows the same path in the same step of ANOTHER run', () => {
    const content = 'let a = 1\n'
    const edit1 = { path: 'a.ts', oldText: 'let a = 1', newText: 'let a = 9' }
    expect(store.propose('runA', 1, edit1, content).kind).toBe('proposed')
    expect(store.propose('runB', 1, edit1, content).kind).toBe('proposed')
  })

  it('rejects NUL in either text (the result would not be a text file)', () => {
    expect(store.propose(RUN, 1, { path: 'a.ts', oldText: 'a', newText: 'b\u0000c' }, 'a').kind).toBe('rejected')
    expect(store.propose(RUN, 1, { path: 'b.ts', oldText: 'a\u0000', newText: 'b' }, 'a\u0000').kind).toBe('rejected')
  })

  it('fails closed on a malformed run id or step number', () => {
    expect(store.propose('', 1, base, 'return x').kind).toBe('rejected')
    expect(store.propose(RUN, -1, base, 'return x').kind).toBe('rejected')
    expect(store.propose(RUN, 1.5, base, 'return x').kind).toBe('rejected')
    expect(store.propose(RUN, Number.NaN, base, 'return x').kind).toBe('rejected')
  })

  it('keeps oldText and newText, so the accept step can re-verify against the current file', () => {
    store.propose(RUN, 1, base, 'return x')
    const [p] = store.pending(RUN)
    expect(p.oldText).toBe('return x')
    expect(p.newText).toBe('return y')
    expect(p.path).toBe('a.ts')
  })
})

describe('EditProposalStore diff', () => {
  it('names the file, counts changed lines and shows three lines of context', () => {
    const content = ['l1', 'l2', 'l3', 'l4', 'target', 'l6', 'l7', 'l8', 'l9'].join('\n') + '\n'
    store.propose(RUN, 1, { path: 'src/a.ts', oldText: 'target', newText: 'changed' }, content)
    const [p] = store.pending(RUN)
    expect(p.addedLines).toBe(1)
    expect(p.removedLines).toBe(1)
    expect(p.diff).toContain('--- a/src/a.ts')
    expect(p.diff).toContain('+++ b/src/a.ts')
    expect(p.diff).toContain('-target')
    expect(p.diff).toContain('+changed')
    expect(p.diff).toContain(' l2')
    expect(p.diff).toContain(' l8')
    expect(p.diff).not.toContain(' l1\n')
    expect(p.diff).not.toContain(' l9')
    expect(p.diff).toMatch(/@@ -2,7 \+2,7 @@/)
  })

  it('counts a multi-line replacement and leaves unchanged lines out of the counts', () => {
    const content = 'keep\nold1\nold2\ntail\n'
    store.propose(RUN, 1, { path: 'a.ts', oldText: 'old1\nold2', newText: 'old1\nnew2\nnew3' }, content)
    const [p] = store.pending(RUN)
    expect(p.removedLines).toBe(1)
    expect(p.addedLines).toBe(2)
    expect(p.diff).toContain(' old1')
    expect(p.diff).toContain('-old2')
    expect(p.diff).toContain('+new2')
    expect(p.diff).toContain('+new3')
  })

  it('shows a deletion (empty new text) as removed lines', () => {
    store.propose(RUN, 1, { path: 'a.ts', oldText: 'gone\n', newText: '' }, 'a\ngone\nb\n')
    const [p] = store.pending(RUN)
    expect(p.removedLines).toBe(1)
    expect(p.addedLines).toBe(0)
  })

  it('works at the very start and the very end of a file', () => {
    store.propose(RUN, 1, { path: 'a.ts', oldText: 'first', newText: '1st' }, 'first\nsecond')
    store.propose(RUN, 1, { path: 'b.ts', oldText: 'last', newText: 'end' }, 'before\nlast')
    const [a, b] = store.pending(RUN)
    expect(a.diff).toContain('+1st')
    expect(b.diff).toContain('+end')
  })
})

describe('EditProposalStore.pending / resolve', () => {
  it('returns copies: changing the result does not change the store', () => {
    store.propose(RUN, 1, { path: 'a.ts', oldText: 'a', newText: 'b' }, 'a')
    const list = store.pending(RUN)
    list[0].newText = 'EVIL'
    list.length = 0
    expect(store.pending(RUN)).toHaveLength(1)
    expect(store.pending(RUN)[0].newText).toBe('b')
  })

  it('collects across steps and files, per run', () => {
    store.propose(RUN, 1, { path: 'a.ts', oldText: 'a', newText: 'b' }, 'a')
    store.propose(RUN, 1, { path: 'b.ts', oldText: 'a', newText: 'b' }, 'a')
    store.propose('other', 1, { path: 'c.ts', oldText: 'a', newText: 'b' }, 'a')
    expect(store.pending(RUN).map((p) => p.path)).toEqual(['a.ts', 'b.ts'])
    expect(store.pending('other')).toHaveLength(1)
    expect(store.pending('nobody')).toEqual([])
  })

  it('resolve empties the run, accepted or not, and leaves other runs alone', () => {
    store.propose(RUN, 1, { path: 'a.ts', oldText: 'a', newText: 'b' }, 'a')
    store.propose('other', 1, { path: 'a.ts', oldText: 'a', newText: 'b' }, 'a')
    store.resolve(RUN, false, 'user said no')
    expect(store.pending(RUN)).toEqual([])
    expect(store.pending('other')).toHaveLength(1)
    store.resolve('other', true)
    expect(store.pending('other')).toEqual([])
  })

  it('after resolve the same path may be proposed again in the same step number', () => {
    store.propose(RUN, 1, { path: 'a.ts', oldText: 'a', newText: 'b' }, 'a')
    store.resolve(RUN, true)
    expect(store.propose(RUN, 1, { path: 'a.ts', oldText: 'a', newText: 'c' }, 'a').kind).toBe('proposed')
  })

  it('getEditProposalStore returns one shared instance', () => {
    expect(getEditProposalStore()).toBe(getEditProposalStore())
  })
})

describe('end of a run: abandoned versus finished', () => {
  const one = { path: 'a.ts', oldText: 'a', newText: 'b' }

  it('a FINISHED run keeps its pending proposals (the deliverable awaiting review) and they can be resolved', () => {
    store.propose(RUN, 1, one, 'a')
    store.endRun(RUN, 'finished')
    expect(store.pending(RUN)).toHaveLength(1)
    expect(store.pending(RUN)[0]).toMatchObject({ path: 'a.ts', oldText: 'a', newText: 'b' })
    store.resolve(RUN, true, 'looks right')
    expect(store.pending(RUN)).toEqual([])
    const outcomes = store.auditRecords(RUN).records.map((r) => r.outcome)
    expect(outcomes).toContain('package-accepted')
    expect(outcomes).not.toContain('package-abandoned')
  })

  it('an ABANDONED run loses its pending proposals', () => {
    store.propose(RUN, 1, one, 'a')
    store.endRun(RUN, 'abandoned')
    expect(store.pending(RUN)).toEqual([])
  })

  it.each(['abandoned', 'finished'] as const)(
    'a run that has ended (%s) accepts no further proposals: a straggler cannot add to a package under review',
    (how) => {
      store.propose(RUN, 1, one, 'a')
      store.endRun(RUN, how)
      const late = store.propose(RUN, 2, { path: 'b.ts', oldText: 'a', newText: 'b' }, 'a')
      expect(late).toEqual({ kind: 'rejected', reason: expect.stringMatching(/ended/i) })
      expect(store.pending(RUN).map((p) => p.path)).toEqual(how === 'finished' ? ['a.ts'] : [])
    }
  )

  it('a finished run without pending proposals leaves nothing retained', () => {
    store.propose(RUN, 1, one, 'a')
    store.resolve(RUN, true)
    store.endRun(RUN, 'finished')
    expect(store.pending(RUN)).toEqual([])
    expect(store.auditRecords(RUN).records.length).toBeGreaterThan(0)
  })

  it('retention is bounded by REFUSING a new run, never by dropping a package under review', () => {
    for (let i = 0; i < EDIT_MAX_RETAINED_RUNS; i++) {
      store.propose(`run-${i}`, 1, one, 'a')
      store.endRun(`run-${i}`, 'finished')
    }
    const refused = store.propose('one-too-many', 1, one, 'a')
    expect(refused).toEqual({ kind: 'rejected', reason: expect.stringMatching(/awaiting review|resolve/i) })
    for (let i = 0; i < EDIT_MAX_RETAINED_RUNS; i++) {
      expect(store.pending(`run-${i}`)).toHaveLength(1)
    }
    expect(store.pending('one-too-many')).toEqual([])
    expect(store.auditRecords('one-too-many').records.some((r) => r.outcome === 'rejected-capacity')).toBe(true)
    // refused every time, not only the first (a refused run must not slip in on its second try)
    expect(store.propose('one-too-many', 2, { path: 'b.ts', oldText: 'a', newText: 'b' }, 'a').kind).toBe('rejected')
    // endRun of a run that already holds a package never drops anything
    store.endRun('one-too-many', 'finished')
    expect(store.pending('run-0')).toHaveLength(1)
  })

  it('resolving a retained run frees its slot', () => {
    for (let i = 0; i < EDIT_MAX_RETAINED_RUNS; i++) {
      store.propose(`run-${i}`, 1, one, 'a')
      store.endRun(`run-${i}`, 'finished')
    }
    store.resolve('run-3', true)
    store.propose('extra', 1, one, 'a')
    store.endRun('extra', 'finished')
    expect(store.pending('run-0')).toHaveLength(1) // nobody was evicted
    expect(store.pending('extra')).toHaveLength(1)
  })
})

describe('a proposal whose RESULT would exceed the file ceiling', () => {
  // The apply and the undo both read the file through the same 2 MiB ceiling.
  // A proposal that grows the file past it applies once and can then never be
  // read back: restoreEntry reports 'unreadable', the rollback gets stuck and
  // the undo refuses — the one promise this feature makes.
  const CEILING = 2 * 1024 * 1024

  it('is refused at proposal time, with the uniform content-dependent text', () => {
    const content = 'head\n' + 'a'.repeat(CEILING - 200)
    const insert = 'b'.repeat(400)
    expect(Buffer.byteLength(content)).toBeLessThan(CEILING)
    expect(Buffer.byteLength(content) + insert.length).toBeGreaterThan(CEILING)

    const out = store.propose(RUN, 1, { path: 'a.ts', oldText: 'head', newText: 'head' + insert }, content)

    expect(out.kind).toBe('rejected')
    if (out.kind !== 'rejected') throw new Error('expected a rejection')
    // The SAME text as every other content-dependent refusal, compared against
    // one produced in this same run: "your result would be too big" would be a
    // size oracle for a file the agent is not allowed to read.
    const notFound = store.propose(RUN, 1, { path: 'b.ts', oldText: 'nowhere', newText: 'x' }, 'content')
    if (notFound.kind !== 'rejected') throw new Error('expected a rejection')
    expect(out.reason).toBe(notFound.reason)
    expect(store.pending(RUN)).toEqual([])
    // A failed attempt is counted, as for every other content-dependent miss.
    const records = store.auditRecords(RUN).records
    expect(records.some((r) => r.failedAttempts === 1)).toBe(true)
  })

  it('positive control: the same edit just under the ceiling is proposed', () => {
    const content = 'head\n' + 'a'.repeat(CEILING - 2000)
    const insert = 'b'.repeat(400)
    expect(Buffer.byteLength(content) + insert.length).toBeLessThan(CEILING)
    const out = store.propose(RUN, 1, { path: 'a.ts', oldText: 'head', newText: 'head' + insert }, content)
    expect(out.kind).toBe('proposed')
  })

  it('counts BYTES, not characters: multi-byte text over the ceiling is refused', () => {
    // 'ä' is two bytes in UTF-8. A character count would pass this.
    const content = 'head\n' + 'a'.repeat(CEILING - 200)
    const insert = 'ä'.repeat(150)
    expect(content.length + insert.length).toBeLessThan(CEILING)
    expect(Buffer.byteLength(content) + Buffer.byteLength(insert)).toBeGreaterThan(CEILING)
    const out = store.propose(RUN, 1, { path: 'a.ts', oldText: 'head', newText: 'head' + insert }, content)
    expect(out.kind).toBe('rejected')
  })
})

describe('global byte budget over everything pending', () => {
  /** One proposal of a given size: a single long line, replaced by another. */
  const big = (n: number) => ({
    edit: { path: 'a.ts', oldText: 'x'.repeat(n), newText: 'y'.repeat(n) },
    content: 'x'.repeat(n)
  })
  const propose = (st: EditProposalStore, runId: string, p: string, n: number) => {
    const { edit, content } = big(n)
    return st.propose(runId, 1, { ...edit, path: p }, content)
  }
  const finish = (st: EditProposalStore, runId: string) => st.endRun(runId, 'finished')

  /** Bytes one proposal of size n costs in this store, measured, not assumed. */
  function measure(n: number): number {
    const probe = createEditProposalStore()
    propose(probe, 'probe', 'a.ts', n)
    return probe.pendingBytes()
  }

  it('has a default budget sized for a real session, far below gigabytes', () => {
    expect(EDIT_PENDING_BYTES_BUDGET).toBeGreaterThanOrEqual(8 * 1024 * 1024)
    expect(EDIT_PENDING_BYTES_BUDGET).toBeLessThanOrEqual(128 * 1024 * 1024)
  })

  it('counts what is held and returns it on resolve', () => {
    expect(store.pendingBytes()).toBe(0)
    propose(store, RUN, 'a.ts', 1000)
    expect(store.pendingBytes()).toBeGreaterThan(2000)
    store.resolve(RUN, true)
    expect(store.pendingBytes()).toBe(0)
  })

  it('returns the bytes of an abandoned run', () => {
    propose(store, RUN, 'a.ts', 1000)
    store.endRun(RUN, 'abandoned')
    expect(store.pendingBytes()).toBe(0)
  })

  it('a proposal that would pass the budget is REFUSED; nothing retained is evicted', () => {
    const per = measure(2000)
    const small = createEditProposalStore({ byteBudget: Math.floor(per * 2.5) })
    propose(small, 'old', 'a.ts', 2000)
    finish(small, 'old')
    propose(small, 'newer', 'a.ts', 2000)
    finish(small, 'newer')
    expect(small.pendingBytes()).toBe(per * 2)

    const out = propose(small, 'active', 'a.ts', 2000)

    expect(out.kind).toBe('rejected')
    expect(small.auditRecords('active').records.some((r) => r.outcome === 'rejected-capacity')).toBe(true)
    expect(small.pending('old')).toHaveLength(1)
    expect(small.pending('newer')).toHaveLength(1)
    expect(small.pending('active')).toEqual([])
    expect(small.pendingBytes()).toBe(per * 2)
  })

  it('a review that is waiting can never disappear: even a maximal-size runaway cannot wipe retained packages', () => {
    const per = measure(2000)
    const small = createEditProposalStore({ byteBudget: per * 4 })
    for (const id of ['r1', 'r2', 'r3']) {
      propose(small, id, 'a.ts', 2000)
      finish(small, id)
    }
    for (let i = 0; i < 20; i++) propose(small, 'runaway', `f${i}.ts`, 2000)
    for (const id of ['r1', 'r2', 'r3']) expect(small.pending(id)).toHaveLength(1)
    expect(small.pendingBytes()).toBeLessThanOrEqual(per * 4)
  })

  it('resolving a pending package frees the space, and the refused proposal then succeeds', () => {
    const per = measure(2000)
    const small = createEditProposalStore({ byteBudget: Math.floor(per * 1.5) })
    propose(small, 'old', 'a.ts', 2000)
    finish(small, 'old')
    expect(propose(small, 'active', 'a.ts', 2000).kind).toBe('rejected')
    small.resolve('old', false, 'discarded')
    expect(propose(small, 'active', 'a.ts', 2000).kind).toBe('proposed')
  })

  it('records the refusal for the audit as a capacity event, with the path', () => {
    const per = measure(2000)
    const small = createEditProposalStore({ byteBudget: Math.floor(per * 1.5) })
    propose(small, 'old', 'a.ts', 2000)
    finish(small, 'old')
    propose(small, 'active', 'b.ts', 2000)
    const rec = small.auditRecords('active').records.find((r) => r.outcome === 'rejected-capacity')
    expect(rec).toMatchObject({ path: 'b.ts', stepNumber: 1 })
    expect(rec?.reason).toMatch(/budget/i)
  })

  it('a single proposal larger than the whole budget is refused', () => {
    const per = measure(2000)
    const small = createEditProposalStore({ byteBudget: per * 2 })
    expect(propose(small, 'active', 'a.ts', 20000).kind).toBe('rejected')
    expect(small.pending('active')).toEqual([])
  })

  it('a refused (budget) proposal leaves the byte count unchanged', () => {
    const per = measure(2000)
    const small = createEditProposalStore({ byteBudget: per })
    propose(small, 'active', 'a.ts', 2000)
    const before = small.pendingBytes()
    propose(small, 'active', 'b.ts', 2000)
    expect(small.pendingBytes()).toBe(before)
  })

  it('counts the DIFF too: small old/new text with large context is large', () => {
    const line = 'c'.repeat(1000)
    const content = `${line}\n${line}\n${line}\ntarget\n${line}\n${line}\n${line}\n`
    store.propose(RUN, 1, { path: 'a.ts', oldText: 'target', newText: 'T' }, content)
    // old + new + path are a few bytes; the context lines in the diff are ~6000
    expect(store.pendingBytes()).toBeGreaterThanOrEqual(6000)
  })
})

describe('rendering: the diff must not lie to the reviewer', () => {
  const BIDI = '\u202E'
  const ZW = '\u200B'

  it('shows bidi and zero-width characters escaped in the diff and flags the proposal', () => {
    store.propose(RUN, 1, { path: 'a.ts', oldText: 'if (ok)', newText: `if (ok${BIDI}${ZW})` }, 'if (ok) {}\n')
    const [p] = store.pending(RUN)
    expect(p.diff).toContain('<U+202E>')
    expect(p.diff).toContain('<U+200B>')
    expect(p.diff).not.toContain(BIDI)
    expect(p.diff).not.toContain(ZW)
    expect(p.introducesHiddenCharacters).toBe(true)
    // The warning line is a user text in a German dialog (the diff is shown
    // to the human and never returned to the model), and it keeps the `!!`
    // prefix the renderer reads as a meta line.
    expect(p.diff).toMatch(/^!! .*unsichtbare oder richtungsändernde Zeichen/m)
    expect(p.diff).not.toMatch(/invisible|direction-changing/i)
  })

  it('stores the text byte-exact: what gets written is not what is displayed', () => {
    store.propose(RUN, 1, { path: 'a.ts', oldText: 'if (ok)', newText: `if (ok${BIDI}${ZW})` }, 'if (ok) {}\n')
    const [p] = store.pending(RUN)
    expect(p.newText).toBe(`if (ok${BIDI}${ZW})`)
    expect(p.oldText).toBe('if (ok)')
  })

  it.each([
    ['carriage return', '\r'],
    ['C0 control', '\u0007'],
    ['C1 control', '\u0085'],
    ['line separator', '\u2028'],
    ['paragraph separator', '\u2029'],
    ['byte order mark', '\uFEFF'],
    ['bidi isolate', '\u2066']
  ])('makes %s visible', (_n, ch) => {
    store.propose(RUN, 1, { path: 'a.ts', oldText: 'x', newText: `x${ch}y` }, 'x\n')
    const [p] = store.pending(RUN)
    const hex = ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')
    expect(p.diff).toContain(`<U+${hex}>`)
    expect(p.diff).not.toContain(ch)
    expect(p.introducesHiddenCharacters).toBe(true)
  })

  it('leaves a tab alone and does not flag an ordinary proposal', () => {
    store.propose(RUN, 1, { path: 'a.ts', oldText: 'x', newText: '\tx' }, 'x\n')
    const [p] = store.pending(RUN)
    expect(p.diff).toContain('+\tx')
    expect(p.diff).not.toContain('<U+')
    expect(p.introducesHiddenCharacters).toBe(false)
  })

  it('escapes such characters in CONTEXT lines too, but flags only what the proposal introduces', () => {
    const content = `before${BIDI}\ntarget\nafter\n`
    store.propose(RUN, 1, { path: 'a.ts', oldText: 'target', newText: 'changed' }, content)
    const [p] = store.pending(RUN)
    expect(p.diff).toContain('<U+202E>')
    expect(p.diff).not.toContain(BIDI)
    expect(p.introducesHiddenCharacters).toBe(false)
  })

  it('does not flag a change that keeps the hidden characters it already had', () => {
    store.propose(RUN, 1, { path: 'a.ts', oldText: `a${ZW}b`, newText: `a${ZW}c` }, `a${ZW}b\n`)
    expect(store.pending(RUN)[0].introducesHiddenCharacters).toBe(false)
  })

  it('flags a swap of one hidden character for another', () => {
    store.propose(RUN, 1, { path: 'a.ts', oldText: `a${ZW}b`, newText: `a${BIDI}b` }, `a${ZW}b\n`)
    expect(store.pending(RUN)[0].introducesHiddenCharacters).toBe(true)
  })
})

describe('the refusal never varies with file content (no scan verdict, no count)', () => {
  it('zero matches and several matches give the SAME tool result, on any file', async () => {
    write('plain.ts', 'foo\nfoo\n')
    write('pw.ts', 'const cfg = { password: "hunter22secret" }\nfoo\nfoo\n')
    const results: string[] = []
    for (const file of ['plain.ts', 'pw.ts']) {
      for (const old of ['absent', 'foo']) {
        results.push(await edit({ path: file, old, new: 'y' }, await ctxFor()))
      }
    }
    expect(new Set(results).size).toBe(1)
    expect(results[0]).toMatch(/exactly once/i)
    expect(results[0]).toMatch(/longer/i)
    expect(results[0]).not.toMatch(/[0-9]|occurs|times/i)
  })

  it('audits the real figure (0, or 2 for "two or more") without showing it to the model', async () => {
    write('s.ts', 'foo\nfoo\n')
    await edit({ path: 's.ts', old: 'foo', new: 'y' }, await ctxFor())
    await edit({ path: 's.ts', old: 'absent', new: 'y' }, await ctxFor())
    const recs = store.auditRecords(RUN).records
    expect(recs[0]).toMatchObject({ outcome: 'rejected-ambiguous', path: 's.ts', occurrences: 2 })
    expect(recs[1]).toMatchObject({ outcome: 'rejected-not-found', path: 's.ts', occurrences: 0 })
  })

  it('does not take a scan dependency any more: registering without one still works', async () => {
    write('o.ts', 'plain\n')
    expect(await edit({ path: 'o.ts', old: 'plain', new: 'y' }, await ctxFor())).toMatch(/proposed/i)
  })
})

describe('rendering: what counts as invisible or confusable', () => {
  // Each of these is a valid identifier character or a blank in some editor
  // and invisible or look-alike in a diff view. Escaped, and flagged if added.
  it.each([
    ['Hangul filler U+3164', '\u3164'],
    ['halfwidth Hangul filler U+FFA0', '\uFFA0'],
    ['Hangul choseong filler U+115F', '\u115F'],
    ['Hangul jungseong filler U+1160', '\u1160'],
    ['braille blank U+2800', '\u2800'],
    ['combining grapheme joiner U+034F', '\u034F'],
    ['variation selector U+FE0F', '\uFE0F'],
    ['Mongolian variation selector U+180B', '\u180B'],
    ['Mongolian free variation selector four U+180F', '\u180F'],
    ['variation selector supplement U+E0100', '\u{E0100}'],
    ['no-break space U+00A0', '\u00A0'],
    ['ideographic space U+3000', '\u3000'],
    ['en space U+2002', '\u2002'],
    ['narrow no-break space U+202F', '\u202F'],
    ['soft hyphen U+00AD', '\u00AD'],
    ['Khmer inherent vowel U+17B4', '\u17B4'],
    ['private use U+E000', '\uE000']
  ])('escapes %s and flags a proposal that adds it', (_n, ch) => {
    store.propose(RUN, 1, { path: 'a.ts', oldText: 'x', newText: `x${ch}y` }, 'x\n')
    const [p] = store.pending(RUN)
    const hex = ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')
    expect(p.diff).toContain(`<U+${hex}>`)
    expect(p.diff).not.toContain(ch)
    expect(p.introducesHiddenCharacters).toBe(true)
    expect(p.newText).toBe(`x${ch}y`)
  })

  it('an invisible variable name: the Hangul filler as an identifier is flagged', () => {
    store.propose(RUN, 1, { path: 'a.ts', oldText: 'let a = 1', newText: 'let a = 1\nlet \u3164 = 2' }, 'let a = 1\n')
    const [p] = store.pending(RUN)
    expect(p.introducesHiddenCharacters).toBe(true)
    expect(p.diff).toContain('+let <U+3164> = 2')
  })

  it('leaves plain space and tab alone', () => {
    store.propose(RUN, 1, { path: 'a.ts', oldText: 'x', newText: ' \tx' }, 'x\n')
    const [p] = store.pending(RUN)
    expect(p.diff).toContain('+ \tx')
    expect(p.diff).not.toContain('<U+')
    expect(p.introducesHiddenCharacters).toBe(false)
  })

  it('does not treat a normal multi-line replacement as hidden characters', () => {
    store.propose(RUN, 1, { path: 'a.ts', oldText: 'x', newText: 'a\nb\nc' }, 'x\n')
    expect(store.pending(RUN)[0].introducesHiddenCharacters).toBe(false)
  })

  it('stores a plain old text that CONTAINS a hidden character exactly (the write must not write the escaping)', () => {
    const old = `if (a${'\u202E'}b)`
    store.propose(RUN, 1, { path: 'a.ts', oldText: old, newText: 'if (ab)' }, `${old}\n`)
    const [p] = store.pending(RUN)
    expect(p.oldText).toBe(old)
    expect(p.oldText).not.toContain('<U+')
    expect(p.newText).toBe('if (ab)')
    expect(p.diff).toContain('-if (a<U+202E>b)')
  })

  it('escapes REMOVED lines too, not only added and context lines', () => {
    store.propose(RUN, 1, { path: 'a.ts', oldText: `a\u3164b`, newText: 'ab' }, 'a\u3164b\n')
    const [p] = store.pending(RUN)
    const removed = p.diff.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---'))
    expect(removed).toEqual(['-a<U+3164>b'])
  })

  it('escapes the path in the diff header, including a line break that would forge diff lines', () => {
    store.propose(RUN, 1, { path: 'src/a\u202E.ts', oldText: 'x', newText: 'y' }, 'x\n')
    store.propose(RUN, 1, { path: 'b\n+++ forged.ts', oldText: 'x', newText: 'y' }, 'x\n')
    const [one, two] = store.pending(RUN)
    expect(one.diff).toContain('--- a/src/a<U+202E>.ts')
    expect(one.diff).toContain('+++ b/src/a<U+202E>.ts')
    expect(two.diff.split('\n').filter((l) => l.startsWith('+++ '))).toHaveLength(1)
    expect(two.diff).toContain('<U+000A>')
  })
})

describe('file identity: the approved diff is provably the one that gets written', () => {
  const sha = (t: string) => createHash('sha256').update(Buffer.from(t, 'utf-8')).digest('hex')

  it('stores the hash of the content as read, and the match offset', () => {
    const content = 'let a = 1\nlet b = 2\n'
    store.propose(RUN, 1, { path: 'a.ts', oldText: 'let b = 2', newText: 'let b = 3' }, content)
    const [p] = store.pending(RUN)
    expect(p.baseSha256).toBe(sha(content))
    expect(p.matchIndex).toBe(content.indexOf('let b = 2'))
  })

  it('editStillMatches: true for the file the diff was computed against', () => {
    const content = 'let a = 1\nlet b = 2\n'
    store.propose(RUN, 1, { path: 'a.ts', oldText: 'let b = 2', newText: 'let b = 3' }, content)
    expect(editStillMatches(store.pending(RUN)[0], content)).toBe(true)
  })

  it('editStillMatches: false when the user edited ELSEWHERE in the file (old text still occurs once)', () => {
    const content = 'let a = 1\nlet b = 2\n'
    store.propose(RUN, 1, { path: 'a.ts', oldText: 'let b = 2', newText: 'let b = 3' }, content)
    const changed = 'let a = 100\nlet b = 2\n'
    expect(changed.split('let b = 2').length - 1).toBe(1)
    expect(editStillMatches(store.pending(RUN)[0], changed)).toBe(false)
  })

  it('editStillMatches: false when the user edited AFTER the match (same position, old text still there once)', () => {
    // Only the hash can tell this: the old text sits at the stored index in both versions.
    const content = 'let a = 1\nlet b = 2\nlet c = 3\n'
    store.propose(RUN, 1, { path: 'a.ts', oldText: 'let b = 2', newText: 'let b = 9' }, content)
    const changed = 'let a = 1\nlet b = 2\nlet c = 300\n'
    expect(changed.startsWith('let b = 2', store.pending(RUN)[0].matchIndex)).toBe(true)
    expect(editStillMatches(store.pending(RUN)[0], changed)).toBe(false)
  })

  it('editStillMatches: false when a second run changed the file (two runs may hold proposals on one file)', () => {
    const content = 'let a = 1\n'
    store.propose('runA', 1, { path: 'a.ts', oldText: 'let a = 1', newText: 'let a = 2' }, content)
    store.propose('runB', 1, { path: 'a.ts', oldText: 'let a = 1', newText: 'let a = 3' }, content)
    const afterA = 'let a = 2\n'
    expect(editStillMatches(store.pending('runB')[0], afterA)).toBe(false)
  })

  it('editStillMatches: false when the file is unchanged but the stored fields were altered', () => {
    const content = 'let a = 1\n'
    store.propose(RUN, 1, { path: 'a.ts', oldText: 'let a = 1', newText: 'let a = 2' }, content)
    const forged = { ...store.pending(RUN)[0], matchIndex: 3 }
    expect(editStillMatches(forged, content)).toBe(false)
  })

  it('the handler stores the hash of the bytes on disk (multi-byte text included)', async () => {
    const abs = write('a.ts', 'const s = "caf\u00e9"\nlet b = 2\n')
    await edit({ path: 'a.ts', old: 'let b = 2', new: 'let b = 3' }, await ctxFor())
    const onDisk = createHash('sha256').update(fs.readFileSync(abs)).digest('hex')
    expect(store.pending(RUN)[0].baseSha256).toBe(onDisk)
  })
})

describe('the search is linear, not just limited to two calls', () => {
  /** The shape that makes a naive or engine indexOf quadratic: a long near-match everywhere. */
  const adversarial = (h: number, k: number) => ({
    haystack: 'a'.repeat(h),
    needle: 'a'.repeat(k) + 'b' + 'a'.repeat(k - 1)
  })

  it('does O(haystack + needle) work on the adversarial needle, asserted as work, not as time', () => {
    // One indexOf call on a^400000 vs a^100000 b a^99999 took 4743 ms (and 106 s
    // at the 2 MiB cap), scaling 356 ms, 1271 ms, 4743 ms per doubling.
    const { haystack, needle } = adversarial(400_000, 100_000)
    const steps = { n: 0 }
    const r = findUpToTwo(haystack, needle, steps)
    expect(r).toEqual({ count: 0, first: -1 })
    expect(steps.n).toBeLessThanOrEqual(2 * (haystack.length + needle.length))
  })

  it('stays linear when the work doubles', () => {
    const small = { n: 0 }
    const big = { n: 0 }
    const a = adversarial(100_000, 25_000)
    const b = adversarial(200_000, 50_000)
    findUpToTwo(a.haystack, a.needle, small)
    findUpToTwo(b.haystack, b.needle, big)
    expect(big.n).toBeLessThanOrEqual(small.n * 2 + 10)
  })

  it('the store decides the adversarial proposal without hanging (it took minutes before)', () => {
    const { haystack, needle } = adversarial(400_000, 100_000)
    const out = store.propose(RUN, 1, { path: 'a.ts', oldText: needle, newText: 'x' }, haystack)
    expect(out.kind).toBe('rejected')
  })

  it('agrees with indexOf on 6000 random small inputs (needles up to 9, so the failure table matters), overlaps included', () => {
    let seed = 12345
    const rnd = (n: number) => {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff
      return (seed >>> 16) % n
    }
    const str = (len: number) => Array.from({ length: len }, () => 'ab'[rnd(2)]).join('')
    for (let i = 0; i < 6000; i++) {
      const hay = str(rnd(30))
      const needle = str(1 + rnd(9))
      const first = hay.indexOf(needle)
      const second = first === -1 ? -1 : hay.indexOf(needle, first + 1)
      const expected = first === -1 ? { count: 0, first: -1 } : { count: second === -1 ? 1 : 2, first }
      expect(findUpToTwo(hay, needle)).toEqual(expected)
    }
  })

  it('finds a match that needs the longest proper border of the needle (a table built with a wrong fallback misses it)', () => {
    const hay = 'aabaaabaaaa'
    const needle = 'aabaaaa'
    expect(hay.indexOf(needle)).toBe(4)
    expect(findUpToTwo(hay, needle)).toEqual({ count: 1, first: 4 })
  })

  it('counts "aa" in "aaa" as two (overlap) and finds the first index', () => {
    expect(findUpToTwo('xaaa', 'aa')).toEqual({ count: 2, first: 1 })
    expect(findUpToTwo('xaay', 'aa')).toEqual({ count: 1, first: 1 })
  })

  it('handles a needle as long as the haystack and a longer one', () => {
    expect(findUpToTwo('abc', 'abc')).toEqual({ count: 1, first: 0 })
    expect(findUpToTwo('abc', 'abcd')).toEqual({ count: 0, first: -1 })
  })
})

describe('a lone surrogate cannot be written, so it is not proposed', () => {
  it.each([
    ['lone high surrogate in the new text', 'x', 'a\uD800b'],
    ['lone low surrogate in the new text', 'x', 'a\uDC00b'],
    ['lone high surrogate at the end of the new text', 'x', 'a\uD83D'],
    ['lone surrogate in the old text', 'a\uD800b', 'x']
  ])('rejects %s', (_n, oldText, newText) => {
    const out = store.propose(RUN, 1, { path: 'a.ts', oldText, newText }, `${oldText}\n`)
    expect(out).toEqual({ kind: 'rejected', reason: expect.stringMatching(/surrogate/i) })
    expect(store.pending(RUN)).toHaveLength(0)
  })

  it('accepts a well-formed surrogate pair (an emoji)', () => {
    const out = store.propose(RUN, 1, { path: 'a.ts', oldText: 'x', newText: 'a\uD83D\uDE00b' }, 'x\n')
    expect(out.kind).toBe('proposed')
    expect(store.pending(RUN)[0].newText).toBe('a\uD83D\uDE00b')
  })

  it('does not count as a failed attempt (it depends only on the model text)', () => {
    for (let i = 0; i < 10; i++) {
      store.propose(RUN, 1, { path: 'a.ts', oldText: 'x', newText: 'a\uD800' }, 'x\n')
    }
    expect(store.propose(RUN, 1, { path: 'a.ts', oldText: 'x', newText: 'y' }, 'x\n').kind).toBe('proposed')
  })
})

describe('the counting work is bounded', () => {
  it('adversarial overlap (a^200000, a^100000) is decided without scanning every match', () => {
    const content = 'a'.repeat(200_000)
    const started = performance.now()
    const out = store.propose(RUN, 1, { path: 'a.ts', oldText: 'a'.repeat(100_000), newText: 'b' }, content)
    const elapsed = performance.now() - started
    expect(out.kind).toBe('rejected')
    // Measured: the unbounded overlapping loop took 2.65 s on the review machine
    // for this shape (about 100000 matches, each compared over 100000 characters);
    // the bounded version stops after the second match and took a few ms here.
    // The bound is 500 ms, i.e. over 50x the bounded measurement and over 5x
    // under the unbounded one, so it separates the two without being flaky.
    expect(elapsed).toBeLessThan(500)
  })

  it('a longer old text than the file can never match and is refused at once', () => {
    expect(store.propose(RUN, 1, { path: 'a.ts', oldText: 'abcd', newText: 'x' }, 'abc').kind).toBe('rejected')
  })
})

describe('capacity checks must not become a content probe', () => {
  const CAP = EDIT_MAX_FAILED_ATTEMPTS_PER_PATH
  const NOT_ONCE = /exactly once/i

  /** A store whose run RUN already holds the maximum number of pending proposals. */
  function fullRun(): EditProposalStore {
    const st = createEditProposalStore()
    for (let i = 0; i < EDIT_MAX_PENDING_PER_RUN; i++) {
      expect(st.propose(RUN, 1, { path: `f${i}.ts`, oldText: 'a', newText: 'b' }, 'a').kind).toBe('proposed')
    }
    return st
  }

  it('with the pending cap full, a matching and a non-matching old text give the IDENTICAL message', () => {
    const st = fullRun()
    const match = st.propose(RUN, 2, { path: 'z.ts', oldText: 'present', newText: 'x' }, 'present')
    const miss = st.propose(RUN, 2, { path: 'z.ts', oldText: 'absent', newText: 'x' }, 'present')
    if (match.kind !== 'rejected' || miss.kind !== 'rejected') throw new Error('expected rejections')
    expect(match.reason).toBe(miss.reason)
  })

  it('with the pending cap full, both outcomes increment the per-path failure count and hit the cap together', () => {
    const st = fullRun()
    for (let i = 0; i < CAP; i++) {
      const old = i % 2 === 0 ? 'present' : 'absent'
      st.propose(RUN, 2, { path: 'z.ts', oldText: old, newText: 'x' }, 'present')
    }
    const counts = st.auditRecords(RUN).records.filter((r) => r.path === 'z.ts').map((r) => r.failedAttempts)
    expect(counts).toEqual([1, 2, 3, 4, 5].slice(0, CAP))
    const after = st.propose(RUN, 2, { path: 'z.ts', oldText: 'present', newText: 'x' }, 'present')
    expect(after).toEqual({ kind: 'rejected', reason: expect.stringMatching(/limit/i) })
  })

  it('the pending-cap decision does not look at the file: a content that cannot match gives the same answer', () => {
    const st = fullRun()
    const a = st.propose(RUN, 2, { path: 'y.ts', oldText: 'q', newText: 'x' }, '')
    const b = st.propose(RUN, 2, { path: 'x.ts', oldText: 'q', newText: 'x' }, 'q')
    if (a.kind !== 'rejected' || b.kind !== 'rejected') throw new Error('expected rejections')
    expect(a.reason).toBe(b.reason)
  })

  it('oversized by lower bound: refused before any search, same text whether or not the old text matches, and not counted as a failure', () => {
    const small = createEditProposalStore({ byteBudget: 2000 })
    const huge = 'n'.repeat(5000)
    const match = small.propose(RUN, 1, { path: 'a.ts', oldText: 'present', newText: huge }, 'present')
    const miss = small.propose(RUN, 1, { path: 'a.ts', oldText: 'absent', newText: huge }, 'present')
    if (match.kind !== 'rejected' || miss.kind !== 'rejected') throw new Error('expected rejections')
    expect(match.reason).toBe(miss.reason)
    expect(match.reason).toMatch(/budget/i)
    for (let i = 0; i < CAP * 3; i++) {
      small.propose(RUN, 1, { path: 'a.ts', oldText: 'present', newText: huge }, 'present')
    }
    // not locked out: no failure was counted for decisions that need nothing from the file
    expect(small.propose(RUN, 1, { path: 'a.ts', oldText: 'present', newText: 'ok' }, 'present').kind).toBe('proposed')
  })

  it('oversized only after the diff exists: refused with the NOT-EXACTLY-ONCE text, and it costs a failed attempt', () => {
    const line = 'c'.repeat(1000)
    const content = `${line}\n${line}\n${line}\ntarget\n${line}\n${line}\n${line}\n`
    const small = createEditProposalStore({ byteBudget: 3000 })
    const overflow = small.propose(RUN, 1, { path: 'a.ts', oldText: 'target', newText: 'T' }, content)
    const plainMiss = small.propose(RUN, 1, { path: 'b.ts', oldText: 'absent', newText: 'T' }, content)
    if (overflow.kind !== 'rejected' || plainMiss.kind !== 'rejected') throw new Error('expected rejections')
    expect(overflow.reason).toBe(plainMiss.reason)
    expect(overflow.reason).toMatch(NOT_ONCE)
    const rec = small.auditRecords(RUN).records.find((r) => r.path === 'a.ts')
    expect(rec).toMatchObject({ outcome: 'rejected-capacity', failedAttempts: 1 })
    expect(small.pendingBytes()).toBe(0)
  })

  it('the audit keeps the causes apart: pending cap, byte lower bound, after the diff, ambiguous', () => {
    const line = 'c'.repeat(1000)
    const big = `${line}\n${line}\n${line}\ntarget\n${line}\n${line}\n${line}\n`
    const st = createEditProposalStore({ byteBudget: 3000 })
    st.propose(RUN, 1, { path: 'lb.ts', oldText: 'x', newText: 'n'.repeat(5000) }, 'x')
    st.propose(RUN, 1, { path: 'diff.ts', oldText: 'target', newText: 'T' }, big)
    st.propose(RUN, 1, { path: 'amb.ts', oldText: 'a', newText: 'b' }, 'a a')
    const by = (p: string) => st.auditRecords(RUN).records.find((r) => r.path === p)
    expect(by('lb.ts')).toMatchObject({ outcome: 'rejected-capacity', reason: expect.stringMatching(/lower bound/i) })
    expect(by('diff.ts')).toMatchObject({ outcome: 'rejected-capacity', reason: expect.stringMatching(/after the diff/i) })
    expect(by('amb.ts')).toMatchObject({ outcome: 'rejected-ambiguous' })
    const full = fullRun()
    full.propose(RUN, 2, { path: 'z.ts', oldText: 'a', newText: 'b' }, 'a')
    expect(full.auditRecords(RUN).records.find((r) => r.path === 'z.ts')).toMatchObject({
      outcome: 'rejected-capacity',
      reason: expect.stringMatching(/pending cap/i)
    })
  })

  describe('through the tool', () => {
    it('an oversized proposal is refused WITHOUT the file being opened (spy on open, not timing)', async () => {
      write('a.ts', 'present\n')
      const tiny = createEditProposalStore({ byteBudget: 2000 })
      registry = new ToolRegistry({ toolTimeoutMs: 5000, maxResultChars: 1_000_000 })
      const deps = { findGrant: async (id: string) => grants.find((g) => g.id === id) }
      registerReadTools(registry, deps)
      registerEditTools(registry, { ...deps, store: tiny })
      const ctx = await ctxFor()
      const opened: string[] = []
      const realOpen = fs.promises.open.bind(fs.promises)
      const spy = vi.spyOn(fs.promises, 'open').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
        opened.push(String(p))
        return (realOpen as (...a: unknown[]) => Promise<fs.promises.FileHandle>)(p, ...rest)
      }) as typeof fs.promises.open)
      try {
        const out = await edit({ path: 'a.ts', old: 'present', new: 'n'.repeat(5000) }, ctx)
        expect(out).toMatch(/budget/i)
        expect(opened.filter((p) => p.endsWith('a.ts'))).toEqual([])
        // control: a proposal that fits DOES open the file
        const ok = await edit({ path: 'a.ts', old: 'present', new: 'ok' }, ctx)
        expect(ok).toMatch(/proposed/i)
        expect(opened.filter((p) => p.endsWith('a.ts'))).toHaveLength(1)
      } finally {
        spy.mockRestore()
      }
    })

    it('with the pending cap full, matching and non-matching old text give the same tool result without opening the file', async () => {
      write('z.ts', 'present\n')
      for (let i = 0; i < EDIT_MAX_PENDING_PER_RUN; i++) {
        store.propose(RUN, 1, { path: `f${i}.ts`, oldText: 'a', newText: 'b' }, 'a')
      }
      const ctx = await ctxFor('propose', { stepNumber: 2 })
      const match = await edit({ path: 'z.ts', old: 'present', new: 'x' }, ctx)
      const miss = await edit({ path: 'z.ts', old: 'absent', new: 'x' }, ctx)
      expect(match).toBe(miss)
      expect(match).toMatch(/too many/i)
    })
  })
})

describe('failed-attempt cap per path (belt and braces: the refusal text itself no longer varies)', () => {
  const CAP = EDIT_MAX_FAILED_ATTEMPTS_PER_PATH
  const miss = (s: EditProposalStore, step = 1, p = 'a.ts', runId = RUN) =>
    s.propose(runId, step, { path: p, oldText: 'zzz', newText: 'y' }, 'abc')
  const hit = (s: EditProposalStore, step: number, p = 'a.ts', runId = RUN) =>
    s.propose(runId, step, { path: p, oldText: 'abc', newText: 'y' }, 'abc')

  it('is small enough that honest use never touches it', () => {
    expect(CAP).toBeGreaterThanOrEqual(3)
    expect(CAP).toBeLessThanOrEqual(10)
  })

  it('refuses further attempts on the path once the cap is reached, even a correct one', () => {
    for (let i = 0; i < CAP; i++) {
      expect(miss(store, i + 1)).toEqual({ kind: 'rejected', reason: expect.stringMatching(/exactly once/i) })
    }
    const capped = miss(store, CAP + 1)
    expect(capped.kind).toBe('rejected')
    const correct = hit(store, CAP + 2)
    expect(correct.kind).toBe('rejected')
    expect(store.pending(RUN)).toHaveLength(0)
  })

  it('says only that the limit was reached: nothing about the file, no count', () => {
    for (let i = 0; i < CAP; i++) miss(store, i + 1)
    const out = hit(store, CAP + 1)
    if (out.kind !== 'rejected') throw new Error('expected rejection')
    expect(out.reason).toMatch(/limit/i)
    expect(out.reason).not.toMatch(/occurs|\btimes\b/i)
  })

  it('counts ambiguous attempts too', () => {
    for (let i = 0; i < CAP; i++) {
      store.propose(RUN, i + 1, { path: 'a.ts', oldText: 'a', newText: 'b' }, 'a a')
    }
    expect(hit(store, CAP + 1).kind).toBe('rejected')
    expect(store.pending(RUN)).toHaveLength(0)
  })

  it('does not count successful proposals, in any number', () => {
    for (let i = 1; i <= CAP * 3; i++) {
      expect(hit(store, i).kind).toBe('proposed')
      store.resolve(RUN, true)
    }
    expect(miss(store, CAP * 3 + 1)).toEqual({ kind: 'rejected', reason: expect.stringMatching(/exactly once/i) })
  })

  it('does not count refusals that depend only on the model string (no-op, same step)', () => {
    for (let i = 0; i < CAP * 2; i++) {
      store.propose(RUN, 1, { path: 'a.ts', oldText: 'abc', newText: 'abc' }, 'abc')
    }
    expect(hit(store, 1).kind).toBe('proposed')
    for (let i = 0; i < CAP * 2; i++) hit(store, 1)
    store.resolve(RUN, true)
    expect(miss(store, 2)).toEqual({ kind: 'rejected', reason: expect.stringMatching(/exactly once/i) })
  })

  it('is per path and per run', () => {
    for (let i = 0; i < CAP; i++) miss(store, i + 1)
    expect(hit(store, 1, 'b.ts').kind).toBe('proposed')
    expect(hit(store, 1, 'a.ts', 'otherRun').kind).toBe('proposed')
  })

  it('is shared by spellings of one file (case folded)', () => {
    for (let i = 0; i < CAP; i++) miss(store, i + 1, 'src/A.ts')
    expect(hit(store, 1, 'src/a.ts').kind).toBe('rejected')
  })

  it('is NOT reset by resolve (the executor resolves per step)', () => {
    for (let i = 0; i < CAP - 1; i++) miss(store, i + 1)
    expect(hit(store, CAP).kind).toBe('proposed')
    store.resolve(RUN, false, 'step over') // a real pending package is resolved here
    miss(store, CAP + 1) // the CAP-th failure, after the resolve
    expect(hit(store, CAP + 2).kind).toBe('rejected')
  })

  it('reaches the model through the tool as a limit message, not an occurrence count', async () => {
    write('a.ts', 'abc')
    const ctx = await ctxFor()
    for (let i = 0; i < CAP; i++) {
      expect(await edit({ path: 'a.ts', old: 'zzz', new: 'y' }, { ...ctx, stepNumber: i + 1 })).toMatch(/exactly once/i)
    }
    const out = await edit({ path: 'a.ts', old: 'abc', new: 'y' }, { ...ctx, stepNumber: CAP + 1 })
    expect(out).toMatch(/limit/i)
    expect(out).not.toMatch(/occurs/i)
    expect(store.pending(RUN)).toHaveLength(0)
  })
})

describe('audit records (for the audit task to wire; not an audit itself)', () => {
  it('records proposed, ambiguous, not-found and limit-reached with path, step and counts', () => {
    store.propose(RUN, 1, { path: 'a.ts', oldText: 'x', newText: 'y' }, 'x')
    store.propose(RUN, 2, { path: 'b.ts', oldText: 'x', newText: 'y' }, 'x x x')
    store.propose(RUN, 3, { path: 'b.ts', oldText: 'q', newText: 'y' }, 'x')
    for (let i = 0; i < EDIT_MAX_FAILED_ATTEMPTS_PER_PATH; i++) {
      store.propose(RUN, 10 + i, { path: 'c.ts', oldText: 'q', newText: 'y' }, 'x')
    }
    store.propose(RUN, 99, { path: 'c.ts', oldText: 'x', newText: 'y' }, 'x')
    const { records } = store.auditRecords(RUN)
    const by = (o: string) => records.filter((r) => r.outcome === o)
    expect(by('proposed')).toHaveLength(1)
    expect(by('proposed')[0]).toMatchObject({ runId: RUN, stepNumber: 1, path: 'a.ts' })
    expect(by('rejected-ambiguous')[0]).toMatchObject({ path: 'b.ts', stepNumber: 2, occurrences: 2, failedAttempts: 1 })
    expect(by('rejected-not-found')[0]).toMatchObject({ path: 'b.ts', stepNumber: 3, occurrences: 0, failedAttempts: 2 })
    expect(by('limit-reached')).toHaveLength(1)
    expect(by('limit-reached')[0]).toMatchObject({ path: 'c.ts', stepNumber: 99 })
    expect(typeof records[0].at).toBe('number')
  })

  it('a repeated probe on one path is visible as a rising failedAttempts', () => {
    for (let i = 1; i <= 3; i++) store.propose(RUN, i, { path: 'a.ts', oldText: 'q', newText: 'y' }, 'x')
    const counts = store.auditRecords(RUN).records.map((r) => r.failedAttempts)
    expect(counts).toEqual([1, 2, 3])
  })

  it('never stores the old or new text (a probe string may be the secret being guessed)', () => {
    store.propose(RUN, 1, { path: 'a.ts', oldText: 'TOPSECRETGUESS', newText: 'NEWSECRET' }, 'x')
    store.propose(RUN, 2, { path: 'a.ts', oldText: 'x', newText: 'NEWSECRET2' }, 'x')
    const json = JSON.stringify(store.auditRecords(RUN))
    expect(json).not.toContain('TOPSECRETGUESS')
    expect(json).not.toContain('NEWSECRET')
  })

  it('resolve stores accepted and reason (bounded, control characters stripped)', () => {
    store.propose(RUN, 1, { path: 'a.ts', oldText: 'a', newText: 'b' }, 'a')
    store.resolve(RUN, false, 'user said no\nFORGED' + 'x'.repeat(2000))
    store.propose(RUN, 2, { path: 'a.ts', oldText: 'a', newText: 'b' }, 'a')
    store.resolve(RUN, true)
    const pkgs = store.auditRecords(RUN).records.filter((r) => r.outcome.startsWith('package-'))
    expect(pkgs.map((r) => r.outcome)).toEqual(['package-rejected', 'package-accepted'])
    expect(pkgs[0].edits).toBe(1)
    expect(pkgs[0].reason).toContain('user said no')
    expect(pkgs[0].reason).not.toContain('\n')
    expect(pkgs[0].reason!.length).toBeLessThanOrEqual(500)
  })

  it('endRun(abandoned) clears pending, records the abandoned package and keeps the records readable', () => {
    store.propose(RUN, 1, { path: 'a.ts', oldText: 'a', newText: 'b' }, 'a')
    store.endRun(RUN, 'abandoned')
    expect(store.pending(RUN)).toEqual([])
    const { records } = store.auditRecords(RUN)
    expect(records.some((r) => r.outcome === 'package-abandoned' && r.edits === 1)).toBe(true)
    expect(records.some((r) => r.outcome === 'proposed')).toBe(true)
  })

  it('endRun on a run with nothing pending records no abandoned package', () => {
    store.propose(RUN, 1, { path: 'a.ts', oldText: 'a', newText: 'b' }, 'a')
    store.resolve(RUN, true)
    store.endRun(RUN, 'abandoned')
    expect(store.auditRecords(RUN).records.some((r) => r.outcome === 'package-abandoned')).toBe(false)
  })

  it('is bounded per run and says how much was dropped', () => {
    for (let i = 0; i < 1100; i++) {
      store.propose(RUN, i, { path: `f${i}.ts`, oldText: 'a', newText: 'b' }, 'a')
      store.resolve(RUN, true)
    }
    const { records, dropped } = store.auditRecords(RUN)
    expect(records.length).toBeLessThanOrEqual(1000)
    expect(dropped).toBeGreaterThan(0)
  })

  it('unknown run: empty', () => {
    expect(store.auditRecords('nobody')).toEqual({ records: [], dropped: 0 })
  })

  it('ordinary runs without proposals do not displace the records of a coding run', () => {
    // endRun is called in the `finally` of EVERY agent run, coding or not. A
    // run with nothing proposed used to take a slot in the retention of 50, so
    // 50 ordinary chats deleted the audit records of a coding run.
    store.propose(RUN, 1, { path: 'a.ts', oldText: 'a', newText: 'b' }, 'a')
    store.resolve(RUN, false, 'not this one')
    store.endRun(RUN, 'finished')
    expect(store.auditRecords(RUN).records.length).toBeGreaterThan(0)

    for (let i = 0; i < 60; i++) store.endRun(`plain-${i}`, 'finished')

    const { records } = store.auditRecords(RUN)
    expect(records.some((r) => r.outcome === 'proposed')).toBe(true)
    expect(records.some((r) => r.outcome === 'package-rejected')).toBe(true)
  })

  it('still refuses a straggler proposal for a run that ended long ago', () => {
    // The reason the empty entry existed: a late tool call must not start a
    // package for a run that is over. Dropping the entry would reopen that.
    store.endRun('ended-early', 'finished')
    for (let i = 0; i < 60; i++) store.endRun(`plain-${i}`, 'finished')
    const out = store.propose('ended-early', 1, { path: 'a.ts', oldText: 'a', newText: 'b' }, 'a')
    expect(out.kind).toBe('rejected')
    expect(store.pending('ended-early')).toEqual([])
  })

  it('a run WITH records is still bounded: the oldest of them is dropped', () => {
    // The cap on runs whose records are kept still exists; it now counts only
    // runs that have records.
    for (let i = 0; i < 60; i++) {
      store.propose(`r${i}`, 1, { path: 'a.ts', oldText: 'a', newText: 'b' }, 'a')
      store.endRun(`r${i}`, 'abandoned')
    }
    expect(store.auditRecords('r0').records).toEqual([])
    expect(store.auditRecords('r59').records.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

describe('mingly_edit_file handler: proposes, never writes', () => {
  it('proposes an edit without touching the file', async () => {
    const abs = write('a.ts', 'const a = 1\nconst b = 2\n')
    const before = fs.statSync(abs).mtimeMs
    const out = await edit({ path: 'a.ts', old: 'const a = 1', new: 'const a = 2' }, await ctxFor())
    expect(out).toMatch(/proposed/i)
    expect(fs.readFileSync(abs, 'utf8')).toBe('const a = 1\nconst b = 2\n')
    expect(fs.statSync(abs).mtimeMs).toBe(before)
    expect(store.pending(RUN)).toHaveLength(1)
    expect(store.pending(RUN)[0]).toMatchObject({
      path: 'a.ts',
      oldText: 'const a = 1',
      newText: 'const a = 2'
    })
  })

  it('returns the rejection reason to the agent as a tool result', async () => {
    write('a.ts', 'function a(){ return x }\nfunction b(){ return x }')
    const out = await edit({ path: 'a.ts', old: 'return x', new: 'return y' }, await ctxFor())
    expect(out).toMatch(/exactly once/i)
    expect(store.pending(RUN)).toHaveLength(0)
  })

  it('gives the same result for a text that is not in the file', async () => {
    write('a.ts', 'function a(){ return x }\nfunction b(){ return x }')
    write('b.ts', 'abc')
    const twice = await edit({ path: 'a.ts', old: 'return x', new: 'y' }, await ctxFor())
    const none = await edit({ path: 'b.ts', old: 'zzz', new: 'y' }, await ctxFor())
    expect(none).toBe(twice)
  })

  it('returns no file content: neither neighbouring lines nor the line number', async () => {
    write('a.ts', 'SECRET_BEFORE = 1\nconst a = 1\nSECRET_AFTER = 2\n')
    const out = await edit({ path: 'a.ts', old: 'const a = 1', new: 'const a = 2' }, await ctxFor())
    expect(out).not.toContain('SECRET_BEFORE')
    expect(out).not.toContain('SECRET_AFTER')
    // The human gets context in the stored diff; the model does not.
    expect(store.pending(RUN)[0].diff).toContain('SECRET_BEFORE')
  })

  it('keeps the line counts in the stored proposal and out of the model-visible text', async () => {
    write('a.ts', 'a\nb\nc\n')
    const out = await edit({ path: 'a.ts', old: 'b', new: 'b1\nb2' }, await ctxFor())
    expect(out).not.toMatch(/[0-9]/)
    expect(out).toMatch(/proposed/i)
    const [p] = store.pending(RUN)
    expect(p.removedLines).toBe(1)
    expect(p.addedLines).toBe(2)
  })

  it('the success text is identical whatever surrounds the match (end of file, before a newline, line start)', async () => {
    // Counts used to come out -1/+1, -0/+1 or -1/+2 depending on the structure around the match.
    write('end.ts', 'KEY=')
    write('nl.ts', 'KEY=\nrest\n')
    write('start.ts', 'x\nKEY=\nrest\n')
    const outs: string[] = []
    for (const f of ['end.ts', 'nl.ts', 'start.ts']) {
      outs.push(await edit({ path: f, old: 'KEY=', new: 'KEY=\n' }, await ctxFor()))
    }
    expect(new Set(outs).size).toBe(1)
  })

  it('stores the resolved real path, not the model spelling (alias link inside the project)', async () => {
    write('src/a.ts', 'let a = 1\n')
    fs.symlinkSync(path.join(project, 'src', 'a.ts'), path.join(project, 'alias.ts'))
    await edit({ path: 'alias.ts', old: 'let a = 1', new: 'let a = 2' }, await ctxFor())
    expect(store.pending(RUN).map((p) => p.path)).toEqual(['src/a.ts'])
  })

  it('same file under two spellings in one parallel step: one proposal, one rejection', async () => {
    write('a.ts', 'let a = 1\nlet b = 2\n')
    const ctx = await ctxFor()
    const results = await registry.executeToolCalls(
      [
        { id: 'p1', name: 'mingly_edit_file', arguments: { path: 'a.ts', old: 'let a = 1', new: 'let a = 9' } },
        { id: 'p2', name: 'mingly_edit_file', arguments: { path: './a.ts', old: 'let b = 2', new: 'let b = 9' } }
      ],
      ctx
    )
    const texts = results.map((r) => r.content)
    expect(texts.filter((t) => /proposed/i.test(t) && !/rejected/i.test(t))).toHaveLength(1)
    expect(texts.filter((t) => /rejected/i.test(t))).toHaveLength(1)
    expect(store.pending(RUN)).toHaveLength(1)
  })

  it('accepts an absolute path inside the project, as mingly_read_file does', async () => {
    write('a.ts', 'let a = 1\n')
    const out = await edit(
      { path: path.join(project, 'a.ts'), old: 'let a = 1', new: 'let a = 2' },
      await ctxFor()
    )
    expect(out).toMatch(/proposed/i)
    expect(store.pending(RUN)[0].path).toBe('a.ts')
  })
})

describe('mingly_edit_file handler: gate', () => {
  it('is not offered in read-only mode, and a direct call is refused as unknown', async () => {
    write('a.ts', 'x')
    const ctx = await ctxFor('read-only')
    expect(registry.getAvailableTools(ctx).map((t) => t.name)).not.toContain('mingly_edit_file')
    const out = await edit({ path: 'a.ts', old: 'x', new: 'y' }, ctx)
    expect(out).toMatch(/unknown tool/i)
    expect(store.pending(RUN)).toHaveLength(0)
  })

  it('is offered in propose and propose-run mode, not without context', async () => {
    expect(registry.getAvailableTools(await ctxFor('propose')).map((t) => t.name)).toContain('mingly_edit_file')
    expect(registry.getAvailableTools(await ctxFor('propose-run')).map((t) => t.name)).toContain('mingly_edit_file')
    expect(registry.getAvailableTools(undefined).map((t) => t.name)).not.toContain('mingly_edit_file')
    expect(registry.getAvailableTools(await ctxFor('off')).map((t) => t.name)).not.toContain('mingly_edit_file')
  })

  it('refuses a mode string outside the vocabulary', async () => {
    write('a.ts', 'x')
    const ctx = await ctxFor('propose')
    ctx.coding = { ...ctx.coding!, mode: 'auto' as unknown as CodingMode }
    expect(await edit({ path: 'a.ts', old: 'x', new: 'y' }, ctx)).toMatch(/unknown tool/i)
  })

  it('refuses when the grant lacks the edit permission', async () => {
    write('a.ts', 'x')
    grants = [grant({ permissions: ['read'] })]
    const out = await edit({ path: 'a.ts', old: 'x', new: 'y' }, await ctxFor())
    expect(out).toMatch(/refused/i)
    expect(store.pending(RUN)).toHaveLength(0)
  })

  it('refuses when the grant is gone', async () => {
    write('a.ts', 'x')
    grants = []
    expect(await edit({ path: 'a.ts', old: 'x', new: 'y' }, await ctxFor())).toMatch(/refused/i)
  })

  it('refuses without a run id or step number in the context (nothing to key the proposal on)', async () => {
    write('a.ts', 'x')
    const noRun = await ctxFor('propose', { runId: undefined })
    const noStep = await ctxFor('propose', { stepNumber: undefined })
    expect(await edit({ path: 'a.ts', old: 'x', new: 'y' }, noRun)).toMatch(/refused/i)
    expect(await edit({ path: 'a.ts', old: 'x', new: 'y' }, noStep)).toMatch(/refused/i)
    expect(store.pending(RUN)).toHaveLength(0)
  })
})

describe('mingly_edit_file handler: path discipline (same order as mingly_read_file)', () => {
  it('refuses a blocked name and leaves the file untouched', async () => {
    const abs = write('.env', 'KEY=1\n')
    const out = await edit({ path: '.env', old: 'KEY=1', new: 'KEY=2' }, await ctxFor())
    expect(out).toMatch(/refused/i)
    expect(fs.readFileSync(abs, 'utf8')).toBe('KEY=1\n')
    expect(store.pending(RUN)).toHaveLength(0)
  })

  it('refuses a path outside the grant, relative and absolute', async () => {
    fs.writeFileSync(path.join(outside, 'x.ts'), 'secret')
    const rel = await edit({ path: '../../../../../../etc/hosts', old: 'a', new: 'b' }, await ctxFor())
    const abs = await edit({ path: path.join(outside, 'x.ts'), old: 'secret', new: 'b' }, await ctxFor())
    expect(rel).toMatch(/refused/i)
    expect(abs).toMatch(/refused/i)
    expect(store.pending(RUN)).toHaveLength(0)
  })

  it('refuses a link that points outside the grant', async () => {
    fs.writeFileSync(path.join(outside, 'x.ts'), 'secret')
    fs.symlinkSync(path.join(outside, 'x.ts'), path.join(project, 'link.ts'))
    const out = await edit({ path: 'link.ts', old: 'secret', new: 'b' }, await ctxFor())
    expect(out).toMatch(/refused/i)
    expect(store.pending(RUN)).toHaveLength(0)
  })

  it('refuses a link inside the project whose TARGET is blocked (second pass on the real path)', async () => {
    write('.env', 'KEY=1\n')
    fs.symlinkSync(path.join(project, '.env'), path.join(project, 'config.ts'))
    const out = await edit({ path: 'config.ts', old: 'KEY=1', new: 'KEY=2' }, await ctxFor())
    expect(out).toMatch(/refused/i)
    expect(store.pending(RUN)).toHaveLength(0)
  })

  it('refuses a link whose target is a blocked DATA name with a readable extension (secrets.json)', async () => {
    // .env alone would not prove the second blocklist pass: its extension is
    // unreadable, so the extension check refuses it anyway. secrets.json is only
    // stopped by the blocklist on the resolved real path.
    const abs = write('secrets.json', '{"k": 1}\n')
    fs.symlinkSync(abs, path.join(project, 'settings.ts'))
    const out = await edit({ path: 'settings.ts', old: '"k": 1', new: '"k": 2' }, await ctxFor())
    expect(out).toMatch(/refused/i)
    expect(fs.readFileSync(abs, 'utf8')).toBe('{"k": 1}\n')
    expect(store.pending(RUN)).toHaveLength(0)
  })

  it('refuses a blocked NAME even when the link behind it is harmless (first pass, on the path as given)', async () => {
    // Only the name check on the model's own string stops this: the resolved
    // target (ok.json) is perfectly editable.
    const abs = write('ok.json', '{"k": 1}\n')
    fs.symlinkSync(abs, path.join(project, 'secrets.json'))
    const out = await edit({ path: 'secrets.json', old: '"k": 1', new: '"k": 2' }, await ctxFor())
    expect(out).toMatch(/refused/i)
    expect(store.pending(RUN)).toHaveLength(0)
  })

  it('refuses a link that reaches a MULTI-segment blocked pattern (.docker/config.json)', async () => {
    const abs = write('.docker/config.json', '{"auth": 1}\n')
    fs.symlinkSync(abs, path.join(project, 'cfg.ts'))
    const out = await edit({ path: 'cfg.ts', old: '"auth": 1', new: '"auth": 2' }, await ctxFor())
    expect(out).toMatch(/refused/i)
    expect(store.pending(RUN)).toHaveLength(0)
  })

  it('refuses a link whose target has an unreadable extension, with the uniform text', async () => {
    write('data.bin', 'KEY=1\n')
    fs.symlinkSync(path.join(project, 'data.bin'), path.join(project, 'thing.ts'))
    const viaLink = await edit({ path: 'thing.ts', old: 'KEY=1', new: 'x' }, await ctxFor())
    const missing = await edit({ path: 'nope-dir/missing.ts', old: 'a', new: 'x' }, await ctxFor())
    expect(viaLink).toBe(missing)
  })

  it('existence oracle: a dangling link, an outside link and a missing file get the SAME refusal', async () => {
    fs.writeFileSync(path.join(outside, 'x.ts'), 'secret')
    fs.symlinkSync(path.join(outside, 'x.ts'), path.join(project, 'outside.ts'))
    fs.symlinkSync(path.join(project, 'nowhere.ts'), path.join(project, 'dangling.ts'))
    const a = await edit({ path: 'outside.ts', old: 'secret', new: 'x' }, await ctxFor())
    const b = await edit({ path: 'dangling.ts', old: 'secret', new: 'x' }, await ctxFor())
    const c = await edit({ path: 'missing.ts', old: 'secret', new: 'x' }, await ctxFor())
    expect(a).toBe(b)
    expect(b).toBe(c)
  })

  it('a refusal that depends only on the model string may differ: unreadable extension', async () => {
    const out = await edit({ path: 'photo.png', old: 'a', new: 'b' }, await ctxFor())
    expect(out).toMatch(/file type/i)
  })

  it('refuses a binary file', async () => {
    write('a.ts', Buffer.from([0x61, 0x00, 0x62, 0x00, 0x63]))
    const out = await edit({ path: 'a.ts', old: 'a', new: 'b' }, await ctxFor())
    expect(out).toMatch(/refused/i)
    expect(store.pending(RUN)).toHaveLength(0)
  })

  it('refuses a file that is not valid UTF-8 (writing it back would corrupt it)', async () => {
    write('a.ts', Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x3d, 0x20, 0x31]))
    const out = await edit({ path: 'a.ts', old: 'caf', new: 'cafe' }, await ctxFor())
    expect(out).toMatch(/refused/i)
    expect(store.pending(RUN)).toHaveLength(0)
  })

  it('refuses a directory', async () => {
    fs.mkdirSync(path.join(project, 'dir.ts'))
    expect(await edit({ path: 'dir.ts', old: 'a', new: 'b' }, await ctxFor())).toMatch(/refused/i)
  })

  it('refuses a file over the size limit', async () => {
    write('big.ts', 'a'.repeat(2 * 1024 * 1024 + 1))
    expect(await edit({ path: 'big.ts', old: 'a', new: 'b' }, await ctxFor())).toMatch(/refused|too large/i)
  })
})

describe('mingly_edit_file handler: the .mingly workspace is read yes, write no', () => {
  const WS_FILE = '.mingly/context/run1/result.json'

  it('refuses a proposal inside .mingly/ and leaves the file untouched', async () => {
    const abs = write(WS_FILE, '{"k": 1}\n')
    const out = await edit({ path: WS_FILE, old: '"k": 1', new: '"k": 2' }, await ctxFor())
    expect(out).toMatch(/refused/i)
    expect(out).toMatch(/\.mingly|workspace/i)
    expect(fs.readFileSync(abs, 'utf8')).toBe('{"k": 1}\n')
    expect(store.pending(RUN)).toHaveLength(0)
  })

  it('refuses the snapshot area, which holds the undo path itself', async () => {
    write('.mingly/snapshots/run1/batch-1/manifest.json', '{"files": []}\n')
    const out = await edit(
      { path: '.mingly/snapshots/run1/batch-1/manifest.json', old: '"files": []', new: '"files": ["x"]' },
      await ctxFor()
    )
    expect(out).toMatch(/refused/i)
    expect(store.pending(RUN)).toHaveLength(0)
  })

  it.each([
    ['dot segment', './.mingly/context/run1/result.json'],
    ['parent segment', 'src/../.mingly/context/run1/result.json'],
    ['upper case', '.MINGLY/context/run1/result.json'],
    ['absolute inside the project', '__ABS__/.mingly/context/run1/result.json']
  ])('refuses the same file by a different spelling: %s', async (_n, spelling) => {
    write(WS_FILE, '{"k": 1}\n')
    const p = spelling.replace('__ABS__', project)
    const out = await edit({ path: p, old: '"k": 1', new: '"k": 2' }, await ctxFor())
    expect(out).toMatch(/refused/i)
    expect(store.pending(RUN)).toHaveLength(0)
  })

  it('refuses a link inside the project that RESOLVES into .mingly/ (only the second pass sees it)', async () => {
    const abs = write(WS_FILE, '{"k": 1}\n')
    fs.symlinkSync(abs, path.join(project, 'innocent.json'))
    const out = await edit({ path: 'innocent.json', old: '"k": 1', new: '"k": 2' }, await ctxFor())
    expect(out).toMatch(/refused/i)
    expect(fs.readFileSync(abs, 'utf8')).toBe('{"k": 1}\n')
    expect(store.pending(RUN)).toHaveLength(0)
  })

  it('the resolved-path refusal is the uniform one: same text as a missing file (no probe for link targets)', async () => {
    const abs = write(WS_FILE, '{"k": 1}\n')
    fs.symlinkSync(abs, path.join(project, 'innocent.json'))
    const viaLink = await edit({ path: 'innocent.json', old: 'a', new: 'b' }, await ctxFor())
    const missing = await edit({ path: 'nothing.json', old: 'a', new: 'b' }, await ctxFor())
    expect(viaLink).toBe(missing)
  })

  it('leaves ordinary files alone, including names that only start like the workspace', async () => {
    write('src/a.ts', 'let a = 1\n')
    write('.minglyx/a.ts', 'let a = 1\n')
    write('.mingly-notes.ts', 'let a = 1\n')
    write('src/.mingly/a.ts', 'let a = 1\n') // not at the project root: not the workspace
    for (const f of ['src/a.ts', '.minglyx/a.ts', '.mingly-notes.ts', 'src/.mingly/a.ts']) {
      const ctx = await ctxFor()
      const out = await edit({ path: f, old: 'let a = 1', new: 'let a = 2' }, ctx)
      expect(out, f).toMatch(/proposed/i)
    }
  })

  it('neither refusal consumes the per-path failure cap or leaves an audit record', async () => {
    const abs = write(WS_FILE, '{"k": 1}\n')
    fs.symlinkSync(abs, path.join(project, 'innocent.json'))
    const ctx = await ctxFor()
    for (let i = 0; i < EDIT_MAX_FAILED_ATTEMPTS_PER_PATH * 3; i++) {
      await edit({ path: WS_FILE, old: '"k": 1', new: 'x' }, ctx)
      await edit({ path: 'innocent.json', old: '"k": 1', new: 'x' }, ctx)
    }
    expect(store.auditRecords(RUN).records).toEqual([])
    // and no lockout happened: an ordinary proposal still works
    write('ok.json', '{"k": 1}\n')
    expect(await edit({ path: 'ok.json', old: '"k": 1', new: 'x' }, ctx)).toMatch(/proposed/i)
  })

  it('does not reach the store at all (decided before the file is read)', async () => {
    write(WS_FILE, '{"k": 1}\n')
    const spy = vi.spyOn(store, 'propose')
    const pre = vi.spyOn(store, 'precheck')
    await edit({ path: WS_FILE, old: '"k": 1', new: 'x' }, await ctxFor())
    expect(spy).not.toHaveBeenCalled()
    expect(pre).not.toHaveBeenCalled()
  })

  it('mingly_read_file STILL reads the workspace: compaction externalises results there and tells the model to read them back', async () => {
    write(WS_FILE, '{"externalized": true}\n')
    const result = await registry.executeTool(
      { id: 'r1', name: 'mingly_read_file', arguments: { path: WS_FILE } },
      await ctxFor('read-only')
    )
    expect(result.content).toContain('externalized')
  })
})

describe('mingly_edit_file handler: arguments fail closed', () => {
  it.each([
    ['missing path', { old: 'a', new: 'b' }],
    ['missing old', { path: 'a.ts', new: 'b' }],
    ['missing new', { path: 'a.ts', old: 'a' }],
    ['non-string old', { path: 'a.ts', old: 1, new: 'b' }],
    ['non-string new', { path: 'a.ts', old: 'a', new: { x: 1 } }],
    ['empty path', { path: '', old: 'a', new: 'b' }],
    ['empty old', { path: 'a.ts', old: '', new: 'b' }]
  ])('%s: refuses and records nothing', async (_name, args) => {
    const abs = write('a.ts', 'abc')
    const out = await edit(args as Record<string, unknown>, await ctxFor())
    expect(out).toMatch(/refused|must|rejected/i)
    expect(fs.readFileSync(abs, 'utf8')).toBe('abc')
    expect(store.pending(RUN)).toHaveLength(0)
  })

  it('accepts an empty new text (a deletion)', async () => {
    write('a.ts', 'keep\ngone\n')
    const out = await edit({ path: 'a.ts', old: 'gone\n', new: '' }, await ctxFor())
    expect(out).toMatch(/proposed/i)
  })

  it('rejects an oversized replacement text', async () => {
    write('a.ts', 'abc')
    const out = await edit({ path: 'a.ts', old: 'abc', new: 'x'.repeat(2 * 1024 * 1024) }, await ctxFor())
    expect(out).toMatch(/refused|rejected|too large/i)
    expect(store.pending(RUN)).toHaveLength(0)
  })
})
