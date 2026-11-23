/**
 * planCommand (Task 12): the command line is split into an argv and checked
 * against a prefix allowlist with argument checking. Pure and synchronous.
 * Every expected value below is written out by hand; none is computed with
 * the code under test.
 */
import { describe, it, expect, vi } from 'vitest'
import { ToolRegistry, type ToolContext } from '../../src/main/agent/tool-registry'
import {
  planCommand,
  COMMAND_UNAVAILABLE,
  type CommandPlan
} from '../../src/main/coding/command-allowlist'
import { registerRunCommand } from '../../src/main/coding/run-command'
import type { CodingMode } from '../../src/shared/coding-types'

vi.mock('../../src/main/mcp/mcp-client-manager', () => ({
  getMCPClientManager: vi.fn(() => ({ listAllTools: vi.fn().mockReturnValue([]) }))
}))

const p = '/work/proj'
const ALL = {
  npm: '/usr/local/bin/npm',
  git: '/usr/bin/git',
  pytest: '/usr/local/bin/pytest'
}
const SCRIPTS = ['build', 'lint', 'test:unit']

// Written out by hand, never imported from the module under test. The two
// submodule entries were added when a filter driver in a submodule's own config
// turned out to be invisible to gitConfigIsSafe's probe; the behaviour that
// matters is asserted against real git in
// tests/unit/coding-git-submodule-filter-real-fs.test.ts.
const GIT_PREFIX = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'diff.ignoreSubmodules=all',
  '-c',
  'status.submoduleSummary=false',
  '--no-pager'
]

function refusedReason(plan: CommandPlan): string {
  if (plan.kind !== 'refused') throw new Error('expected a refusal, got ' + JSON.stringify(plan))
  return plan.reason
}

describe('planCommand: what runs', () => {
  it('plans an allowlisted command with an absolute interpreter path', () => {
    expect(planCommand('npm test', p, ALL)).toEqual({
      kind: 'run',
      file: '/usr/local/bin/npm',
      args: ['test'],
      cwd: p
    })
  })

  it('resolves a project binary from node_modules/.bin', () => {
    expect(planCommand('vitest run', p, {})).toEqual({
      kind: 'run',
      file: '/work/proj/node_modules/.bin/vitest',
      args: ['run'],
      cwd: p
    })
  })

  it('plans `npx tsc --noEmit` onto the project tsc, never onto npx (which could download)', () => {
    const expected = {
      kind: 'run',
      file: '/work/proj/node_modules/.bin/tsc',
      args: ['--noEmit'],
      cwd: p
    }
    expect(planCommand('npx tsc --noEmit', p, {})).toEqual(expected)
    expect(planCommand('tsc --noEmit', p, {})).toEqual(expected)
  })

  it('plans pytest through the configured interpreter, with checked path arguments', () => {
    expect(planCommand('pytest tests/test_a.py', p, ALL)).toEqual({
      kind: 'run',
      file: '/usr/local/bin/pytest',
      args: ['tests/test_a.py'],
      cwd: p
    })
  })

  it('never searches PATH: every planned file is an absolute path with a separator', () => {
    for (const c of ['npm test', 'vitest run', 'tsc --noEmit', 'git status', 'pytest']) {
      const plan = planCommand(c, p, ALL)
      expect(plan.kind).toBe('run')
      if (plan.kind === 'run') {
        expect(plan.file.startsWith('/')).toBe(true)
        expect(plan.file).toContain('/')
      }
    }
  })

  it('accepts an npm script that is in package.json (counter-check against false alarms)', () => {
    expect(planCommand('npm run build', p, ALL, SCRIPTS)).toEqual({
      kind: 'run',
      file: '/usr/local/bin/npm',
      args: ['run', 'build'],
      cwd: p
    })
    expect(planCommand('npm run test:unit', p, ALL, SCRIPTS).kind).toBe('run')
  })
})

describe('planCommand: git', () => {
  it('runs status and the name-only diff forms with config-driven execution switched off', () => {
    const cases: Array<[string, string[]]> = [
      ['git status', [...GIT_PREFIX, 'status', '--ignore-submodules=all']],
      ['git status --short', [...GIT_PREFIX, 'status', '--short', '--ignore-submodules=all']],
      [
        'git diff --stat',
        [...GIT_PREFIX, 'diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', '--stat']
      ],
      [
        'git diff --name-only',
        [
          ...GIT_PREFIX,
          'diff',
          '--no-ext-diff',
          '--no-textconv',
          '--ignore-submodules=all',
          '--name-only'
        ]
      ]
    ]
    for (const [line, args] of cases) {
      expect(planCommand(line, p, ALL)).toEqual({ kind: 'run', file: '/usr/bin/git', args, cwd: p })
    }
  })

  it('refuses a diff that prints file contents: it would carry a blocked file past the blocklist', () => {
    const plan = planCommand('git diff', p, ALL)
    expect(plan.kind).toBe('refused')
    expect(refusedReason(plan)).toMatch(/--stat|--name-only/)
  })

  it('refuses every other git invocation', () => {
    for (const c of [
      'git log',
      'git show HEAD',
      'git status -uall',
      'git diff HEAD',
      'git diff --stat HEAD',
      'git -c core.pager=x status',
      'git push',
      'git config --list',
      'git'
    ]) {
      expect(planCommand(c, p, ALL).kind, c).toBe('refused')
    }
  })
})

describe('planCommand: what never runs', () => {
  it('refuses a command whose interpreter is not configured', () => {
    expect(planCommand('git status', p, {}).kind).toBe('refused')
    expect(planCommand('npm test', p, {}).kind).toBe('refused')
    expect(planCommand('pytest', p, {}).kind).toBe('refused')
  })

  it('refuses shell metacharacters in any position', () => {
    for (const c of [
      'npm test && rm -rf /',
      'npm test | tee x',
      'npm test; ls',
      'npm test $(whoami)',
      'npm run "a b"',
      'npm test\nls',
      'npm test\rls',
      'npm test\tls',
      'npm test > out',
      'npm test < in',
      'npm test `id`',
      "npm run 'x'",
      'npm test &',
      'npm test {a,b}',
      'npm test (x)',
      'npm te\\st',
      'npm test\u0000',
      '$(npm) test',
      ';npm test',
      'npm\u00a0test',
      'npm\u2028test'
    ]) {
      expect(planCommand(c, p, ALL, SCRIPTS).kind, JSON.stringify(c)).toBe('refused')
    }
  })

  it('refuses an npm script that is not in package.json (argument check, not just the prefix)', () => {
    expect(planCommand('npm run deploy', p, ALL, SCRIPTS).kind).toBe('refused')
    // Empty or absent list means no scripts are allowed.
    expect(planCommand('npm run build', p, ALL, []).kind).toBe('refused')
    expect(planCommand('npm run build', p, ALL).kind).toBe('refused')
  })

  it('refuses npm forms with extra arguments, flags or an odd script name', () => {
    for (const c of [
      'npm run build --foo',
      'npm run',
      'npm run -- build',
      'npm test --foo',
      'npm install',
      'npm exec foo',
      'npm run ../x',
      'npm run __proto__',
      'npm run constructor',
      'npm run toString'
    ]) {
      expect(planCommand(c, p, ALL, SCRIPTS).kind, c).toBe('refused')
    }
  })

  it('refuses unlisted commands, empty input and absurd length', () => {
    for (const c of ['', '   ', 'rm -rf /', 'node x.js', 'curl http://x', 'bash -c ls', 'sh', 'python x.py']) {
      expect(planCommand(c, p, ALL).kind, c).toBe('refused')
    }
    expect(planCommand('npm test ' + 'a'.repeat(5000), p, ALL).kind).toBe('refused')
    expect(planCommand('pytest ' + 'a/'.repeat(30), p, ALL).kind).toBe('run')
    expect(planCommand('pytest ' + Array(20).fill('a.py').join(' '), p, ALL).kind).toBe('refused')
  })

  it('refuses non-string input', () => {
    expect(planCommand(undefined as unknown as string, p, ALL).kind).toBe('refused')
    expect(planCommand(42 as unknown as string, p, ALL).kind).toBe('refused')
  })

  it('refuses path arguments that are flags, absolute, escaping or blocked', () => {
    for (const c of [
      'pytest -x',
      'pytest --rootdir=/',
      'pytest /etc/passwd',
      'pytest ../x.py',
      'pytest a/../../x.py',
      'pytest .env',
      'pytest src/.env.local',
      'pytest secrets/a.py',
      'vitest run --config evil.ts',
      'vitest run ../x',
      'vitest watch',
      'vitest',
      'vitest run .env',
      'pytest tests/a.py::test_x'
    ]) {
      expect(planCommand(c, p, ALL).kind, c).toBe('refused')
    }
  })

  it('refuses tsc with anything but exactly --noEmit', () => {
    for (const c of ['tsc', 'tsc --noEmit --watch', 'tsc -p other', 'npx tsc', 'npx tsc --noEmit x', 'npx eslint .']) {
      expect(planCommand(c, p, ALL).kind, c).toBe('refused')
    }
  })

  it('does not take an interpreter from the prototype chain or from a relative path', () => {
    expect(planCommand('npm test', p, Object.create({ npm: '/usr/local/bin/npm' })).kind).toBe('refused')
    expect(planCommand('npm test', p, { npm: 'npm' }).kind).toBe('refused')
    expect(planCommand('npm test', p, { npm: './npm' }).kind).toBe('refused')
    expect(planCommand('npm test', p, { npm: '' }).kind).toBe('refused')
    expect(planCommand('npm test', p, { npm: '/usr/bin/np\u0000m' }).kind).toBe('refused')
    expect(planCommand('npm test', p, { npm: 5 as unknown as string }).kind).toBe('refused')
  })

  it('refuses a relative project path rather than resolving it against the process cwd', () => {
    expect(planCommand('vitest run', 'proj', {}).kind).toBe('refused')
  })
})

describe('planCommand: refusals that depend on the environment look alike', () => {
  it('unconfigured interpreter, unknown npm script and relative interpreter share ONE text', () => {
    const a = refusedReason(planCommand('git status', p, {}))
    const b = refusedReason(planCommand('npm run nothing', p, ALL, SCRIPTS))
    const c = refusedReason(planCommand('npm test', p, { npm: 'relative/npm' }))
    expect(a).toBe(COMMAND_UNAVAILABLE)
    expect(b).toBe(COMMAND_UNAVAILABLE)
    expect(c).toBe(COMMAND_UNAVAILABLE)
  })

  it('a refusal that depends only on the caller input may say why, and is not the environment text', () => {
    const reason = refusedReason(planCommand('npm test && ls', p, ALL))
    expect(reason).not.toBe(COMMAND_UNAVAILABLE)
    expect(reason).toMatch(/shell/i)
    // Input checks run before environment checks: bad input is reported as
    // bad input even when the interpreter is missing too.
    expect(refusedReason(planCommand('npm test && ls', p, {}))).toBe(reason)
  })
})

describe('mingly_run_command gate', () => {
  function ctxFor(mode: CodingMode | undefined): ToolContext | undefined {
    if (mode === undefined) return undefined
    return { coding: { directoryId: 'd', projectPath: p, mode } }
  }
  const registry = new ToolRegistry({ toolTimeoutMs: 5000, maxResultChars: 4000 })
  registerRunCommand(registry)
  const offered = (ctx?: ToolContext): boolean =>
    registry.getAvailableTools(ctx).some((t) => t.name === 'mingly_run_command')

  it('is offered only in propose-run', () => {
    expect(offered(ctxFor('propose-run'))).toBe(true)
    expect(offered(ctxFor('propose'))).toBe(false)
    expect(offered(ctxFor('read-only'))).toBe(false)
    expect(offered(ctxFor('off'))).toBe(false)
    expect(offered(undefined)).toBe(false)
    expect(offered({})).toBe(false)
    expect(offered({ coding: { directoryId: 'd', projectPath: p, mode: 'auto' as CodingMode } })).toBe(false)
  })

  it('is refused at call time below propose-run, independent of the offer', async () => {
    const result = await registry.executeTool(
      { id: 't', name: 'mingly_run_command', arguments: { command: 'npm test' } },
      ctxFor('propose')
    )
    expect(result.content).toMatch(/Unknown tool/)
  })
})
