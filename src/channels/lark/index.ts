import * as lark from "@larksuiteoapi/node-sdk"
import { LARK_APP_ID, LARK_APP_SECRET, LARK_DOMAIN } from "@config/lark"
import type { LarkMessage } from "./types"
import { parseMessageContent } from "./message"

/**
 * 飞书客户端：通过 WebSocket 长连接接收事件推送（im.message.receive_v1），
 * 免公网回调地址。收到消息后自动回复「收到：xxx」。
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
  }

  /** 收到消息的处理逻辑 */
  private async handleMessage(msg: LarkMessage): Promise<void> {
    console.log(`🔥 msg ===>`, JSON.stringify(msg), `<=== 🔥`)

    const text = parseMessageContent(
      msg.message.message_type,
      msg.message.content,
      msg.message.mentions
    )

    console.log(`🔥 text ===>`, text, `<=== 🔥`)

    const sender = msg.sender.sender_id?.open_id ?? "unknown"
    console.log(`[lark] ${sender} (${msg.message.chat_type}): ${text}`)

    await this.replyText(msg.message.message_id, `收到：${text}`)
  }

  /** 回复指定消息（文本） */
  private async replyText(messageId: string, text: string) {
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
