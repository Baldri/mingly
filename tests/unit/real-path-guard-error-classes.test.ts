/**
 * Which realpath failures mean "not there", and which mean "do not trust me".
 *
 * fs IS mocked here, on purpose and in contrast to symlink-escape-real-fs.test.ts:
 * the subject is the errno classification, and EACCES, ELOOP and EIO cannot be
 * produced reliably across platforms on a real filesystem. The real-filesystem
 * file carries the one case that can (a directory with no search permission),
 * so neither file stands alone.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const fsMock = vi.hoisted(() => ({
  realpath: vi.fn()
}))

vi.mock('fs/promises', () => ({ default: fsMock, ...fsMock }))

import {
  isMissingPathError,
  isRealPathWithin,
  isRealPathWithinAny,
  resolveRealPath
} from '../../src/main/file-access/real-path-guard'

type Answer = { real: string } | { fail: string }

/**
 * Answer realpath from a table. A path that is not in the table reports
 * ENOENT, which is what the walk-up branch needs to see.
 */
function answerRealpath(answers: Record<string, Answer>): void {
  fsMock.realpath.mockImplementation((async (target: unknown) => {
    const key = String(target)
    const answer = answers[key]
    if (answer === undefined) {
      throw Object.assign(new Error(`ENOENT: ${key}`), { code: 'ENOENT' })
    }
    if ('fail' in answer) {
      throw Object.assign(new Error(`${answer.fail}: ${key}`), { code: answer.fail })
    }
    return answer.real
  }) as never)
}

describe('isMissingPathError', () => {
  it('accepts only the codes that mean the path is not there', () => {
    expect(isMissingPathError({ code: 'ENOENT' })).toBe(true)
    expect(isMissingPathError({ code: 'ENOTDIR' })).toBe(true)
  })

  it('refuses the codes that mean the filesystem would not answer', () => {
    for (const code of ['EACCES', 'EPERM', 'ELOOP', 'EIO', 'ENAMETOOLONG', 'EMFILE']) {
      expect(isMissingPathError({ code })).toBe(false)
    }
  })

  it('refuses anything without a usable code', () => {
    expect(isMissingPathError(new Error('no code at all'))).toBe(false)
    expect(isMissingPathError({ code: 42 })).toBe(false)
    expect(isMissingPathError(null)).toBe(false)
    expect(isMissingPathError(undefined)).toBe(false)
  })
})

describe('resolveRealPath error classes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('tolerates a missing tail and appends it to the deepest existing ancestor', async () => {
    answerRealpath({ '/granted': { real: '/granted' } })

    expect(await resolveRealPath('/granted/neu/datei.md')).toBe('/granted/neu/datei.md')
  })

  it('treats ENOTDIR as a missing path too', async () => {
    answerRealpath({
      '/granted': { real: '/granted' },
      '/granted/datei.md': { fail: 'ENOTDIR' }
    })

    expect(await resolveRealPath('/granted/datei.md/weiter.md')).toBe('/granted/datei.md/weiter.md')
  })

  it('refuses to guess when the filesystem denies access', async () => {
    answerRealpath({ '/granted/gesperrt': { fail: 'EACCES' } })

    expect(await resolveRealPath('/granted/gesperrt')).toBeNull()
  })

  it('refuses to guess on a symlink loop', async () => {
    answerRealpath({ '/granted/ringschluss': { fail: 'ELOOP' } })

    expect(await resolveRealPath('/granted/ringschluss')).toBeNull()
  })

  it('refuses to guess on an unknown failure', async () => {
    answerRealpath({ '/granted/kaputt': { fail: 'EIO' } })

    expect(await resolveRealPath('/granted/kaputt')).toBeNull()
  })

  it('stops at the first refusal instead of walking past it', async () => {
    // The tail is absent AND the parent is unreadable: the walk-up must not
    // reach the grandparent and answer with the unresolved spelling.
    answerRealpath({
      '/granted': { real: '/granted' },
      '/granted/gesperrt': { fail: 'EACCES' }
    })

    expect(await resolveRealPath('/granted/gesperrt/ziel.md')).toBeNull()
  })
})

describe('containment with an unresolvable path', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('denies when the requested path cannot be resolved', async () => {
    answerRealpath({
      '/granted': { real: '/granted' },
      '/granted/gesperrt': { fail: 'EACCES' }
    })

    expect(await isRealPathWithin('/granted/gesperrt', '/granted')).toBe(false)
  })

  it('denies when the GRANT itself cannot be resolved', async () => {
    answerRealpath({
      '/granted': { fail: 'EACCES' },
      '/granted/datei.md': { real: '/granted/datei.md' }
    })

    expect(await isRealPathWithin('/granted/datei.md', '/granted')).toBe(false)
  })

  it('still allows a legitimate read, so the denial above is not blanket', async () => {
    answerRealpath({
      '/granted': { real: '/granted' },
      '/granted/datei.md': { real: '/granted/datei.md' }
    })

    expect(await isRealPathWithin('/granted/datei.md', '/granted')).toBe(true)
  })

  it('drops an unresolvable grant from the list but keeps the others usable', async () => {
    answerRealpath({
      '/kaputt': { fail: 'EACCES' },
      '/granted': { real: '/granted' },
      '/granted/datei.md': { real: '/granted/datei.md' }
    })

    expect(await isRealPathWithinAny('/granted/datei.md', ['/kaputt', '/granted'])).toBe(true)
  })

  it('denies across the whole list when the requested path is unresolvable', async () => {
    answerRealpath({
      '/granted': { real: '/granted' },
      '/granted/gesperrt': { fail: 'EACCES' },
      '/anderes': { real: '/anderes' }
    })

    expect(await isRealPathWithinAny('/granted/gesperrt', ['/granted', '/anderes'])).toBe(false)
  })
})
