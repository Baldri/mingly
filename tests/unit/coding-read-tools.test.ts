/**
 * mingly_list_files / mingly_read_file (Task 9).
 *
 * The tools are exercised through ToolRegistry.executeTool, so the gate and
 * the handler run exactly as they do in a coding run. Grants and workspace
 * are injected; the files are real, in a real temp directory.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { ToolRegistry, type ToolContext } from '../../src/main/agent/tool-registry'
import {
  registerReadTools,
  originForToolCall,
  LIST_FILES_MAX_ENTRIES
} from '../../src/main/coding/read-tools'
import { ensureProjectWorkspace } from '../../src/main/coding/project-workspace'
import type { AllowedDirectory } from '../../src/shared/file-access-types'
import type { CodingMode } from '../../src/shared/coding-types'

vi.mock('../../src/main/mcp/mcp-client-manager', () => ({
  getMCPClientManager: vi.fn(() => ({ listAllTools: vi.fn().mockReturnValue([]) }))
}))

let project: string
let registry: ToolRegistry
let grants: AllowedDirectory[]
let outside: string

function grant(overrides: Partial<AllowedDirectory> = {}): AllowedDirectory {
  return {
    id: 'dir-1',
    path: project,
    name: 'p',
    location: 'local',
    permissions: ['read'],
    recursive: true,
    grantedAt: 1,
    confirmedAt: 1,
    ...overrides
  }
}

async function ctxFor(mode: CodingMode = 'read-only', runId = 'run1'): Promise<ToolContext> {
  const workspace = await ensureProjectWorkspace(project, runId)
  return { coding: { directoryId: 'dir-1', projectPath: project, mode }, workspace }
}

async function call(
  name: string,
  args: Record<string, unknown>,
  ctx?: ToolContext
): Promise<string> {
  const result = await registry.executeTool({ id: 't1', name, arguments: args }, ctx)
  return result.content
}

function write(rel: string, content: string | Buffer): void {
  const full = path.join(project, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
}

beforeEach(() => {
  project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mingly-read-tools-')))
  outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mingly-read-outside-')))
  grants = [grant()]
  registry = new ToolRegistry({ toolTimeoutMs: 5000, maxResultChars: 1_000_000 })
  registerReadTools(registry, { findGrant: async (id) => grants.find((g) => g.id === id) })
})

afterEach(() => {
  fs.rmSync(project, { recursive: true, force: true })
  fs.rmSync(outside, { recursive: true, force: true })
})

describe('mingly_read_file', () => {
  it('reads a file inside the grant', async () => {
    write('src/a.ts', 'const a = 1\nconst b = 2\n')
    const out = await call('mingly_read_file', { path: 'src/a.ts' }, await ctxFor())
    expect(out).toContain('const a = 1')
    expect(out).toContain('const b = 2')
  })

  it('honours offset and limit and says that the read stopped', async () => {
    write('big.ts', Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n'))
    const out = await call('mingly_read_file', { path: 'big.ts', offset: 3, limit: 2 }, await ctxFor())
    expect(out).toContain('line3')
    expect(out).toContain('line4')
    expect(out).not.toContain('line5')
    expect(out).not.toContain('line2')
    expect(out).toMatch(/more lines|truncated|offset/i)
  })

  it('refuses a path outside the grant', async () => {
    const out = await call('mingly_read_file', { path: '../../../../../../etc/passwd' }, await ctxFor())
    expect(out).toMatch(/refused/i)
    expect(out).not.toContain('root:')
  })

  it('refuses an absolute path outside the project', async () => {
    fs.writeFileSync(path.join(outside, 'x.ts'), 'outside-secret-content')
    const out = await call('mingly_read_file', { path: path.join(outside, 'x.ts') }, await ctxFor())
    expect(out).toMatch(/refused/i)
    expect(out).not.toContain('outside-secret-content')
  })

  it('refuses a symlink that points outside the grant', async () => {
    fs.writeFileSync(path.join(outside, 'passwd.ts'), 'outside-secret-content')
    fs.symlinkSync(outside, path.join(project, 'out'))
    const out = await call('mingly_read_file', { path: 'out/passwd.ts' }, await ctxFor())
    expect(out).toMatch(/refused/i)
    expect(out).not.toContain('outside-secret-content')
  })

  it('refuses a blocklisted file even in read-only mode', async () => {
    write('.env', 'API_KEY=hunter2-value')
    const out = await call('mingly_read_file', { path: '.env' }, await ctxFor())
    expect(out).toMatch(/refused/i)
    expect(out).not.toContain('hunter2-value')
  })

  it('refuses a symlink named config.ts that points at .env INSIDE the grant (second blocklist pass)', async () => {
    write('.env', 'API_KEY=hunter2-value')
    fs.mkdirSync(path.join(project, 'src'))
    fs.symlinkSync('../.env', path.join(project, 'src', 'config.ts'))
    const out = await call('mingly_read_file', { path: 'src/config.ts' }, await ctxFor())
    expect(out).toMatch(/refused/i)
    expect(out).not.toContain('hunter2-value')
  })

  it('refuses config.ts -> .env.ts: readable extension on both names, so ONLY the second blocklist pass can stop it', async () => {
    // `.env` alone is also stopped by the extension check, which would hide a
    // missing second pass. `.env.ts` is blocked by name yet ends in a readable
    // extension.
    write('.env.ts', 'export const KEY = "hunter2-value"')
    fs.mkdirSync(path.join(project, 'src'))
    fs.symlinkSync('../.env.ts', path.join(project, 'src', 'config.ts'))
    const out = await call('mingly_read_file', { path: 'src/config.ts' }, await ctxFor())
    expect(out).toMatch(/refused/i)
    expect(out).not.toContain('hunter2-value')
  })

  it('refuses a link whose target is a blocked DATA name that only FOLDS to an exempt one', async () => {
    // `secrets.ts.` is a data file named secrets, not the module the code
    // exemption exists for. The second blocklist pass must see the name as the
    // filesystem spells it: handed the folded form it reads `secrets.ts` and
    // exempts the very payload this check is for.
    write('secrets.ts.', 'export const KEY = "folded-secret-value"')
    fs.symlinkSync('secrets.ts.', path.join(project, 'notes.ts'))
    const out = await call('mingly_read_file', { path: 'notes.ts' }, await ctxFor())
    expect(out).toMatch(/refused/i)
    expect(out).not.toContain('folded-secret-value')
    // Positive control: a link to the real module still reads.
    write('secrets.ts', 'export const KEY = "module-value"')
    fs.symlinkSync('secrets.ts', path.join(project, 'alias.ts'))
    expect(await call('mingly_read_file', { path: 'alias.ts' }, await ctxFor())).toContain('module-value')
  })

  it('refuses a link whose target is a blocked DATA name (secrets.json, credentials.json)', async () => {
    write('secrets.json', '{"k":"secret-data-value"}')
    write('credentials.json', '{"k":"cred-data-value"}')
    fs.symlinkSync('secrets.json', path.join(project, 'config.json'))
    fs.symlinkSync('credentials.json', path.join(project, 'plain.json'))
    const ctx = await ctxFor()
    for (const name of ['config.json', 'plain.json']) {
      const out = await call('mingly_read_file', { path: name }, ctx)
      expect(out).toMatch(/refused/i)
      expect(out).not.toContain('data-value')
    }
  })

  it('refuses a link that reaches a MULTI-segment blocked pattern (.docker/config.json)', async () => {
    write('.docker/config.json', '{"auth":"docker-auth-value"}')
    fs.symlinkSync('.docker/config.json', path.join(project, 'dc.json'))
    const out = await call('mingly_read_file', { path: 'dc.json' }, await ctxFor())
    expect(out).toMatch(/refused/i)
    expect(out).not.toContain('docker-auth-value')
  })

  it('answers a dangling link and a link to an existing outside file IDENTICALLY (no existence oracle)', async () => {
    fs.writeFileSync(path.join(outside, 'o.ts'), 'x')
    fs.writeFileSync(path.join(outside, 'o.xyz'), 'x')
    fs.symlinkSync(path.join(outside, 'o.ts'), path.join(project, 'exists.ts'))
    fs.symlinkSync(path.join(outside, 'gone', 'nowhere.ts'), path.join(project, 'dangling.ts'))
    fs.symlinkSync(path.join(outside, 'o.xyz'), path.join(project, 'exists.xyz'))
    fs.symlinkSync(path.join(outside, 'gone', 'nowhere.xyz'), path.join(project, 'dangling.xyz'))
    const ctx = await ctxFor()
    const a = await call('mingly_read_file', { path: 'exists.ts' }, ctx)
    const b = await call('mingly_read_file', { path: 'dangling.ts' }, ctx)
    const c = await call('mingly_read_file', { path: 'exists.xyz' }, ctx)
    const d = await call('mingly_read_file', { path: 'dangling.xyz' }, ctx)
    expect(b).toBe(a)
    expect(d).toBe(c)
  })

  it('refuses a symlinked DIRECTORY that leads into a blocked directory inside the grant', async () => {
    write('.git/hooks/x.ts', 'hook-content')
    fs.symlinkSync('.git', path.join(project, 'g'))
    const out = await call('mingly_read_file', { path: 'g/hooks/x.ts' }, await ctxFor())
    expect(out).toMatch(/refused/i)
    expect(out).not.toContain('hook-content')
  })

  it('gives the same answer for a blocked, an outside and a missing-grant path (reveals nothing)', async () => {
    write('.env', 'x=1')
    const ctx = await ctxFor()
    const blocked = await call('mingly_read_file', { path: '.env' }, ctx)
    const nested = await call('mingly_read_file', { path: 'nope/.env' }, ctx)
    const outsidePath = await call('mingly_read_file', { path: '../x.ts' }, ctx)
    expect(nested).toBe(blocked)
    expect(outsidePath).toBe(blocked)
  })

  it('refuses a binary file whose extension is on the read list (a lying extension)', async () => {
    // NOT .png: CODING_READ_EXTENSIONS does not contain it (the brief assumed
    // the older ALLOWED_READ_EXTENSIONS list). A binary under an allowed name:
    write('logo.ts', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]))
    write('blob.json', Buffer.from([0x7b, 0x00, 0x7d]))
    const ctx = await ctxFor()
    for (const name of ['logo.ts', 'blob.json']) {
      const out = await call('mingly_read_file', { path: name }, ctx)
      expect(out).toMatch(/binary/i)
      expect(out).not.toContain('\u0000')
    }
  })

  it('refuses a real image by type', async () => {
    write('logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]))
    const out = await call('mingly_read_file', { path: 'logo.png' }, await ctxFor())
    expect(out).toMatch(/file type/i)
    expect(out).not.toContain('\u0000')
  })

  it('refuses a file with an extension that is not on the read list', async () => {
    write('data.xyz', 'hello')
    const out = await call('mingly_read_file', { path: 'data.xyz' }, await ctxFor())
    expect(out).toMatch(/not readable|not on the read list|file type/i)
    expect(out).not.toContain('hello')
  })

  it('refuses a symlink whose NAME is readable but whose TARGET has an unreadable extension', async () => {
    write('real.xyz', 'target-content')
    fs.symlinkSync('real.xyz', path.join(project, 'looks-fine.ts'))
    const out = await call('mingly_read_file', { path: 'looks-fine.ts' }, await ctxFor())
    expect(out).not.toContain('target-content')
  })

  it('a link whose TARGET has an unreadable extension gets the generic refusal, not the bad-type one', async () => {
    // Inside the grant, so no leak either way; the point is the branch is pinned.
    write('data.xyz', 'target-content')
    fs.symlinkSync('data.xyz', path.join(project, 'harmless.ts'))
    fs.symlinkSync(path.join(outside, 'gone', 'x.ts'), path.join(project, 'dangling.ts'))
    const ctx = await ctxFor()
    const out = await call('mingly_read_file', { path: 'harmless.ts' }, ctx)
    expect(out).toBe(await call('mingly_read_file', { path: 'dangling.ts' }, ctx))
    expect(out).not.toMatch(/file type/i)
    expect(out).not.toContain('target-content')
  })

  it('refuses a directory', async () => {
    fs.mkdirSync(path.join(project, 'dir.ts'))
    const out = await call('mingly_read_file', { path: 'dir.ts' }, await ctxFor())
    expect(out).toMatch(/refused|cannot be read|not a regular file/i)
  })

  it('refuses a file it cannot read (fail closed, no detail)', async () => {
    write('locked.ts', 'locked-content')
    fs.chmodSync(path.join(project, 'locked.ts'), 0o000)
    try {
      const out = await call('mingly_read_file', { path: 'locked.ts' }, await ctxFor())
      expect(out).not.toContain('locked-content')
      expect(out).not.toMatch(/EACCES|permission denied/i)
    } finally {
      fs.chmodSync(path.join(project, 'locked.ts'), 0o600)
    }
  })

  it('refuses a missing file without an errno detail', async () => {
    const out = await call('mingly_read_file', { path: 'missing.ts' }, await ctxFor())
    expect(out).not.toMatch(/ENOENT/)
    expect(out).toMatch(/cannot be read|refused/i)
  })

  it('refuses without a grant for the directory id', async () => {
    write('a.ts', 'content-a')
    grants = []
    const out = await call('mingly_read_file', { path: 'a.ts' }, await ctxFor())
    expect(out).toMatch(/refused/i)
    expect(out).not.toContain('content-a')
  })

  it('refuses when the grant has no read permission', async () => {
    write('a.ts', 'content-a')
    grants = [grant({ permissions: ['create'] })]
    const out = await call('mingly_read_file', { path: 'a.ts' }, await ctxFor())
    expect(out).toMatch(/refused/i)
    expect(out).not.toContain('content-a')
  })

  it('refuses when the project path is not inside the grant', async () => {
    write('a.ts', 'content-a')
    grants = [grant({ path: outside })]
    const out = await call('mingly_read_file', { path: 'a.ts' }, await ctxFor())
    expect(out).toMatch(/refused/i)
    expect(out).not.toContain('content-a')
  })

  it('refuses when the context carries no workspace (fail closed)', async () => {
    write('a.ts', 'content-a')
    const ctx: ToolContext = { coding: { directoryId: 'dir-1', projectPath: project, mode: 'read-only' } }
    const out = await call('mingly_read_file', { path: 'a.ts' }, ctx)
    expect(out).toMatch(/refused/i)
    expect(out).not.toContain('content-a')
  })

  it('refuses non-string and empty paths', async () => {
    const ctx = await ctxFor()
    expect(await call('mingly_read_file', { path: 42 }, ctx)).toMatch(/refused/i)
    expect(await call('mingly_read_file', { path: '' }, ctx)).toMatch(/refused/i)
    expect(await call('mingly_read_file', {}, ctx)).toMatch(/refused/i)
  })

  it('opens an externalized result under .mingly/context through a SYMLINKED project path', async () => {
    // macOS: /var -> /private/var. Here an explicit link makes the two forms
    // differ on every platform.
    const link = path.join(outside, 'project-link')
    fs.symlinkSync(project, link)
    grants = [grant({ path: link })]
    const workspace = await ensureProjectWorkspace(link, 'run-sym')
    // The executor-side path is path.resolve, NOT realpath: it goes through the link.
    expect(workspace.contextDir.startsWith(link)).toBe(true)
    const file = path.join(workspace.contextDir, 'tc-1.txt')
    fs.writeFileSync(file, 'externalized-body')
    const ctx: ToolContext = {
      coding: { directoryId: 'dir-1', projectPath: link, mode: 'read-only' },
      workspace
    }
    // The compaction text hands the model the ABSOLUTE path; use it verbatim.
    const out = await call('mingly_read_file', { path: file }, ctx)
    expect(out).toContain('externalized-body')
    // And the relative spelling.
    const rel = await call('mingly_read_file', { path: path.relative(link, file) }, ctx)
    expect(rel).toContain('externalized-body')
  })

  it('the workspace the handler sees is the instance the caller passed, no second ensureProjectWorkspace', async () => {
    write('a.ts', 'content-a')
    const ctx = await ctxFor('read-only', 'only-run')
    const before = fs.readdirSync(path.join(project, '.mingly', 'context'))
    await call('mingly_read_file', { path: 'a.ts' }, ctx)
    await call('mingly_list_files', {}, ctx)
    // A handler that made its own workspace would have needed a run id of its
    // own; nothing new may appear next to the caller's.
    expect(fs.readdirSync(path.join(project, '.mingly', 'context'))).toEqual(before)
    expect(before).toEqual(['only-run'])
  })
})

describe('mingly_read_file result budget', () => {
  const BUDGET = 400
  let small: ToolRegistry

  beforeEach(() => {
    small = new ToolRegistry({ toolTimeoutMs: 5000, maxResultChars: BUDGET })
    registerReadTools(small, { findGrant: async (id) => grants.find((g) => g.id === id) })
  })

  async function readSmall(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    return (await small.executeTool({ id: 't', name: 'mingly_read_file', arguments: args }, ctx)).content
  }

  it('pages a file larger than the budget with no gap, no repetition, and a present, correct hint every time', async () => {
    const lines = Array.from({ length: 120 }, (_, i) => `line-${String(i + 1).padStart(3, '0')} ${'x'.repeat(20)}`)
    write('long.ts', lines.join('\n'))
    const ctx = await ctxFor()
    const received: string[] = []
    let offset = 1
    let calls = 0
    for (;;) {
      calls++
      expect(calls).toBeLessThan(200)
      const out = await readSmall({ path: 'long.ts', offset }, ctx)
      expect(out.length).toBeLessThanOrEqual(BUDGET)
      expect(out).not.toContain('[truncated]')
      const hint = /\n\[showing lines (\d+)-(\d+) of (\d+); (\d+) more lines; continue with offset=(\d+)\]$/.exec(out)
      const body = hint ? out.slice(0, hint.index) : out
      const got = body.split('\n')
      received.push(...got)
      if (!hint) break
      expect(Number(hint[1])).toBe(offset)
      expect(Number(hint[2])).toBe(offset + got.length - 1)
      expect(Number(hint[3])).toBe(120)
      expect(Number(hint[4])).toBe(120 - (offset + got.length - 1))
      expect(Number(hint[5])).toBe(offset + got.length)
      offset = Number(hint[5])
    }
    expect(calls).toBeGreaterThan(1)
    expect(received).toEqual(lines)
  })

  it('a file ending in a newline: no phantom last line, the final call is not empty', async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `row-${String(i + 1).padStart(2, '0')} ${'y'.repeat(20)}`)
    write('nl.ts', lines.join('\n') + '\n')
    const ctx = await ctxFor()
    const received: string[] = []
    let offset = 1
    for (let calls = 0; ; calls++) {
      expect(calls).toBeLessThan(100)
      const out = await readSmall({ path: 'nl.ts', offset }, ctx)
      expect(out).not.toBe('')
      const hint = /\n\[showing lines (\d+)-(\d+) of (\d+); (\d+) more lines; continue with offset=(\d+)\]$/.exec(out)
      received.push(...(hint ? out.slice(0, hint.index) : out).split('\n'))
      if (!hint) break
      expect(Number(hint[3])).toBe(30)
      offset = Number(hint[5])
    }
    expect(received).toEqual(lines)
    // small file, whole read: no hint at all
    write('tiny.ts', 'one\ntwo\n')
    expect(await readSmall({ path: 'tiny.ts' }, ctx)).toBe('one\ntwo')
  })

  it('says explicitly when a single line exceeds the budget, and names the offset that skips it', async () => {
    write('wide.ts', ['short', 'y'.repeat(BUDGET * 3), 'after'].join('\n'))
    const ctx = await ctxFor()
    const out = await readSmall({ path: 'wide.ts', offset: 2 }, ctx)
    expect(out.length).toBeLessThanOrEqual(BUDGET)
    expect(out).toMatch(/line 2 .*longer than/i)
    expect(out).toContain('offset=3')
    expect(out).not.toContain('yyyyyyyyyy')
    const next = await readSmall({ path: 'wide.ts', offset: 3 }, ctx)
    expect(next).toBe('after')
  })
})

describe('mingly_list_files result budget', () => {
  /** The production default of ToolRegistry: what a real run gets. */
  const PRODUCTION_BUDGET = 4000

  it('sizes the list against the production budget, so the footer survives', async () => {
    // 500 paths of ~20 characters are ~10 KB. Without a character budget the
    // registry cuts the result at 4000 and appends its own marker — removing
    // the footer that says the list is incomplete, which turns an incomplete
    // list into a false statement.
    for (let i = 0; i < LIST_FILES_MAX_ENTRIES + 5; i++) {
      write(`many/file${String(i).padStart(4, '0')}.ts`, 'x')
    }
    const prod = new ToolRegistry()
    expect(prod.getMaxResultChars()).toBe(PRODUCTION_BUDGET)
    registerReadTools(prod, { findGrant: async (id) => grants.find((g) => g.id === id) })
    const out = (
      await prod.executeTool({ id: 't', name: 'mingly_list_files', arguments: {} }, await ctxFor())
    ).content

    expect(out.length).toBeLessThanOrEqual(PRODUCTION_BUDGET)
    // The registry's own cut marker must not appear: the tool budgeted itself.
    expect(out).not.toMatch(/\.\.\. \[truncated\]$/)
    expect(out).toMatch(/INCOMPLETE/)
    const entries = out.split('\n').filter((l) => l.startsWith('many/'))
    expect(entries.length).toBeGreaterThan(0)
    expect(entries.length).toBeLessThan(LIST_FILES_MAX_ENTRIES)
    // No half-written path: every line listed is a whole file name.
    for (const entry of entries) expect(entry).toMatch(/^many\/file\d{4}\.ts$/)
  })

  it('a budget too small for the footer answers with a whole sentence, not a cut one', async () => {
    // `bodyBudget = maxResultChars - 300` is <= 0 below 300, so not one entry
    // can ever be shown. The footer that says so is 138 characters (measured),
    // and below that the REGISTRY cuts it mid-word and appends its own marker:
    // the statement about the result is the part that gets chopped. 120 is
    // under the footer and over any short sentence, so it pins both halves.
    // Unreachable from the production default of 4000.
    const TINY = 120
    write('src/a.ts', 'a')
    write('b.md', 'b')
    const tiny = new ToolRegistry({ toolTimeoutMs: 5000, maxResultChars: TINY })
    registerReadTools(tiny, { findGrant: async (id) => grants.find((g) => g.id === id) })
    const out = (
      await tiny.executeTool({ id: 't', name: 'mingly_list_files', arguments: {} }, await ctxFor())
    ).content

    expect(out.length).toBeLessThanOrEqual(TINY)
    expect(out).not.toContain('... [truncated]')
    expect(out).toMatch(/INCOMPLETE/)
    // And it must not read as a complete, empty project.
    expect(out).not.toBe('(no files)')
    // Advice that cannot work is not given: no entry fits at any breadth.
    expect(out).not.toMatch(/pattern/)
  })

  it('says nothing about truncation when the whole list fits the production budget', async () => {
    write('src/a.ts', 'a')
    write('b.md', 'b')
    const prod = new ToolRegistry()
    registerReadTools(prod, { findGrant: async (id) => grants.find((g) => g.id === id) })
    const out = (
      await prod.executeTool({ id: 't', name: 'mingly_list_files', arguments: {} }, await ctxFor())
    ).content
    expect(out.split('\n').sort()).toEqual(['b.md', 'src/a.ts'])
  })
})

describe('mingly_list_files', () => {
  it('lists files and hides .mingly', async () => {
    write('src/a.ts', 'a')
    write('b.md', 'b')
    const ctx = await ctxFor()
    fs.writeFileSync(path.join(ctx.workspace!.contextDir, 'hidden.txt'), 'h')
    const out = await call('mingly_list_files', {}, ctx)
    expect(out).toContain('src/a.ts')
    expect(out).toContain('b.md')
    expect(out).not.toContain('.mingly')
    expect(out).not.toContain('hidden.txt')
  })

  it('applies the blocklist to EVERY entry: a blocked file is not even named', async () => {
    write('.env', 'x')
    write('.env.local', 'x')
    write('keys/server.pem', 'x')
    write('.git/config', 'x')
    write('ok.ts', 'x')
    const out = await call('mingly_list_files', {}, await ctxFor())
    expect(out).toContain('ok.ts')
    expect(out).not.toContain('.env')
    expect(out).not.toContain('server.pem')
    expect(out).not.toContain('.git/')
    expect(out).not.toMatch(/\.git\b(?!ignore)/)
  })

  it('does not name an entry whose symlink target is blocked or outside', async () => {
    write('.env', 'x')
    fs.writeFileSync(path.join(outside, 'o.ts'), 'x')
    fs.symlinkSync('.env', path.join(project, 'innocent.ts'))
    fs.symlinkSync(path.join(outside, 'o.ts'), path.join(project, 'escape.ts'))
    write('ok.ts', 'x')
    const out = await call('mingly_list_files', {}, await ctxFor())
    expect(out).toContain('ok.ts')
    expect(out).not.toContain('innocent.ts')
    expect(out).not.toContain('escape.ts')
  })

  it('declares truncation in a footer, and says nothing when the list is complete', async () => {
    for (let i = 0; i < LIST_FILES_MAX_ENTRIES + 5; i++) write(`many/f${String(i).padStart(4, '0')}.ts`, 'x')
    const ctx = await ctxFor()
    const out = await call('mingly_list_files', {}, ctx)
    const lines = out.split('\n').filter((l) => l.startsWith('many/'))
    expect(lines).toHaveLength(LIST_FILES_MAX_ENTRIES)
    expect(out).toMatch(/truncated|incomplete/i)
    expect(out).toContain(String(LIST_FILES_MAX_ENTRIES))

    const small = await call('mingly_list_files', { pattern: 'many/f0000.ts' }, ctx)
    expect(small).toContain('many/f0000.ts')
    expect(small).not.toMatch(/truncated|incomplete/i)
  })

  it('skips gitignored paths, and still lists them when there is no .gitignore', async () => {
    write('src/a.ts', 'a')
    write('node_modules/pkg/index.ts', 'n')
    write('dist/out.ts', 'd')
    write('keep.log', 'k')
    const ctx = await ctxFor()
    const without = await call('mingly_list_files', {}, ctx)
    expect(without).toContain('node_modules/pkg/index.ts')
    expect(without).toContain('dist/out.ts')

    write('.gitignore', 'node_modules/\n/dist\n*.log\n!keep.log\n')
    const withIgnore = await call('mingly_list_files', {}, ctx)
    expect(withIgnore).toContain('src/a.ts')
    expect(withIgnore).toContain('keep.log')
    expect(withIgnore).not.toContain('node_modules')
    expect(withIgnore).not.toContain('dist/out.ts')
  })

  it('filters by pattern', async () => {
    write('src/a.ts', 'a')
    write('src/deep/b.ts', 'b')
    write('docs/c.md', 'c')
    const out = await call('mingly_list_files', { pattern: '**/*.ts' }, await ctxFor())
    expect(out).toContain('src/a.ts')
    expect(out).toContain('src/deep/b.ts')
    expect(out).not.toContain('c.md')
  })

  it('refuses the whole listing when a directory cannot be read (fail closed)', async () => {
    write('ok.ts', 'x')
    write('locked/inner.ts', 'x')
    fs.chmodSync(path.join(project, 'locked'), 0o000)
    try {
      const out = await call('mingly_list_files', {}, await ctxFor())
      expect(out).toMatch(/refused|cannot be listed/i)
      expect(out).not.toContain('ok.ts')
      expect(out).not.toMatch(/EACCES|locked/)
    } finally {
      fs.chmodSync(path.join(project, 'locked'), 0o700)
    }
  })

  it('refuses without a grant', async () => {
    write('a.ts', 'x')
    grants = []
    const out = await call('mingly_list_files', {}, await ctxFor())
    expect(out).toMatch(/refused/i)
    expect(out).not.toContain('a.ts')
  })
})

describe('gate', () => {
  it('the tools are withheld in off mode, without context, and for an unknown mode', async () => {
    const off = registry.getAvailableTools(await ctxFor('off')).map((t) => t.name)
    expect(off).not.toContain('mingly_read_file')
    expect(off).not.toContain('mingly_list_files')
    const none = registry.getAvailableTools(undefined).map((t) => t.name)
    expect(none).not.toContain('mingly_read_file')
    const bogus = registry
      .getAvailableTools({ coding: { directoryId: 'd', projectPath: project, mode: 'CRITICAL' as CodingMode } })
      .map((t) => t.name)
    expect(bogus).not.toContain('mingly_read_file')
  })

  it('the tools are offered in read-only, propose and propose-run', async () => {
    for (const mode of ['read-only', 'propose', 'propose-run'] as CodingMode[]) {
      const names = registry.getAvailableTools(await ctxFor(mode)).map((t) => t.name)
      expect(names).toContain('mingly_read_file')
      expect(names).toContain('mingly_list_files')
    }
  })

  it('a call in off mode is refused as an unknown tool', async () => {
    write('a.ts', 'content-a')
    const out = await call('mingly_read_file', { path: 'a.ts' }, await ctxFor('off'))
    expect(out).toMatch(/Unknown tool/)
    expect(out).not.toContain('content-a')
  })
})

describe('originForToolCall', () => {
  it('carries the RESOLVED path, never the model-written one', () => {
    const call = { id: '1', name: 'mingly_read_file', arguments: { path: './x/../src/a.ts' } }
    expect(originForToolCall(call, 'src/a.ts')).toEqual({ toolName: 'mingly_read_file', filePath: 'src/a.ts' })
  })

  it('has no filePath without a resolved path, even when the call carries a path', () => {
    const call = { id: '1', name: 'mingly_read_file', arguments: { path: 'src/a.ts' } }
    expect(originForToolCall(call)).toEqual({ toolName: 'mingly_read_file' })
    expect(originForToolCall({ id: '1', name: 'mingly_list_files', arguments: {} }, 'src/a.ts')).toEqual({
      toolName: 'mingly_list_files'
    })
  })

  it('strips bidi overrides, isolates, zero-width and control characters, and caps the length', () => {
    const dirty = 'a\u202Eb\u2066c\u2069d\u200Be\u0000f\n\u001bg\u2028h' + 'x'.repeat(1000)
    const o = originForToolCall({ id: '1', name: 'mingly_read_file', arguments: {} }, dirty)
    expect(o.filePath).toBeDefined()
    expect(o.filePath!).toMatch(/^abcdefgh/)
    expect(o.filePath!).not.toMatch(/[\u0000-\u001f\u007f\u200B-\u200F\u2028-\u202E\u2066-\u2069]/)
    expect(o.filePath!.length).toBeLessThanOrEqual(300)
  })

  it('gives the TOOL NAME the same treatment: it comes from the model too', () => {
    // The name travels into CodingConsentRequest.toolName, the approval
    // dialog, the withheld notice and from there back into the conversation.
    // An invented name produces an origin just as a real one does.
    const dirty = 'a\u202Eb\u2066c\u200Bd\u0000e\n\u001bf\u2028g' + 'x'.repeat(10_000)
    const o = originForToolCall({ id: '1', name: dirty, arguments: {} })
    expect(o.toolName).toMatch(/^abcdefg/)
    expect(o.toolName).not.toMatch(/[\u0000-\u001f\u007f\u200B-\u200F\u2028-\u202E\u2066-\u2069]/)
    expect(o.toolName.length).toBeLessThanOrEqual(100)
  })

  it('caps and strips the name on the read_file branch as well', () => {
    const dirty = 'mingly_read_file\u202E' + 'y'.repeat(10_000)
    const o = originForToolCall({ id: '1', name: dirty, arguments: {} }, 'src/a.ts')
    expect(o.toolName.length).toBeLessThanOrEqual(100)
    expect(o.toolName).not.toContain('\u202E')
  })

  it('a name that strips to nothing is reported as unknown, never as an empty field', () => {
    for (const name of ['\u202E\u200B', '\u0000', '', '   \u0007']) {
      const o = originForToolCall({ id: '1', name, arguments: {} })
      expect(o.toolName.trim()).not.toBe('')
      expect(o.toolName).toBe('unknown')
    }
  })
})

describe('pattern matching cannot hang the main process', () => {
  // Measured before the fix (old regex compiler, 10 stars, 'a' x N, no match):
  // N=28 326 ms, N=32 1982 ms, growing roughly 6x per +4. N=34 is several seconds.
  const NASTY = '*a'.repeat(10) + '*b'
  const NAME = 'a'.repeat(34)
  // No wall-clock assertions in this block: the claim is about WORK, not seconds.
  // A pathological pattern must be answered correctly and COMPLETELY, i.e. without
  // spending the work budget (no incomplete marker). Measured here: 2-3 ms each
  // (2026-11-19); a regex-compiled glob took seconds on the same input. A
  // regression to unbounded matching still fails: the test would not finish.

  it('mingly_list_files pattern: a pathological pattern is evaluated correctly and completely', async () => {
    write(NAME, 'x')
    write('aaab', 'x')
    const ctx = await ctxFor()
    const out = await call('mingly_list_files', { pattern: NASTY }, ctx)
    expect(out).not.toContain(NAME)
    expect(out).not.toMatch(/INCOMPLETE|truncated/)
    // positive control: the same shape of pattern still matches
    expect(await call('mingly_list_files', { pattern: '*a*a*b' }, ctx)).toContain('aaab')
  })

  it('.gitignore rule written by the project: a pathological rule is bounded and does not hide files wrongly', async () => {
    write(NAME, 'x')
    write('aaab', 'x')
    write('.gitignore', `${NASTY}\n`)
    const out = await call('mingly_list_files', {}, await ctxFor())
    // Complete (the budget was not spent) and correct (the rule does not match).
    expect(out).toContain(NAME)
    expect(out).toContain('aaab')
    expect(out).not.toMatch(/INCOMPLETE|truncated/)
  })

  it('hostile .gitignore (many heavy rules) x 400 files is cut by the work budget and says so', async () => {
    // The review's case. The property under test is that the WORK is bounded: the
    // incomplete marker appears only when the step budget was exhausted, so the
    // marker below is the proof. The budget is the invariant (the same number of
    // steps on every machine); the clock is only its shadow on this hardware, and
    // an assertion on it flaked at 5276 ms under a load average of ~30. Hence no
    // wall-clock bound here. Record of what the budget costs in time: this test
    // took 481-498 ms over six runs on the development machine (2026-11-19,
    // 100M-step budget, ~5 ns per step).
    // '*' + a long literal run that nearly matches: the two-pointer matcher
    // re-compares the run at every start position, O(pattern x text) per pair.
    const rule = '*' + 'a'.repeat(150) + 'b'
    write('.gitignore', Array.from({ length: 300 }, () => rule).join('\n') + '\n')
    for (let i = 0; i < 400; i++) write(`files/${'a'.repeat(230)}${String(i).padStart(3, '0')}`, 'x')
    const out = await call('mingly_list_files', {}, await ctxFor())
    expect(out).toMatch(/matching work budget reached/)
    expect(out).toMatch(/INCOMPLETE/)
    // File-rule cost: narrowing with `pattern` genuinely helps, so the advice stays.
    expect(out).toMatch(/pattern/)
  })

  it('budget spent on DIRECTORY ignore rules: says incomplete and does NOT advise a remedy that cannot apply', async () => {
    // Directory-only rules run before any pattern test, so `pattern` cannot help.
    const rule = '*' + 'a'.repeat(150) + 'b/'
    write('.gitignore', Array.from({ length: 300 }, () => rule).join('\n') + '\n')
    for (let i = 0; i < 400; i++) write(`${'a'.repeat(230)}${String(i).padStart(3, '0')}/f.ts`, 'x')
    const out = await call('mingly_list_files', {}, await ctxFor())
    expect(out).toMatch(/INCOMPLETE/)
    expect(out).not.toMatch(/narrow|pattern/i)
    expect(out).toMatch(/ignore rules/i)
  })

  it('a narrowed pattern is not charged for the ignore rules of entries it excludes', async () => {
    // The incomplete marker advises narrowing with `pattern`; that advice is only
    // true if the pattern is tested BEFORE the ignore rules for files. The claim is
    // relative and holds on every machine: the SAME tree exhausts the work budget
    // without a pattern and comes back complete with one. (Time on the development
    // machine, 2026-11-19: about 0.5 s for the unnarrowed run, tens of ms narrowed;
    // recorded only, not asserted.)
    const rule = '*' + 'a'.repeat(150) + 'b'
    write('.gitignore', Array.from({ length: 300 }, () => rule).join('\n') + '\n')
    for (let i = 0; i < 400; i++) write(`files/${'a'.repeat(230)}${String(i).padStart(3, '0')}`, 'x')
    write('files/target.ts', 'x')
    const ctx = await ctxFor()
    const wide = await call('mingly_list_files', {}, ctx)
    expect(wide).toMatch(/matching work budget reached/)
    const narrow = await call('mingly_list_files', { pattern: 'target.ts' }, ctx)
    expect(narrow).toContain('files/target.ts')
    expect(narrow).not.toMatch(/INCOMPLETE|truncated/)
  })

  it('an ordinary 400-file listing with an ordinary .gitignore is complete and unchanged', async () => {
    write('.gitignore', 'node_modules/\n*.log\n/dist\nbuild/\n*.tmp\n.cache\n')
    for (let i = 0; i < 400; i++) write(`src/mod${String(i).padStart(3, '0')}.ts`, 'x')
    write('debug.log', 'x')
    write('node_modules/p/i.ts', 'x')
    const out = await call('mingly_list_files', {}, await ctxFor())
    expect(out).not.toMatch(/INCOMPLETE|truncated/)
    expect(out.split('\n').filter((l) => l.startsWith('src/'))).toHaveLength(400)
    expect(out).not.toContain('debug.log')
    expect(out).not.toContain('node_modules')
  })

  it('.gitignore with a normal rule still ignores (positive control)', async () => {
    write('aaab', 'x')
    write('keep.ts', 'x')
    write('.gitignore', '*a*a*b\n')
    const out = await call('mingly_list_files', {}, await ctxFor())
    expect(out).not.toContain('aaab')
    expect(out).toContain('keep.ts')
  })
})
