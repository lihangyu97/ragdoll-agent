import { Service, type Context } from 'cordis'

declare module 'cordis' {
  interface Context {
    sqlite: AgentService
  }
  interface Events {}
}

export default class AgentService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'agent')
  }
}
