/**
 * Project workspace — `<project>/.mingly/`.
 *
 * Snapshots and externalized tool results live INSIDE the project, not in
 * os.tmpdir(): project source must not leave the project boundary, and that
 * holds for backup copies as much as for the files the agent reads. As a side
 * effect `.mingly/context/` sits inside the granted directory, so `mingly_read_file`
 * can open an externalized result without widening the grant.
 *
 * Every decision here fails closed: anything unexpected throws a
 * ProjectWorkspaceError, and all checks run BEFORE the first write.
 */

import * as fs from 'fs'
import * as path from 'path'

export interface ProjectWorkspace {
  /** <project>/.mingly */
  root: string
  /** <project>/.mingly/snapshots/<runId> */
  snapshotDir: string
  /** <project>/.mingly/context/<runId> */
  contextDir: string
}

export class ProjectWorkspaceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProjectWorkspaceError'
  }
}

const WORKSPACE_DIR = '.mingly'
const GITIGNORE_ENTRY = '.mingly/'
/** Equivalent spellings that already ignore the workspace. */
const GITIGNORE_EQUIVALENTS = new Set(['.mingly', '.mingly/', '/.mingly', '/.mingly/'])
const DIR_MODE = 0o700
/** One path segment, no separators, no dots-only names. */
const SAFE_RUN_ID = /^[A-Za-z0-9_-]{1,128}$/

async function lstatOrNull(target: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.lstat(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new ProjectWorkspaceError(`Cannot inspect ${target}: ${(error as Error).message}`)
  }
}

async function assertWritableDir(dir: string): Promise<void> {
  try {
    await fs.promises.access(dir, fs.constants.W_OK | fs.constants.X_OK)
  } catch {
    throw new ProjectWorkspaceError(`Directory is not writable: ${dir}`)
  }
}

/**
 * Create one directory level, tolerating a concurrent run that created it
 * first. EEXIST is not swallowed blindly: the path is re-verified with lstat
 * and must be a real directory, otherwise a symlink planted in between would
 * be accepted and the following chmod would follow it.
 */
async function createDirectory(dir: string): Promise<void> {
  try {
    await fs.promises.mkdir(dir, { mode: DIR_MODE })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const stat = await fs.promises.lstat(dir)
    if (!stat.isDirectory()) {
      throw new ProjectWorkspaceError(`${dir} appeared as something other than a plain directory`)
    }
  }
}

/**
 * True when the last matching rule ignores `.mingly`. Deliberately narrow, not
 * a gitignore parser. Fail-closed rule: when in doubt the entry counts as
 * absent and gets appended (a redundant entry is harmless, a missing one lets
 * externalized tool results be committed). Leading whitespace is part of a
 * gitignore pattern, so an indented line is NOT treated as a rule here.
 */
function ignoresWorkspace(content: string): boolean {
  let ignored = false
  for (const raw of content.split('\n')) {
    // git strips unescaped TRAILING spaces but keeps LEADING whitespace as part
    // of the pattern, so only the trailing side is normalised.
    const line = (raw.endsWith('\r') ? raw.slice(0, -1) : raw).replace(/(?<!\\) +$/, '')
    if (line === '' || line.startsWith('#') || /^\s/.test(line)) continue
    // Any negation may re-include the workspace (`!.min*`, `!*`, ...); without
    // a glob engine it is assumed to. Bounded: a later `.mingly/` is the last
    // matching rule again, so the appended entry is not re-appended next run.
    if (line.startsWith('!')) ignored = false
    else if (GITIGNORE_EQUIVALENTS.has(line)) ignored = true
  }
  return ignored
}

export async function ensureProjectWorkspace(
  projectPath: string,
  runId: string
): Promise<ProjectWorkspace> {
  if (typeof projectPath !== 'string' || !path.isAbsolute(projectPath)) {
    throw new ProjectWorkspaceError('Project path must be absolute')
  }
  if (typeof runId !== 'string' || !SAFE_RUN_ID.test(runId)) {
    throw new ProjectWorkspaceError('Run id is not a safe path segment')
  }

  const project = path.resolve(projectPath)
  const root = path.join(project, WORKSPACE_DIR)
  const snapshotsDir = path.join(root, 'snapshots')
  const contextsDir = path.join(root, 'context')
  const snapshotDir = path.join(snapshotsDir, runId)
  const contextDir = path.join(contextsDir, runId)

  // ── Pass 1: inspect everything, write nothing ───────────────────────────
  // The project root itself may be reached through a symlink (e.g. /var on
  // macOS), so it is followed with stat; the workspace components below it
  // must not be symlinks and are checked with lstat.
  let projectIsDir = false
  try {
    projectIsDir = (await fs.promises.stat(project)).isDirectory()
  } catch {
    projectIsDir = false
  }
  if (!projectIsDir) {
    throw new ProjectWorkspaceError(`Project path is not an existing directory: ${project}`)
  }

  const components = [root, snapshotsDir, contextsDir, snapshotDir, contextDir]
  const missing = new Set<string>()
  for (const component of components) {
    const stat = await lstatOrNull(component)
    if (!stat) {
      missing.add(component)
      continue
    }
    // lstat: a symlink is rejected even when it points at a directory, because
    // writes through it would leave the project.
    if (!stat.isDirectory()) {
      throw new ProjectWorkspaceError(
        `${component} exists but is not a plain directory (file or symlink)`
      )
    }
    await assertWritableDir(component)
  }

  // Components are created top-down, so only the first missing one is created
  // inside a directory that already exists.
  const firstMissing = components.find((c) => missing.has(c))
  if (firstMissing) await assertWritableDir(path.dirname(firstMissing))

  const gitignorePath = path.join(project, '.gitignore')
  const gitignoreStat = await lstatOrNull(gitignorePath)
  let gitignoreNeedsEntry = false
  let gitignoreContent = ''
  if (gitignoreStat) {
    if (!gitignoreStat.isFile()) {
      throw new ProjectWorkspaceError('.gitignore exists but is not a regular file')
    }
    try {
      gitignoreContent = await fs.promises.readFile(gitignorePath, 'utf-8')
    } catch {
      throw new ProjectWorkspaceError('.gitignore is not readable')
    }
    gitignoreNeedsEntry = !ignoresWorkspace(gitignoreContent)
    // Writability matters only when the entry has to be appended. Without the
    // entry, .mingly/ (externalized tool results) could be committed, so an
    // unwritable .gitignore then fails closed.
    if (gitignoreNeedsEntry) {
      try {
        await fs.promises.access(gitignorePath, fs.constants.W_OK)
      } catch {
        throw new ProjectWorkspaceError(
          `${gitignorePath} does not ignore ${GITIGNORE_ENTRY} and is not writable: ` +
            `add the line "${GITIGNORE_ENTRY}" to it (or make it writable) and retry`
        )
      }
    }
  }

  // ── Pass 2: write ───────────────────────────────────────────────────────
  try {
    for (const component of components) {
      if (missing.has(component)) {
        await createDirectory(component)
      }
      // Explicit chmod: mkdir's mode is ignored for a directory that already
      // exists, and is filtered by the umask for a new one.
      await fs.promises.chmod(component, DIR_MODE)
    }
    if (gitignoreNeedsEntry) {
      const separator = gitignoreContent === '' || gitignoreContent.endsWith('\n') ? '' : '\n'
      await fs.promises.appendFile(gitignorePath, `${separator}${GITIGNORE_ENTRY}\n`, 'utf-8')
    }
  } catch (error) {
    throw new ProjectWorkspaceError(`Cannot create project workspace: ${(error as Error).message}`)
  }

  return { root, snapshotDir, contextDir }
}
