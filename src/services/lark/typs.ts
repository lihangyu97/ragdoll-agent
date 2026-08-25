import LarkService from './LarkService'

declare module 'cordis' {
  interface Context {
    lark: LarkService
  }
  interface Events {
    /** lark 收到消息、解析完、落库入队后广播；将来加 web/console 渠道时同一事件 */
    'message/received'(threadId: string, content: string): void
  }
}
