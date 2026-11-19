/**
 * edit_file as a proposal (Task 10).
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
import { ToolRegistry, type ToolContext } from '../../src/main/agent/tool-registry'
import { registerReadTools } from '../../src/main/coding/read-tools'
import {
  registerEditTools,
  createEditProposalStore,
  getEditProposalStore,
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
  const result = await registry.executeTool({ id: 't1', name: 'edit_file', arguments: args }, ctx)
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

  it('rejects an old text that occurs twice and says how often', () => {
    const out = store.propose(RUN, 1, base, 'function a(){ return x }\nfunction b(){ return x }')
    expect(out).toEqual({ kind: 'rejected', reason: expect.stringContaining('2') })
    expect(store.pending(RUN)).toHaveLength(0)
  })

  it('rejects an old text that does not occur', () => {
    const out = store.propose(RUN, 1, base, 'nothing to see here')
    expect(out).toEqual({ kind: 'rejected', reason: expect.stringContaining('0') })
    expect(store.pending(RUN)).toHaveLength(0)
  })

  it('counts overlapping occurrences: "aa" in "aaa" is ambiguous', () => {
    const out = store.propose(RUN, 1, { path: 'a.ts', oldText: 'aa', newText: 'b' }, 'aaa')
    expect(out).toEqual({ kind: 'rejected', reason: expect.stringContaining('2') })
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

  it('allows a second proposal for the same path in the NEXT step', () => {
    const content = 'let a = 1\nlet b = 2\n'
    store.propose(RUN, 1, { path: 'a.ts', oldText: 'let a = 1', newText: 'let a = 9' }, content)
    const next = store.propose(RUN, 2, { path: 'a.ts', oldText: 'let b = 2', newText: 'let b = 9' }, content)
    expect(next.kind).toBe('proposed')
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

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

describe('edit_file handler: proposes, never writes', () => {
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
    expect(out).toMatch(/occurs 2 times/i)
    expect(store.pending(RUN)).toHaveLength(0)
  })

  it('says "occurs 0 times" for a text that is not in the file', async () => {
    write('a.ts', 'abc')
    const out = await edit({ path: 'a.ts', old: 'zzz', new: 'y' }, await ctxFor())
    expect(out).toMatch(/occurs 0 times/i)
  })

  it('returns no file content: neither neighbouring lines nor the line number', async () => {
    write('a.ts', 'SECRET_BEFORE = 1\nconst a = 1\nSECRET_AFTER = 2\n')
    const out = await edit({ path: 'a.ts', old: 'const a = 1', new: 'const a = 2' }, await ctxFor())
    expect(out).not.toContain('SECRET_BEFORE')
    expect(out).not.toContain('SECRET_AFTER')
    // The human gets context in the stored diff; the model does not.
    expect(store.pending(RUN)[0].diff).toContain('SECRET_BEFORE')
  })

  it('reports the line counts of the proposal', async () => {
    write('a.ts', 'a\nb\nc\n')
    const out = await edit({ path: 'a.ts', old: 'b', new: 'b1\nb2' }, await ctxFor())
    expect(out).toMatch(/-1/)
    expect(out).toMatch(/\+2/)
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
        { id: 'p1', name: 'edit_file', arguments: { path: 'a.ts', old: 'let a = 1', new: 'let a = 9' } },
        { id: 'p2', name: 'edit_file', arguments: { path: './a.ts', old: 'let b = 2', new: 'let b = 9' } }
      ],
      ctx
    )
    const texts = results.map((r) => r.content)
    expect(texts.filter((t) => /proposed/i.test(t) && !/rejected/i.test(t))).toHaveLength(1)
    expect(texts.filter((t) => /rejected/i.test(t))).toHaveLength(1)
    expect(store.pending(RUN)).toHaveLength(1)
  })

  it('accepts an absolute path inside the project, as read_file does', async () => {
    write('a.ts', 'let a = 1\n')
    const out = await edit(
      { path: path.join(project, 'a.ts'), old: 'let a = 1', new: 'let a = 2' },
      await ctxFor()
    )
    expect(out).toMatch(/proposed/i)
    expect(store.pending(RUN)[0].path).toBe('a.ts')
  })
})

describe('edit_file handler: gate', () => {
  it('is not offered in read-only mode, and a direct call is refused as unknown', async () => {
    write('a.ts', 'x')
    const ctx = await ctxFor('read-only')
    expect(registry.getAvailableTools(ctx).map((t) => t.name)).not.toContain('edit_file')
    const out = await edit({ path: 'a.ts', old: 'x', new: 'y' }, ctx)
    expect(out).toMatch(/unknown tool/i)
    expect(store.pending(RUN)).toHaveLength(0)
  })

  it('is offered in propose and propose-run mode, not without context', async () => {
    expect(registry.getAvailableTools(await ctxFor('propose')).map((t) => t.name)).toContain('edit_file')
    expect(registry.getAvailableTools(await ctxFor('propose-run')).map((t) => t.name)).toContain('edit_file')
    expect(registry.getAvailableTools(undefined).map((t) => t.name)).not.toContain('edit_file')
    expect(registry.getAvailableTools(await ctxFor('off')).map((t) => t.name)).not.toContain('edit_file')
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

describe('edit_file handler: path discipline (same order as read_file)', () => {
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

describe('edit_file handler: arguments fail closed', () => {
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
