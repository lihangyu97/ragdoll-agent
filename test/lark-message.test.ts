import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseImageContent,
  parseMessageContent,
  parsePostContent,
  parseTextContent,
  resolveThreadId,
  type LarkMessage
} from '../src/services/channel/adapters/lark/message'

/** fixture：create_time 必填但测试不关心，override 类型排除它 */
type MessageOverride = Partial<Omit<LarkMessage['message'], 'create_time'>>

function textMsg(overrides: MessageOverride = {}): LarkMessage {
  return {
    sender: { sender_type: 'user' },
    message: {
      message_id: 'm-1',
      chat_id: 'oc_1',
      chat_type: 'p2p',
      message_type: 'text',
      content: '{"text":"hi"}',
      create_time: '0',
      ...overrides
    }
  }
}

test('parseTextContent：解析 JSON 并替换提及 key（长 key 优先）', () => {
  assert.equal(
    parseTextContent('{"text":"hi @_user_1"}', [
      { key: '@_user_1', id: { open_id: 'ou_1' }, name: '张三' }
    ]),
    'hi @张三'
  )

  // key 长的先替换，避免 @_user_1 误伤 @_user_10 前缀
  assert.equal(
    parseTextContent('{"text":"a @_user_10 b @_user_1"}', [
      { key: '@_user_1', id: {}, name: '一' },
      { key: '@_user_10', id: {}, name: '十' }
    ]),
    'a @十 b @一'
  )

  // 非 JSON 原样返回（不抛错）
  assert.equal(parseTextContent('not-json'), 'not-json')
})

test('parsePostContent：post 富文本转纯文本（content_v2 优先，无则 content）', () => {
  const post = JSON.stringify({
    content_v2: [
      [
        { tag: 'text', text: '你好' },
        { tag: 'img', image_key: 'img_v2_abc' }
      ],
      [{ tag: 'text', text: '第二行' }]
    ]
  })
  assert.equal(
    parsePostContent(post, 'om_1'),
    '你好[图片 channel=lark message_id=om_1 image_key=img_v2_abc]\n第二行'
  )

  // 无 image_key 退回纯占位符
  const noKey = JSON.stringify({ content_v2: [[{ tag: 'img' }]] })
  assert.equal(parsePostContent(noKey, 'om_1'), '[图片]')

  const legacy = JSON.stringify({
    title: '标题',
    content: [[{ tag: 'text', text: '旧格式' }]]
  })
  assert.equal(parsePostContent(legacy, 'om_1'), '标题\n旧格式')

  assert.equal(parsePostContent('not-json', 'om_1'), 'not-json')
})

test('parseImageContent：image 消息生成带渠道和 message_id 的占位符，异常原样返回', () => {
  assert.equal(
    parseImageContent('{"image_key":"img_v2_abc"}', 'om_9'),
    '[图片 channel=lark message_id=om_9 image_key=img_v2_abc]'
  )
  assert.equal(parseImageContent('{}', 'om_9'), '{}')
  assert.equal(parseImageContent('not-json', 'om_9'), 'not-json')
})

test('parseMessageContent：按类型分发，未知类型原样返回', () => {
  assert.equal(parseMessageContent(textMsg()), 'hi')
  const post = textMsg({
    message_type: 'post',
    content: JSON.stringify({ content_v2: [[{ tag: 'text', text: 'x' }]] })
  })
  assert.equal(parseMessageContent(post), 'x')
  const image = textMsg({ message_type: 'image', content: '{"image_key":"img_v2_abc"}' })
  assert.equal(
    parseMessageContent(image),
    '[图片 channel=lark message_id=m-1 image_key=img_v2_abc]'
  )
  assert.equal(parseMessageContent(textMsg({ message_type: 'file', content: 'raw' })), 'raw')
})

test('resolveThreadId：p2p 用 chat_id，group 需要话题线程，无则 null', () => {
  assert.equal(resolveThreadId(textMsg()), 'oc_1')
  assert.equal(resolveThreadId(textMsg({ chat_type: 'group', thread_id: 'omt_1' })), 'omt_1')
  assert.equal(resolveThreadId(textMsg({ chat_type: 'group' })), null)
})
