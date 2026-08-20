/**
 * 飞书消息 content 解析工具。
 *
 * 官方 SDK（@larksuiteoapi/node-sdk）只提供原始 content 字符串，不做「转纯文本」，
 * 各家 bot 框架（如 nanobot、LangBot）都是按 msg_type 手写解析，这里同款做法。
 * 各类型 content 的 JSON 结构见官方文档：
 * https://open.feishu.cn/document/server-docs/im-v1/message-content-description/message_content.md
 */

import type { LarkMention } from './types'

/** post 消息 content 里的单个元素 */
export type PostElement = {
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
export type PostContent = {
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

/** 解析消息 content（文本消息是 JSON 字符串，形如 {"text":"..."}，提及 key 会替换成 @名字） */
export function parseTextContent(content: string, mentions?: LarkMention[]): string {
  try {
    const parsed = JSON.parse(content) as { text?: string }
    return replaceMentions(parsed.text ?? '', mentions)
  } catch {
    return content
  }
}

/** post 单个元素 → 文本 */
function postElementToText(el: PostElement): string {
  switch (el.tag) {
    case 'text':
    case 'a':
    case 'md':
      return el.text ?? ''
    case 'at':
    case 'mention':
      return el.user_name ? `@${el.user_name}` : '@'
    case 'img':
      return '[图片]'
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
export function parsePostContent(content: string): string {
  let data: PostContent
  try {
    data = JSON.parse(content) as PostContent
  } catch {
    return content
  }
  const lines = data.content_v2 ?? data.content ?? []
  const body = lines.map(line => line.map(el => postElementToText(el)).join('')).join('\n')
  return data.title ? `${data.title}\n${body}` : body
}

/** 按消息类型把 content 解析为纯文本（当前支持 text / post，其余类型原样返回） */
export function parseMessageContent(
  messageType: string,
  content: string,
  mentions?: LarkMention[]
): string {
  switch (messageType) {
    case 'text':
      return parseTextContent(content, mentions)
    case 'post':
      return parsePostContent(content)
    default:
      return content
  }
}
