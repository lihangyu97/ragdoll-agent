import { Service, type Context } from 'cordis'
import { z } from 'zod'
import logger from '@/utils/logger'
import { stringify } from '@/utils'
import type { ChannelAdapter, InboundMessage, MessageReceivedEvent, OutboundReply } from './types'

declare module 'cordis' {
  interface Context {
    channel: ChannelService
  }
  interface Events {
    'message/received': (payload: MessageReceivedEvent) => void
  }
}

/**
 * channel Service：渠道编排层（所有渠道共享）。
 * - register：渠道适配器注册（新渠道 = 实现 ChannelAdapter + 注册，不改 worker/agent）
 * - dispatch：统一入站管线（落库 channel_messages → 建 thread → 入队 → 回执 → 广播）
 * - send：出站回复按 channel 路由到对应 adapter
 * 具体渠道协议（监听/解析/发消息）在各 adapter 里，不在此层。
 */
export default class ChannelService extends Service {
  static inject = ['channelStore', 'threads', 'traces']

  static Config = z
    .object({
      /** 入站回执文案（原 lark 的「正在思考中」），空字符串 = 不回执 */
      thinkingReply: z.string().optional()
    })
    .default({})

  private readonly adapters = new Map<string, ChannelAdapter>()
  private readonly thinkingReply: string

  constructor(ctx: Context, config: z.infer<typeof ChannelService.Config>) {
    super(ctx, 'channel')
    this.thinkingReply = config.thinkingReply ?? '🤔 正在思考中…'
  }

  /** 注册渠道适配器（同 id 重复注册抛错） */
  register(adapter: ChannelAdapter) {
    if (this.adapters.has(adapter.id)) {
      throw new Error(`[channel] adapter 已注册: ${adapter.id}`)
    }
    this.adapters.set(adapter.id, adapter)
  }

  /** 统一入站管线：落库 → 建 thread → 入队 → 回执 → 广播（重复 message_id 整条跳过，幂等） */
  async dispatch(msg: InboundMessage): Promise<void> {
    const inserted = this.ctx.channelStore.insertMessage({
      channel: msg.channel,
      messageId: msg.messageId,
      chatId: msg.chatId,
      chatType: msg.chatType,
      threadId: msg.threadId,
      senderId: msg.senderId ?? null,
      senderName: msg.senderName ?? null,
      text: msg.text,
      extra: msg.raw ? stringify(msg.raw) : null
    })
    if (!inserted) {
      logger.warn(`[channel] 重复消息已忽略（${msg.channel}/${msg.messageId}）`)
      return
    }

    this.ctx.threads.ensureThread(msg.threadId, msg.chatType, msg.chatId, msg.senderId ?? null)
    this.ctx.traces.insertTrace(msg.threadId, msg.messageId, msg.chatId, msg.text, msg.channel)

    if (this.thinkingReply) {
      await this.send({
        channel: msg.channel,
        messageId: msg.messageId,
        text: this.thinkingReply
      })
    }

    this.ctx.emit('message/received', {
      channel: msg.channel,
      threadId: msg.threadId,
      text: msg.text
    })
  }

  /** 出站回复：按 reply.channel 路由到对应 adapter；无 adapter 记日志并返回 false */
  async send(reply: OutboundReply): Promise<boolean> {
    const adapter = this.adapters.get(reply.channel)
    if (!adapter) {
      logger.error(`[channel] 无对应 adapter（channel=${reply.channel}），回复丢弃: `, reply)
      return false
    }
    return adapter.send(reply)
  }
}
