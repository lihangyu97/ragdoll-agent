import { Service, type Context } from 'cordis'
import * as lark from '@larksuiteoapi/node-sdk'
import { z } from 'zod'
import logger from '@/utils/logger'
import { assign } from '@/utils'
import type { ChannelAdapter, InboundMessage, OutboundReply } from '../../types'
import { type LarkMessage, parseMessageContent, resolveThreadId } from './message'

declare module 'cordis' {
  interface Context {
    larkAdapter: LarkAdapter
  }
}

/**
 * lark adapter：实现 ChannelAdapter（id='lark'）。
 * 入站：WS 收 im.message.receive_v1 → 归一化成 InboundMessage（threadId 加 'lark:' 前缀命名空间）
 *      → ctx.channel.dispatch（统一入站管线；用户名缓存走 channelStore，渠道专属）。
 * 出站：send() 用 REST 回复（im.message.reply），worker 完成路径经 ctx.channel.send 路由到此处。
 */
export default class LarkAdapter extends Service implements ChannelAdapter {
  readonly id = 'lark'

  static inject = ['channel', 'channelStore']

  static Config = z.object({
    appId: z.string().min(1),
    appSecret: z.string().min(1),
    domain: z.enum(['feishu', 'lark']).default('feishu')
  })

  private readonly LOGGER_LEVEL = lark.LoggerLevel.error
  private readonly client: lark.Client
  private readonly ws: lark.WSClient
  private started = false

  constructor(ctx: Context, config: z.infer<typeof LarkAdapter.Config>) {
    super(ctx, 'larkAdapter')

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
    if (this.started) return
    this.started = true
    this.watchDispatcher()
  }

  async stop() {
    this.ws.close()
    this.started = false
  }

  async send(reply: OutboundReply): Promise<boolean> {
    try {
      await this.client.im.message.reply({
        path: { message_id: reply.messageId },
        data: { content: JSON.stringify({ text: reply.text }), msg_type: 'text' }
      })
      return true
    } catch (error) {
      logger.error('[lark] 回复失败: ', { messageId: reply.messageId, error })
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
    const rawThreadId = resolveThreadId(msg)
    if (!rawThreadId) {
      logger.error('无 threadId 无法确认场景', msg)
      return
    }

    const openId = msg.sender.sender_id?.open_id
    const senderName = openId ? await this.getUserName(openId) : undefined
    const chatType = msg.message.chat_type

    const inbound: InboundMessage = {
      channel: 'lark',
      threadId: `lark:${chatType}:${rawThreadId}`,
      chatType: chatType,
      chatId: msg.message.chat_id,
      messageId: msg.message.message_id,
      text: parseMessageContent(msg),
      raw: msg,
      ...(openId ? { senderId: openId } : {}),
      ...(senderName ? { senderName } : {})
    }

    await this.ctx.channel.dispatch(inbound)
  }

  private async getUserName(openId: string): Promise<string | undefined> {
    const cached = this.ctx.channelStore.getUserName('lark', openId)
    if (cached) return cached

    try {
      const res = await this.client.contact.v3.user.get({
        path: { user_id: openId },
        params: { user_id_type: 'open_id' }
      })
      const name = res.data?.user?.name
      if (name) {
        this.ctx.channelStore.upsertUser('lark', openId, name)
        return name
      }
    } catch (err) {
      logger.error('[lark] 获取用户信息失败: ', err)
    }
    return undefined
  }
}
