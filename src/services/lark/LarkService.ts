import { Service, type Context } from 'cordis'
import * as lark from '@larksuiteoapi/node-sdk'
import logger, { stringify } from '@/logger'
import { assign } from '@/utils'
import { larkBaseConfig, larkHandlers, LOGGER_LEVEL } from '@/config/lark'
import { type LarkMessage, parseMessageContent } from './message'

/**
 * lark adapter Service：入站（WS 长连接收消息、落库入队）+ 出站（replyToMessage 等能力）。
 * 回复路径保持事件解耦：只订阅 agent/result、agent/error，反查 processing trace 拿 message_id 回消息，
 * 完全不知道 agent 内部如何执行。
 */
export default class LarkService extends Service {
  static inject = ['channelLark', 'threads', 'traces']

  private readonly client: lark.Client
  private readonly ws: lark.WSClient

  constructor(ctx: Context) {
    super(ctx, 'lark')

    this.client = new lark.Client(assign(larkBaseConfig))
    this.ws = new lark.WSClient(assign(larkBaseConfig, larkHandlers))
  }

  async start() {
    this.watchAgentLoop()
    this.watchDispatcher()
  }

  async close() {
    this.ws.close()
  }

  /** 回复指定消息（文本） */
  async replyToMessage(messageId: string, text: string) {
    return this.client.im.message.reply({
      path: { message_id: messageId },
      data: { content: JSON.stringify({ text }), msg_type: 'text' }
    })
  }

  /** 订阅 agent 事件：结果/错误回消息（agent 完全不知道 lark 存在） */
  private watchAgentLoop() {
    this.ctx.on('agent/result', (threadId, _node, msg) => {
      if (typeof msg.content !== 'string' || !msg.content) {
        logger.error('[lark] 消息格式异常: ', { threadId, msg })
        return
      }
      const trace = this.ctx.traces.getLatestProcessingTrace(threadId)
      if (!trace) return
      this.replyToMessage(trace.message_id, msg.content).catch(err =>
        logger.error('[lark] 回复失败: ', { threadId, error: stringify(err) })
      )
    })

    this.ctx.on('agent/error', (threadId, error) => {
      const trace = this.ctx.traces.getLatestProcessingTrace(threadId)
      if (!trace) return
      this.replyToMessage(trace.message_id, `⚠️ Agent 处理失败：${error}`).catch(err =>
        logger.error('[lark] 错误回复失败: ', { threadId, error: stringify(err) })
      )
    })
  }

  private watchDispatcher() {
    const dispatcher = new lark.EventDispatcher({
      loggerLevel: LOGGER_LEVEL
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

    const content = parseMessageContent(msg)

    const threadId = this.resolveThreadId(msg)
    if (!threadId) {
      logger.error('无 threadId 无法确认场景', stringifyMsg)
      return
    }

    const chatId = msg.message.chat_id
    const messageId = msg.message.message_id
    const openId = msg.sender.sender_id?.open_id

    const senderName = openId ? await this.getUserName(openId) : 'unknown'

    this.ctx.channelLark.insertLarkMessage({
      event_type: msg.event_type ?? '',
      app_id: msg.app_id ?? '',
      chat_id: chatId,
      chat_type: msg.message.chat_type,
      message_id: messageId,
      message_type: msg.message.message_type,
      thread_id: msg.message.thread_id ?? null,
      sender_open_id: openId ?? null,
      sender_type: msg.sender.sender_type,
      sender_name: senderName,
      content
    })

    // 写入 agent 队列（pending），由 workerService 轮询消费；最终回复由 agent/result 事件触发
    this.ctx.threads.ensureThread(threadId, msg.message.chat_type, chatId, openId ?? null)
    this.ctx.traces.insertTrace(threadId, messageId, chatId, content)

    this.ctx.emit('message/received', threadId, content)

    // 先回个"正在思考"，长任务期间用户有反馈
    await this.replyToMessage(messageId, '🤔 正在思考中…')
  }

  private resolveThreadId(msg: LarkMessage): string | null {
    if (msg.message.chat_type === 'p2p') {
      return msg.message.chat_id
    }
    if (msg.message.chat_type === 'group' && msg.message.thread_id) {
      return msg.message.thread_id
    }

    return null // 不支持的场景
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
