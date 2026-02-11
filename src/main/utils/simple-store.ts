import { app } from 'electron'
import fs from 'fs'
import path from 'path'

export class SimpleStore {
  private storePath: string
  private data: Record<string, any> = {}

  constructor(filename: string = 'config.json') {
    const userDataPath = app.getPath('userData')
    this.storePath = path.join(userDataPath, filename)
    this.load()
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
