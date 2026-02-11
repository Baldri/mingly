declare module 'sql.js' {
  interface SqlJsStatic {
    Database: typeof Database
  }

  interface QueryExecResult {
    columns: string[]
    values: any[][]
  }

  interface ParamsObject {
    [key: string]: any
  }

  interface ParamsCallback {
    (obj: ParamsObject): void
  }

  interface Statement {
    bind(params?: any[]): boolean
    step(): boolean
    getAsObject(params?: any): Record<string, any>
    get(params?: any): any[]
    run(params?: any[]): void
    free(): boolean
    reset(): void
    getColumnNames(): string[]
  }

  class Database {
    constructor(data?: ArrayLike<number> | Buffer | null)
    run(sql: string, params?: any[]): Database
    exec(sql: string, params?: any[]): QueryExecResult[]
    prepare(sql: string): Statement
    export(): Uint8Array
    close(): void
    getRowsModified(): number
  }

  interface SqlJsConfig {
    locateFile?: (filename: string) => string
  }

  export default function initSqlJs(config?: SqlJsConfig): Promise<SqlJsStatic>
  export { Database, Statement, QueryExecResult, SqlJsStatic }
}
