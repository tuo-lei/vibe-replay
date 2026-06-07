declare module "sql.js" {
  interface QueryExecResult {
    columns: string[];
    values: any[][];
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
