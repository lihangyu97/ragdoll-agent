import { Service, type Context } from 'cordis'
import * as lark from '@larksuiteoapi/node-sdk'
import { z } from 'zod'
import logger from '@/utils/logger'
import { assign, stringify } from '@/utils'
import { type LarkMessage, parseMessageContent, resolveThreadId } from './message'

declare module 'cordis' {
  interface Context {
    lark: LarkService
  }
  interface Events {
    // 后续可能有用...
    'message/received': (threadId: string, content: string) => void
  }
}

export default class LarkService extends Service {
  static inject = ['channelLark', 'threads', 'traces']

  static Config = z.object({
    appId: z.string().min(1),
    appSecret: z.string().min(1),
    domain: z.enum(['feishu', 'lark']).default('feishu')
  })

  private readonly LOGGER_LEVEL = lark.LoggerLevel.error
  private readonly client: lark.Client
  private readonly ws: lark.WSClient

  constructor(ctx: Context, config: z.infer<typeof LarkService.Config>) {
    super(ctx, 'lark')

    const larkConfig = {
      appId: config.appId,
      appSecret: config.appSecret,
      domain: config.domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu,
      loggerLevel: this.LOGGER_LEVEL
    }

    this.client = new lark.Client(assign(larkConfig))
    this.ws = new lark.WSClient(
      assign(larkConfig, {
        onReady: () => console.log('[lark] ready'),
        onError: (error: Error) => console.error('[lark] error: ', error.message),
        onReconnecting: () => console.warn('[lark] reconnecting…'),
        onReconnected: () => console.log('[lark] reconnected')
      })
    )
  }

  async start() {
    this.watchDispatcher()
  }

  async close() {
    this.ws.close()
  }

  async reply(messageId: string, text: string): Promise<boolean> {
    try {
      await this.client.im.message.reply({
        path: { message_id: messageId },
        data: { content: JSON.stringify({ text }), msg_type: 'text' }
      })
      return true
    } catch (error) {
      logger.error('[lark] 回复失败: ', { messageId, error: stringify(error) })
      return false
    }
  }

  private watchDispatcher() {
    const dispatcher = new lark.EventDispatcher({
      loggerLevel: this.LOGGER_LEVEL
    }).register({
      'im.message.receive_v1': data => {
        if (data.sender.sender_type === 'user') {
          this.handleReceiveV1Message(data).catch(err => {
            logger.error('[lark] 消息处理失败: ', err)
          })
        }
      }
    })

    this.ws.start({ eventDispatcher: dispatcher })
  }

  private async handleReceiveV1Message(msg: LarkMessage): Promise<void> {
    const stringifyMsg = stringify(msg)
    console.log('🤖 收到飞书消息: ', stringifyMsg)

    const threadId = resolveThreadId(msg)
    if (!threadId) {
      logger.error('无 threadId 无法确认场景', stringifyMsg)
      return
    }

    const chatId = msg.message.chat_id
    const messageId = msg.message.message_id
    const openId = msg.sender.sender_id?.open_id

    const senderName = openId ? await this.getUserName(openId) : 'unknown'
    const content = parseMessageContent(msg)

    this.ctx.channelLark.insertLarkMessage({
      eventType: msg.event_type ?? '',
      appId: msg.app_id ?? '',
      chatId,
      chatType: msg.message.chat_type,
      messageId,
      messageType: msg.message.message_type,
      threadId: msg.message.thread_id ?? null,
      senderOpenId: openId ?? null,
      senderType: msg.sender.sender_type,
      senderName,
      content
    })

    // 写 thread
    this.ctx.threads.ensureThread(threadId, msg.message.chat_type, chatId, openId ?? null)
    this.ctx.traces.insertTrace(threadId, messageId, chatId, content)

    this.ctx.emit('message/received', threadId, content)

    await this.reply(messageId, '🤔 正在思考中…')
  }

  private async getUserName(openId: string): Promise<string> {
    const cached = this.ctx.channelLark.getUserName(openId)
    if (cached) return cached

    try {
      const res = await this.client.contact.v3.user.get({
        path: { user_id: openId },
        params: { user_id_type: 'open_id' }
      })
      const name = res.data?.user?.name
      if (name) {
        this.ctx.channelLark.upsertUser(openId, name)
        return name
      }
    } catch (err) {
      logger.error('[lark] 获取用户信息失败: ', err)
    }
    return openId
  }
}
