import * as lark from '@larksuiteoapi/node-sdk'
import { LARK_APP_ID, LARK_APP_SECRET, LARK_DOMAIN } from '@config/lark'
import {
  insertLarkMessage,
  getUserName as getCachedUserName,
  upsertUser
} from '@sqlite/channelLark'
import { ensureThread } from '@sqlite/agentThreads'
import { insertTrace, getLatestProcessingTrace } from '@sqlite/agentTraces'
import { Hooks, trackHook } from '@agent/hooks'
import logger, { stringify } from '@logger'
import { type LarkMessage, parseMessageContent } from './message'

export class LarkClient {
  private readonly appId: string
  private readonly appSecret: string
  private readonly loggerLevel: lark.LoggerLevel
  private readonly larkDomain: lark.Domain
  private readonly client: lark.Client
  private readonly ws: lark.WSClient
  private started = false

  constructor() {
    this.appId = LARK_APP_ID
    this.appSecret = LARK_APP_SECRET
    this.larkDomain = LARK_DOMAIN
    this.loggerLevel = lark.LoggerLevel.info
    this.client = this.createClient()
    this.ws = this.createWSClient()
    this.trackAgentResults()
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true

    const dispatcher = new lark.EventDispatcher({
      loggerLevel: this.loggerLevel
    }).register({
      'im.message.receive_v1': data => {
        if (data.sender.sender_type === 'app') return
        return this.handleMessage(data).catch(err => this.handleMessageError(data, err))
      }
    })

    await this.ws.start({ eventDispatcher: dispatcher })
  }

  close(): void {
    this.ws.close()
    this.started = false
  }

  // 收到消息
  private async handleMessage(msg: LarkMessage): Promise<void> {
    const stringifyMsg = stringify(msg)
    console.log('🤖 收到飞书消息: ', stringifyMsg)

    const text = parseMessageContent(
      msg.message.message_type,
      msg.message.content,
      msg.message.mentions
    )

    const threadId = this.resolveThreadId(msg)
    if (!threadId) {
      logger.error('无 threadId 无法确认场景', stringifyMsg)
      return
    }

    const chatId = msg.message.chat_id
    const messageId = msg.message.message_id
    const openId = msg.sender.sender_id?.open_id

    const senderName = openId ? await this.getUserName(openId) : 'unknown'

    insertLarkMessage({
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
      content: text
    })

    // 写入 agent 队列
    ensureThread(threadId, msg.message.chat_type, chatId, openId ?? null)
    insertTrace(threadId, messageId, chatId, text)

    // 立即回复
    await this.replyToMessage(messageId, '🤔 正在思考中…')
  }

  private handleMessageError(msg: LarkMessage, err: unknown): void {
    logger.error('[lark] 消息处理失败: ', err)
    this.replyToMessage(msg.message.message_id, `⚠️ 处理失败：${stringify(err)}`).catch(replyErr =>
      logger.error('[lark] 错误回复失败: ', { error: stringify(replyErr) })
    )
  }

  private trackAgentResults() {
    trackHook(Hooks.AGENT_RESULT, (threadId, msg) => {
      if (typeof msg.content !== 'string' || !msg.content) {
        logger.error('[lark] 消息格式异常: ', { threadId, msg })
        return
      }
      const trace = getLatestProcessingTrace(threadId)
      if (!trace) return
      this.replyToMessage(trace.message_id, msg.content).catch(err =>
        logger.error('[lark] 回复失败: ', { threadId, error: stringify(err) })
      )
    })

    trackHook(Hooks.AGENT_ERROR, (threadId, error) => {
      const trace = getLatestProcessingTrace(threadId)
      if (!trace) return
      this.replyToMessage(trace.message_id, `⚠️ Agent 处理失败：${error}`).catch(err =>
        logger.error('[lark] 错误回复失败: ', { threadId, error: stringify(err) })
      )
    })
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
    const cached = getCachedUserName(openId)
    if (cached) return cached

    try {
      const res = await this.client.contact.v3.user.get({
        path: { user_id: openId },
        params: { user_id_type: 'open_id' }
      })
      const name = res.data?.user?.name
      if (name) {
        upsertUser(openId, name)
        return name
      }
    } catch (err) {
      logger.error('[lark] 获取用户信息失败: ', err)
    }
    return openId
  }

  /** 回复指定消息（文本），Worker 处理完成后调用 */
  async replyToMessage(messageId: string, text: string) {
    return this.client.im.message.reply({
      path: { message_id: messageId },
      data: { content: JSON.stringify({ text }), msg_type: 'text' }
    })
  }

  /** 向会话发送文本消息（chat_id 来自 msg.message.chat_id） */
  private async sendText(chatId: string, text: string) {
    return this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text })
      }
    })
  }

  private createClient() {
    return new lark.Client({
      appId: this.appId,
      appSecret: this.appSecret,
      domain: this.larkDomain,
      loggerLevel: this.loggerLevel
    })
  }

  private createWSClient() {
    return new lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      domain: this.larkDomain,
      loggerLevel: this.loggerLevel,
      autoReconnect: true,
      onReady: () => console.log('[lark] 长连接已建立'),
      onError: err => console.error('[lark] 连接失败：', err.message),
      onReconnecting: () => console.warn('[lark] 连接断开，正在重连…'),
      onReconnected: () => console.log('[lark] 重连成功')
    })
  }
}

export default LarkClient
