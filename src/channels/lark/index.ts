import * as lark from "@larksuiteoapi/node-sdk"
import { LARK_APP_ID, LARK_APP_SECRET, LARK_DOMAIN } from "@config/lark"
import {
  insertLarkMessage,
  getUserName as getCachedUserName,
  upsertUser
} from "@sqlite/channelLark"
import { ensureThread } from "@sqlite/agentThreads"
import { insertTrace } from "@sqlite/agentTraces"
import { Hooks, trackHook } from "@agent/hooks"
import type { LarkMessage } from "./types"
import { parseMessageContent } from "./message"

/**
 * 飞书客户端：通过 WebSocket 长连接接收事件推送（im.message.receive_v1），
 * 免公网回调地址。收到消息后写入 agent_traces 排队，由 Worker 处理；
 * Worker 完成通过 AGENT_MESSAGE hook 广播回复，这里订阅并发送。
 */
export class LarkClient {
  private readonly appId: string
  private readonly appSecret: string
  private readonly loggerLevel: lark.LoggerLevel
  private readonly larkDomain: lark.Domain
  private readonly client: lark.Client
  private readonly ws: lark.WSClient
  private started = false

  constructor() {
    if (!LARK_APP_ID || !LARK_APP_SECRET) {
      throw new Error(
        "缺少飞书配置：请在 .env 里设置 LARK_APP_ID / LARK_APP_SECRET（开放平台「凭证与基础信息」获取）"
      )
    }

    this.appId = LARK_APP_ID
    this.appSecret = LARK_APP_SECRET
    this.larkDomain = LARK_DOMAIN
    this.loggerLevel = lark.LoggerLevel.info
    this.client = this.createClient()
    this.ws = this.createWSClient()
    this.trackAgentMessages()
  }

  // 订阅 Worker 的 AGENT_MESSAGE 广播，把 agent 回复发回飞书
  private trackAgentMessages() {
    trackHook(Hooks.AGENT_MESSAGE, (_threadId, { messageId, text }) => {
      this.replyToMessage(messageId, text).catch(err =>
        console.error(`[lark] 回复失败（messageId=${messageId}）：`, err)
      )
    })
  }

  /** 收到消息的处理逻辑 */
  private async handleMessage(msg: LarkMessage): Promise<void> {
    console.log(`🔥 msg ===>`, JSON.stringify(msg), `<=== 🔥`)

    const text = parseMessageContent(
      msg.message.message_type,
      msg.message.content,
      msg.message.mentions
    )

    // 确定 threadId
    const threadId = this.resolveThreadId(msg)
    if (!threadId) return // 不支持的场景，忽略

    const chatId = msg.message.chat_id
    const messageId = msg.message.message_id

    // 飞书消息落库（日志用途）
    const openId = msg.sender.sender_id?.open_id
    const senderName = openId ? await this.getUserName(openId) : "unknown"
    insertLarkMessage({
      event_type: msg.event_type ?? "",
      app_id: msg.app_id ?? "",
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
    ensureThread(threadId, msg.message.chat_type, chatId)
    insertTrace(threadId, messageId, chatId, text)

    // 立即回复「思考中」
    await this.replyToMessage(messageId, "🤔 正在思考中…")
  }

  // 根据消息确定 threadId，不支持的场景返回 null
  private resolveThreadId(msg: LarkMessage): string | null {
    if (msg.message.chat_type === "p2p") {
      return msg.message.chat_id
    }
    if (msg.message.chat_type === "group" && msg.message.thread_id) {
      return msg.message.thread_id
    }
    return null
  }

  /**
   * 通过 open_id 获取用户名：
   * 1. 先查 channel_lark_user 表，命中直接返回；
   * 2. 没有再调飞书通讯录接口（contact.v3.user.get），查到后写库；
   * 3. 都失败返回 open_id 兜底，避免影响消息回复。
   */
  private async getUserName(openId: string): Promise<string> {
    const cached = getCachedUserName(openId)
    if (cached) return cached

    try {
      const res = await this.client.contact.v3.user.get({
        path: { user_id: openId },
        params: { user_id_type: "open_id" }
      })
      const name = res.data?.user?.name
      if (name) {
        upsertUser(openId, name)
        return name
      }
    } catch (err) {
      console.error(`[lark] 获取用户信息失败（open_id=${openId}）：`, err)
    }
    return openId
  }

  /** 回复指定消息（文本），Worker 处理完成后调用 */
  async replyToMessage(messageId: string, text: string) {
    return this.client.im.message.reply({
      path: { message_id: messageId },
      data: { content: JSON.stringify({ text }), msg_type: "text" }
    })
  }

  /** 向会话发送文本消息（chat_id 来自 msg.message.chat_id） */
  private async sendText(chatId: string, text: string) {
    return this.client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: "text",
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
      onReady: () => console.log("[lark] 长连接已建立"),
      onError: err => console.error("[lark] 连接失败：", err.message),
      onReconnecting: () => console.warn("[lark] 连接断开，正在重连…"),
      onReconnected: () => console.log("[lark] 重连成功")
    })
  }

  /** 启动长连接，开始接收并处理消息（只会启动一次） */
  async start(): Promise<void> {
    if (this.started) return
    this.started = true

    const dispatcher = new lark.EventDispatcher({
      loggerLevel: lark.LoggerLevel.info
    }).register({
      "im.message.receive_v1": data => {
        // 忽略机器人自己发出的消息（例如群聊里回复触发的接收）
        if (data.sender.sender_type === "app") return
        return this.handleMessage(data)
      }
    })

    await this.ws.start({ eventDispatcher: dispatcher })
  }

  /** 关闭长连接 */
  close(): void {
    this.ws.close()
    this.started = false
  }
}

export default LarkClient
