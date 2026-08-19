/** 消息里的提及（text 消息正文里的 @_user_1 就是 key 占位符） */
export type LarkMention = {
  key: string
  id: { union_id?: string; user_id?: string; open_id?: string }
  name: string
}

/** im.message.receive_v1 事件里我们关心的字段（SDK 完整类型见 EventHandles） */
export interface LarkMessage {
  event_id?: string
  tenant_key?: string
  sender: {
    sender_id?: { union_id?: string; user_id?: string; open_id?: string }
    sender_type: string
    tenant_key?: string
  }
  message: {
    message_id: string
    chat_id: string
    chat_type: string
    message_type: string
    content: string
    create_time: string
    mentions?: LarkMention[]
  }
}

export type LarkMessageHandler = (msg: LarkMessage) => void | Promise<void>
