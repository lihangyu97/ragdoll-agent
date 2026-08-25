import LarkService from './LarkService'

declare module 'cordis' {
  interface Context {
    lark: LarkService
  }
  interface Events {}
}
