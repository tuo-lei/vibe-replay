declare module "sql.js" {
  type SqlValue = string | number | null | Uint8Array;

  interface QueryExecResult {
    columns: string[];
    values: SqlValue[][];
  }

  interface Statement {
    bind(params?: any[]): boolean;
    step(): boolean;
    get(): any[];
    getAsObject(): Record<string, any>;
    reset(): void;
    free(): void;
  }

  interface Database {
    exec(sql: string, params?: any[]): QueryExecResult[];
    prepare(sql: string): Statement;
    close(): void;
  }

  interface SqlJsStatic {
    Database: new (data?: ArrayLike<number> | Buffer | null) => Database;
  }

  export default function initSqlJs(config?: Record<string, unknown>): Promise<SqlJsStatic>;
}
