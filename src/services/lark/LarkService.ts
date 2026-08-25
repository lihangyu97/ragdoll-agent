import { Service, type Context } from 'cordis'
import * as lark from '@larksuiteoapi/node-sdk'
import { stringify } from '@/logger'
import { assign } from '@/utils'
import { larkBaseConfig, larkHandlers, LOGGER_LEVEL } from '@/config/lark'
import { type LarkMessage, parseMessageContent } from './message'

export default class LarkService extends Service {
  private readonly client: lark.Client
  private readonly ws: lark.WSClient

  constructor(ctx: Context) {
    super(ctx, 'lark')

    this.client = new lark.Client(assign(larkBaseConfig))
    this.ws = new lark.WSClient(assign(larkBaseConfig, larkHandlers))
  }

  async start() {
    this.watchDispatcher()
    this.watchAgentLoop()
  }

  async close() {
    this.ws.close()
  }

  private watchAgentLoop() {}

  private watchDispatcher() {
    const dispatcher = new lark.EventDispatcher({
      loggerLevel: LOGGER_LEVEL
    }).register({
      'im.message.receive_v1': data => {
        if (data.sender.sender_type === 'user') {
          this.handleReceiveV1Message(data).catch(err => {
            console.log('🤖 飞书消息处理失败: ', err)
          })
        }
      }
    })

    this.ws.start({ eventDispatcher: dispatcher })
  }

  private async handleReceiveV1Message(msg: LarkMessage) {
    const stringifyMsg = stringify(msg)
    console.log('🤖 收到飞书消息: ', stringifyMsg)

    const messageId = msg.message.message_id
    const content = parseMessageContent(msg)

    // TODO: 消息插入 lark 表
    // TODO: 登记 thread
    // TODO: 登记 trace

    this.replyToMessage(messageId, '收到: ' + content)
  }

  async replyToMessage(messageId: string, text: string) {
    return this.client.im.message.reply({
      path: { message_id: messageId },
      data: { content: JSON.stringify({ text }), msg_type: 'text' }
    })
  }
}
