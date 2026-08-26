/**
 * 渠道契约（框架无关）：任何渠道完整实现 ChannelAdapter 即可插拔（lark / telegram / console…）。
 * 入站方向：adapter 监听平台事件 → 归一化成 InboundMessage → 调 ctx.channel.dispatch(msg)（统一入站管线）。
 * 出站方向：worker 完成路径经 ctx.channel.send(reply) 按 reply.channel 路由回对应 adapter。
 */

/** 入站消息：适配器把平台原始事件归一化后的标准形态 */
export interface InboundMessage {
  /** 渠道 id（'lark' | 'telegram'…），出站回复路由依据 */
  channel: string
  /** 会话 thread id：适配器负责加渠道前缀命名空间（如 'lark:p2p:oc_xxx'），防跨渠道撞 id */
  threadId: string
  chatId: string
  chatType: string
  /** 出站回复锚点（reply-to） */
  messageId: string
  senderId?: string
  senderName?: string
  /** 解析后的纯文本 */
  text: string
  /** 原始事件（debug 用，落库进 channel_messages.extra） */
  raw?: unknown
}

/** 出站回复：统一经 ChannelService.send 路由到对应 adapter */
export interface OutboundReply {
  channel: string
  messageId: string
  text: string
}

/** 渠道适配器接口：完整实现即可插拔 */
export interface ChannelAdapter {
  readonly id: string
  /** 建连：WS / 长轮询 / webhook */
  start(): Promise<void>
  stop(): Promise<void>
  /** 出站回复，失败返回 false（上层只记日志不中断主流程） */
  send(reply: OutboundReply): Promise<boolean>
}
