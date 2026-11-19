/**
 * Write a file atomically: a temp file in the target's own directory, then a
 * rename over the target. Shared by the apply and undo paths and by the
 * snapshot ledger, so there is ONE implementation of the discipline.
 */

import * as fs from 'fs'
import * as path from 'path'
import { randomBytes } from 'crypto'

const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0

/** Thrown by a `verifyBeforeRename` hook when the file is no longer what was verified. */
export class ContentChanged extends Error {
  constructor(message = 'the file changed after it was verified') {
    super(message)
    this.name = 'ContentChanged'
  }
}


export interface AtomicWriteOptions {
  /** Permission bits of the new file. Default: those of the file it replaces, else 0o644. */
  mode?: number
  /**
   * The inode the caller verified. Checked right before the rename: if the path
   * is no longer that file, nothing is renamed.
   */
  expectIdentity?: { dev: number; ino: number }
  /**
   * Called as the LAST check before the rename, after the identity check. It
   * must throw (ContentChanged) when the file's content is no longer what the
   * caller verified. Identity alone is the wrong property: an editor's in-place
   * save keeps the inode, so the inode check passes while the content moved on.
   */
  verifyBeforeRename?: () => Promise<void>
}

async function assertRealDirectory(dir: string): Promise<void> {
  if ((await fs.promises.realpath(dir)) !== dir) throw new Error('directory changed under the write')
}

/**
 * Write `content` to a temp file in the target's own directory, then rename it
 * over the target. `rename` inside one file system is atomic: an interruption
 * leaves the target entirely old or entirely new, and a temp file in /tmp would
 * not give that, because rename across file systems copies.
 */
export async function writeFileAtomic(
  target: string,
  content: string | Buffer,
  options: AtomicWriteOptions = {}
): Promise<void> {
  const dir = path.dirname(target)
  const expected = options.expectIdentity
  if (expected) await assertRealDirectory(dir)

  let mode = options.mode
  if (mode === undefined) {
    try {
      mode = (await fs.promises.stat(target)).mode & 0o777
    } catch {
      mode = 0o644
    }
  }

  // Fixed length, independent of the target's name: a long file name must not
  // make the temp name too long.
  const temp = path.join(dir, `.mingly-tmp-${randomBytes(8).toString('hex')}`)
  let handle: fs.promises.FileHandle | undefined
  try {
    handle = await fs.promises.open(
      temp,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW,
      0o600
    )
    await handle.writeFile(content)
    await handle.chmod(mode)
    await handle.sync()
    await handle.close()
    handle = undefined

    if (expected) {
      await assertRealDirectory(dir)
      const now = await fs.promises.lstat(target)
      if (!now.isFile() || now.dev !== expected.dev || now.ino !== expected.ino) {
        throw new Error('target is no longer the file that was verified')
      }
    }
    // Content, as late as possible: the gap left is hash-to-rename.
    await options.verifyBeforeRename?.()
    await fs.promises.rename(temp, target)
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await fs.promises.unlink(temp).catch(() => undefined)
    throw error
  }
}

