import { app } from 'electron'
import fs from 'fs'
import path from 'path'

/**
 * Simple JSON key-value store persisted to disk.
 *
 * Multiple modules create `new SimpleStore()` for the same file
 * (default: config.json). Each instance snapshots the file at
 * construction time, so a later `set()` on instance A overwrites
 * changes made by instance B — classic stale-cache bug.
 *
 * Fix: a per-file singleton cache ensures all callers share the
 * same in-memory map and never silently overwrite each other.
 */

const _instances = new Map<string, SimpleStore>()

export class SimpleStore {
  private storePath: string
  private data: Record<string, any> = {}

  /** @internal — use `new SimpleStore(filename)` which returns a singleton per file */
  private constructor(storePath: string) {
    this.storePath = storePath
    this.load()
  }

  /** Singleton factory — returns the same instance for the same filename */
  static create(filename: string = 'config.json'): SimpleStore {
    const userDataPath = app.getPath('userData')
    const storePath = path.join(userDataPath, filename)

    let instance = _instances.get(storePath)
    if (!instance) {
      instance = new SimpleStore(storePath)
      _instances.set(storePath, instance)
    }
    return instance
  }

  private load(): void {
    try {
      if (fs.existsSync(this.storePath)) {
        const content = fs.readFileSync(this.storePath, 'utf-8')
        this.data = JSON.parse(content)
      }
    } catch (error) {
      console.error('Failed to load store:', error)
      this.data = {}
    }
  }

  private save(): void {
    try {
      fs.writeFileSync(this.storePath, JSON.stringify(this.data, null, 2), 'utf-8')
    } catch (error) {
      console.error('Failed to save store:', error)
    }
  }

  get(key: string, defaultValue?: any): any {
    return this.data[key] !== undefined ? this.data[key] : defaultValue
  }

  set(key: string, value: any): void {
    this.data[key] = value
    this.save()
  }

  has(key: string): boolean {
    return this.data[key] !== undefined
  }

  delete(key: string): void {
    delete this.data[key]
    this.save()
  }

  clear(): void {
    this.data = {}
    this.save()
  }
}
