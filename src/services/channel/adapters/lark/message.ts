/**
 * 飞书消息 content 解析工具。
 * 各类型 content 的 JSON 结构见官方文档：
 * https://open.feishu.cn/document/server-docs/im-v1/message-content-description/message_content.md
 */

/** im.message.receive_v1 事件里我们关心的字段（SDK 完整类型见 EventHandles） */
export interface LarkMessage {
  event_id?: string
  event_type?: string
  app_id?: string
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
    thread_id?: string
    mentions?: LarkMention[]
  }
}

/** 消息里的提及（text 消息正文里的 @_user_1 就是 key 占位符） */
interface LarkMention {
  key: string
  id: {
    union_id?: string
    user_id?: string
    open_id?: string
  }
  name: string
}

/** post 消息 content 里的单个元素 */
interface PostElement {
  tag: string
  text?: string
  href?: string
  user_id?: string
  user_name?: string
  image_key?: string
  file_key?: string
  emoji_type?: string
  content?: string
}

/** post 消息 content 解析后的结构（content / content_v2 是「行」数组，每行是元素数组） */
interface PostContent {
  title?: string
  content?: PostElement[][]
  content_v2?: PostElement[][]
}

/**
 * 把正文里的提及占位符（key，如 @_user_1）替换成真实名字。
 * key 长的先替换，避免 @_user_1 误伤 @_user_10 这类前缀情况。
 */
function replaceMentions(text: string, mentions?: LarkMention[]): string {
  if (!mentions?.length) return text
  const sorted = [...mentions].sort((a, b) => b.key.length - a.key.length)
  return sorted.reduce((acc, m) => acc.split(m.key).join(`@${m.name}`), text)
}

/**
 * 图片占位符：带渠道 + message_id + image_key，供 fetch_image 类工具复制参数。
 * image_key 只在所属渠道内有效（飞书的 key 换不来 telegram 的图），渠道标识防跨渠道混淆。
 */
function imagePlaceholder(imageKey: string | undefined, messageId: string): string {
  if (!imageKey) return '[图片]'
  return `[图片 channel=lark message_id=${messageId} image_key=${imageKey}]`
}

/** 解析消息 content（文本消息是 JSON 字符串，形如 {"text":"..."}，提及 key 会替换成 @名字） */
export function parseTextContent(content: string, mentions?: LarkMention[]): string {
  try {
    const parsed = JSON.parse(content) as { text?: string }
    return replaceMentions(parsed.text ?? '', mentions)
  } catch {
    return content
  }
}

/** post 单个元素 → 文本（messageId 进图片占位符，取图接口需要 message_id + file_key） */
function postElementToText(el: PostElement, messageId: string): string {
  switch (el.tag) {
    case 'text':
    case 'a':
    case 'md':
      return el.text ?? ''
    case 'at':
    case 'mention':
      return el.user_name ? `@${el.user_name}` : '@'
    case 'img':
      return imagePlaceholder(el.image_key, messageId)
    case 'media':
      return '[视频]'
    case 'file':
      return '[文件]'
    case 'emotion':
      return `[表情:${el.emoji_type ?? 'unknown'}]`
    case 'code_block':
      return el.content ?? el.text ?? ''
    case 'reply':
      return el.text ?? '[回复]'
    default:
      return el.text ?? ''
  }
}

/**
 * 解析 post（富文本）消息 content 为纯文本。
 * 优先取 content_v2（新格式），没有则退回 content；每行元素拼接，行间换行，标题在最前。
 */
export function parsePostContent(content: string, messageId: string): string {
  let data: PostContent
  try {
    data = JSON.parse(content) as PostContent
  } catch {
    return content
  }
  const lines = data.content_v2 ?? data.content ?? []
  const body = lines
    .map(line => line.map(el => postElementToText(el, messageId)).join(''))
    .join('\n')
  return data.title ? `${data.title}\n${body}` : body
}

/** image 消息 content → 图片占位符（解析失败原样返回） */
export function parseImageContent(content: string, messageId: string): string {
  try {
    const imageKey = (JSON.parse(content) as { image_key?: string }).image_key
    return imageKey ? imagePlaceholder(imageKey, messageId) : content
  } catch {
    return content
  }
}

/** 按消息类型把 content 解析为纯文本（当前支持 text / post / image，其余类型原样返回） */
export function parseMessageContent(msg: LarkMessage): string {
  const messageType = msg.message.message_type
  const content = msg.message.content
  const mentions = msg.message.mentions
  const messageId = msg.message.message_id

  switch (messageType) {
    case 'text':
      return parseTextContent(content, mentions)
    case 'post':
      return parsePostContent(content, messageId)
    case 'image':
      return parseImageContent(content, messageId)
    default:
      return content
  }
}

export function resolveThreadId(msg: LarkMessage): string | null {
  if (msg.message.chat_type === 'p2p') {
    return msg.message.chat_id
  }
  if (msg.message.chat_type === 'group' && msg.message.thread_id) {
    return msg.message.thread_id
  }

  return null // 不支持的场景
}
