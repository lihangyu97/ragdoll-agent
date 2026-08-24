import { Service, type Context } from 'cordis'

declare module 'cordis' {
  interface Context {
    sqlite: SqliteService
  }
  interface Events {}
}

export default class SqliteService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'sqlite')
  }
}
